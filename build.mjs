// Build the extension into a zip that can be uploaded to the Chrome Web Store.
//
//   node build.mjs            -> dist/site-blocker-<version>.zip
//
// The zip contains the contents of extension/ at its root (manifest.json at
// the top level), which is what the store expects. No dependencies: the zip
// is written by hand, so the project stays free of node_modules.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.join(ROOT, "extension");
const DIST_DIR = path.join(ROOT, "dist");

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
    else if (entry.isFile()) out.push({ name: path.relative(base, full).split(path.sep).join("/"), full });
  }
  return out;
}

function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const raw = readFileSync(file.full);
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

// ---------- build ----------

if (!existsSync(EXT_DIR)) {
  console.error("extension/ not found - run this from the project root");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8"));
const version = manifest.version || "0.0.0";
const files = collect(EXT_DIR);

// manifest.json has to be the first entry for some tools to recognise the zip.
files.sort((a, b) => (a.name === "manifest.json" ? -1 : b.name === "manifest.json" ? 1 : 0));

if (!files.some((f) => f.name === "manifest.json")) {
  console.error("extension/manifest.json is missing");
  process.exit(1);
}

mkdirSync(DIST_DIR, { recursive: true });
const zipName = `site-blocker-${version}.zip`;
const zipPath = path.join(DIST_DIR, zipName);
const zip = buildZip(files);
writeFileSync(zipPath, zip);

const sha = createHash("sha256").update(zip).digest("hex");
writeFileSync(path.join(DIST_DIR, `${zipName}.sha256`), `${sha}  ${zipName}\n`);

console.log(`Built ${path.relative(ROOT, zipPath)}`);
console.log(`  ${files.length} files, ${(zip.length / 1024).toFixed(1)} KB`);
console.log(`  sha256 ${sha}`);
for (const file of files) console.log(`    ${file.name}`);
