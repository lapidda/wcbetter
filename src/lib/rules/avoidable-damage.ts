import { formatNumber } from "@/lib/model/stats";
import type { Finding, Rule, RuleContext, Severity } from "./types";

/** Below this share of your total damage taken, an ability is not worth a finding. */
const SIGNIFICANT_SHARE = 0.05;
/** How far above the reference median counts as excess rather than variance. */
const EXCESS_RATIO = 1.5;

/**
 * "Avoidable" is decided statistically rather than from a curated per-boss list,
 * which would rot every patch. If the top parses were almost never hit by
 * something that hit you hard, it was avoidable. Unavoidable raid damage shows
 * up in both groups and filters itself out.
 *
 * WCL's damage-taken tables carry totals but no hit counts, so significance is
 * measured as a share of your own damage taken. That is scale-free: it needs no
 * health pool, no item level, and no per-tier tuning.
 */
export const avoidableDamage: Rule = {
  id: "avoidable-damage",
  name: "Avoidable damage taken",

  run({ player, reference }: RuleContext): Finding[] {
    const findings: Finding[] = [];
    if (player.durationMs <= 0) return findings;

    for (const stat of Object.values(player.damageTaken)) {
      if (stat.total <= 0) continue;

      // Must be a meaningful slice of what hurt you, not a rounding error.
      if (stat.shareOfDamageTaken < SIGNIFICANT_SHARE) continue;

      const refDpm = reference.medianDamageTakenDpm[stat.gameID] ?? 0;
      if (refDpm > 0 && stat.damagePerMinute < refDpm * EXCESS_RATIO) continue;

      // How many reference parses avoided it entirely — the confidence signal.
      const total = reference.members.length;
      const avoidedBy = reference.members.filter((m) => !m.damageTaken[stat.gameID]).length;

      // Only call it avoidable if a real share of the best players took zero.
      if (avoidedBy < Math.ceil(total / 2)) continue;

      const sharePct = stat.shareOfDamageTaken * 100;
      const severity: Severity =
        avoidedBy === total && sharePct >= 15 ? "critical" : sharePct >= 10 ? "major" : "minor";

      findings.push({
        id: `avoidable-damage:${stat.gameID}`,
        rule: "avoidable-damage",
        severity,
        title: `${stat.name} — ${formatNumber(stat.total)} damage taken (${avoidedBy}/${total} top parses took none)`,
        detail:
          `${stat.name} was ${sharePct.toFixed(0)}% of all damage you took. ` +
          `${avoidedBy} of ${total} reference parses were never hit by it at all, which is strong ` +
          `evidence that it is fully avoidable on this fight.`,
        advice:
          `Look up what ${stat.name} is on this boss and set up a warning for it. ` +
          `Damage you do not take is healing your raid does not have to spend on you.`,
        metric: {
          label: `${stat.name} damage/min`,
          you: formatNumber(stat.damagePerMinute),
          reference: formatNumber(refDpm),
        },
        evidence: [
          `${sharePct.toFixed(0)}% of your total damage taken`,
          `Reference parses hit by it: ${total - avoidedBy}/${total}`,
          ...reference.members.map(
            (m) => `${m.name}: ${formatNumber(m.damageTaken[stat.gameID]?.total ?? 0)}`,
          ),
        ],
        abilityId: stat.gameID,
      });
    }

    return findings;
  },
};
