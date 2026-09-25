import { formatNumber } from "@/lib/model/stats";
import {
  severityFromGain,
  talentHedge,
  valuePerCast,
  type Finding,
  type Rule,
  type RuleContext,
} from "./types";

/** Below this share of the reference rate, a gap is a real priority problem rather than noise. */
const RATE_THRESHOLD = 0.75;

/**
 * Rotational drift: abilities the reference set presses far more often than you,
 * and abilities they all press that you never touched. This is the rule that
 * catches priority-order mistakes without knowing anything about the spec.
 */
export const castFrequency: Rule = {
  id: "cast-frequency",
  name: "Cast frequency vs top parses",

  run({ player, reference }: RuleContext): Finding[] {
    const findings: Finding[] = [];
    const minutes = player.durationMs / 60_000;
    if (minutes <= 0) return findings;

    const consensus = Math.ceil(reference.members.length * 0.8);

    for (const [idStr, refCpm] of Object.entries(reference.medianCpm)) {
      const gameID = Number(idStr);
      if (refCpm <= 0) continue;

      // Skip long cooldowns; missed-cooldowns owns those and says it better.
      const cooldown = reference.estimatedCooldownMs[gameID];
      if (cooldown != null && cooldown >= 30_000) continue;

      // Require near-unanimity, otherwise we are flagging a talent choice.
      if ((reference.usageCount[gameID] ?? 0) < consensus) continue;

      const yourStat = player.abilities[gameID];
      const yourCpm = yourStat?.castsPerMinute ?? 0;
      if (yourCpm >= refCpm * RATE_THRESHOLD) continue;

      const name = reference.abilityNames[gameID] ?? yourStat?.name ?? String(gameID);
      const missedCasts = (refCpm - yourCpm) * minutes;
      const perCast = valuePerCast(player, reference, gameID);
      const gainPct =
        player.totalDamage > 0 ? ((missedCasts * perCast) / player.totalDamage) * 100 : 0;

      const neverCast = (yourStat?.casts ?? 0) === 0;

      findings.push({
        id: `cast-frequency:${gameID}`,
        rule: "cast-frequency",
        severity: severityFromGain(neverCast ? Math.max(gainPct, 2) : gainPct),
        title: neverCast
          ? `You never cast ${name}`
          : `${name} cast ${Math.round((1 - yourCpm / refCpm) * 100)}% less than top parses`,
        detail: neverCast
          ? `All ${reference.usageCount[gameID]} of the reference parses used ${name} ` +
            `(median ${refCpm.toFixed(1)} casts/min). You did not cast it once.`
          : `You cast ${name} ${yourCpm.toFixed(1)} times per minute; the top parses median ` +
            `${refCpm.toFixed(1)}. Over this fight that is about ${missedCasts.toFixed(0)} fewer casts.`,
        advice: neverCast
          ? `${reference.usageCount[gameID]} of ${reference.members.length} reference parses on your ` +
            `build press ${name}; it belongs in your priority.${talentHedge(reference)}`
          : `Move ${name} higher in your priority. The rotation table shows what you cast instead.`,
        metric: {
          label: `${name} casts/min`,
          you: yourCpm.toFixed(1),
          reference: refCpm.toFixed(1),
        },
        evidence: [
          `Your casts: ${yourStat?.casts ?? 0} over ${minutes.toFixed(1)} min`,
          `Reference median rate: ${refCpm.toFixed(2)}/min across ${reference.usageCount[gameID]} parses`,
          perCast > 0 ? `Estimated value per cast for you: ${formatNumber(perCast)} damage` : "",
        ].filter(Boolean),
        estimatedGainPct: gainPct,
        facts: {
          ability: name,
          shortfallPct: Math.round((1 - yourCpm / refCpm) * 100),
          neverCast: neverCast ? 1 : 0,
        },
        abilityId: gameID,
      });
    }

    return findings;
  },
};
