import type { Actor, Fight, TableEntry, WclEvent } from "@/lib/wcl/types";
import { MAX_MECHANIC_CPM, MECHANIC_LOOKBACK_MS, precedingBossCast } from "./encounter";
import { buildMechanicProfile, type MechanicProfile } from "./mechanic-profile";
import type { BossCast, EncounterContext } from "./types";

// Pure, like encounter.ts: no fetching, no node-only imports. Everything here
// takes already-fetched payloads so the same code runs in the CLI, the route
// handler and a test with hand-written fixtures.

/**
 * Damage landing later than this after a cast belongs to a different mechanic.
 * The same 8s window `precedingBossCast` already uses for gaps and deaths —
 * one number for "this happened because of that", not three.
 */
export const MECHANIC_DAMAGE_WINDOW_MS = MECHANIC_LOOKBACK_MS;

/** Damage can land a hair before its cast event is stamped. Mirrors encounter.ts. */
const DAMAGE_LEAD_SLACK_MS = 500;

/**
 * A player must be hit this many times by an ability before its rate is evidence
 * of anything. Without it a 20s wipe makes every hit look like melee.
 */
const MIN_MELEE_HITS = 5;

/**
 * Melee only ever reaches the handful of people standing in it. An ability above
 * MAX_MECHANIC_CPM that lands on more of the raid than this is a raid-wide damage
 * tick, not the boss swinging — the CPM test alone would call everyone a tank.
 */
const MAX_TANK_SHARE = 0.25;

/** A cast must claim this share of an ability's hits before the time fallback maps it. */
const TIME_MATCH_SHARE = 0.6;
/** ...and the ability must have landed this often, so one coincidence is not a mapping. */
const MIN_TIME_MATCH_HITS = 3;

/**
 * Damage taken sooner than this after dying is the killing blow still landing,
 * not proof of a battle rez. Same grace period profile.ts uses on the cast side.
 */
const REZ_GRACE_MS = 2000;

export interface RaidActor {
  id: number;
  name: string;
  className: string;
}

export interface RaidRoster {
  actors: Record<number, RaidActor>;
  /** fightId -> actor ids present, from `Fight.friendlyPlayers`. */
  byFight: Record<number, number[]>;
  /**
   * Whoever eats the boss's high-rate melee. The tank test, derived from the log
   * rather than a spec-to-role table: no class or spell id is special-cased.
   */
  tankIds: Set<number>;
}

export interface RaidDeath {
  fightId: number;
  targetId: number;
  atMs: number;
  killingAbilityGameID: number | null;
  killingAbility: string | null;
}

export interface MechanicHit {
  targetId: number;
  /** Times this player was hit by this occurrence — what the damage tables can never say. */
  count: number;
  amount: number;
  firstAtMs: number;
}

export interface MechanicOccurrence {
  fightId: number;
  /** 1-based index of this cast among the same mechanic's casts on this pull. */
  ordinal: number;
  atMs: number;
  hits: MechanicHit[];
  /** Alive and present at `atMs` — the denominator that makes "4 of 19" meaningful. */
  eligible: number[];
  deaths: Array<{ targetId: number; atMs: number; byKillingBlow: boolean }>;
}

export interface MechanicSeries {
  /** `mechanicCasts` collapses by name, so one mechanic may span two cast ids. */
  name: string;
  castGameIDs: number[];
  damageGameIDs: number[];
  icon: string | null;
  /** How the damage was tied to the cast. "time" is a weaker claim, surfaced as such. */
  mappedBy: "name" | "time";
  occurrences: MechanicOccurrence[];
  /** What the mechanic does, measured — cast time, targeting, splash, hit size. */
  profile: MechanicProfile;
}

export interface RaidInput {
  fights: Fight[];
  actors: Actor[];
  context: EncounterContext;
  /** fightId -> damage-taken events. The one thing this analysis genuinely has to fetch. */
  hitsByFight: Record<number, WclEvent[]>;
  deathsByFight: Record<number, RaidDeath[]>;
  /** Damage ability id -> name, from the already-cached fight-wide DamageTaken table. */
  damageAbilityNames: Record<number, string>;
}

export interface RaidAnalysis {
  roster: RaidRoster;
  series: MechanicSeries[];
  stats: {
    /** Mechanics whose damage id was found by name — the free, reliable path. */
    nameMatched: number;
    timeMatched: number;
    /** Named boss casts no damage could be tied to. Dropped rather than guessed at. */
    unmapped: number;
    eventsByFight: Record<number, number>;
  };
}

/** Player actors from `masterData`, keyed by the report-local id every other table uses. */
export function buildActorIndex(actors: Actor[]): Record<number, RaidActor> {
  const index: Record<number, RaidActor> = {};
  for (const actor of actors) {
    if (actor.type !== "Player") continue;
    index[actor.id] = { id: actor.id, name: actor.name, className: actor.subType };
  }
  return index;
}

/** The Deaths table for one fight, as rows the rest of this module can use. */
export function raidDeaths(payload: { entries?: TableEntry[] }, fight: Fight): RaidDeath[] {
  const out: RaidDeath[] = [];
  for (const row of payload.entries ?? []) {
    const targetId = Number(row.id ?? 0);
    if (!targetId) continue;
    const timestamp = Number(row.timestamp ?? row.deathTime ?? 0);
    // The field is `killingBlow`, and it is the ability object itself.
    const blow = row.killingBlow as { name?: string; guid?: number; id?: number } | undefined;
    out.push({
      fightId: fight.id,
      targetId,
      atMs: timestamp - fight.startTime,
      killingAbilityGameID: Number(blow?.guid ?? blow?.id ?? 0) || null,
      killingAbility: blow?.name ?? null,
    });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

/** Damage ability id -> name, from the fight-wide DamageTaken table's nested rows. */
export function damageAbilityNames(payload: { entries?: TableEntry[] }): Record<number, string> {
  const names: Record<number, string> = {};
  for (const entry of payload.entries ?? []) {
    const rows = Array.isArray(entry.abilities) ? entry.abilities : [entry];
    for (const row of rows) {
      const gameID = Number(row.guid ?? row.id ?? 0);
      const name = String(row.name ?? "").trim();
      if (gameID && name) names[gameID] = name;
    }
  }
  return names;
}

/**
 * Damage the raid inflicted on itself, dropped.
 *
 * Measured on a real log: a warlock hitting themselves 753 times in one pull at
 * 96/min, two mages at 54/min, two demon hunters at 16/min. Every one of them
 * passed the melee test and was reported as a tank, and nine of twenty players
 * came back "tanks". Nothing self-inflicted is a boss mechanic anyone failed to
 * dodge, so the source has to be hostile before any of this means anything —
 * which also keeps a player ability from ever being mapped to a boss cast.
 *
 * Aliveness is the deliberate exception: any damage at all proves a player is
 * back on their feet, whoever dealt it.
 */
export function enemySourced(events: WclEvent[], players: Record<number, RaidActor>): WclEvent[] {
  return events.filter((e) => e.sourceID == null || players[e.sourceID] == null);
}

/** Fight-relative hit times per ability, the shape both the melee test and the mapper want. */
function hitTimes(
  events: WclEvent[],
  fight: Fight,
): Map<number, Array<{ targetId: number; atMs: number }>> {
  const byAbility = new Map<number, Array<{ targetId: number; atMs: number }>>();
  for (const event of events) {
    const gameID = event.abilityGameID;
    const targetId = event.targetID;
    if (gameID == null || targetId == null) continue;
    const list = byAbility.get(gameID) ?? [];
    list.push({ targetId, atMs: event.timestamp - fight.startTime });
    byAbility.set(gameID, list);
  }
  return byAbility;
}

/**
 * Abilities landing faster than a mechanic ever does, on too few people to be
 * raid-wide: the boss's melee. Returns the ability ids and the players eating them.
 */
function meleeAbilities(
  events: WclEvent[],
  fight: Fight,
  rosterSize: number,
): { abilityIds: Set<number>; tankIds: Set<number> } {
  const minutes = Math.max(1e-6, (fight.endTime - fight.startTime) / 60_000);
  const abilityIds = new Set<number>();
  const tankIds = new Set<number>();

  for (const [gameID, hits] of hitTimes(events, fight)) {
    if (hits.length < MIN_MELEE_HITS) continue;
    const targets = new Set(hits.map((h) => h.targetId));
    // Per-target rate: two tanks swapping halve the rate of an ability that is
    // still, for each of them, unmistakably melee.
    const perTargetCpm = hits.length / targets.size / minutes;
    if (perTargetCpm <= MAX_MECHANIC_CPM) continue;
    if (rosterSize > 0 && targets.size / rosterSize > MAX_TANK_SHARE) continue;
    abilityIds.add(gameID);
    for (const id of targets) tankIds.add(id);
  }

  return { abilityIds, tankIds };
}

export function buildRoster(input: RaidInput): RaidRoster {
  const actors = buildActorIndex(input.actors);
  const byFight: Record<number, number[]> = {};
  const tankIds = new Set<number>();

  for (const fight of input.fights) {
    const present = (fight.friendlyPlayers ?? []).filter((id) => actors[id] != null);
    byFight[fight.id] = present;
    const hostile = enemySourced(input.hitsByFight[fight.id] ?? [], actors);
    const melee = meleeAbilities(hostile, fight, present.length);
    for (const id of melee.tankIds) tankIds.add(id);
  }

  return { actors, byFight, tankIds };
}

/**
 * When each player was dead, per pull.
 *
 * A player taking damage well after their own death timestamp is back up, which
 * is battle-rez detection for the whole raid for free — the events were fetched
 * for the hits anyway. Someone rezzed who then takes no damage at all stays
 * "dead" here, which shrinks the eligible denominator and so errs toward flagging
 * a mechanic rather than hiding it.
 */
export function deadIntervals(
  deaths: RaidDeath[],
  events: WclEvent[],
  fight: Fight,
): Record<number, Array<{ startMs: number; endMs: number }>> {
  const durationMs = fight.endTime - fight.startTime;
  const damageTimes = new Map<number, number[]>();
  for (const event of events) {
    if (event.targetID == null) continue;
    const list = damageTimes.get(event.targetID) ?? [];
    list.push(event.timestamp - fight.startTime);
    damageTimes.set(event.targetID, list);
  }
  for (const list of damageTimes.values()) list.sort((a, b) => a - b);

  const intervals: Record<number, Array<{ startMs: number; endMs: number }>> = {};
  for (const death of deaths) {
    const after = damageTimes.get(death.targetId)?.find((t) => t > death.atMs + REZ_GRACE_MS);
    const list = intervals[death.targetId] ?? [];
    list.push({ startMs: death.atMs, endMs: after ?? durationMs });
    intervals[death.targetId] = list;
  }
  return intervals;
}

function isDeadAt(
  intervals: Record<number, Array<{ startMs: number; endMs: number }>>,
  actorId: number,
  atMs: number,
): boolean {
  return (intervals[actorId] ?? []).some((i) => atMs >= i.startMs && atMs < i.endMs);
}

/**
 * Which damage ids belong to which mechanic.
 *
 * By name first: a cast and its damage usually share one, the match is exact and
 * it costs nothing. By time second, and only for an ability whose hits follow the
 * same cast most of the time — a missile spawned by a cast under a different id.
 * An ability matching neither is left out, the same never-guess rule
 * `describeLead` follows.
 */
export function mapDamageToMechanics(
  input: RaidInput,
  mechanicNames: string[],
): Map<string, { damageGameIDs: Set<number>; mappedBy: "name" | "time" }> {
  const wanted = new Map(mechanicNames.map((name) => [name.toLowerCase(), name]));
  const mapping = new Map<string, { damageGameIDs: Set<number>; mappedBy: "name" | "time" }>();

  const claim = (name: string, gameID: number, how: "name" | "time") => {
    const existing = mapping.get(name);
    if (existing) {
      existing.damageGameIDs.add(gameID);
      if (how === "name") existing.mappedBy = "name";
    } else {
      mapping.set(name, { damageGameIDs: new Set([gameID]), mappedBy: how });
    }
  };

  const matchedByName = new Set<number>();
  for (const [gameID, damageName] of Object.entries(input.damageAbilityNames)) {
    const mechanic = wanted.get(damageName.trim().toLowerCase());
    if (!mechanic) continue;
    matchedByName.add(Number(gameID));
    claim(mechanic, Number(gameID), "name");
  }

  // Time fallback, per pull, over the abilities name-matching could not place.
  const followTally = new Map<number, Map<string, number>>();
  const totalHits = new Map<number, number>();
  const melee = new Set<number>();

  const players = buildActorIndex(input.actors);
  for (const fight of input.fights) {
    const events = enemySourced(input.hitsByFight[fight.id] ?? [], players);
    const casts = input.context.castsByFight[fight.id] ?? [];
    const roster = (fight.friendlyPlayers ?? []).length;
    for (const id of meleeAbilities(events, fight, roster).abilityIds) melee.add(id);

    for (const [gameID, hits] of hitTimes(events, fight)) {
      if (matchedByName.has(gameID)) continue;
      totalHits.set(gameID, (totalHits.get(gameID) ?? 0) + hits.length);
      const tally = followTally.get(gameID) ?? new Map<string, number>();
      for (const hit of hits) {
        const cast = precedingBossCast(casts, hit.atMs, MECHANIC_DAMAGE_WINDOW_MS);
        const name = cast ? input.context.abilities[cast.gameID]?.name : undefined;
        if (!name || !wanted.has(name.toLowerCase())) continue;
        tally.set(name, (tally.get(name) ?? 0) + 1);
      }
      followTally.set(gameID, tally);
    }
  }

  for (const [gameID, tally] of followTally) {
    if (melee.has(gameID)) continue;
    const hits = totalHits.get(gameID) ?? 0;
    if (hits < MIN_TIME_MATCH_HITS) continue;
    let best: { name: string; count: number } | null = null;
    for (const [name, count] of tally) {
      if (!best || count > best.count) best = { name, count };
    }
    if (!best || best.count / hits < TIME_MATCH_SHARE) continue;
    claim(best.name, gameID, "time");
  }

  return mapping;
}

/** Casts of one mechanic on one pull, in time order. */
function occurrencesOf(casts: BossCast[], gameIDs: Set<number>): BossCast[] {
  return casts.filter((c) => gameIDs.has(c.gameID));
}

export function analyzeRaid(input: RaidInput): RaidAnalysis {
  const roster = buildRoster(input);

  // Cast ids grouped by the name mechanicCasts collapsed them under.
  const castIdsByName = new Map<string, Set<number>>();
  const iconByName = new Map<string, string | null>();
  for (const casts of Object.values(input.context.castsByFight)) {
    for (const cast of casts) {
      const ability = input.context.abilities[cast.gameID];
      if (!ability) continue;
      const set = castIdsByName.get(ability.name) ?? new Set<number>();
      set.add(cast.gameID);
      castIdsByName.set(ability.name, set);
      if (!iconByName.get(ability.name)) iconByName.set(ability.name, ability.icon);
    }
  }

  const mapping = mapDamageToMechanics(input, [...castIdsByName.keys()]);

  const deadByFight: Record<number, Record<number, Array<{ startMs: number; endMs: number }>>> = {};
  const hostileByFight: Record<number, WclEvent[]> = {};
  for (const fight of input.fights) {
    // Aliveness reads every event, attribution only the hostile ones.
    deadByFight[fight.id] = deadIntervals(
      input.deathsByFight[fight.id] ?? [],
      input.hitsByFight[fight.id] ?? [],
      fight,
    );
    hostileByFight[fight.id] = enemySourced(input.hitsByFight[fight.id] ?? [], roster.actors);
  }

  const series: MechanicSeries[] = [];
  let nameMatched = 0;
  let timeMatched = 0;
  let unmapped = 0;

  for (const [name, castGameIDs] of castIdsByName) {
    const mapped = mapping.get(name);
    if (!mapped) {
      unmapped++;
      continue;
    }
    if (mapped.mappedBy === "name") nameMatched++;
    else timeMatched++;

    const occurrences: MechanicOccurrence[] = [];
    // Profile inputs, gathered as the occurrences are built so the cast/damage
    // pairing is done exactly once.
    const profileCasts: BossCast[] = [];
    const profileHits: WclEvent[] = [];
    const hitsPerCast: number[] = [];
    const splashPerCast: boolean[] = [];

    for (const fight of input.fights) {
      const casts = occurrencesOf(input.context.castsByFight[fight.id] ?? [], castGameIDs);
      if (casts.length === 0) continue;

      const events = hostileByFight[fight.id] ?? [];
      const deaths = input.deathsByFight[fight.id] ?? [];
      const dead = deadByFight[fight.id] ?? {};
      const present = roster.byFight[fight.id] ?? [];

      casts.forEach((cast, index) => {
        const from = cast.atMs - DAMAGE_LEAD_SLACK_MS;
        // Never reach into the next occurrence: a mechanic recurring inside the
        // window would otherwise count the same hits twice.
        const next = casts[index + 1];
        const to = Math.min(
          cast.atMs + MECHANIC_DAMAGE_WINDOW_MS,
          next ? next.atMs - DAMAGE_LEAD_SLACK_MS : Number.POSITIVE_INFINITY,
        );

        const byTarget = new Map<number, MechanicHit>();
        profileCasts.push(cast);
        for (const event of events) {
          if (event.abilityGameID == null || !mapped.damageGameIDs.has(event.abilityGameID))
            continue;
          const targetId = event.targetID;
          if (targetId == null || roster.actors[targetId] == null) continue;
          const atMs = event.timestamp - fight.startTime;
          if (atMs < from || atMs >= to) continue;
          profileHits.push(event);

          // Absorbed damage still means the mechanic connected.
          const amount = (Number(event.amount) || 0) + (Number(event.absorbed) || 0);
          const hit = byTarget.get(targetId);
          if (hit) {
            hit.count++;
            hit.amount += amount;
            hit.firstAtMs = Math.min(hit.firstAtMs, atMs);
          } else {
            byTarget.set(targetId, { targetId, count: 1, amount, firstAtMs: atMs });
          }
        }

        hitsPerCast.push(byTarget.size);
        // Only a cast that named a player can answer "did it reach anyone else?".
        if (cast.targetId != null && roster.actors[cast.targetId] != null && byTarget.size > 0) {
          splashPerCast.push([...byTarget.keys()].some((id) => id !== cast.targetId));
        }

        occurrences.push({
          fightId: fight.id,
          ordinal: index + 1,
          atMs: cast.atMs,
          hits: [...byTarget.values()].sort((a, b) => b.amount - a.amount),
          // Anyone this occurrence hit was demonstrably alive for it, whatever
          // the death table and the rez heuristic think. Without this the hits
          // could outnumber the eligible and every share above would exceed 1 —
          // and it is exactly the case a rez detected from the player's own
          // first post-death hit would otherwise get wrong.
          eligible: present.filter((id) => byTarget.has(id) || !isDeadAt(dead, id, cast.atMs)),
          deaths: deaths
            .filter((d) => d.atMs >= from && d.atMs < to)
            .map((d) => ({
              targetId: d.targetId,
              atMs: d.atMs,
              byKillingBlow:
                d.killingAbilityGameID != null && mapped.damageGameIDs.has(d.killingAbilityGameID),
            })),
        });
      });
    }

    if (occurrences.length === 0) continue;
    series.push({
      name,
      castGameIDs: [...castGameIDs].sort((a, b) => a - b),
      damageGameIDs: [...mapped.damageGameIDs].sort((a, b) => a - b),
      icon: iconByName.get(name) ?? null,
      mappedBy: mapped.mappedBy,
      occurrences,
      profile: buildMechanicProfile({
        casts: profileCasts,
        hits: profileHits,
        players: roster.actors,
        hitsPerCast,
        splashPerCast,
      }),
    });
  }

  const eventsByFight: Record<number, number> = {};
  for (const fight of input.fights) {
    eventsByFight[fight.id] = (input.hitsByFight[fight.id] ?? []).length;
  }

  series.sort((a, b) => a.name.localeCompare(b.name));
  return { roster, series, stats: { nameMatched, timeMatched, unmapped, eventsByFight } };
}
