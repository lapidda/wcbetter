// Summarises the on-disk WCL cache: what is stored, how much of it, and how big.
// Filenames are hashes, so this relies on each entry recording its own key.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const DIR = process.env.WCL_CACHE_DIR ?? ".cache";

const kinds = new Map();
let files = 0;
let bytes = 0;
let legacy = 0;
let oldest = null;
let newest = null;

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    console.log(`No cache directory at ${DIR}. Nothing has been fetched yet.`);
    process.exit(0);
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (!entry.name.endsWith(".json")) continue;

    files += 1;
    bytes += (await stat(path)).size;

    let parsed;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }

    if (parsed?.__wcbetter !== 1) {
      legacy += 1;
      continue;
    }

    // Keys look like "table:CODE:fight:DataType:source:hostility|shape".
    const [kind, , , detail] = parsed.key.split(":");
    const label = kind === "table" ? `table (${detail})` : kind;
    const bucket = kinds.get(label) ?? { count: 0, bytes: 0 };
    bucket.count += 1;
    bucket.bytes += (await stat(path)).size;
    kinds.set(label, bucket);

    if (!oldest || parsed.savedAt < oldest) oldest = parsed.savedAt;
    if (!newest || parsed.savedAt > newest) newest = parsed.savedAt;
  }
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

await walk(DIR);

console.log(`cache: ${DIR}`);
console.log(`entries: ${files}  (${mb(bytes)})`);
if (legacy > 0) console.log(`  ${legacy} written before keys were recorded (still valid, just opaque)`);
if (oldest) console.log(`spanning: ${oldest.slice(0, 16)} .. ${newest.slice(0, 16)}`);

console.log("\nby kind:");
for (const [label, b] of [...kinds.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${label.padEnd(26)} ${String(b.count).padStart(5)}   ${mb(b.bytes).padStart(9)}`);
}

console.log("\nEvery entry is a raw WarcraftLogs response. Uploaded logs never change,");
console.log("so a hit is always valid; delete the directory to force a refetch.");
