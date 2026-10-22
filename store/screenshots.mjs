// Capture the store screenshots from the real extension.
//
//   node store/screenshots.mjs
//
// Loads the extension in a headless browser, drives the popup like a user
// would, and saves PNGs of the popup and the blocked page into
// store/screenshots/. Nothing is faked: the images show the extension
// running.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cdpConnect, httpJson, waitFor, sleep } from "../tests/cdp.mjs";

const STORE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(STORE_DIR, "..");
const EXT_DIR = path.join(ROOT, "extension");
const OUT_DIR = path.join(STORE_DIR, "screenshots");
const PORT = 9352;

const browser = [
  process.env.TEST_BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
].filter(Boolean).find((p) => existsSync(p));
if (!browser) {
  console.error("No browser found (set TEST_BROWSER)");
  process.exit(1);
}

const profile = path.join(ROOT, "tests", "profile-shots");
rmSync(profile, { recursive: true, force: true });
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

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
    "--force-color-profile=srgb",
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);
const logFile = createWriteStream(path.join(ROOT, "tests", "chrome-shots.log"));
child.stderr.pipe(logFile);

let client = null;

async function openPage(url, { expect = (u) => u === url, timeout = 30000 } = {}) {
  const { targetId } = await client.send("Target.createTarget", { url });
  const finalUrl = await waitFor(async () => {
    const { targetInfos } = await client.send("Target.getTargets");
    const t = targetInfos.find((x) => x.targetId === targetId);
    return t && t.url && expect(t.url) ? t.url : null;
  }, timeout);
  const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
  await client.send("Runtime.enable", {}, sessionId);
  await waitFor(async () => {
    const r = await client.send(
      "Runtime.evaluate",
      { expression: "document.readyState === 'complete' && location.href", returnByValue: true },
      sessionId
    );
    return typeof r.result?.value === "string" && r.result.value !== "about:blank" ? r.result.value : null;
  }, 20000);
  const evaluate = async (expression, label = "eval") => {
    const r = await client.send(
      "Runtime.evaluate",
      { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true },
      sessionId
    );
    if (r.exceptionDetails) {
      throw new Error(`${label}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    }
    return r.result?.value;
  };
  return { targetId, sessionId, url: finalUrl, evaluate };
}

// Resize the page and save a png of it.
async function shoot(page, file, { width, height, scale = 1 }) {
  await page.sessionId && (await client.send("Page.enable", {}, page.sessionId));
  await client.send(
    "Emulation.setDeviceMetricsOverride",
    { width, height, deviceScaleFactor: scale, mobile: false },
    page.sessionId
  );
  // Let the layout settle after the resize.
  await sleep(400);
  const { data } = await client.send("Page.captureScreenshot", { format: "png" }, page.sessionId);
  const out = path.join(OUT_DIR, file);
  writeFileSync(out, Buffer.from(data, "base64"));
  console.log("wrote", path.relative(ROOT, out));
}

try {
  const version = await waitFor(() => httpJson(`http://127.0.0.1:${PORT}/json/version`), 30000);
  console.log("Browser:", version.Browser);
  client = await cdpConnect(version.webSocketDebuggerUrl);
  const sw = await waitFor(async () => {
    const { targetInfos } = await client.send("Target.getTargets");
    return targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/background.js"));
  }, 30000);
  const extId = new URL(sw.url).host;

  // --- The popup with a blocklist and a focus session. ---------------------
  const popup = await openPage(`chrome-extension://${extId}/popup.html`);
  await sleep(600);

  // Watch for uncaught errors while we drive the popup.
  await popup.evaluate(
    `(() => {
      window.__errs = [];
      window.addEventListener("error", (e) => window.__errs.push("error: " + e.message));
      window.addEventListener("unhandledrejection", (e) =>
        window.__errs.push("rejection: " + ((e.reason && e.reason.message) || e.reason))
      );
      return true;
    })()`,
    "install error hooks"
  );

  // Seed the list the way a user would: through the popup's own forms.
  // Every step waits for the state to land instead of guessing with a
  // fixed delay, so the screenshots are always of a settled popup.
  const addBlocklistSite = async (site) => {
    await popup.evaluate(
      `(() => {
        const input = document.getElementById("domainInput");
        input.value = ${JSON.stringify(site)};
        document.getElementById("addForm").dispatchEvent(new Event("submit", { cancelable: true }));
        return true;
      })()`,
      "add " + site
    );
  };
  const addFocusSite = async (site) => {
    await popup.evaluate(
      `(() => {
        const input = document.getElementById("focusDomainInput");
        input.value = ${JSON.stringify(site)};
        document.getElementById("focusAddForm").dispatchEvent(new Event("submit", { cancelable: true }));
        return true;
      })()`,
      "add focus site " + site
    );
  };

  for (const site of ["youtube.com", "reddit.com", "news.ycombinator.com", "twitter.com"]) {
    await addBlocklistSite(site);
  }
  await waitFor(async () => {
    const v = await popup.evaluate(`(await chrome.storage.sync.get({blockedSites:[]})).blockedSites`, "sites");
    return Array.isArray(v) && v.length === 4 ? v : null;
  }, 15000);

  for (const site of ["reddit.com", "twitter.com"]) {
    await addFocusSite(site);
  }
  await waitFor(async () => {
    const v = await popup.evaluate(`(await chrome.storage.sync.get({focus:{sites:[]}})).focus.sites`, "focus sites");
    return Array.isArray(v) && v.length === 2 ? v : null;
  }, 15000);

  // Make one entry a timed block so the badge shows up.
  await popup.evaluate(
    `(() => {
      const input = document.getElementById("domainInput");
      input.value = "instagram.com";
      document.querySelector('#durationOptions .chip[data-minutes="30"]').click();
      document.getElementById("addForm").dispatchEvent(new Event("submit", { cancelable: true }));
      return true;
    })()`,
    "add timed block"
  );
  await waitFor(async () => {
    const v = await popup.evaluate(`(await chrome.storage.sync.get({timedBlocks:{}})).timedBlocks`, "timed");
    return v && v["instagram.com"] ? v : null;
  }, 15000);
  await sleep(300);

  const errors = await popup.evaluate(`window.__errs`, "errs");
  if (errors && errors.length) {
    console.error("  page errors:", JSON.stringify(errors));
    throw new Error("the popup reported errors while being driven");
  }
  const state = await popup.evaluate(
    `({
      blocked: (await chrome.storage.sync.get({blockedSites:[]})).blockedSites,
      timed: Object.keys((await chrome.storage.sync.get({timedBlocks:{}})).timedBlocks),
      focus: (await chrome.storage.sync.get({focus:{sites:[]}})).focus.sites,
    })`,
    "state"
  );
  console.log("  seeded state:", JSON.stringify(state));

  const popupHeight = await popup.evaluate(
    `Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)`,
    "popup height"
  );
  await shoot(popup, "popup.png", { width: 320, height: Math.ceil(popupHeight) + 4, scale: 2 });

  // --- The blocked page. ----------------------------------------------------
  const blocked = await openPage("https://youtube.com/", {
    expect: (u) => u.includes("blocked.html"),
    timeout: 30000,
  });
  await sleep(700);
  await shoot(blocked, "blocked.png", { width: 1280, height: 800, scale: 1 });

  console.log("\nScreenshots written to", path.relative(ROOT, OUT_DIR));
} catch (e) {
  console.error("Failed:", e.message);
  process.exitCode = 1;
} finally {
  if (client) client.close();
  try {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
  await new Promise((r) => logFile.end(r));
  // The browser may still be releasing its files, so a failed cleanup here
  // must not fail the run.
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch (e) {
    console.warn("Could not remove the temporary browser profile:", e.code || e.message);
  }
}
