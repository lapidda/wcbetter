import type { WclEvent } from "@/lib/wcl/types";
import { median } from "./stats";
import type { BossCast } from "./types";

// What a mechanic *does*, read off the log.
//
// WarcraftLogs has no spell descriptions — `GameAbility` exposes id, icon and
// name and nothing else — so a tooltip is not available from the data this
// project already uses. What is available is the behaviour, and for writing a
// callout the behaviour is the more useful half anyway: "2.4s cast on one player,
// splashes onto four more" tells a raid leader what to say; "Deals 400,000
// Nature damage" does not.
//
// Everything here is measurement. The profile says what happened, never what to
// do about it — the same line `describeLead` and the `<call>` placeholder draw.

/** Below this, a cast bar is too short to react to and reads as instant. */
const INSTANT_MS = 500;

/**
 * A cast names a player often enough to call the mechanic targeted. Not every
 * cast event carries a target even for a targeted ability, so this is a share
 * rather than a requirement.
 */
const TARGETED_SHARE = 0.6;

/** Someone other than the named target is hit this often ⇒ it splashes. */
const SPLASH_SHARE = 0.5;

export interface MechanicProfile {
  /** Median cast bar, ms. Null when the ability is instant or never telegraphed. */
  castMs: number | null;
  /** The cast names a player as its target most of the time. */
  targeted: boolean;
  /** The log flagged the damage as AoE. */
  aoe: boolean;
  /** Median damage of a single hit before absorbs and mitigation. */
  medianHit: number;
  /** Largest single hit seen, unmitigated. */
  maxHit: number;
  /** Share of the raw damage that was absorbed or mitigated away, 0-1. */
  soakedShare: number;
  /** Median players hit by one cast. */
  medianTargets: number;
  /**
   * The named target is not the only one hurt: people near them take it too.
   * This is the signature of a mechanic the raid has to spread or move for, and
   * it is derivable because the cast says who it aimed at and the damage says
   * who paid.
   */
  splashes: boolean;
  /** Casts that named a player, of those seen — the evidence behind `targeted`. */
  targetedCasts: number;
  totalCasts: number;
}

export interface ProfileInput {
  /** This mechanic's casts, across every analysed pull. */
  casts: BossCast[];
  /** Damage events for this mechanic's damage ids, across every analysed pull. */
  hits: WclEvent[];
  /** Report-local ids of players, so an NPC target is not mistaken for one. */
  players: Record<number, unknown>;
  /** Damage events grouped per cast, as the occurrence builder already paired them. */
  hitsPerCast: number[];
  /**
   * Per cast: whether anyone other than the cast's named target took damage from
   * it. Only casts that named a player contribute.
   */
  splashPerCast: boolean[];
}

/** A profile with nothing measured: for a series assembled without event data. */
export function emptyProfile(): MechanicProfile {
  return buildMechanicProfile({ casts: [], hits: [], players: {}, hitsPerCast: [], splashPerCast: [] });
}

export function buildMechanicProfile(input: ProfileInput): MechanicProfile {
  const { casts, hits, players } = input;

  const castTimes = casts.map((c) => c.castMs).filter((ms): ms is number => ms != null && ms > 0);
  const medianCast = castTimes.length > 0 ? median(castTimes) : 0;

  const named = casts.filter((c) => c.targetId != null && players[c.targetId] != null);
  const amounts = hits.map((e) => Number(e.unmitigatedAmount) || Number(e.amount) || 0);
  const raw = amounts.reduce((a, b) => a + b, 0);
  const landed = hits.reduce((n, e) => n + (Number(e.amount) || 0), 0);

  const splashes = input.splashPerCast;

  return {
    castMs: medianCast >= INSTANT_MS ? medianCast : null,
    targeted: casts.length > 0 && named.length / casts.length >= TARGETED_SHARE,
    aoe: hits.some((e) => e.isAoE === true),
    medianHit: amounts.length > 0 ? median(amounts) : 0,
    maxHit: amounts.length > 0 ? Math.max(...amounts) : 0,
    soakedShare: raw > 0 ? Math.max(0, (raw - landed) / raw) : 0,
    medianTargets: input.hitsPerCast.length > 0 ? median(input.hitsPerCast) : 0,
    splashes:
      splashes.length > 0 && splashes.filter(Boolean).length / splashes.length >= SPLASH_SHARE,
    targetedCasts: named.length,
    totalCasts: casts.length,
  };
}

const k = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : String(Math.round(n));

/**
 * The profile as one line of English, for the editor.
 *
 * Strictly descriptive. It will say "lands on one player and splashes onto three
 * more", which is the fact; it will not say "spread", which is the instruction
 * and the raid leader's call to make.
 */
export function describeMechanic(
  profile: MechanicProfile,
  opts: { tankFocus?: number } = {},
): string {
  const parts: string[] = [];

  parts.push(
    profile.castMs != null ? `${(profile.castMs / 1000).toFixed(1)}s cast` : "instant, no cast bar",
  );

  const targets = Math.round(profile.medianTargets);
  if (profile.targeted && profile.splashes) {
    const others = Math.max(0, targets - 1);
    parts.push(
      others > 0
        ? `aimed at one player, and ${others} other${others === 1 ? "" : "s"} nearby take it too`
        : "aimed at one player, and others nearby take it too",
    );
  } else if (profile.targeted) {
    parts.push("aimed at one player, and only they take it");
  } else if (targets <= 1) {
    parts.push("hits one player");
  } else {
    // Several people hit with no AoE flag is the shape of something applied to
    // each of them — a debuff ticking, not one blast landing.
    parts.push(profile.aoe ? `hits ${targets} at once` : `hits ${targets} separately`);
  }

  // Already measured for the fairness rules, and the single most useful
  // qualifier when deciding what to shout: a tank swap is not a raid callout.
  if ((opts.tankFocus ?? 0) >= 2) parts.push("almost always the tanks");

  if (profile.medianHit > 0) {
    parts.push(
      `${k(profile.medianHit)} a hit${profile.maxHit > profile.medianHit * 1.5 ? `, up to ${k(profile.maxHit)}` : ""}`,
    );
  }

  if (profile.soakedShare >= 0.5) {
    parts.push(`${Math.round(profile.soakedShare * 100)}% of it absorbed or mitigated away`);
  }

  return parts.join(" · ");
}

/** The spell on Wowhead. A link the reader may follow, not a request we make. */
export function wowheadUrl(spellId: number): string {
  return `https://www.wowhead.com/spell=${spellId}`;
}
