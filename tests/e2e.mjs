// End-to-end test of the real extension (project root = the extension).
//
// Drives the extension through its own pages (popup.html, blocked.html) rather
// than the service worker: extension pages always have full chrome.* access,
// and opening the popup wakes the service worker. This also tests the actual
// user flow: add a site in the popup -> visit it -> get the blocked page ->
// unblock from there.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cdpConnect, httpJson, waitFor, sleep } from "./cdp.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(TEST_DIR, "..", "extension");
const PORT = 9340;

// Branded Google Chrome ignores --load-extension; Edge is preferred.
const BROWSERS = [
  process.env.TEST_BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
].filter(Boolean);
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) {
  console.error("No test browser found (set TEST_BROWSER env var)");
  process.exit(1);
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  [" + detail + "]" : ""}`);
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`TIMEOUT ${ms}ms: ${label}`)), ms);
    }),
  ]);
}

const profile = path.join(TEST_DIR, "profile-e2e");
rmSync(profile, { recursive: true, force: true });
const logPath = path.join(TEST_DIR, "chrome-e2e.log");

const child = spawn(
  browser,
  [
    "--headless",
    "--user-data-dir=" + profile,
    "--disable-extensions-except=" + EXT_DIR,
    "--load-extension=" + EXT_DIR,
    "--remote-debugging-port=" + PORT,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-gpu",
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);
const logFile = createWriteStream(logPath);
child.stderr.pipe(logFile);

let client = null;
let extId = null;

async function getTargetUrl(targetId) {
  const { targetInfos } = await client.send("Target.getTargets");
  const t = targetInfos.find((x) => x.targetId === targetId);
  return t ? t.url : null;
}

async function openPage(url, { expect = (u) => u === url, timeout = 30000 } = {}) {
  const { targetId } = await withTimeout(client.send("Target.createTarget", { url }), 15000, "createTarget " + url);
  const finalUrl = await waitFor(async () => {
    const u = await getTargetUrl(targetId);
    return u && expect(u) ? u : null;
  }, timeout);
  const { sessionId } = await withTimeout(
    client.send("Target.attachToTarget", { targetId, flatten: true }),
    10000,
    "attach " + url
  );
  await withTimeout(client.send("Runtime.enable", {}, sessionId), 10000, "Runtime.enable");
  // Wait for the document in this session to be the loaded page.
  await waitFor(async () => {
    const r = await client.send(
      "Runtime.evaluate",
      { expression: "document.readyState === 'complete' && location.href", returnByValue: true },
      sessionId
    );
    const v = r.result?.value;
    return typeof v === "string" && v !== "about:blank" ? v : null;
  }, 20000);
  const evaluate = async (expression, label = "eval", ms = 10000) => {
    const r = await withTimeout(
      client.send(
        "Runtime.evaluate",
        { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true },
        sessionId
      ),
      ms,
      label
    );
    if (r.exceptionDetails) {
      throw new Error(`${label}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    }
    return r.result?.value;
  };
  return { targetId, sessionId, url: finalUrl, evaluate };
}

try {
  console.log("Browser:", browser);
  const version = await withTimeout(
    waitFor(() => httpJson(`http://127.0.0.1:${PORT}/json/version`), 30000),
    35000,
    "json/version"
  );
  console.log("Version:", version.Browser);
  client = await cdpConnect(version.webSocketDebuggerUrl);

  // --- Find the extension id from its service worker target. -----------------
  const sw = await waitFor(async () => {
    const { targetInfos } = await client.send("Target.getTargets");
    return targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/background.js"));
  }, 30000);
  extId = new URL(sw.url).host;
  console.log("Extension ID:", extId);

  // --- 1. Open the popup and add a site through the real UI. -----------------
  const popup = await openPage(`chrome-extension://${extId}/popup.html`);
  const api = await popup.evaluate(
    `({ hasStorage: !!chrome.storage, hasDnr: !!chrome.declarativeNetRequest })`,
    "api probe"
  );
  check("popup has extension APIs", api.hasStorage && api.hasDnr, JSON.stringify(api));

  // Add "example.com" by typing it into the form and submitting (real UI path).
  await popup.evaluate(
    `(() => {
      const input = document.getElementById("domainInput");
      input.value = "https://www.example.com/some/page?x=1";
      document.getElementById("addForm").dispatchEvent(new Event("submit", { cancelable: true }));
      return true;
    })()`,
    "add site"
  );

  const sites = await waitFor(async () => {
    const v = await popup.evaluate(`(await chrome.storage.sync.get({blockedSites: []})).blockedSites`, "read sites");
    return Array.isArray(v) && v.length ? v : null;
  }, 10000);
  check("popup normalizes and saves the domain", sites.length === 1 && sites[0] === "example.com", JSON.stringify(sites));

  const listed = await waitFor(async () => {
    const n = await popup.evaluate(`document.querySelectorAll("#siteList li").length`, "list count");
    return n === 1 ? n : null;
  }, 10000).catch(() => 0);
  check("popup renders the site in its list", listed === 1, String(listed));

  // --- 2. A dynamic rule should now exist. ----------------------------------
  const rules = await waitFor(async () => {
    const r = await popup.evaluate(`await chrome.declarativeNetRequest.getDynamicRules()`, "get rules");
    return Array.isArray(r) && r.length ? r : null;
  }, 10000);
  check(
    "one redirect rule installed for the domain",
    rules.length === 1 &&
      rules[0].action.type === "redirect" &&
      rules[0].condition.regexFilter.includes("example\\.com") &&
      rules[0].condition.resourceTypes.includes("main_frame"),
    JSON.stringify(rules)
  );

  // --- 3. Visiting the blocked site lands on the blocked page. --------------
  const blocked = await openPage("https://example.com/", {
    expect: (u) => u.includes("blocked.html"),
    timeout: 40000,
  });
  check("navigation to example.com shows the blocked page", blocked.url.includes("blocked.html"), blocked.url);

  // --- 4. The blocked page shows the site and passes the original URL. ------
  const pageState = await blocked.evaluate(
    `({
      text: document.body.innerText,
      site: document.getElementById("siteName").textContent,
      unblockVisible: !document.getElementById("unblock").hidden
    })`,
    "blocked page state"
  );
  check("blocked page names the blocked site", pageState.site === "example.com", pageState.site);
  check("blocked page offers the unblock button", pageState.unblockVisible === true);
  check("blocked page received the original URL", /url=https?%3A|url=https?:/i.test(blocked.url), blocked.url.slice(0, 120));

  // --- 5. Subdomain is blocked too, look-alike domain is not. --------------
  const sub = await openPage("https://www.example.com/", {
    expect: (u) => u.includes("blocked.html"),
    timeout: 30000,
  });
  check("subdomain is blocked as well", sub.url.includes("blocked.html"), sub.url.slice(0, 100));

  // --- 6. Unblocking from the blocked page removes the site and lets you in. -
  await blocked.evaluate(`document.getElementById("unblock").click()`, "click unblock");
  await sleep(2500);
  const sitesAfter = await popup.evaluate(`(await chrome.storage.sync.get({blockedSites: []})).blockedSites`, "sites after");
  check("unblock removes the site from the list", sitesAfter.length === 0, JSON.stringify(sitesAfter));

  const rulesAfter = await waitFor(async () => {
    const r = await popup.evaluate(`await chrome.declarativeNetRequest.getDynamicRules()`, "rules after");
    return Array.isArray(r) ? r : null;
  }, 10000);
  check("unblock clears the redirect rule", rulesAfter.length === 0, JSON.stringify(rulesAfter));

  // --- 7. The on/off switch clears and restores rules. ----------------------
  await popup.evaluate(
    `(() => {
      const t = document.getElementById("enabledToggle");
      t.checked = false;
      t.dispatchEvent(new Event("change"));
      return true;
    })()`,
    "toggle off"
  );
  await popup.evaluate(`await chrome.storage.sync.set({ blockedSites: ["example.com"] })`, "re-add site");
  await sleep(1200);
  const rulesDisabled = await waitFor(async () => {
    const r = await popup.evaluate(`await chrome.declarativeNetRequest.getDynamicRules()`, "rules disabled");
    return Array.isArray(r) ? r : null;
  }, 10000);
  check("blocking disabled -> no rules installed", rulesDisabled.length === 0, JSON.stringify(rulesDisabled));

  const enabledState = await popup.evaluate(`(await chrome.storage.sync.get({enabled: true})).enabled`, "enabled state");
  check("toggle off is persisted", enabledState === false, String(enabledState));

  await popup.evaluate(
    `(() => {
      const t = document.getElementById("enabledToggle");
      t.checked = true;
      t.dispatchEvent(new Event("change"));
      return true;
    })()`,
    "toggle on"
  );
  const rulesEnabled = await waitFor(async () => {
    const r = await popup.evaluate(`await chrome.declarativeNetRequest.getDynamicRules()`, "rules enabled");
    return Array.isArray(r) && r.length ? r : null;
  }, 10000);
  check("blocking re-enabled -> rule restored", rulesEnabled.length === 1, JSON.stringify(rulesEnabled));

  // --- 8. The popup's current-site row can block the active tab. ------------
  // Open a normal site, keep it as the active tab, and open the popup in the
  // background so chrome.tabs.query() reports the site tab.
  await client.send("Target.createTarget", { url: "https://example.org/" });
  await sleep(1500);
  const bgPopup = await (async () => {
    const { targetId } = await client.send("Target.createTarget", {
      url: `chrome-extension://${extId}/popup.html`,
      background: true,
    });
    const u = await waitFor(async () => {
      const t = await getTargetUrl(targetId);
      return t && t.includes("popup.html") ? t : null;
    }, 20000);
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
    await client.send("Runtime.enable", {}, sessionId);
    await waitFor(async () => {
      const r = await client.send(
        "Runtime.evaluate",
        { expression: "document.readyState === 'complete' && !!document.getElementById('currentAction')", returnByValue: true },
        sessionId
      );
      return r.result?.value === true;
    }, 15000);
    const evaluate = async (expression, label = "eval") => {
      const r = await client.send(
        "Runtime.evaluate",
        { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true },
        sessionId
      );
      if (r.exceptionDetails) throw new Error(`${label}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result?.value;
    };
    return { url: u, evaluate };
  })();

  const currentRow = await waitFor(async () => {
    const v = await bgPopup.evaluate(
      `({
        hidden: document.getElementById("currentSite").hidden,
        domain: document.getElementById("currentDomain").textContent,
        state: document.getElementById("currentState").textContent,
        action: document.getElementById("currentAction").textContent
      })`,
      "current row"
    );
    return v && v.domain ? v : null;
  }, 15000).catch(() => null);
  check(
    "popup shows the active site with a block shortcut",
    !!currentRow && currentRow.domain === "example.org" && currentRow.action === "Block this site",
    JSON.stringify(currentRow)
  );

  const warningShown = await bgPopup.evaluate(`!document.getElementById("accessWarning").hidden`, "warning");
  check("no false site-access warning in normal operation", warningShown === false, String(warningShown));

  await bgPopup.evaluate(`document.getElementById("currentAction").click()`, "block current site");
  const sitesWithOrg = await waitFor(async () => {
    const v = await bgPopup.evaluate(`(await chrome.storage.sync.get({blockedSites: []})).blockedSites`, "sites org");
    return Array.isArray(v) && v.includes("example.org") ? v : null;
  }, 10000).catch(() => null);
  check("block shortcut adds the active site", Array.isArray(sitesWithOrg), JSON.stringify(sitesWithOrg));

  // --- 9. Timed blocks expire on their own. --------------------------------
  // Add a site with a 1 minute timer via the popup UI.
  await popup.evaluate(
    `(() => {
      document.querySelector('#durationOptions .chip[data-minutes="15"]').click();
      const input = document.getElementById("domainInput");
      input.value = "timed-example.com";
      document.getElementById("addForm").dispatchEvent(new Event("submit", { cancelable: true }));
      return true;
    })()`,
    "add timed site"
  );

  const timed = await waitFor(async () => {
    const v = await popup.evaluate(`(await chrome.storage.sync.get({timedBlocks: {}})).timedBlocks`, "read timed");
    return v && v["timed-example.com"] ? v : null;
  }, 10000).catch(() => null);
  const timedExpiry = timed ? timed["timed-example.com"] : 0;
  const expectedDuration = 15 * 60 * 1000;
  check(
    "timed block stores an expiry ~15 minutes out",
    timedExpiry > Date.now() + expectedDuration - 60000 && timedExpiry < Date.now() + expectedDuration + 60000,
    String(timedExpiry)
  );

  const timedRules = await waitFor(async () => {
    const r = await popup.evaluate(`await chrome.declarativeNetRequest.getDynamicRules()`, "timed rules");
    if (!Array.isArray(r)) return null;
    // Wait until the rule for the timed site specifically is present.
    const rule = r.find((x) => x.condition.regexFilter.includes("timed-example"));
    return rule || null;
  }, 10000).catch(() => null);
  const timedRule = timedRules;
  check(
    "timed block produces a rule carrying its expiry",
    !!timedRule &&
      timedRule.action.redirect.regexSubstitution.includes("mode=timed") &&
      timedRule.action.redirect.regexSubstitution.includes("until=" + timedExpiry),
    JSON.stringify(timedRule)
  );

  // A timed site is blocked, and the blocked page explains why + counts down.
  const timedPage = await openPage("https://timed-example.com/", {
    expect: (u) => u.includes("blocked.html"),
    timeout: 30000,
  });
  check("timed site shows the blocked page", timedPage.url.includes("blocked.html"), timedPage.url);
  check("timed blocked page carries mode=timed", /mode=timed/.test(timedPage.url), timedPage.url.slice(0, 160));

  const timedState = await timedPage.evaluate(
    `({
      title: document.getElementById("title").textContent,
      countdown: document.getElementById("countdown").textContent,
      countdownVisible: !document.getElementById("countdown").hidden,
      unblockText: document.getElementById("unblock").textContent
    })`,
    "timed page state"
  );
  check(
    "timed blocked page shows a countdown",
    timedState.countdownVisible && /Unblocks in/.test(timedState.countdown),
    JSON.stringify(timedState)
  );
  check(
    "timed blocked page offers to cancel the timer",
    /Cancel timer/.test(timedState.unblockText),
    timedState.unblockText
  );

  // An expired timed block is dropped automatically by the service worker.
  await popup.evaluate(
    `await chrome.storage.sync.set({ timedBlocks: { "timed-example.com": Date.now() - 1000 } })`,
    "expire timed block"
  );
  const expiredGone = await waitFor(async () => {
    const v = await popup.evaluate(`(await chrome.storage.sync.get({timedBlocks: {}})).timedBlocks`, "read expired");
    return v && !v["timed-example.com"] ? v : null;
  }, 10000).catch(() => null);
  check("expired timed block is cleaned up automatically", expiredGone !== null, JSON.stringify(expiredGone));

  // --- 10. Focus mode (pomodoro) blocks its sites during the work phase. ----
  await popup.evaluate(
    `(() => {
      const input = document.getElementById("focusDomainInput");
      input.value = "focus-example.com";
      document.getElementById("focusAddForm").dispatchEvent(new Event("submit", { cancelable: true }));
      return true;
    })()`,
    "add focus site"
  );
  const focusSites = await waitFor(async () => {
    const v = await popup.evaluate(`(await chrome.storage.sync.get({focus: {sites: []}})).focus.sites`, "read focus sites");
    return Array.isArray(v) && v.length ? v : null;
  }, 10000).catch(() => null);
  check("focus site is saved", Array.isArray(focusSites) && focusSites[0] === "focus-example.com", JSON.stringify(focusSites));

  // Start the session with a 1 minute work phase and a 1 minute break.
  await popup.evaluate(
    `(() => {
      const work = document.getElementById("workMinutes");
      work.value = "custom";
      work.dispatchEvent(new Event("change"));
      const w = document.getElementById("customWorkMinutes");
      w.value = "1";
      w.dispatchEvent(new Event("input"));
      const br = document.getElementById("breakMinutes");
      br.value = "custom";
      br.dispatchEvent(new Event("change"));
      const b = document.getElementById("customBreakMinutes");
      b.value = "1";
      b.dispatchEvent(new Event("input"));
      document.getElementById("focusStartBtn").click();
      return true;
    })()`,
    "start focus session"
  );

  const focusState = await waitFor(async () => {
    const v = await popup.evaluate(`(await chrome.storage.sync.get({focus: {}})).focus`, "read focus");
    return v && v.active && v.state === "working" ? v : null;
  }, 10000).catch(() => null);
  check("focus session starts in the working phase", focusState !== null, JSON.stringify(focusState));
  check(
    "focus session keeps the custom work/break lengths",
    focusState && focusState.workMinutes === 1 && focusState.breakMinutes === 1,
    focusState ? `${focusState.workMinutes}/${focusState.breakMinutes}` : "n/a"
  );

  const focusRules = await waitFor(async () => {
    const r = await popup.evaluate(`await chrome.declarativeNetRequest.getDynamicRules()`, "focus rules");
    return Array.isArray(r) && r.some((x) => x.condition.regexFilter.includes("focus-example")) ? r : null;
  }, 10000).catch(() => null);
  check("focus site is blocked during the work phase", Array.isArray(focusRules), "rule installed");

  const focusPage = await openPage("https://focus-example.com/", {
    expect: (u) => u.includes("blocked.html"),
    timeout: 30000,
  });
  check("focus site shows the blocked page", focusPage.url.includes("blocked.html"), focusPage.url);
  check("focus blocked page carries mode=focus", /mode=focus/.test(focusPage.url), focusPage.url.slice(0, 160));

  const focusPageState = await focusPage.evaluate(
    `({
      hint: document.getElementById("hint").textContent,
      countdown: document.getElementById("countdown").textContent,
      unblockHidden: document.getElementById("unblock").hidden
    })`,
    "focus page state"
  );
  check(
    "focus blocked page shows a countdown and no unblock button",
    /Unlocks in/.test(focusPageState.countdown) && focusPageState.unblockHidden === true,
    JSON.stringify(focusPageState)
  );

  // Stopping the session releases the focus sites.
  await popup.evaluate(`document.getElementById("focusStopBtn").click()`, "stop focus");
  const focusStopped = await waitFor(async () => {
    const v = await popup.evaluate(`(await chrome.storage.sync.get({focus: {}})).focus`, "read stopped");
    return v && !v.active ? v : null;
  }, 10000).catch(() => null);
  check("stopping the session clears it", focusStopped !== null, JSON.stringify(focusStopped));

  const focusRulesAfter = await waitFor(async () => {
    const r = await popup.evaluate(`await chrome.declarativeNetRequest.getDynamicRules()`, "focus rules after");
    if (!Array.isArray(r)) return null;
    // Wait until the focus rule is actually gone.
    return r.some((x) => x.condition.regexFilter.includes("focus-example")) ? null : r;
  }, 15000).catch(() => null);
  check(
    "focus site is released after stopping",
    Array.isArray(focusRulesAfter) &&
      !focusRulesAfter.some((r) => r.condition.regexFilter.includes("focus-example")),
    JSON.stringify((focusRulesAfter || []).map((r) => r.condition.regexFilter))
  );
} catch (e) {
  check("test run completed", false, e.message);
} finally {
  if (client) client.close();
  try {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
  await new Promise((r) => logFile.end(r));

  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed.`);
  if (failed) {
    console.log("Log:", logPath);
    process.exitCode = 1;
  }
}
