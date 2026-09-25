import { priorityOf } from "./aggregate";
import type { MechanicOccurrence, MechanicSeries, RaidRoster } from "./raid";
import { describeMechanic, type MechanicProfile } from "./mechanic-profile";
import { median, percentile } from "./stats";

// Pure. Turns the occurrence matrix from raid.ts into a ranked list of the
// mechanics people actually fail, each with one quotable timestamp.
//
// The governing idea: the raid is its own control group. If a mechanic hit 4 of
// 19 players who were alive for it, the other 15 proved on that pull that it is
// dodgeable — no reference parses, no boss knowledge, nothing to fetch.

/**
 * Above this share of the eligible raid, "the others dodged it" stops being the
 * simplest explanation. More than half the raid eating something is a mechanic
 * the fight forces on people, or a healing problem, not an individual failure.
 */
export const MAX_FAILED_SHARE = 0.5;

/**
 * A near-constant number of people hit, pull after pull, is a soak: somebody was
 * assigned to stand there. Coefficient of variation, so it is scale-free.
 */
export const SOAK_CV = 0.25;

/**
 * The three-pull ideal, as aggregate.ts uses: two pulls is an anecdote.
 *
 * An ideal, not a hard floor. It exists to stop *cross-pull consistency* being
 * read off two data points — but the strongest evidence here needs only one
 * pull, because the raid is its own control group: if four of twenty were hit
 * and sixteen were not, those sixteen proved it was dodgeable there and then.
 * Demanding three pulls of a two-pull report returned an empty note for the very
 * case a raid leader most wants one, the first night on a new boss.
 *
 * So the effective floor is `effectiveMinPulls`, and a report too short to meet
 * this is marked `thinEvidence` rather than silently producing nothing.
 */
export const MIN_NOTE_PULLS = 3;

/** Never demand more pulls of evidence than the night actually contains. */
export function effectiveMinPulls(pullCount: number): number {
  return Math.max(1, Math.min(MIN_NOTE_PULLS, pullCount));
}

/**
 * Lower than a DPS finding's bar deliberately. A note line costs one line of a
 * note; missing the mechanic that keeps wiping the raid costs the evening.
 */
export const MIN_FAIL_CONSISTENCY = 0.4;

/** Scale-free significance, mirroring `shareOfDamageTaken` in the DPS analysis. */
export const MIN_SHARE_OF_RAID_DAMAGE = 0.03;

/** A note nobody reads is worse than no note. */
export const MAX_NOTE_LINES = 20;

/**
 * Quote the 25th percentile of a wave's observed times, not the median: a timer
 * that fires early is a warning, one that fires late is noise. This puts the
 * callout ahead of the mechanic on roughly three pulls in four.
 */
export const TIMER_QUANTILE = 0.25;

/**
 * Spread (p90 - p10) below this and the timer is worth quoting. Matches the
 * COLLAPSE_MS granularity encounter.ts already treats as one event.
 */
export const TIMER_TIGHT_MS = 3000;

/**
 * Casts closer together than this are one callout.
 *
 * Measured, not guessed: on a real fight a mechanic arrived in waves of two to
 * four casts three to five seconds apart, with 65 to 95 seconds between waves.
 * Ten seconds sits in that gap with room on both sides. One warning before a
 * burst is what a raid leader wants; three lines three seconds apart is noise.
 */
export const WAVE_GAP_MS = 10_000;

/** One death per pull should rank like a critical DPS finding: SEVERITY_WEIGHT.critical. */
const DEATH_WEIGHT = 6;

export type MechanicClass = "avoidable" | "raid-wide" | "tank-only" | "assigned" | "unclear";

export interface MechanicWave {
  /** 1-based index of this wave in time order. */
  ordinal: number;
  /** The p25 of observed times: what a timer would quote. */
  atMs: number;
  medianAtMs: number;
  /** p90 - p10. How much this wave drifts across pulls. */
  spreadMs: number;
  /** Tight enough to quote a number for. When false, say so rather than lie. */
  confident: boolean;

  /** Pulls that lasted long enough to see this wave. THE denominator. */
  reached: number;
  /** Pulls where the mechanic actually fired here. */
  seen: number;
  /** Pulls where it fired and hit somebody. */
  failedOn: number;
  /** failedOn / seen: how reliably the raid fails this wave when it happens. */
  consistency: number;

  /** Median casts per pull within the wave — a burst of three says so. */
  medianCasts: number;
  /** Median distinct players hit, across the pulls where anyone was. */
  medianHitCount: number;
  deaths: number;
  /**
   * Who ate it, most-failing first. `eligiblePulls` is that player's own
   * denominator — the pulls they were alive and present for this wave — without
   * which "hit on 3 pulls" cannot be turned into a rate for one person.
   */
  hitPlayers: Array<{ actorId: number; pulls: number; eligiblePulls: number }>;
  /** Who it killed, and on how many pulls. */
  deathPlayers: Array<{ actorId: number; pulls: number }>;
}

export interface NotableMechanic {
  name: string;
  icon: string | null;
  spellId: number;
  /** "time" means the damage was tied to the cast by timing alone — weaker. */
  mappedBy: "name" | "time";
  classification: MechanicClass;
  noteWorthy: boolean;
  /** Why it was classified this way, in one phrase, for the UI and the CLI. */
  reason: string;

  pulls: number;
  occurrences: number;
  medianHitShare: number;
  /** Share of this mechanic's hits that landed on a tank. */
  tankShare: number;
  /**
   * How much more of this mechanic the tanks eat than their headcount would
   * predict: `tankShare` divided by the tanks' share of the roster. 1.0 means
   * they take their turn like anyone else; 6.0 means it is aimed at them.
   *
   * A raw share cannot answer this, because two tanks in twenty players taking
   * 44% of the hits is wildly disproportionate while still being under half.
   * Measured on a real fight the separation is clean: 6.3 and 4.4 for the two
   * tank-facing mechanics, 1.3 or below for everything else.
   */
  tankFocus: number;
  deathsPerPull: number;
  shareOfRaidDamageTaken: number;
  totalDamage: number;
  deaths: number;

  priority: number;
  waves: MechanicWave[];

  /** What the mechanic does, measured from the log. Helps write the call. */
  profile: MechanicProfile;
  /** That profile as one line of English. Descriptive only, never an instruction. */
  description: string;

  /** Pulls a wave needs before it earns a line: three, or the whole night if shorter. */
  minPulls: number;
  /** The report was too short to meet the three-pull ideal. Say so, do not hide it. */
  thinEvidence: boolean;
}

export interface PullLength {
  fightId: number;
  durationMs: number;
}

function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((n, v) => n + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function hitShare(occurrence: MechanicOccurrence): number {
  if (occurrence.eligible.length === 0) return 0;
  return occurrence.hits.length / occurrence.eligible.length;
}

/**
 * What kind of thing this mechanic is.
 *
 * Every branch is a statement about the *distribution* of who got hit, never
 * about the ability itself — there is no boss knowledge anywhere in here.
 */
export function classify(
  series: MechanicSeries,
  roster: RaidRoster,
  minPulls = MIN_NOTE_PULLS,
): { classification: MechanicClass; reason: string } {
  const pulls = new Set(series.occurrences.map((o) => o.fightId)).size;
  if (pulls < minPulls) {
    return { classification: "unclear", reason: `seen on only ${pulls} of the analysed pulls` };
  }

  const landed = series.occurrences.filter((o) => o.hits.length > 0);
  if (landed.length === 0) {
    return { classification: "unclear", reason: "never hit anyone" };
  }

  // Tanks first: an ability that only ever reaches tanks is their job, however
  // much damage it does.
  const everyTargetIsTank = landed.every((o) => o.hits.every((h) => roster.tankIds.has(h.targetId)));
  if (everyTargetIsTank && roster.tankIds.size > 0) {
    return { classification: "tank-only", reason: "only ever hit tanks" };
  }

  const medianShare = median(landed.map(hitShare));

  // Nearly everyone, nearly always: nobody failed, the healers were busy.
  if (medianShare > MAX_FAILED_SHARE) {
    return {
      classification: "raid-wide",
      reason: `hits ${(medianShare * 100).toFixed(0)}% of the raid — unavoidable, not a mistake`,
    };
  }

  // A stable *count* of people, pull after pull, is an assignment being honoured.
  //
  // This one keeps the full three-observation requirement whatever the report
  // length: "the same number every time" is a claim about repetition, and one or
  // two occurrences have a coefficient of variation of zero for free. Relaxing it
  // would file every mechanic in a short log as somebody's soak.
  const counts = landed.map((o) => o.hits.length);
  const cv = coefficientOfVariation(counts);
  if (landed.length >= MIN_NOTE_PULLS && cv <= SOAK_CV) {
    return {
      classification: "assigned",
      reason: `always ${median(counts).toFixed(0)} players — looks like a soak`,
    };
  }

  return {
    classification: "avoidable",
    reason: `hits a median ${(medianShare * 100).toFixed(0)}% of those alive, and varies`,
  };
}

/**
 * Group every occurrence of a mechanic, across every pull, into waves by when it
 * happened.
 *
 * This replaces grouping by per-pull ordinal, and the reason is measured. A real
 * mechanic arrived in waves whose *size* varied between pulls — four casts in one
 * wave on one pull, three on the next — so one extra cast shifted every later
 * ordinal by a whole wave and produced drift of ±99s, which is the wave period.
 * The absolute times, meanwhile, were tight on every pull: 13-15s, then 81-82s,
 * then 183-186s, still within 3s of each other seven minutes in.
 *
 * So the ordinal is derived from a cross-pull time cluster rather than a per-pull
 * count. For a strictly periodic mechanic this gives exactly what counting gave
 * (its waves are single casts); for a bursty one it stops being wrong.
 *
 * `reached` counts pulls that lasted long enough to see the wave, which is the
 * honest denominator — a two-minute wipe cannot fail a mechanic at 6:00 — and is
 * the same correction aggregate.ts makes for short pulls.
 */
export function waveStats(series: MechanicSeries, pulls: PullLength[]): MechanicWave[] {
  const sorted = [...series.occurrences].sort((a, b) => a.atMs - b.atMs);
  if (sorted.length === 0) return [];

  const clusters: MechanicOccurrence[][] = [[sorted[0]]];
  for (const occurrence of sorted.slice(1)) {
    const current = clusters[clusters.length - 1];
    const previous = current[current.length - 1];
    if (occurrence.atMs - previous.atMs > WAVE_GAP_MS) clusters.push([occurrence]);
    else current.push(occurrence);
  }

  return clusters.map((cluster, index) => {
    const times = cluster.map((o) => o.atMs);
    const earliest = Math.min(...times);

    // Per-pull rollups: a wave is one event even when it contains three casts.
    const byFight = new Map<number, MechanicOccurrence[]>();
    for (const occurrence of cluster) {
      const list = byFight.get(occurrence.fightId) ?? [];
      list.push(occurrence);
      byFight.set(occurrence.fightId, list);
    }

    const perPull = [...byFight.values()];
    const failed = perPull.filter((os) => os.some((o) => o.hits.length > 0));

    const pullsByPlayer = new Map<number, number>();
    const eligibleByPlayer = new Map<number, number>();
    const deathsByPlayer = new Map<number, number>();
    for (const occurrences of perPull) {
      // Distinct players per pull: being clipped twice by one wave is one failure.
      const hitHere = new Set(occurrences.flatMap((o) => o.hits.map((h) => h.targetId)));
      for (const id of hitHere) pullsByPlayer.set(id, (pullsByPlayer.get(id) ?? 0) + 1);

      // Alive for any cast in the wave counts as having faced the wave.
      const eligibleHere = new Set(occurrences.flatMap((o) => o.eligible));
      for (const id of eligibleHere) {
        eligibleByPlayer.set(id, (eligibleByPlayer.get(id) ?? 0) + 1);
      }

      const diedHere = new Set(occurrences.flatMap((o) => o.deaths.map((d) => d.targetId)));
      for (const id of diedHere) deathsByPlayer.set(id, (deathsByPlayer.get(id) ?? 0) + 1);
    }

    // Time the wave by when it STARTS on each pull, not by every cast in it. A
    // burst of three casts spans ~8s within a single pull, so pooling all of them
    // reports a ~7s spread and calls a dead-reliable timer unreliable; the per-pull
    // starts of that same wave sit within a second of each other. The callout
    // fires once, at the front of the burst, so the front is what to measure.
    const starts = perPull.map((os) => Math.min(...os.map((o) => o.atMs)));
    const spreadMs = percentile(starts, 0.9) - percentile(starts, 0.1);
    return {
      ordinal: index + 1,
      atMs: percentile(starts, TIMER_QUANTILE),
      medianAtMs: median(starts),
      spreadMs,
      confident: spreadMs <= TIMER_TIGHT_MS,
      reached: pulls.filter((p) => p.durationMs >= earliest).length,
      seen: perPull.length,
      failedOn: failed.length,
      consistency: perPull.length > 0 ? failed.length / perPull.length : 0,
      medianCasts: median(perPull.map((os) => os.length)),
      medianHitCount: median(
        failed.map((os) => new Set(os.flatMap((o) => o.hits.map((h) => h.targetId))).size),
      ),
      deaths: cluster.reduce((n, o) => n + o.deaths.length, 0),
      hitPlayers: [...pullsByPlayer]
        .map(([actorId, pulls_]) => ({
          actorId,
          pulls: pulls_,
          // Fall back to the wave's own count rather than 0: a missing
          // eligibility record must never divide by zero or flatter a rate.
          eligiblePulls: eligibleByPlayer.get(actorId) ?? perPull.length,
        }))
        .sort((a, b) => b.pulls - a.pulls || a.actorId - b.actorId),
      deathPlayers: [...deathsByPlayer]
        .map(([actorId, pulls_]) => ({ actorId, pulls: pulls_ }))
        .sort((a, b) => b.pulls - a.pulls || a.actorId - b.actorId),
    };
  });
}

export interface NotableOptions {
  /** Total damage the raid took across the analysed pulls, for the share test. */
  totalRaidDamageTaken: number;
  pulls: PullLength[];
}

export function findNotableMechanics(
  series: MechanicSeries[],
  roster: RaidRoster,
  opts: NotableOptions,
): NotableMechanic[] {
  const pullCount = opts.pulls.length;
  const minPulls = effectiveMinPulls(pullCount);
  const thinEvidence = pullCount < MIN_NOTE_PULLS;
  const out: NotableMechanic[] = [];

  // What share of hits the tanks would take if the boss picked targets at random.
  const rosterSize = Object.keys(roster.actors).length;
  const expectedTankShare = rosterSize > 0 ? roster.tankIds.size / rosterSize : 0;

  for (const mechanic of series) {
    const { classification, reason } = classify(mechanic, roster, minPulls);
    const pulls = new Set(mechanic.occurrences.map((o) => o.fightId)).size;
    const landed = mechanic.occurrences.filter((o) => o.hits.length > 0);

    const totalDamage = mechanic.occurrences.reduce(
      (n, o) => n + o.hits.reduce((m, h) => m + h.amount, 0),
      0,
    );
    const deaths = mechanic.occurrences.reduce((n, o) => n + o.deaths.length, 0);
    const shareOfRaidDamageTaken =
      opts.totalRaidDamageTaken > 0 ? totalDamage / opts.totalRaidDamageTaken : 0;
    const deathsPerPull = pullCount > 0 ? deaths / pullCount : 0;

    const allHits = mechanic.occurrences.flatMap((o) => o.hits);
    const tankShare =
      allHits.length > 0
        ? allHits.filter((h) => roster.tankIds.has(h.targetId)).length / allHits.length
        : 0;

    const tankFocus = expectedTankShare > 0 ? tankShare / expectedTankShare : 0;

    const waves = waveStats(mechanic, opts.pulls);
    // Consistency across the whole mechanic is the best of its waves: a mechanic
    // failed reliably at one wave and never elsewhere is still worth a line, and
    // the line belongs at that wave.
    const consistency = Math.max(
      0,
      ...waves.filter((w) => w.seen >= minPulls).map((w) => w.consistency),
    );
    const impact = DEATH_WEIGHT * deathsPerPull + 100 * shareOfRaidDamageTaken;

    const significant = shareOfRaidDamageTaken >= MIN_SHARE_OF_RAID_DAMAGE || deaths > 0;
    const noteWorthy =
      classification === "avoidable" &&
      pulls >= minPulls &&
      consistency >= MIN_FAIL_CONSISTENCY &&
      significant;

    let why = reason;
    if (!noteWorthy && classification === "avoidable") {
      if (!significant) why = "too little damage and no deaths to be worth a line";
      else if (consistency < MIN_FAIL_CONSISTENCY) {
        why = `failed on too few pulls (best wave ${(consistency * 100).toFixed(0)}%)`;
      }
    }

    out.push({
      name: mechanic.name,
      icon: mechanic.icon,
      spellId: mechanic.castGameIDs[0],
      mappedBy: mechanic.mappedBy,
      classification,
      noteWorthy,
      reason: why,
      pulls,
      occurrences: mechanic.occurrences.length,
      medianHitShare: median(landed.map(hitShare)),
      tankShare,
      tankFocus,
      deathsPerPull,
      shareOfRaidDamageTaken,
      totalDamage,
      deaths,
      priority: priorityOf(impact, consistency),
      waves,
      profile: mechanic.profile,
      description: describeMechanic(mechanic.profile, { tankFocus }),
      minPulls,
      thinEvidence,
    });
  }

  return out.sort((a, b) => Number(b.noteWorthy) - Number(a.noteWorthy) || b.priority - a.priority);
}

/**
 * The waves that earn a line: each judged on its own, so a mechanic failed at the
 * third wave but not the first two gets one line at the third, not three lines.
 */
export function noteWorthyWaves(mechanic: NotableMechanic): MechanicWave[] {
  if (!mechanic.noteWorthy) return [];
  return mechanic.waves.filter(
    (w) => w.seen >= mechanic.minPulls && w.consistency >= MIN_FAIL_CONSISTENCY,
  );
}
