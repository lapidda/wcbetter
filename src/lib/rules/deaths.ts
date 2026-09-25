import { describeLead, mechanicBefore } from "@/lib/model/encounter";
import { formatDuration, formatNumber } from "@/lib/model/stats";
import { severityFromGain, type Finding, type Rule, type RuleContext } from "./types";

/** Above this share of the last 10s of damage, one ability is "what killed you". */
const ONE_HIT_SHARE = 0.5;

/**
 * A death is the most expensive mistake available, so it is always reported,
 * and always with the damage that led into it.
 *
 * This emits a single finding per pull rather than one per killing ability. On a
 * progression night that is the difference between "you died on 12 of 12 pulls,
 * here are the causes" and eight separate findings that each look like a
 * one-off. The cause breakdown lives in the evidence, where it belongs.
 *
 * The cost is measured rather than assumed. Time dead runs to the battle rez
 * when there was one — detected from the first cast afterwards — not to the end
 * of the pull, which is what made an earlier version of this claim "+71% DPS
 * available" and get the gain removed entirely. The rate used is the player's
 * own damage over the time they were *alive*, so the estimate answers a
 * question the log can actually settle: what would those seconds have been
 * worth at the rate you were already going?
 */
export const deaths: Rule = {
  id: "deaths",
  name: "Deaths",

  run({ player, reference, bossCasts, enemyAbilities }: RuleContext): Finding[] {
    if (player.deaths.length === 0) return [];

    const referenceDeaths = reference.members.reduce((sum, m) => sum + m.deaths.length, 0);
    const first = player.deaths[0];

    // What the boss was doing when you died, from the enemy-side log.
    const lead =
      bossCasts != null && enemyAbilities != null ? mechanicBefore(bossCasts, enemyAbilities, first.atMs) : undefined;

    const causes = player.deaths
      .map((d) => `${formatDuration(d.atMs)} — ${d.killingAbility ?? "unknown"}`)
      .join(", ");

    // --- What the deaths cost -------------------------------------------------
    const deadMs = player.deaths.reduce((sum, d) => sum + d.deadMs, 0);
    const aliveMs = Math.max(1, player.durationMs - deadMs);
    const aliveDps = player.totalDamage / (aliveMs / 1000);
    const lostDamage = aliveDps * (deadMs / 1000);
    // Same denominator as every other finding: a share of the player's own total.
    const gainPct = player.totalDamage > 0 ? (lostDamage / player.totalDamage) * 100 : 0;

    const rezzed = player.deaths.filter((d) => d.rezzed).length;

    // Read the rewind so the user does not have to: was it one big hit, or was
    // the player already low when something small finished them?
    const rewind = first.rewind;
    const sum = rewind.reduce((s, e) => s + e.amount, 0);
    const big = rewind.reduce((a, b) => (b.amount > a.amount ? b : a), rewind[0]);
    const bigPct = sum > 0 ? Math.round((big.amount / sum) * 100) : 0;
    const spanS = rewind.length > 1 ? (rewind[rewind.length - 1].atMs - rewind[0].atMs) / 1000 : 0;

    const advice =
      rewind.length === 0
        ? `No damage was logged in the 10s before this death, so the cause is not visible in the log.`
        : big.amount / sum > ONE_HIT_SHARE
          ? `One hit did it: ${big.ability} for ${formatNumber(big.amount)}, ${bigPct}% of the damage ` +
            `in the last 10s. A defensive or a position change for ${big.ability} is the fix.`
          : `No single hit did it — ${rewind.length} hits over ${spanS.toFixed(1)}s, the largest ` +
            `${big.ability} at ${bigPct}%. You were already low; a defensive or healthstone before ` +
            `the last one would have held.`;

    return [
      {
        id: "deaths",
        rule: "deaths",
        // Dying is a judgement call as well as a number: even a cheap death is
        // a wipe risk, so it never grades below major on its gain alone.
        severity: gainPct >= 5 ? "critical" : severityFromGain(gainPct) === "critical" ? "critical" : "major",
        title:
          player.deaths.length === 1
            ? `Died at ${formatDuration(first.atMs)} to ${first.killingAbility ?? "an unknown ability"}`
            : `Died ${player.deaths.length}x (${causes})`,
        detail:
          `You spent ${formatDuration(deadMs)} of a ${formatDuration(player.durationMs)} pull dead` +
          (rezzed > 0
            ? ` (${rezzed === player.deaths.length ? "battle-rezzed" : `${rezzed} battle-rezzed`}, so the clock stops at the rez).`
            : ` — no rez, so it ran to the end of the pull.`) +
          ` At the ${formatNumber(aliveDps)} DPS you were doing while alive, that is about ` +
          `${formatNumber(lostDamage)} damage, or ${gainPct.toFixed(0)}% of your total. ` +
          `Across the ${reference.members.length} reference parses there were ${referenceDeaths} deaths in total.`,
        advice,
        metric: {
          label: "Time dead",
          you: formatDuration(deadMs),
          reference: `${(referenceDeaths / reference.members.length).toFixed(1)} deaths avg`,
        },
        evidence: [
          ...player.deaths.map(
            (d) =>
              `${formatDuration(d.atMs)} — killed by ${d.killingAbility ?? "unknown"}, dead ` +
              `${formatDuration(d.deadMs)}${d.rezzed ? " (battle rez)" : " (to the end)"}`,
          ),
          `Your DPS while alive: ${formatNumber(aliveDps)}`,
          ...(lead !== undefined ? [`Last boss cast before the first death: ${describeLead(lead)}`] : []),
          ...(rewind.length > 0
            ? [
                `Damage into the first death:`,
                ...rewind.map(
                  (e) => `  ${formatDuration(e.atMs)}  ${e.ability}  ${formatNumber(e.amount)}`,
                ),
              ]
            : []),
        ],
        estimatedGainPct: gainPct,
        anchors: player.deaths.map((d) => ({
          atMs: Math.max(0, d.atMs - 10_000),
          endMs: d.atMs,
          label: `death at ${formatDuration(d.atMs)}`,
        })),
        facts: {
          deaths: player.deaths.length,
          deadMs,
          killingAbilities: player.deaths.map((d) => d.killingAbility ?? "unknown"),
          ...(lead ? { mechanic: lead.name } : {}),
        },
      },
    ];
  },
};
