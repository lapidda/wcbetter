import type { AggregatedFinding } from "./aggregate";
import { median } from "./stats";
import type { PlayerProfile, ReferenceProfile } from "./types";

/**
 * One row of the rotation table: an ability you or the reference cast, with
 * your rate and theirs side by side. This is what replaces a card per ability
 * — and, unlike the cards, it also shows what you cast *instead*, because
 * over-cast abilities appear with a positive delta.
 */
export interface AbilityRow {
  gameID: number;
  name: string;
  icon: string | null;
  /** Median across your pulls. */
  yourCpm: number;
  /** Total across your pulls. */
  yourCasts: number;
  /** Median share of your own damage, 0-1. */
  yourDamageShare: number;
  /** Reference median; null when nobody in the reference set cast it. */
  refCpm: number | null;
  refUsers: number;
  /** Empirical cooldown when this is a cooldown ability (>= 30s), else null. */
  cooldownMs: number | null;
  /** "Time held": median delay past ready before you pressed it. Cooldowns only. */
  medianHeldMs: number | null;
  /** The finding about this ability, when one fired. */
  findingId?: string;
  gainDps?: number;
}

/** Same floor as missed-cooldowns: below this it is filler and "time held" means nothing. */
const COOLDOWN_FLOOR_MS = 30_000;

export function buildAbilityRows(
  profiles: PlayerProfile[],
  reference: ReferenceProfile,
  findings: AggregatedFinding[],
  medianDps: number,
): AbilityRow[] {
  const ids = new Set<number>();
  for (const p of profiles) {
    for (const [id, stat] of Object.entries(p.abilities)) {
      if (stat.casts > 0 || stat.damage > 0) ids.add(Number(id));
    }
  }
  for (const id of Object.keys(reference.medianCpm)) ids.add(Number(id));

  const rows: AbilityRow[] = [];

  for (const gameID of ids) {
    const fromProfile = profiles.find((p) => p.abilities[gameID]);
    const name = reference.abilityNames[gameID] ?? fromProfile?.abilities[gameID]?.name;
    // Unnamed ids are auto attacks and ticks; nothing useful can be said about them.
    if (!name) continue;

    const yourCpm = median(profiles.map((p) => p.abilities[gameID]?.castsPerMinute ?? 0));
    const yourCasts = profiles.reduce((n, p) => n + (p.abilities[gameID]?.casts ?? 0), 0);
    const yourDamageShare = median(
      profiles.map((p) => (p.totalDamage > 0 ? (p.abilities[gameID]?.damage ?? 0) / p.totalDamage : 0)),
    );

    const cooldown = reference.estimatedCooldownMs[gameID];
    const cooldownMs = cooldown != null && cooldown >= COOLDOWN_FLOOR_MS ? cooldown : null;
    const held = cooldownMs
      ? profiles.flatMap((p) => p.abilities[gameID]?.interCastGaps ?? []).map((g) => Math.max(0, g - cooldownMs))
      : [];

    const finding = findings.find(
      (f) => f.id === `cast-frequency:${gameID}` || f.id === `missed-cooldowns:${gameID}`,
    );

    rows.push({
      gameID,
      name,
      icon: profiles.map((p) => p.abilities[gameID]?.icon).find((i) => i != null) ?? null,
      yourCpm,
      yourCasts,
      yourDamageShare,
      refCpm: reference.medianCpm[gameID] ?? null,
      refUsers: reference.usageCount[gameID] ?? 0,
      cooldownMs,
      medianHeldMs: held.length > 0 ? median(held) : null,
      findingId: finding?.id,
      gainDps: finding?.medianGainPct != null ? (finding.medianGainPct / 100) * medianDps : undefined,
    });
  }

  // Flagged rows first by what they are worth, then the rest by how much of
  // your damage they are — the table reads as "problems, then the rotation".
  return rows.sort((a, b) => {
    const fa = a.findingId ? 1 : 0;
    const fb = b.findingId ? 1 : 0;
    if (fa !== fb) return fb - fa;
    if (fa) return (b.gainDps ?? 0) - (a.gainDps ?? 0);
    return b.yourDamageShare - a.yourDamageShare;
  });
}
