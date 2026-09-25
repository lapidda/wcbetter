// The report's address. Parameter names mirror WarcraftLogs' own (`fight`,
// `source`) so a WCL link and a wcbetter link are close to interchangeable —
// paste either and the pickers fill themselves in.
//
// Pure functions, no React, so they can be tested without a DOM.

export interface UrlState {
  /** Report code. */
  report?: string;
  /** WCL's actor id for the player. */
  source?: number;
  /** A fight to resolve the boss from. */
  fight?: number;
  /**
   * The exact pulls to analyse. Only ever written by an Analyze click, so its
   * presence is what distinguishes "someone shared a finished report" from
   * "someone pasted a log link" — the first auto-runs, the second only prefills.
   */
  pulls?: number[];
}

export function encodeState(state: UrlState): string {
  const params = new URLSearchParams();
  if (state.report) params.set("report", state.report);
  if (state.source != null) params.set("source", String(state.source));
  if (state.fight != null) params.set("fight", String(state.fight));
  if (state.pulls?.length) params.set("pulls", state.pulls.join(","));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function decodeState(search: string): UrlState {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const num = (key: string) => {
    const raw = params.get(key);
    if (raw == null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };

  const pullsRaw = params.get("pulls");
  const pulls = pullsRaw
    ? pullsRaw
        .split(",")
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n) && n > 0)
    : undefined;

  return {
    report: params.get("report") ?? undefined,
    source: num("source"),
    fight: num("fight"),
    pulls: pulls?.length ? pulls : undefined,
  };
}

/** A pull this short is an accidental pull or an immediate reset, not a real attempt. */
export const MIN_PULL_MS = 30_000;
/** ...and neither is one far shorter than the night's typical attempt. */
const SHORT_PULL_RATIO = 0.2;

/**
 * Which pulls to tick by default. Every real attempt, because aggregation is
 * the point — but a 20-second "we pulled by accident" skews cast rates, the
 * opener window and uptime, so those start unticked with a reason shown.
 */
export function defaultSelection<T extends { id: number; durationMs: number }>(
  fights: T[],
): { selected: number[]; short: number[] } {
  if (fights.length === 0) return { selected: [], short: [] };

  const sorted = [...fights].map((f) => f.durationMs).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const floor = Math.max(MIN_PULL_MS, medianMs * SHORT_PULL_RATIO);

  const selected: number[] = [];
  const short: number[] = [];
  for (const fight of fights) (fight.durationMs >= floor ? selected : short).push(fight.id);

  // Never hand back an empty selection: if every pull looks short, they are the
  // night, and the floor was the wrong call.
  return selected.length > 0 ? { selected, short } : { selected: fights.map((f) => f.id), short: [] };
}
