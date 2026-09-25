import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const CACHE_DIR = process.env.WCL_CACHE_DIR ?? ".cache";

/**
 * Raw WCL responses are cached on disk forever. Logs are immutable once
 * uploaded, so a hit is always valid, and it means iterating on the analyzers
 * costs zero API points.
 */
function pathFor(key: string): string {
  const hash = createHash("sha1").update(key).digest("hex");
  // Shard so a busy cache directory stays listable.
  return join(CACHE_DIR, hash.slice(0, 2), `${hash}.json`);
}

/** Filenames are hashes, so the key is stored alongside the value to keep the cache inspectable. */
interface CacheEntry<T> {
  __wcbetter: 1;
  key: string;
  savedAt: string;
  value: T;
}

export async function cached<T>(key: string, produce: () => Promise<T>): Promise<T> {
  const file = pathFor(key);
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    // Entries written before the key was recorded hold the bare value.
    return (parsed?.__wcbetter === 1 ? (parsed as CacheEntry<T>).value : parsed) as T;
  } catch {
    // Miss (or unreadable) -> fetch.
  }

  const value = await produce();
  const entry: CacheEntry<T> = { __wcbetter: 1, key, savedAt: new Date().toISOString(), value };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(entry), "utf8");
  return value;
}
