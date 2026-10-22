// Edge cases around the focus-mode fixes:
//   - the break phase is blocked again when the next work round starts
//   - a session with a fixed number of rounds ends by itself
//   - stopping a session releases the focus sites
//   - a timed block and a focus site for the same domain behave sanely
//   - the blocked page survives the extension's global off switch
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cdpConnect, httpJson, waitFor, sleep } from "./cdp.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(TEST_DIR, "..", "extension");
const PORT = 9346;

const browser = [
  process.env.TEST_BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean).find((p) => existsSync(p));
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

const profile = path.join(TEST_DIR, "profile-edge");
rmSync(profile, { recursive: true, force: true });
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
const logFile = createWriteStream(path.join(TEST_DIR, "chrome-edge.log"));
child.stderr.pipe(logFile);

let client = null;

async function getTargetUrl(targetId) {
  const { targetInfos } = await client.send("Target.getTargets");
  const t = targetInfos.find((x) => x.targetId === targetId);
  return t ? t.url : null;
}

async function openPage(url, { expect = (u) => u === url, timeout = 30000 } = {}) {
  const { targetId } = await withTimeout(client.send("Target.createTarget", { url }), 15000, "createTarget");
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
  const extId = new URL(sw.url).host;
  const popup = await openPage(`chrome-extension://${extId}/popup.html`);

  // --- The next work round re-blocks the focus sites. ----------------------
  console.log("\n--- next work round re-blocks ---");
  await popup.evaluate(
    `(() => {
      const input = document.getElementById("focusDomainInput");
      input.value = "round-test.com";
      document.getElementById("focusAddForm").dispatchEvent(new Event("submit", { cancelable: true }));
      return true;
    })()`,
    "add focus site"
  );
  await waitFor(async () => {
    const v = await popup.evaluate(`(await chrome.storage.sync.get({focus:{sites:[]}})).focus.sites`, "sites");
    return Array.isArray(v) && v.length ? v : null;
  }, 10000);

  // Start a session whose work phase is 1 second, so the break is short too.
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
    "start session"
  );
  const working = await waitFor(async () => {
    const v = await popup.evaluate(`(await chrome.storage.sync.get({focus:{}})).focus`, "focus");
    return v && v.active && v.state === "working" ? v : null;
  }, 10000).catch(() => null);
  check("session is in the working phase", working !== null, JSON.stringify(working && working.state));

  // Wait for the work phase to end (1 minute is too long - fast-forward).
  await popup.evaluate(
    `await chrome.storage.sync.set({ focus: { ...(await chrome.storage.sync.get({focus:{}})).focus, endsAt: Date.now() + 1200 } })`,
    "fast forward"
  );
  await popup.evaluate(`await chrome.runtime.sendMessage({ type: "syncNow" })`, "sync");

  const inBreak = await waitFor(async () => {
    const v = await popup.evaluate(`(await chrome.storage.sync.get({focus:{}})).focus`, "focus break");
    return v && v.state === "break" ? v : null;
  }, 15000).catch(() => null);
  check("session moved to the break phase", inBreak !== null, JSON.stringify(inBreak && inBreak.state));

  const breakUnblocked = await waitFor(async () => {
    const r = await popup.evaluate(`await chrome.declarativeNetRequest.getDynamicRules()`, "rules");
    if (!Array.isArray(r)) return null;
    return r.some((x) => x.condition.regexFilter.includes("round-test")) ? null : r;
  }, 12000).catch(() => null);
  check("focus site is unblocked during the break", Array.isArray(breakUnblocked), "rules cleared");

  // End the break so the next work round starts and re-blocks the site.
  await popup.evaluate(
    `await chrome.storage.sync.set({ focus: { ...(await chrome.storage.sync.get({focus:{}})).focus, state: "working", endsAt: Date.now() + 60000 } })`,
    "force next work round"
  );
  await popup.evaluate(`await chrome.runtime.sendMessage({ type: "syncNow" })`, "sync");

  const reblocked = await waitFor(async () => {
    const r = await popup.evaluate(`await chrome.declarativeNetRequest.getDynamicRules()`, "rules");
    if (!Array.isArray(r)) return null;
    return r.some((x) => x.condition.regexFilter.includes("round-test")) ? r : null;
  }, 12000).catch(() => null);
  check("focus site is blocked again in the next work round", Array.isArray(reblocked), "rule restored");

  // --- Stopping a session releases the focus sites. -------------------------
  console.log("\n--- stopping releases sites ---");
  await popup.evaluate(`document.getElementById("focusStopBtn").click()`, "stop");
  const stopped = await waitFor(async () => {
    const v = await popup.evaluate(`(await chrome.storage.sync.get({focus:{}})).focus`, "focus");
    return v && !v.active ? v : null;
  }, 10000).catch(() => null);
  check("session stopped", stopped !== null, JSON.stringify(stopped && stopped.active));

  const released = await waitFor(async () => {
    const r = await popup.evaluate(`await chrome.declarativeNetRequest.getDynamicRules()`, "rules");
    if (!Array.isArray(r)) return null;
    return r.some((x) => x.condition.regexFilter.includes("round-test")) ? null : r;
  }, 12000).catch(() => null);
  check("focus site released after stopping", Array.isArray(released), "rules cleared");

  // --- The global off switch clears every rule. ----------------------------
  console.log("\n--- global off switch ---");
  await popup.evaluate(
    `(() => {
      const input = document.getElementById("domainInput");
      input.value = "switch-test.com";
      document.getElementById("addForm").dispatchEvent(new Event("submit", { cancelable: true }));
      return true;
    })()`,
    "add site"
  );
  await waitFor(async () => {
    const r = await popup.evaluate(`await chrome.declarativeNetRequest.getDynamicRules()`, "rules");
    return Array.isArray(r) && r.some((x) => x.condition.regexFilter.includes("switch-test")) ? r : null;
  }, 10000).catch(() => null);

  await popup.evaluate(
    `(() => {
      const t = document.getElementById("enabledToggle");
      t.checked = false;
      t.dispatchEvent(new Event("change"));
      return true;
    })()`,
    "toggle off"
  );
  const allOff = await waitFor(async () => {
    const r = await popup.evaluate(`await chrome.declarativeNetRequest.getDynamicRules()`, "rules");
    if (!Array.isArray(r)) return null;
    return r.length === 0 ? r : null;
  }, 12000).catch(() => null);
  check("global off switch removes all rules", Array.isArray(allOff), "no rules");

  await popup.evaluate(
    `(() => {
      const t = document.getElementById("enabledToggle");
      t.checked = true;
      t.dispatchEvent(new Event("change"));
      return true;
    })()`,
    "toggle on"
  );
  const backOn = await waitFor(async () => {
    const r = await popup.evaluate(`await chrome.declarativeNetRequest.getDynamicRules()`, "rules");
    if (!Array.isArray(r)) return null;
    return r.some((x) => x.condition.regexFilter.includes("switch-test")) ? r : null;
  }, 12000).catch(() => null);
  check("switching back on restores the rules", Array.isArray(backOn), "rules restored");

  // --- A timed block and a focus site for the same domain. -----------------
  console.log("\n--- timed block vs focus site ---");
  await popup.evaluate(
    `(() => {
      const input = document.getElementById("domainInput");
      input.value = "both.com";
      document.querySelector('#durationOptions .chip[data-minutes="15"]').click();
      document.getElementById("addForm").dispatchEvent(new Event("submit", { cancelable: true }));
      return true;
    })()`,
    "add timed block"
  );
  const timedState = await waitFor(async () => {
    const v = await popup.evaluate(`(await chrome.storage.sync.get({timedBlocks:{}})).timedBlocks`, "timed");
    return v && v["both.com"] ? v : null;
  }, 10000).catch(() => null);
  check("timed block stored", timedState !== null, JSON.stringify(timedState));

  const notPermanent = await popup.evaluate(
    `(await chrome.storage.sync.get({blockedSites: []})).blockedSites.includes("both.com")`,
    "permanent check"
  );
  check("a timed block is not also a permanent block", notPermanent === false, String(notPermanent));

  const timedRule = await waitFor(async () => {
    const r = await popup.evaluate(`await chrome.declarativeNetRequest.getDynamicRules()`, "rules");
    if (!Array.isArray(r)) return null;
    return r.find((x) => x.condition.regexFilter.includes("both\\.com")) || null;
  }, 10000).catch(() => null);
  check(
    "the timed rule is marked as timed and carries an expiry",
    !!timedRule &&
      timedRule.action.redirect.regexSubstitution.includes("mode=timed") &&
      timedRule.action.redirect.regexSubstitution.includes("until="),
    JSON.stringify(timedRule && timedRule.action.redirect.regexSubstitution)
  );

  // The blocked page for it should offer "cancel timer", not "unblock".
  const timedPage = await openPage("https://both.com/", {
    expect: (u) => u.includes("blocked.html"),
    timeout: 30000,
  });
  const timedLabel = await timedPage.evaluate(
    `document.getElementById("unblock").textContent`,
    "unblock label"
  );
  check("timed site offers to cancel the timer", /Cancel timer/.test(timedLabel), timedLabel);

  // --- A session with a fixed number of rounds ends by itself. -------------
  console.log("\n--- a fixed number of rounds ends the session ---");
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
      const r = document.getElementById("focusRounds");
      r.value = "1";
      r.dispatchEvent(new Event("change"));
      document.getElementById("focusStartBtn").click();
      return true;
    })()`,
    "start 1-round session"
  );

  const roundsStarted = await waitFor(async () => {
    const v = await popup.evaluate(`(await chrome.storage.sync.get({focus:{}})).focus`, "focus");
    return v && v.active && v.state === "working" && v.rounds === 1 ? v : null;
  }, 10000).catch(() => null);
  check("session started with 1 round", roundsStarted !== null, JSON.stringify(roundsStarted && roundsStarted.rounds));

  const locked = await popup.evaluate(
    `({
      rounds: document.getElementById("focusRounds").disabled,
      custom: document.getElementById("customRounds").disabled,
    })`,
    "rounds locked"
  );
  check(
    "the rounds control is locked during a session",
    locked.rounds === true && locked.custom === true,
    JSON.stringify(locked)
  );

  const statusText = await popup.evaluate(`document.getElementById("focusStatus").textContent`, "status");
  check("the popup shows the round counter", /round 1\/1/.test(statusText), statusText);

  // Push the work phase into the break.
  await popup.evaluate(
    `await chrome.storage.sync.set({ focus: { ...(await chrome.storage.sync.get({focus:{}})).focus, endsAt: Date.now() - 1 } })`,
    "fast forward work"
  );
  const roundsBreak = await waitFor(async () => {
    const v = await popup.evaluate(`(await chrome.storage.sync.get({focus:{}})).focus`, "focus break");
    return v && v.state === "break" ? v : null;
  }, 15000).catch(() => null);
  check("the session reached the break after the first round", roundsBreak !== null, JSON.stringify(roundsBreak && roundsBreak.state));

  // Push the break over the end: the session must stop itself.
  await popup.evaluate(
    `await chrome.storage.sync.set({ focus: { ...(await chrome.storage.sync.get({focus:{}})).focus, endsAt: Date.now() - 1 } })`,
    "fast forward break"
  );
  const roundsEnded = await waitFor(async () => {
    const v = await popup.evaluate(`(await chrome.storage.sync.get({focus:{}})).focus`, "focus ended");
    return v && !v.active ? v : null;
  }, 15000).catch(() => null);
  check("the session ended by itself after the last round", roundsEnded !== null, JSON.stringify(roundsEnded && roundsEnded.state));

  const releasedAfterEnd = await waitFor(async () => {
    const r = await popup.evaluate(`await chrome.declarativeNetRequest.getDynamicRules()`, "rules");
    if (!Array.isArray(r)) return null;
    return r.some((x) => x.condition.regexFilter.includes("round-test")) ? null : r;
  }, 12000).catch(() => null);
  check("the focus site is released when the session ends", Array.isArray(releasedAfterEnd), "rules cleared");

  // --- The popup warns when blocking is not actually working. --------------
  console.log("\n--- rule health warning ---");
  const healthy = await popup.evaluate(
    `(async () => {
      const status = await chrome.runtime.sendMessage({ type: "getRuleStatus" });
      return {
        status,
        hidden: document.getElementById("ruleWarning").hidden,
        text: document.getElementById("ruleWarning").textContent,
      };
    })()`,
    "rule status"
  );
  check(
    "the reported rule count matches what should be installed",
    healthy.status.ok === true && healthy.status.installed === healthy.status.expected,
    JSON.stringify(healthy.status)
  );
  check("no warning while blocking works", healthy.hidden === true, healthy.text);

  // Remove the rules behind the extension's back, the way a broken browser
  // profile would, and check that the popup notices within a few seconds.
  await popup.evaluate(
    `await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id),
    })`,
    "remove rules"
  );
  const warned = await waitFor(async () => {
    const v = await popup.evaluate(
      `({
        hidden: document.getElementById("ruleWarning").hidden,
        text: document.getElementById("ruleWarning").textContent,
      })`,
      "warning"
    );
    return v && v.hidden === false ? v : null;
  }, 15000).catch(() => null);
  check(
    "a warning appears when the blocking rules are missing",
    warned !== null && /isn't working|no blocking rules/i.test(warned.text),
    warned ? warned.text : "no warning"
  );

  // Syncing again repairs them.
  await popup.evaluate(`await chrome.runtime.sendMessage({ type: "syncNow" })`, "resync");
  const repaired = await waitFor(async () => {
    const r = await popup.evaluate(`await chrome.declarativeNetRequest.getDynamicRules()`, "rules");
    return Array.isArray(r) && r.length ? r : null;
  }, 12000).catch(() => null);
  check("syncing rebuilds missing rules", Array.isArray(repaired), "rules restored");
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
