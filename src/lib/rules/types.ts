import type { Fight } from "@/lib/wcl/types";
import type { BossCast, EnemyAbility, PlayerProfile, ReferenceProfile } from "@/lib/model/types";

export type Severity = "critical" | "major" | "minor" | "info";

export interface Finding {
  /** Stable within a run, e.g. "missed-cooldowns:31884". */
  id: string;
  rule: string;
  severity: Severity;
  title: string;
  /** What the data shows. */
  detail: string;
  /** What to actually do next pull. */
  advice: string;
  metric?: {
    label: string;
    you: string;
    reference: string;
  };
  /** Timestamps, hit counts, and other raw backing so the user can verify in the log. */
  evidence: string[];
  /**
   * Estimated throughput recovered if fixed, as a percentage of the player's own
   * total damage. Always an estimate; used for ranking, not for promises.
   */
  estimatedGainPct?: number;
  /**
   * Structured values behind the prose, so aggregation can summarise across
   * pulls ("died on 9 of 12 — Stone Breaker (6)") instead of showing one pull's
   * title next to an every-pull badge. Keys are rule-specific.
   */
  facts?: Record<string, number | string | string[]>;
  /** Fight-relative windows the UI deep-links into the log replay. */
  anchors?: Array<{ atMs: number; endMs?: number; label: string }>;
  /** The ability the finding is about, for icons and wowhead links. */
  abilityId?: number;
}

export interface RuleContext {
  player: PlayerProfile;
  reference: ReferenceProfile;
  fight: Fight;
  /** Boss mechanic casts for this pull, when the enemy-side log was available. */
  bossCasts?: BossCast[];
  enemyAbilities?: Record<number, EnemyAbility>;
}

export interface Rule {
  id: string;
  name: string;
  run(ctx: RuleContext): Finding[];
}

/**
 * What one extra cast of an ability would actually have been worth *to this
 * player*.
 *
 * Their own damage-per-cast is the honest number whenever they cast it at all.
 * When they never did, the only available figure is the reference median — but
 * that comes from players on much better gear, and using it raw tells a Heroic
 * progression player that a missed cast is worth 37% of their output. Scaling it
 * by their share of the reference's DPS removes the imported gear level.
 */
export function valuePerCast(
  player: PlayerProfile,
  reference: ReferenceProfile,
  gameID: number,
): number {
  const own = player.abilities[gameID]?.damagePerCast ?? 0;
  if (own > 0) return own;

  const referenceValue = reference.medianDamagePerCast[gameID] ?? 0;
  if (referenceValue <= 0 || reference.medianDps <= 0) return 0;

  // Never scale up: if the player out-damages the reference, their own output
  // is already the better estimate.
  const outputRatio = Math.min(1, player.dps / reference.medianDps);
  return referenceValue * outputRatio;
}

/** Severity from estimated impact, so every rule grades on the same curve. */
export function severityFromGain(gainPct: number): Severity {
  if (gainPct >= 5) return "critical";
  if (gainPct >= 2) return "major";
  if (gainPct >= 0.5) return "minor";
  return "info";
}

/**
 * Below this talent overlap the reference set may be playing a different
 * build, and rotational findings need a hedge. Above it, build matching has
 * done its job and telling the user to "check your talents" is just noise.
 */
export const WEAK_BUILD_MATCH = 0.75;

/** The talent caveat, or nothing when the reference set demonstrably plays the player's build. */
export function talentHedge(reference: Pick<ReferenceProfile, "buildMatch">): string {
  const { matched, similarity } = reference.buildMatch;
  return matched && similarity > WEAK_BUILD_MATCH
    ? ""
    : " If you are not talented into it, ignore this finding.";
}
