import { DOUBLE_LOG_MS } from "./opener";
import type { PlayerProfile, ReferenceProfile } from "./types";

// The whole-fight cast timeline, you against the top parses, one row per
// ability. The opener and burn panels answer "what went wrong in the scripted
// windows"; this answers "what did they do over the fight that I did not" —
// which cooldowns drift later pull after pull, which filler they swap in
// during movement, where their casts bunch up and yours thin out.
//
// Everything here is already fetched for the rules: every profile is built
// with its cast event stream, so the comparison costs no extra API queries.

/** Same floor as missed-cooldowns: below this the ability is filler, and a cooldown bar means nothing. */
const COOLDOWN_FLOOR_MS = 30_000;

export interface CastLane {
  /** "you" or "ref:<index>" — stable across renders, used as the React key. */
  key: string;
  label: string;
  durationMs: number;
  dps: number;
  kill: boolean;
  /** When the boss entered execute range, or null if this pull never got there. */
  burnStartMs: number | null;
  deaths: number[];
  /** gameID -> fight-relative cast times in ms, sorted, rounded to 10ms. */
  casts: Record<number, number[]>;
  /** Your pulls: which fight, so the chart can pair it with that pull's boss casts. */
  fightId?: number;
  /** Reference parses: where to open them in WarcraftLogs. */
  source?: { reportCode: string; fightId: number; actorId: number };
}

export interface CompareAbility {
  gameID: number;
  name: string;
  icon: string | null;
  /** Empirical cooldown when this is a cooldown ability (>= 30s), else null. */
  cooldownMs: number | null;
}

export interface CastComparison {
  /** Cooldowns first (longest first), then by how often anyone presses them. */
  abilities: CompareAbility[];
  /** One lane per analysed pull, in pull order. */
  yours: CastLane[];
  /** One lane per reference parse, in reference (rank) order. */
  reference: CastLane[];
}

/**
 * Build the lanes. Only abilities someone actually *pressed* — a row in the
 * Casts table — make it in: the event stream also carries auto attacks and
 * channel ticks, which would bury the real buttons under twice-a-second noise.
 */
export function buildCastComparison(
  yours: Array<{ profile: PlayerProfile; label: string; kill: boolean }>,
  reference: ReferenceProfile,
): CastComparison {
  const profiles = [...yours.map((y) => y.profile), ...reference.members];

  const pressed = new Map<number, number>();
  for (const p of profiles) {
    for (const stat of Object.values(p.abilities)) {
      if (stat.casts > 0) pressed.set(stat.gameID, (pressed.get(stat.gameID) ?? 0) + stat.casts);
    }
  }

  // One button can log under several ids with one name — a talent-modified
  // version, a proc'd empowered cast. Two rows called "Voidblade" read as two
  // different buttons, so they share one row, under the id cast most often.
  const nameOf = (gameID: number) =>
    reference.abilityNames[gameID] ?? profiles.map((p) => p.abilities[gameID]?.name).find((n) => n != null) ?? String(gameID);
  const rowByName = new Map<string, number>();
  for (const [gameID, casts] of [...pressed.entries()].sort((a, b) => b[1] - a[1])) {
    if (!rowByName.has(nameOf(gameID))) rowByName.set(nameOf(gameID), gameID);
  }
  const rowOf = (gameID: number) => rowByName.get(nameOf(gameID))!;

  const lane = (
    profile: PlayerProfile,
    key: string,
    label: string,
    kill: boolean,
  ): CastLane => {
    const casts: Record<number, number[]> = {};
    for (const c of profile.castTimeline) {
      if (!pressed.has(c.gameID)) continue;
      (casts[rowOf(c.gameID)] ??= []).push(Math.round(c.atMs / 10) * 10);
    }
    // Merged ids interleave, so the row needs re-sorting — and one press logged
    // under two ids at once is one cast, not two (see DOUBLE_LOG_MS).
    for (const [row, times] of Object.entries(casts)) {
      times.sort((a, b) => a - b);
      casts[Number(row)] = times.filter((t, i) => i === 0 || t - times[i - 1] >= DOUBLE_LOG_MS);
    }
    return {
      key,
      label,
      durationMs: profile.durationMs,
      dps: profile.dps,
      kill,
      burnStartMs: profile.burnStartMs,
      deaths: profile.deaths.map((d) => Math.round(d.atMs)),
      casts,
    };
  };

  const yourLanes = yours.map((y) => ({
    ...lane(y.profile, `you:${y.profile.fightId}`, y.label, y.kill),
    fightId: y.profile.fightId,
  }));

  // A ranked parse is by definition a kill.
  const refLanes = reference.members.map((m, i) => ({
    ...lane(m, `ref:${i}`, m.name, true),
    source: { reportCode: m.reportCode, fightId: m.fightId, actorId: m.actorId },
  }));

  const totalCasts = new Map<number, number>();
  for (const l of [...yourLanes, ...refLanes]) {
    for (const [id, times] of Object.entries(l.casts)) {
      totalCasts.set(Number(id), (totalCasts.get(Number(id)) ?? 0) + times.length);
    }
  }

  const abilities: CompareAbility[] = [...totalCasts.keys()].map((gameID) => {
    const cooldown = reference.estimatedCooldownMs[gameID];
    return {
      gameID,
      name: nameOf(gameID),
      icon: profiles.map((p) => p.abilities[gameID]?.icon).find((i) => i != null) ?? null,
      cooldownMs: cooldown != null && cooldown >= COOLDOWN_FLOOR_MS ? cooldown : null,
    };
  });

  abilities.sort((a, b) => {
    const ca = a.cooldownMs ?? 0;
    const cb = b.cooldownMs ?? 0;
    if ((ca > 0) !== (cb > 0)) return cb - ca;
    if (ca !== cb) return cb - ca;
    return (totalCasts.get(b.gameID) ?? 0) - (totalCasts.get(a.gameID) ?? 0);
  });

  return { abilities, yours: yourLanes, reference: refLanes };
}

/**
 * The pull to open the comparison on: your best kill, since that is the pull
 * most like the reference parses; on a night without one, your longest pull,
 * since it covers the most of the fight.
 */
export function defaultComparePull(lanes: CastLane[]): CastLane | null {
  if (lanes.length === 0) return null;
  const kills = lanes.filter((l) => l.kill);
  if (kills.length > 0) return kills.reduce((a, b) => (b.dps > a.dps ? b : a));
  return lanes.reduce((a, b) => (b.durationMs > a.durationMs ? b : a));
}

/** Casts per minute of one ability in one lane: fight lengths differ, so counts alone mislead. */
export function laneCpm(lane: CastLane, gameID: number): number {
  const n = lane.casts[gameID]?.length ?? 0;
  return lane.durationMs > 0 ? n / (lane.durationMs / 60_000) : 0;
}
