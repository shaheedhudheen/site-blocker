// End-to-end test for the Firefox build.
//
// Firefox is driven through geckodriver (WebDriver), because Firefox has no
// CDP. geckodriver is started with --allow-system-access so that WebDriver may
// open moz-extension:// pages. The add-on is installed temporarily, which is
// also how you would try it from about:debugging.
//
// Requirements (the test skips with a message if they are missing):
//   TEST_FIREFOX     path to firefox.exe
//   TEST_GECKODRIVER path to geckodriver.exe (or geckodriver on PATH)
//
// Example:
//   set TEST_FIREFOX=C:\Firefox\firefox.exe
//   set TEST_GECKODRIVER=C:\tools\geckodriver.exe
//   node tests/firefox.mjs
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, "..");
const PORT = 9348;
const BASE = `http://127.0.0.1:${PORT}`;
const ADDON_ID = "site-blocker@shaheedhudheen.github.io";

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  [" + detail + "]" : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const firefox =
  [process.env.TEST_FIREFOX, "C:\\Program Files\\Mozilla Firefox\\firefox.exe"].filter(Boolean).find((p) => existsSync(p)) ||
  null;

const geckodriver =
  [
    process.env.TEST_GECKODRIVER,
    "C:\\Program Files\\geckodriver\\geckodriver.exe",
  ]
    .filter(Boolean)
    .find((p) => existsSync(p)) || null;

if (!firefox) {
  console.log("SKIP: Firefox not found. Set TEST_FIREFOX to firefox.exe to run this test.");
  process.exit(0);
}
if (!geckodriver) {
  console.log("SKIP: geckodriver not found. Set TEST_GECKODRIVER to geckodriver.exe to run this test.");
  console.log("      Download: https://github.com/mozilla/geckodriver/releases");
  process.exit(0);
}

// Build the package that would actually be submitted, so the test covers the
// Firefox manifest transformation as well as the extension code.
const built = spawnSync(process.execPath, [path.join(ROOT, "build.mjs"), "firefox"], { encoding: "utf8" });
if (built.status !== 0) {
  check("the Firefox package builds", false, (built.stderr || "").trim());
  process.exit(1);
}
const version = JSON.parse(readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8")).version;
const xpi = path.join(ROOT, "dist", `site-blocker-firefox-${version}.zip`);
check("the Firefox package builds", existsSync(xpi), path.relative(ROOT, xpi));

function profileDirs() {
  return readdirSync(os.tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("rust_mozprofile"))
    .map((entry) => path.join(os.tmpdir(), entry.name));
}

async function rpc(method, url, body) {
  const response = await fetch(BASE + url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

function killLeftoverFirefox() {
  if (process.platform !== "win32") return;
  const ps =
    "Get-CimInstance Win32_Process -Filter \"Name='firefox.exe'\" | " +
    `Where-Object { $_.ExecutablePath -eq '${firefox.replace(/'/g, "''")}' } | ` +
    "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
  spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" });
}

const driver = spawn(geckodriver, ["--port", String(PORT), "--allow-system-access", "--log", "error"], {
  stdio: ["ignore", "ignore", "pipe"],
});
driver.stderr.on("data", () => {});

let sessionId = null;
let profile = null;

try {
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    try {
      ready = (await rpc("GET", "/status")).status === 200;
    } catch {
      // not up yet
    }
    if (!ready) await sleep(250);
  }
  if (!ready) throw new Error("geckodriver did not start");

  const before = new Set(profileDirs());
  const created = await rpc("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "firefox",
        "moz:firefoxOptions": { binary: firefox, args: ["-headless"] },
      },
    },
  });
  if (created.status !== 200) {
    throw new Error("could not start Firefox: " + JSON.stringify(created.data).slice(0, 500));
  }
  sessionId = created.data.value.sessionId;

  const installed = await rpc("POST", `/session/${sessionId}/moz/addon/install`, {
    path: xpi,
    temporary: true,
  });
  check(
    "the add-on installs in Firefox",
    installed.status === 200 && installed.data.value === ADDON_ID,
    JSON.stringify(installed.data).slice(0, 200)
  );

  // Find the profile geckodriver made and read the add-on's moz-extension UUID.
  // The preference is flushed to prefs.js shortly after the add-on starts, so
  // poll for it instead of reading once.
  for (let i = 0; i < 40 && !profile; i++) {
    profile = profileDirs().find((dir) => !before.has(dir)) || null;
    if (!profile) await sleep(250);
  }
  if (!profile) throw new Error("could not find the Firefox profile");

  let uuid = null;
  for (let i = 0; i < 60 && !uuid; i++) {
    let prefs = "";
    try {
      prefs = readFileSync(path.join(profile, "prefs.js"), "utf8");
    } catch {
      prefs = "";
    }
    const uuids = prefs.split(/\r?\n/).find((line) => line.includes("webextensions.uuids"));
    const raw = uuids && uuids.match(/webextensions\.uuids", "(.*)"\);/);
    if (raw) {
      try {
        uuid = JSON.parse(JSON.parse(`"${raw[1]}"`))[ADDON_ID] || null;
      } catch {
        uuid = null;
      }
    }
    if (!uuid) await sleep(250);
  }
  if (!uuid) throw new Error("could not read the extension UUID");
  const origin = `moz-extension://${uuid}`;

  const navigate = async (url) => {
    const result = await rpc("POST", `/session/${sessionId}/url`, { url });
    if (result.status !== 200) throw new Error(`navigate ${url}: ${JSON.stringify(result.data).slice(0, 300)}`);
  };
  const currentUrl = async () => (await rpc("GET", `/session/${sessionId}/url`)).data.value;
  const evaluate = async (script) => {
    const result = await rpc("POST", `/session/${sessionId}/execute/sync`, { script, args: [] });
    if (result.status !== 200) {
      throw new Error("script failed: " + JSON.stringify(result.data).slice(0, 400));
    }
    return result.data.value;
  };

  // --- the popup -------------------------------------------------------------
  console.log("\n--- the popup ---");
  await navigate(`${origin}/popup.html`);
  await sleep(1200);
  check("the popup loads", (await evaluate("return document.title;")) === "Site Blocker");
  check(
    "the extension has site access",
    (await evaluate("return browser.permissions.contains({ origins: ['<all_urls>'] });")) === true
  );

  // --- adding a site through the real UI ------------------------------------
  console.log("\n--- blocking a site ---");
  await evaluate(`
    const input = document.getElementById("domainInput");
    input.value = "example.com";
    document.getElementById("addForm").dispatchEvent(new Event("submit", { cancelable: true }));
    return true;
  `);
  const stored = await evaluate(
    "return browser.storage.sync.get({ blockedSites: [] }).then((v) => JSON.stringify(v.blockedSites));"
  );
  check("the popup stores and normalizes the domain", stored === '["example.com"]', stored);

  // The service worker/event page installs the rules asynchronously.
  const ruleMatchesSite = (json) => {
    try {
      return JSON.parse(json).some((filter) => new RegExp(filter).test("https://example.com/"));
    } catch {
      return false;
    }
  };
  let rule = "[]";
  for (let i = 0; i < 40 && !ruleMatchesSite(rule); i++) {
    rule = await evaluate(`
      return browser.declarativeNetRequest.getDynamicRules().then((rules) =>
        JSON.stringify(rules.map((r) => r.condition.regexFilter))
      );
    `);
    if (!ruleMatchesSite(rule)) await sleep(250);
  }
  check("a declarativeNetRequest rule is installed", ruleMatchesSite(rule), rule);

  const status = await evaluate(
    "return browser.runtime.sendMessage({ type: 'getRuleStatus' }).then((s) => JSON.stringify(s));"
  );
  const parsed = JSON.parse(status);
  check("the rule status is healthy", parsed.ok === true && parsed.expected === 1 && parsed.installed === 1, status);

  // --- navigation is redirected --------------------------------------------
  console.log("\n--- the blocked page ---");
  await navigate("https://example.com/");
  await sleep(2500);
  const blockedUrl = await currentUrl();
  check(
    "the site is redirected to the blocked page",
    blockedUrl.startsWith(`${origin}/blocked.html?url=https://example.com/`),
    blockedUrl
  );
  check(
    "the blocked page names the site",
    (await evaluate("return document.getElementById('siteName').textContent;")) === "example.com"
  );

  // --- unblocking releases the site ----------------------------------------
  console.log("\n--- unblocking ---");
  await evaluate("document.getElementById('unblock').click(); return true;");
  await sleep(3000);
  const afterUnblock = await currentUrl();
  check("the site is reachable again after unblocking", afterUnblock.startsWith("https://example.com/"), afterUnblock);

  // Back to an extension page: browser.* only exists there.
  await navigate(`${origin}/popup.html`);
  await sleep(800);
  let rulesAfter = 1;
  for (let i = 0; i < 40 && rulesAfter !== 0; i++) {
    rulesAfter = await evaluate("return browser.declarativeNetRequest.getDynamicRules().then((r) => r.length);");
    if (rulesAfter !== 0) await sleep(250);
  }
  check("unblocking removes the rule", rulesAfter === 0, String(rulesAfter));

  // --- the permission page --------------------------------------------------
  console.log("\n--- the permission page ---");
  await navigate(`${origin}/grant.html`);
  await sleep(1000);
  const grantTitle = await evaluate("return document.getElementById('title').textContent;");
  check("the permission page renders", /access/i.test(grantTitle), grantTitle);
} catch (error) {
  check("the Firefox test run completes", false, error.message);
} finally {
  if (sessionId) {
    await rpc("DELETE", `/session/${sessionId}`).catch(() => {});
    await sleep(1500);
  }
  driver.kill();
  await sleep(500);
  if (profile) {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    } catch {
      killLeftoverFirefox();
      await sleep(500);
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      } catch {
        // leaving the temp profile behind is not worth failing the run
      }
    }
  }
}

const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed.`);
process.exit(failed ? 1 : 0);
