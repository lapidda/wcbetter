import { severityFromGain, type Finding, type Rule, type RuleContext } from "./types";

/** Only compare things the reference set held for essentially the whole fight. */
const REFERENCE_FLOOR_PCT = 90;
/** Below this fraction of the reference uptime, it is a real gap rather than variance. */
const SHORTFALL_RATIO = 0.75;

/**
 * The one place this tool uses hardcoded game knowledge, and it earns its place.
 *
 * The Buffs table returns every aura on the player, with no field distinguishing
 * one the player applied from one cast on them. Without this filter the rule
 * reports a Warlock for poor Riptide uptime, or for missing Windwalking when
 * their raid simply had no Windwalker Monk — mistakes the player cannot act on.
 *
 * Consumables are the subset that is unambiguously the player's own
 * responsibility, and the vocabulary is small and stable across expansions. The
 * failure mode is a missed finding rather than a wrong one, which is the right
 * way round.
 */
const CONSUMABLE_PATTERN = /flask|well fed|\brune\b|weapon oil|sharpening|whetstone|food|potion|elixir/i;

export const consumables: Rule = {
  id: "consumables",
  name: "Consumables",

  run({ player, reference }: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const [idStr, refPct] of Object.entries(reference.medianBuffUptime)) {
      const gameID = Number(idStr);
      if (refPct < REFERENCE_FLOOR_PCT) continue;

      const name = reference.buffNames[gameID] ?? String(gameID);
      if (!CONSUMABLE_PATTERN.test(name)) continue;

      // Require most of the reference set to have it, so we do not flag one
      // player's idiosyncratic choice.
      const holders = reference.members.filter((m) => (m.buffs[gameID]?.uptimePct ?? 0) > 0).length;
      if (holders < Math.ceil(reference.members.length * 0.8)) continue;

      const yourPct = player.buffs[gameID]?.uptimePct ?? 0;
      if (yourPct >= refPct * SHORTFALL_RATIO) continue;

      const missing = yourPct === 0;
      // Consumables are worth a couple of percent; precision here is not the point.
      const gainPct = ((refPct - yourPct) / 100) * 2;

      findings.push({
        id: `consumables:${gameID}`,
        rule: "consumables",
        severity: missing ? "major" : severityFromGain(gainPct),
        title: missing
          ? `${name} missing entirely`
          : `${name} uptime ${yourPct.toFixed(0)}% vs ${refPct.toFixed(0)}%`,
        detail: missing
          ? `${holders} of ${reference.members.length} reference parses had ${name} up for ` +
            `${refPct.toFixed(0)}% of the fight. You did not have it at all.`
          : `You held ${name} for ${yourPct.toFixed(0)}% of the fight; the reference median is ` +
            `${refPct.toFixed(0)}%.`,
        advice: `A consumable is gold, not skill. Buy it and this is fixed before the next pull.`,
        metric: {
          label: `${name} uptime`,
          you: `${yourPct.toFixed(0)}%`,
          reference: `${refPct.toFixed(0)}%`,
        },
        evidence: reference.members.map(
          (m) => `${m.name}: ${(m.buffs[gameID]?.uptimePct ?? 0).toFixed(0)}%`,
        ),
        estimatedGainPct: gainPct,
        abilityId: gameID,
      });
    }

    return findings;
  },
};
