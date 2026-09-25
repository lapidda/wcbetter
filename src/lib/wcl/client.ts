import { createHash } from "node:crypto";
import { getAccessToken } from "./auth";
import { cached } from "./cache";

const API_URL = "https://www.warcraftlogs.com/api/v2/client";

export interface RateLimit {
  limitPerHour: number;
  pointsSpentThisHour: number;
  pointsResetIn: number;
}

let lastRateLimit: RateLimit | null = null;
export function getLastRateLimit(): RateLimit | null {
  return lastRateLimit;
}

/** Upstream requests actually made, by cache key prefix. Cache hits never appear here. */
const queryCounts = new Map<string, number>();

export function getQueryCounts(): Record<string, number> {
  return Object.fromEntries([...queryCounts.entries()].sort((a, b) => b[1] - a[1]));
}

export function resetQueryCounts(): void {
  queryCounts.clear();
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/**
 * Caps in-flight requests rather than serialising them.
 *
 * WCL limits points per hour, not requests per second, and a full analysis
 * spends around 3% of the hourly budget — so the constraint that actually
 * matters is not tripping the burst limiter. Firing everything at once reliably
 * draws 429s; a handful at a time does not, and it roughly halves wall clock
 * because each profile issues seven independent table queries.
 */
const MAX_IN_FLIGHT = 4;

let active = 0;
const waiting: Array<() => void> = [];

async function throttled<T>(task: () => Promise<T>): Promise<T> {
  // A loop rather than a single await: being woken does not guarantee the slot
  // is still free by the time this continuation runs.
  while (active >= MAX_IN_FLIGHT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }

  active += 1;
  try {
    return await task();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

async function post<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = await getAccessToken();

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 429 || res.status >= 500) {
      // Exponential backoff: 1s, 2s, 4s.
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }

    if (!res.ok) {
      throw new Error(`WCL API error (${res.status}): ${await res.text()}`);
    }

    const json = (await res.json()) as GraphQLResponse<T>;
    if (json.errors?.length) {
      throw new Error(`WCL GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
    }
    if (!json.data) throw new Error("WCL returned no data");
    return json.data;
  }

  throw new Error("WCL API is rate limiting or unavailable; try again shortly.");
}

/**
 * Cached, serialised GraphQL query. `key` must capture every variable that
 * changes the result.
 *
 * The document itself is folded into the cache key. Without that, editing a
 * query — adding a field, say — keeps serving responses fetched by the old one,
 * and the new field silently reads as absent forever.
 */
export function query<T>(key: string, document: string, variables: Record<string, unknown>): Promise<T> {
  const shape = createHash("sha1").update(document).digest("hex").slice(0, 8);
  return cached(`${key}|${shape}`, () => {
    const kind = key.split(":")[0];
    queryCounts.set(kind, (queryCounts.get(kind) ?? 0) + 1);
    return throttled(() => post<T>(document, variables));
  });
}

/** Uncached — the whole point is to read the live counter. */
export async function fetchRateLimit(): Promise<RateLimit> {
  const data = await throttled(() =>
    post<{ rateLimitData: RateLimit }>(
      `query { rateLimitData { limitPerHour pointsSpentThisHour pointsResetIn } }`,
      {},
    ),
  );
  lastRateLimit = data.rateLimitData;
  return data.rateLimitData;
}
