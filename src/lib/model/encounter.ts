import type { TableEntry, WclEvent } from "@/lib/wcl/types";
import type { BossCast, EnemyAbility } from "./types";

// This module is deliberately pure — no fetching — so anything that needs to
// reason about boss casts can import it without dragging node-only modules into
// a client bundle. The orchestration that fetches lives in analyze.ts.

/**
 * Anything an enemy casts more often than this is an auto-attack or a periodic
 * tick, not a mechanic. Calibrated on a real fight: the boss's melee-like
 * ability ran at 30.7/min, while every genuine mechanic sat between 0.2 and
 * 8.1/min. No ability id or name is special-cased.
 */
export const MAX_MECHANIC_CPM = 10;

/**
 * How far before a gap or death a boss cast can be and still count as its
 * cause. A mechanic that forces movement does so within a few seconds; further
 * back than this is not a reaction to it.
 */
export const MECHANIC_LOOKBACK_MS = 8000;

/**
 * A gap can start a hair before the cast event is stamped when the player
 * pre-empts the cast bar. This much lead is still "after".
 */
const LEAD_SLACK_MS = 500;

/**
 * The same mechanic can appear as begincast then cast, or under two ids with
 * one name (a real boss did exactly that). Collapse by name within a short
 * window — short, because an 8/min mechanic recurs every 7s and must not
 * collapse into itself.
 */
const COLLAPSE_MS = 3000;
/** A completed cast this long after its own cast bar started is the same cast. */
const CAST_BAR_MS = 8000;

/** The enemy-side Casts table: NPC rows with nested abilities, or flat ability rows. */
export function buildDictionary(payload: { entries?: TableEntry[] }): Record<number, EnemyAbility> {
  const dict: Record<number, EnemyAbility> = {};

  for (const entry of payload.entries ?? []) {
    const nested = Array.isArray(entry.abilities);
    const rows = nested ? entry.abilities! : [entry];
    const caster = nested ? String(entry.name ?? "") : "";

    for (const row of rows) {
      const gameID = Number(row.guid ?? row.id ?? 0);
      const name = String(row.name ?? "").trim();
      if (!gameID || !name) continue;

      const icon = typeof row.icon === "string" ? row.icon : typeof row.abilityIcon === "string" ? row.abilityIcon : null;
      const casts = Number(row.total ?? 0) || 0;
      const existing = dict[gameID];

      if (existing) {
        existing.casts += casts;
        if (caster && !existing.casters.includes(caster)) existing.casters.push(caster);
      } else {
        dict[gameID] = { gameID, name, icon, casters: caster ? [caster] : [], casts };
      }
    }
  }

  return dict;
}

/**
 * Ability ids that belong to the raid, from either friendly-side table shape:
 * the Casts table (players with nested abilities) or the Buffs table (`auras`,
 * beneficial effects on friendlies). Anti-Magic Zone is the case that needs
 * the second: the log files the zone under the environment, no friendly "casts"
 * it, but it is unmistakably a buff on the raid.
 */
export function friendlyAbilityIds(payload: { entries?: TableEntry[]; auras?: TableEntry[] }): Set<number> {
  const ids = new Set<number>();
  for (const entry of [...(payload.entries ?? []), ...(payload.auras ?? [])]) {
    const rows = Array.isArray(entry.abilities) ? entry.abilities : [entry];
    for (const row of rows) {
      const gameID = Number(row.guid ?? row.id ?? 0);
      if (gameID) ids.add(gameID);
    }
  }
  return ids;
}

/**
 * The enemy-side log attributes some player abilities to the environment —
 * a Death Knight's Anti-Magic Zone turned up as a "boss cast" preceding three
 * gaps on one pull. Source id cannot separate them (real mechanics spawn from
 * the environment too), but the raid can: a friendly cast it, or it sits on
 * friendlies as a beneficial aura. Removes those, and says how many.
 */
export function withoutFriendlyAbilities(
  abilities: Record<number, EnemyAbility>,
  friendly: Set<number>,
): { abilities: Record<number, EnemyAbility>; excluded: string[] } {
  const kept: Record<number, EnemyAbility> = {};
  const excluded: string[] = [];
  for (const ability of Object.values(abilities)) {
    if (friendly.has(ability.gameID)) excluded.push(ability.name);
    else kept[ability.gameID] = ability;
  }
  return { abilities: kept, excluded };
}

/**
 * Enemy cast events for one fight, reduced to the casts that mean something:
 * named, not an auto-attack, one entry per mechanic occurrence.
 */
export function mechanicCasts(
  events: WclEvent[],
  fight: { startTime: number; endTime: number },
  abilities: Record<number, EnemyAbility>,
): BossCast[] {
  const minutes = Math.max(1e-6, (fight.endTime - fight.startTime) / 60_000);

  const counts = new Map<number, number>();
  for (const e of events) {
    if (e.abilityGameID != null) counts.set(e.abilityGameID, (counts.get(e.abilityGameID) ?? 0) + 1);
  }
  const isMechanic = (gameID: number) =>
    abilities[gameID] != null && (counts.get(gameID) ?? 0) / minutes <= MAX_MECHANIC_CPM;

  const raw = events
    .filter(
      (e) =>
        e.abilityGameID != null &&
        (e.type === "cast" || e.type === "begincast") &&
        isMechanic(e.abilityGameID),
    )
    .map<BossCast>((e) => ({
      atMs: e.timestamp - fight.startTime,
      gameID: e.abilityGameID as number,
      sourceId: e.sourceID ?? -1,
      telegraphed: e.type === "begincast",
      targetId: e.targetID ?? null,
      castMs: null,
    }))
    .sort((a, b) => a.atMs - b.atMs);

  const out: BossCast[] = [];
  const lastIndexByName = new Map<string, number>();

  for (const cast of raw) {
    const name = abilities[cast.gameID].name;
    const prevIndex = lastIndexByName.get(name);
    const prev = prevIndex != null ? out[prevIndex] : undefined;

    if (prev) {
      const gap = cast.atMs - prev.atMs;
      const finishesPrev = prev.telegraphed && !cast.telegraphed && gap <= CAST_BAR_MS;
      const sameCast = gap <= COLLAPSE_MS || finishesPrev;
      if (sameCast) {
        if (cast.telegraphed) prev.telegraphed = true;
        // A begincast followed by its own cast measures the cast bar. The
        // completed cast is also the one that reliably names a target, so take
        // the target from whichever event actually carried one.
        if (finishesPrev) prev.castMs = gap;
        prev.targetId ??= cast.targetId;
        continue;
      }
    }

    out.push({ ...cast });
    lastIndexByName.set(name, out.length - 1);
  }

  return out;
}

/**
 * The last boss cast within the lookback before `atMs`, or null. Callers must
 * treat null as "no boss cast in the previous 8s" — player-side downtime —
 * never guess a cause.
 */
export function precedingBossCast(
  casts: BossCast[],
  atMs: number,
  lookbackMs = MECHANIC_LOOKBACK_MS,
): BossCast | null {
  // Tens of casts per pull: a reverse scan is clearer than a binary search.
  for (let i = casts.length - 1; i >= 0; i--) {
    const cast = casts[i];
    if (cast.atMs > atMs + LEAD_SLACK_MS) continue;
    if (cast.atMs < atMs - lookbackMs) break;
    return cast;
  }
  return null;
}

/** Name and lead time of the mechanic before `atMs`, for prose. */
export function mechanicBefore(
  casts: BossCast[],
  abilities: Record<number, EnemyAbility>,
  atMs: number,
): { name: string; gameID: number; leadMs: number } | null {
  const cast = precedingBossCast(casts, atMs);
  if (!cast) return null;
  return { name: abilities[cast.gameID]?.name ?? String(cast.gameID), gameID: cast.gameID, leadMs: atMs - cast.atMs };
}

/** `— 1.8s after Stone Breaker` or `— no boss cast in the previous 8s`. */
export function describeLead(lead: ReturnType<typeof mechanicBefore>): string {
  return lead
    ? `${(Math.max(0, lead.leadMs) / 1000).toFixed(1)}s after ${lead.name}`
    : `no boss cast in the previous ${MECHANIC_LOOKBACK_MS / 1000}s`;
}
