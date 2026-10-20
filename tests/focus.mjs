// Focused regression tests for the focus-mode bugs that were reported:
//   1. the timer could be changed mid-session and messed with the timer
//   2. the site did not refresh when the break started
//   3. adding sites to focus mode sometimes did not block them
//   4. a site could still be used after being added to the blocked list
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cdpConnect, httpJson, waitFor, sleep } from "./cdp.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(TEST_DIR, "..", "extension");
const PORT = 9344;

const BROWSERS = [
  process.env.TEST_BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) {
  console.error("No browser found (set TEST_BROWSER)");
  process.exit(1);
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  [" + detail + "]" : ""}`);
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`TIMEOUT ${ms}ms: ${label}`)), ms)),
  ]);
}

const profile = path.join(TEST_DIR, "profile-focus");
rmSync(profile, { recursive: true, force: true });
const logPath = path.join(TEST_DIR, "chrome-focus.log");

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
    "attach"
  );
  await withTimeout(client.send("Runtime.enable", {}, sessionId), 10000, "Runtime.enable");
  // Wait for the document to be fully loaded - otherwise we would interact
  // with the page before its script attached its event listeners.
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

  const sw = await waitFor(async () => {
    const { targetInfos } = await client.send("Target.getTargets");
    return targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/background.js"));
  }, 30000);
  extId = new URL(sw.url).host;
  console.log("Extension ID:", extId);

  const popup = await openPage(`chrome-extension://${extId}/popup.html`);

  // ---------------------------------------------------------------------
  // BUG 3: adding sites to focus mode must actually block them.
  // ---------------------------------------------------------------------
  console.log("\n--- BUG 3: focus sites must block ---");
  for (const site of ["x.com", "reddit.com", "news.ycombinator.com"]) {
    await popup.evaluate(
      `(() => {
        const input = document.getElementById("focusDomainInput");
        input.value = "${site}";
        document.getElementById("focusAddForm").dispatchEvent(new Event("submit", { cancelable: true }));
        return true;
      })()`,
      "add focus site " + site
    );
  }
  const focusSites = await waitFor(async () => {
    const v = await popup.evaluate(`(await chrome.storage.sync.get({focus:{sites:[]}})).focus.sites`, "focus sites");
    return Array.isArray(v) && v.length === 3 ? v : null;
  }, 10000).catch(() => null);
  check(
    "all three focus sites are stored (incl. x.com)",
    Array.isArray(focusSites) && focusSites.includes("x.com") && focusSites.length === 3,
    JSON.stringify(focusSites)
  );

  // Start a session with a 2 minute work phase.
  await popup.evaluate(
    `(() => {
      const work = document.getElementById("workMinutes");
      work.value = "custom";
      work.dispatchEvent(new Event("change"));
      document.getElementById("customWorkMinutes").value = "2";
      document.getElementById("customWorkMinutes").dispatchEvent(new Event("input"));
      document.getElementById("focusStartBtn").click();
      return true;
    })()`,
    "start session"
  );
  const started = await waitFor(async () => {
    const v = await popup.evaluate(`(await chrome.storage.sync.get({focus:{}})).focus`, "focus");
    return v && v.active && v.state === "working" ? v : null;
  }, 10000).catch(() => null);
  check("focus session started", started !== null, JSON.stringify(started));

  // Every focus site must have a rule, including x.com.
  const focusRules = await waitFor(async () => {
    const r = await popup.evaluate(`await chrome.declarativeNetRequest.getDynamicRules()`, "rules");
    if (!Array.isArray(r)) return null;
    const has = (s) => r.some((x) => x.condition.regexFilter.includes(s.replace(/\./g, "\\.")));
    return has("x.com") && has("reddit.com") && has("news.ycombinator.com") ? r : null;
  }, 10000).catch(() => null);
  check(
    "a rule exists for every focus site (x.com included)",
    Array.isArray(focusRules),
    Array.isArray(focusRules) ? focusRules.map((r) => r.condition.regexFilter).join(" | ") : "missing rules"
  );

  // x.com must actually be blocked when navigated to.
  const xPage = await openPage("https://x.com/", {
    expect: (u) => u.includes("blocked.html"),
    timeout: 30000,
  });
  check("x.com shows the blocked page", xPage.url.includes("blocked.html"), xPage.url);

  // ---------------------------------------------------------------------
  // BUG 1: the timer must not be editable while a session runs, and the
  // popup must not clobber the running timer.
  // ---------------------------------------------------------------------
  console.log("\n--- BUG 1: timer is locked during a session ---");
  const locked = await popup.evaluate(
    `({
      workDisabled: document.getElementById("workMinutes").disabled,
      breakDisabled: document.getElementById("breakMinutes").disabled,
      customWorkDisabled: document.getElementById("customWorkMinutes").disabled
    })`,
    "locked state"
  );
  check(
    "work/break selects are disabled during a session",
    locked.workDisabled === true && locked.breakDisabled === true && locked.customWorkDisabled === true,
    JSON.stringify(locked)
  );

  // Changing the select must not corrupt the running session.
  const before = await popup.evaluate(`(await chrome.storage.sync.get({focus:{}})).focus`, "focus before");
  await popup.evaluate(
    `(() => {
      const work = document.getElementById("workMinutes");
      work.disabled = false; // force it, to simulate a hostile edit
      work.value = "50";
      work.dispatchEvent(new Event("change"));
      document.getElementById("focusStartBtn").click();
      return true;
    })()`,
    "try to change timer"
  );
  await sleep(1200);
  const after = await popup.evaluate(`(await chrome.storage.sync.get({focus:{}})).focus`, "focus after");
  check(
    "the running session's end time is not changed by a popup edit",
    after && before && after.endsAt === before.endsAt,
    `${before && before.endsAt} -> ${after && after.endsAt}`
  );
  check(
    "the running session stays active and working",
    after && after.active === true && after.state === "working",
    JSON.stringify(after && { active: after.active, state: after.state })
  );

  // The popup's own view of the focus list must not lose sites when it
  // re-renders (the bug that made x.com silently stop being blocked).
  await popup.evaluate(
    `(() => {
      const input = document.getElementById("focusDomainInput");
      input.value = "example.com";
      document.getElementById("focusAddForm").dispatchEvent(new Event("submit", { cancelable: true }));
      return true;
    })()`,
    "add another focus site mid-session"
  );
  const sitesAfterAdd = await waitFor(async () => {
    const v = await popup.evaluate(`(await chrome.storage.sync.get({focus:{sites:[]}})).focus.sites`, "sites");
    return Array.isArray(v) && v.includes("example.com") ? v : null;
  }, 8000).catch(() => null);
  check(
    "adding a site mid-session keeps the earlier sites",
    Array.isArray(sitesAfterAdd) && sitesAfterAdd.includes("x.com") && sitesAfterAdd.length === 4,
    JSON.stringify(sitesAfterAdd)
  );

  // ---------------------------------------------------------------------
  // BUG 2: when the break starts, the blocked page must take the user to
  // the site automatically.
  // ---------------------------------------------------------------------
  console.log("\n--- BUG 2: break releases the site automatically ---");
  // Fast-forward the session to the end of its work phase.
  await popup.evaluate(
    `await chrome.storage.sync.set({ focus: { ...(await chrome.storage.sync.get({focus:{}})).focus, endsAt: Date.now() + 1500 } })`,
    "shorten work phase"
  );
  await popup.evaluate(`await chrome.runtime.sendMessage({ type: "syncNow" })`, "sync");

  // The blocked page should notice the break and navigate to the site.
  let released = false;
  try {
    await waitFor(
      async () => {
        const u = await getTargetUrl(xPage.targetId);
        if (u && !u.includes("blocked.html")) {
          released = true;
          return u;
        }
        return null;
      },
      25000,
      500
    );
  } catch {
    // not released
  }
  const releasedUrl = await getTargetUrl(xPage.targetId);
  check(
    "the blocked page navigates to the site when the break starts",
    released === true,
    String(releasedUrl).slice(0, 120)
  );

  // The focus sites must be unblocked during the break.
  const breakState = await waitFor(async () => {
    const v = await popup.evaluate(`(await chrome.storage.sync.get({focus:{}})).focus`, "focus break");
    return v && v.state === "break" ? v : null;
  }, 15000).catch(() => null);
  check("the session moved into the break phase", breakState !== null, JSON.stringify(breakState && breakState.state));

  const breakRules = await waitFor(async () => {
    const r = await popup.evaluate(`await chrome.declarativeNetRequest.getDynamicRules()`, "break rules");
    if (!Array.isArray(r)) return null;
    return r.some((x) => x.condition.regexFilter.includes("x\\.com")) ? null : r;
  }, 10000).catch(() => null);
  check(
    "focus sites are not blocked during the break",
    Array.isArray(breakRules),
    Array.isArray(breakRules) ? "no focus rules" : "still blocked"
  );

  // x.com should now load normally.
  const xDuringBreak = await openPage("https://x.com/", {
    expect: (u) => !u.includes("blocked.html"),
    timeout: 30000,
  }).catch(() => null);
  check(
    "x.com is reachable during the break",
    xDuringBreak && !xDuringBreak.url.includes("blocked.html"),
    xDuringBreak ? xDuringBreak.url : "failed to open"
  );

  // ---------------------------------------------------------------------
  // BUG 4: an already open tab must be blocked when the site is added.
  // ---------------------------------------------------------------------
  console.log("\n--- BUG 4: open tabs are blocked without a manual reload ---");
  // Open a tab on a site that is not blocked yet, then block it.
  const openTab = await openPage("https://example.org/", {
    expect: (u) => u.includes("example.org"),
    timeout: 30000,
  });
  const urlBefore = await getTargetUrl(openTab.targetId);
  check("tab is open on the unblocked site", String(urlBefore).includes("example.org"), String(urlBefore));

  await popup.evaluate(
    `(() => {
      const input = document.getElementById("domainInput");
      input.value = "example.org";
      document.getElementById("addForm").dispatchEvent(new Event("submit", { cancelable: true }));
      return true;
    })()`,
    "block the open site"
  );

  let reloaded = false;
  try {
    await waitFor(
      async () => {
        const u = await getTargetUrl(openTab.targetId);
        if (u && u.includes("blocked.html")) {
          reloaded = true;
          return u;
        }
        return null;
      },
      20000,
      400
    );
  } catch {
    // not reloaded
  }
  const urlAfter = await getTargetUrl(openTab.targetId);
  check(
    "the open tab is reloaded into the blocked page automatically",
    reloaded === true,
    String(urlAfter).slice(0, 120)
  );

  // ---------------------------------------------------------------------
  // Extra: a site blocked while its tab is open must not stay usable.
  // ---------------------------------------------------------------------
  const openTab2 = await openPage("https://example.com/", {
    expect: (u) => u.includes("example.com"),
    timeout: 30000,
  });
  await popup.evaluate(
    `(() => {
      const input = document.getElementById("domainInput");
      input.value = "example.com";
      document.getElementById("addForm").dispatchEvent(new Event("submit", { cancelable: true }));
      return true;
    })()`,
    "block example.com"
  );
  let reloaded2 = false;
  try {
    await waitFor(
      async () => {
        const u = await getTargetUrl(openTab2.targetId);
        if (u && u.includes("blocked.html")) {
          reloaded2 = true;
          return u;
        }
        return null;
      },
      20000,
      400
    );
  } catch {
    // not reloaded
  }
  check("a second open tab is also reloaded into the blocked page", reloaded2 === true, String(await getTargetUrl(openTab2.targetId)).slice(0, 120));

  // The focus session should still be healthy after all of this.
  const finalFocus = await popup.evaluate(`(await chrome.storage.sync.get({focus:{}})).focus`, "final focus");
  check(
    "focus session survived the whole run with all sites intact",
    finalFocus && Array.isArray(finalFocus.sites) && finalFocus.sites.length === 4,
    JSON.stringify(finalFocus && finalFocus.sites)
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
