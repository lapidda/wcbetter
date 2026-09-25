import type { NotableMechanic } from "./notable";
import type { RaidActor, RaidAnalysis, RaidRoster } from "./raid";

// Pure, and deliberately in model/ rather than beside the orchestration in
// lib/raid.ts: the browser needs these types and this one helper, and importing
// them from lib/raid.ts pulls the WCL client — and `node:crypto` — into the
// client bundle. Webpack fails that build outright, which is the good outcome;
// the bad one would have been shipping the fetching layer to the browser.

export interface RaidReportMeta {
  report: { code: string; title: string };
  encounter: { id: number; name: string; difficulty: string };
  pulls: Array<{ fightId: number; label: string; durationMs: number; kill: boolean }>;
  warnings: string[];
}

/**
 * What actually crosses the wire.
 *
 * `series` is dropped: it carries every occurrence of every mechanic with its
 * per-player hit lists, which measured 319 KB on a twelve-pull night, and the
 * editor reads none of it — `notable` already holds the per-wave summaries.
 * `tankIds` becomes an array because JSON.stringify turns a Set into `{}`.
 */
export interface RaidPayload extends RaidReportMeta {
  roster: { actors: Record<number, RaidActor>; tankIds: number[] };
  notable: NotableMechanic[];
  stats: RaidAnalysis["stats"];
  totalRaidDamageTaken: number;
}

/** Rebuild the roster the pure generators want from what the wire carried. */
export function rosterFromPayload(payload: RaidPayload): RaidRoster {
  return { actors: payload.roster.actors, byFight: {}, tankIds: new Set(payload.roster.tankIds) };
}
