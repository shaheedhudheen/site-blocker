// Build the extension into zips that can be uploaded to the Chrome Web Store
// and to addons.mozilla.org (AMO).
//
//   node build.mjs            -> dist/site-blocker-<version>.zip          (Chrome)
//   node build.mjs firefox    -> dist/site-blocker-firefox-<version>.zip  (Firefox)
//
// The Firefox build also writes dist/firefox-unpacked/, which can be loaded
// temporarily from about:debugging for testing.
//
// The zips contain the contents of extension/ at their root (manifest.json at
// the top level), which is what the stores expect. There is one source tree:
// the Firefox manifest is derived from the Chrome one at build time, because
// the only differences are a handful of manifest keys.
//
// No dependencies: the zip is written by hand, so the project stays free of
// node_modules.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.join(ROOT, "extension");
const DIST_DIR = path.join(ROOT, "dist");

// The add-on ID is what AMO signs the add-on under. It has to stay the same
// across releases, or AMO treats every upload as a different add-on.
const FIREFOX_ADDON_ID = "site-blocker@shaheedhudheen.github.io";
// Firefox 142 is where both desktop and Android understand data_collection_permissions,
// which AMO requires for new add-ons. The blocking APIs need 113+, so this is
// comfortably above them.
const FIREFOX_MIN_VERSION = "142.0";

// ---------- a very small zip writer ----------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// MS-DOS date/time, the format the zip header uses.
function dosStamp(date) {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() >> 1) & 0x1f);
  const day =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { time, day };
}

// Every entry gets the same timestamp, so the same sources always produce
// the same bytes and the same sha256. File mtimes are not used: a fresh
// checkout or a rebase would change them and silently change the hash.
//
// Set SOURCE_DATE_EPOCH (a unix timestamp in seconds) to stamp the archive
// with a date of your choosing instead.
const STAMP = (() => {
  const fromEnv = Number(process.env.SOURCE_DATE_EPOCH);
  const seconds = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 1577836800; // 2020-01-01
  return dosStamp(new Date(seconds * 1000));
})();

// Collect every file under dir, relative to dir, in a stable order.
function collect(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, base, out);
    else if (entry.isFile()) {
      out.push({ name: path.relative(base, full).split(path.sep).join("/"), content: readFileSync(full) });
    }
  }
  return out;
}

function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const raw = file.content;
    const deflated = deflateRawSync(raw, { level: 9 });
    // Storing is smaller for tiny files, and always valid.
    const useStore = deflated.length >= raw.length;
    const body = useStore ? raw : deflated;
    const method = useStore ? 0 : 8;
    const { time, day } = STAMP;
    const name = Buffer.from(file.name, "utf8");
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x800, 6); // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0o644 << 16, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const localBlock = Buffer.concat(locals);
  const centralBlock = Buffer.concat(centrals);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the central directory
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBlock.length, 12);
  end.writeUInt32LE(localBlock.length, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localBlock, centralBlock, end]);
}

// ---------- per-browser manifests ----------

// Firefox supports the same Manifest V3 APIs, with three differences:
//   - no service workers: the background script runs as an event page
//   - it does not use Chrome's minimum_chrome_version
//   - use_dynamic_url in web_accessible_resources is Chrome-only
// Host permissions are declared the same way, but Firefox asks the user to
// grant them at runtime instead of granting them at install time.
function firefoxManifest(chromeManifest) {
  const manifest = { ...chromeManifest };
  delete manifest.minimum_chrome_version;

  manifest.background = { scripts: ["background.js"] };
  manifest.browser_specific_settings = {
    gecko: {
      id: FIREFOX_ADDON_ID,
      strict_min_version: FIREFOX_MIN_VERSION,
      // Firefox 140+ requires new add-ons to declare what data they collect.
      // This extension has no network access of its own and stores everything
      // locally, so the answer is "none".
      data_collection_permissions: {
        required: ["none"],
      },
    },
  };
  manifest.web_accessible_resources = (chromeManifest.web_accessible_resources || []).map((entry) => {
    const copy = { ...entry };
    delete copy.use_dynamic_url;
    return copy;
  });
  return manifest;
}

function withManifest(files, manifest) {
  const json = JSON.stringify(manifest, null, 2) + "\n";
  return files.map((file) =>
    file.name === "manifest.json" ? { name: file.name, content: Buffer.from(json, "utf8") } : file
  );
}

// manifest.json has to be the first entry for some tools to recognise the zip.
function orderFiles(files) {
  return files.sort((a, b) =>
    a.name === "manifest.json" ? -1 : b.name === "manifest.json" ? 1 : 0
  );
}

function writeUnpacked(dir, files) {
  rmSync(dir, { recursive: true, force: true });
  for (const file of files) {
    const target = path.join(dir, ...file.name.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
}

function writeZip(zipName, files) {
  const zipPath = path.join(DIST_DIR, zipName);
  const zip = buildZip(files);
  writeFileSync(zipPath, zip);

  const sha = createHash("sha256").update(zip).digest("hex");
  writeFileSync(path.join(DIST_DIR, `${zipName}.sha256`), `${sha}  ${zipName}\n`);

  console.log(`Built ${path.relative(ROOT, zipPath)}`);
  console.log(`  ${files.length} files, ${(zip.length / 1024).toFixed(1)} KB`);
  console.log(`  sha256 ${sha}`);
  for (const file of files) console.log(`    ${file.name}`);
  return zipPath;
}

// ---------- build ----------

const target = (process.argv[2] || "chrome").toLowerCase();
if (target !== "chrome" && target !== "firefox") {
  console.error(`Unknown target "${target}". Use "chrome" (default) or "firefox".`);
  process.exit(1);
}

if (!existsSync(EXT_DIR)) {
  console.error("extension/ not found - run this from the project root");
  process.exit(1);
}

const chromeManifest = JSON.parse(readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8"));
const version = chromeManifest.version || "0.0.0";
const baseFiles = collect(EXT_DIR);

if (!baseFiles.some((f) => f.name === "manifest.json")) {
  console.error("extension/manifest.json is missing");
  process.exit(1);
}

mkdirSync(DIST_DIR, { recursive: true });

if (target === "firefox") {
  const files = orderFiles(withManifest(baseFiles, firefoxManifest(chromeManifest)));
  writeZip(`site-blocker-firefox-${version}.zip`, files);
  const unpacked = path.join(DIST_DIR, "firefox-unpacked");
  writeUnpacked(unpacked, files);
  console.log(`  unpacked: ${path.relative(ROOT, unpacked)} (load temporarily from about:debugging)`);
} else {
  const files = orderFiles(baseFiles);
  writeZip(`site-blocker-${version}.zip`, files);
}
