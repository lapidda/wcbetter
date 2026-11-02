// The spec-independent half of a priority check: the shapes a pull's casts and
// auras arrive in, aura windows and stacks, and the summary that ranks each
// line by how much more often you break it than the top parses.
//
// What a spec module adds is only the judgement: which line a press belongs
// to, and which higher lines the log can prove applied at that moment. The
// rules for that are in each spec's own file (windwalker-priority.ts,
// deathknight.ts).

export interface PriorityRule {
  /** For specs with several lists in play (Unholy in and out of Forbidden Knowledge); matches the guide list id. */
  list?: string;
  rank: number;
  action: string;
  /** When the line applies; empty for an unconditional line. */
  when: string;
  /** Whether the log can prove a violation of this line. */
  checked: boolean;
  /** Why not, when it cannot. */
  why?: string;
  /** What to do differently, shown when you break it more than the top parses. */
  fix?: string;
}

export interface CastResource {
  amount: number;
  max: number;
  cost?: number;
}

export interface PriorityCast {
  /** Fight-relative ms. */
  t: number;
  name: string;
  energy: number | null;
  energyMax: number | null;
  /** Chi when the press began; only on presses that spend Chi. */
  chi: number | null;
  chiCost: number | null;
  chiMax: number | null;
  /**
   * Every resource the cast carried, by WCL resource type (3 Energy, 5 Runes,
   * 6 Runic Power, 12 Chi). The amount is what the player had as the press
   * began; a resource the press does not spend is often absent.
   */
  resources?: Record<number, CastResource>;
}

export interface PriorityAura {
  /** Fight-relative ms. */
  t: number;
  type: string;
  /** Aura id; one name can come in several ids, from different sources. */
  id: number;
  name: string;
  /** Stack count after the event, on applybuffstack / removebuffstack. */
  stack?: number;
}

export interface PriorityInput {
  durationMs: number;
  casts: PriorityCast[];
  /** The player's own buff events. */
  auras: PriorityAura[];
  /** Fight-relative death times: buffs dropping then are not wasted procs. */
  deathsMs: number[];
}

export interface PriorityViolation {
  /** The list the line belongs to, for specs with more than one in play. */
  list?: string;
  rank: number;
  /** "skipped": a lower press while this line provably applied. "wasted": its proc ran out unused. */
  kind: "skipped" | "wasted";
  t: number;
  /** What was pressed instead; null for a wasted proc. */
  pressed: string | null;
  note: string;
}

export type Windows = Map<number, Array<[number, number]>>;

export function auraWindows(auras: PriorityAura[], durationMs: number): Windows {
  const out: Windows = new Map();
  const open = new Map<number, number>();
  const push = (id: number, a: number, b: number) => (out.get(id) ?? out.set(id, []).get(id)!).push([a, b]);
  for (const e of auras) {
    if (e.type === "applybuff") {
      if (!open.has(e.id)) open.set(e.id, e.t);
    } else if (e.type === "removebuff") {
      push(e.id, open.get(e.id) ?? 0, e.t);
      open.delete(e.id);
    }
  }
  for (const [id, from] of open) push(id, from, durationMs);
  return out;
}

/** End of the window covering t, or null when the aura was not up. Touching the edge does not count. */
export function upUntil(windows: Windows, ids: number[], t: number): number | null {
  let best: number | null = null;
  for (const id of ids) for (const [a, b] of windows.get(id) ?? []) if (t > a && t < b) best = Math.max(best ?? 0, b);
  return best;
}

/**
 * Stack count of the given aura ids just before time t: 0 when down, 1 after
 * an applybuff, the logged count after a stack event. A cast and the stack it
 * consumes share a timestamp, so "just before" is what the press saw. The
 * auras must be in time order, as the loader returns them.
 */
export function stacksAt(auras: PriorityAura[], ids: number[], t: number): number {
  let stacks = 0;
  for (const e of auras) {
    if (e.t >= t) break;
    if (!ids.includes(e.id)) continue;
    if (e.type === "applybuff") stacks = Math.max(stacks, 1);
    else if (e.type === "removebuff") stacks = 0;
    else if ((e.type === "applybuffstack" || e.type === "removebuffstack") && e.stack != null) stacks = e.stack;
  }
  return stacks;
}

export const auraIdsNamed = (auras: PriorityAura[], name: string) => [
  ...new Set(auras.filter((a) => a.name === name).map((a) => a.id)),
];

export const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
export const clock = (ms: number) =>
  `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

export interface PriorityRow extends PriorityRule {
  you: { count: number; perMin: number; skipped: number; wasted: number };
  /** Median per minute across the top parses; null when there were none to check. */
  topPerMin: number | null;
  /** you − top, per minute. What the ranking is by. */
  excessPerMin: number;
  examples: Array<{ fightId: number; label: string; t: number; note: string }>;
}

export interface PrioritySummary {
  rows: PriorityRow[];
  /** How many top parses the baseline came from. */
  referenceCount: number;
}

const sameLine = (rule: PriorityRule, v: PriorityViolation) => v.rank === rule.rank && (v.list ?? null) === (rule.list ?? null);

/** Your violations per line against the top parses', worst excess first. */
export function summarizeRules(
  rules: PriorityRule[],
  yours: Array<{ fightId: number; label: string; durationMs: number; violations: PriorityViolation[] }>,
  refs: Array<{ durationMs: number; violations: PriorityViolation[] }>,
): PrioritySummary {
  const minutes = yours.reduce((s, p) => s + p.durationMs, 0) / 60_000;
  const rows: PriorityRow[] = rules.map((rule) => {
    const mine = yours.flatMap((p) => p.violations.filter((v) => sameLine(rule, v)).map((v) => ({ ...v, pull: p })));
    const perMin = minutes > 0 ? mine.length / minutes : 0;
    const refRates = refs
      .filter((r) => r.durationMs > 0)
      .map((r) => r.violations.filter((v) => sameLine(rule, v)).length / (r.durationMs / 60_000))
      .sort((a, b) => a - b);
    const topPerMin = refRates.length
      ? refRates.length % 2
        ? refRates[(refRates.length - 1) / 2]
        : (refRates[refRates.length / 2 - 1] + refRates[refRates.length / 2]) / 2
      : null;
    return {
      ...rule,
      you: {
        count: mine.length,
        perMin,
        skipped: mine.filter((v) => v.kind === "skipped").length,
        wasted: mine.filter((v) => v.kind === "wasted").length,
      },
      topPerMin,
      excessPerMin: perMin - (topPerMin ?? 0),
      examples: mine.slice(0, 6).map((v) => ({ fightId: v.pull.fightId, label: v.pull.label, t: v.t, note: v.note })),
    };
  });

  rows.sort((a, b) => Number(b.checked) - Number(a.checked) || b.excessPerMin - a.excessPerMin || a.rank - b.rank);
  return { rows, referenceCount: refs.length };
}
