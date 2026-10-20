// Test harness: launches a headless Chromium (Edge preferred - branded Chrome
// ignores --load-extension) with the probe extension, waits for the probe to
// finish, then reads its results over CDP from chrome.storage.local.
//
// Usage: node run.mjs [a|b]   (a = with host_permissions, b = without)
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cdpConnect, evalInTarget, httpJson, waitFor, sleep } from "./cdp.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(TEST_DIR, "probe");
const BUILT = path.join(TEST_DIR, "built");
const HTTP_PORT = 8765;
const CDP_PORT = 9444;

const BROWSERS = [
  process.env.TEST_BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) {
  console.error("No Chromium based browser found. Set TEST_BROWSER.");
  process.exit(1);
}
console.log("Browser:", browser);

// --- Build probe extension copies -------------------------------------------
rmSync(BUILT, { recursive: true, force: true });
for (const [run, useHostPermissions] of [
  ["a", true],
  ["b", false],
]) {
  const dir = path.join(BUILT, run);
  mkdirSync(dir, { recursive: true });
  for (const f of ["background.js", "blocked.html", "blocked-render.js"]) {
    copyFileSync(path.join(PROBE, f), path.join(dir, f));
  }
  const manifest = {
    manifest_version: 3,
    name: "DNR Probe " + run.toUpperCase(),
    version: "1.0.0",
    permissions: ["declarativeNetRequest", "storage", "tabs"],
    background: { service_worker: "background.js" },
    web_accessible_resources: [{ resources: ["blocked.html"], matches: ["<all_urls>"], use_dynamic_url: false }],
  };
  if (useHostPermissions) manifest.host_permissions = ["<all_urls>"];
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

// --- Local HTTP server (control page; /report kept as legacy diagnostic) ----
const server = createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${HTTP_PORT}`);
  if (u.pathname === "/page") {
    res.setHeader("content-type", "text/html");
    res.end("<h1>LOCAL PAGE</h1>");
    return;
  }
  if (u.pathname === "/report") {
    const raw = u.searchParams.get("data") || "";
    writeFileSync(path.join(TEST_DIR, "report-raw.txt"), raw);
    console.log("(legacy /report endpoint hit; raw saved to report-raw.txt)");
    res.end("ok");
    return;
  }
  res.statusCode = 404;
  res.end("nope");
});
await new Promise((r) => server.listen(HTTP_PORT, "127.0.0.1", r));

// --- Read probe state over CDP ----------------------------------------------
async function readProbeState() {
  const version = await waitFor(() => httpJson(`http://127.0.0.1:${CDP_PORT}/json/version`), 30000);
  const client = await cdpConnect(version.webSocketDebuggerUrl);
  let last = null;
  try {
    const sw = await waitFor(async () => {
      const { targetInfos } = await client.send("Target.getTargets");
      return targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/background.js"));
    }, 30000);
    const { sessionId } = await client.send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
    const start = Date.now();
    while (Date.now() - start < 180000) {
      const raw = await evalInTarget(client, sessionId, `JSON.stringify(await chrome.storage.local.get(null))`).catch(
        () => null
      );
      if (raw) {
        const state = JSON.parse(raw);
        if (Array.isArray(state.probeProgress)) last = state;
        if (state.probeComplete) return state;
      }
      await sleep(1000);
    }
    return last;
  } finally {
    client.close();
  }
}

// --- Run one probe copy -------------------------------------------------------
async function runProbe(runId, label) {
  const profile = path.join(TEST_DIR, "profile-" + runId);
  rmSync(profile, { recursive: true, force: true });
  const dir = path.join(BUILT, runId);
  const logPath = path.join(TEST_DIR, `chrome-${runId}.log`);
  const args = [
    "--headless",
    "--user-data-dir=" + profile,
    "--disable-extensions-except=" + dir,
    "--load-extension=" + dir,
    "--remote-debugging-port=" + CDP_PORT,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-gpu",
  ];
  console.log(`\n=== RUN ${runId.toUpperCase()}: ${label} ===`);
  const child = spawn(browser, args, { stdio: ["ignore", "ignore", "pipe"] });
  const logFile = createWriteStream(logPath);
  child.stderr.pipe(logFile);

  let state = null;
  try {
    state = await readProbeState();
  } catch (e) {
    console.log("Failed to read probe state:", e.message);
  }

  spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  await new Promise((r) => logFile.end(r));

  if (!state) {
    console.log("NO RESULT. Last Chrome stderr lines:");
    console.log(readFileSync(logPath, "utf8").split(/\r?\n/).slice(-20).join("\n"));
    return null;
  }
  console.log(JSON.stringify(state, null, 2));
  return state;
}

const only = process.argv[2];
const runs = [
  ["a", "with host_permissions"],
  ["b", "without host_permissions"],
].filter(([id]) => !only || only === id);

for (const [id, label] of runs) {
  await runProbe(id, label);
}

server.close();
console.log("\nDone.");
