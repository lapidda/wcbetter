import { describeLead, mechanicBefore, MECHANIC_LOOKBACK_MS } from "@/lib/model/encounter";
import { formatDuration } from "@/lib/model/stats";
import { GCD_MS } from "@/lib/model/profile";
import { severityFromGain, type Finding, type Rule, type RuleContext } from "./types";

/** Gaps at least this long are worth naming individually. */
const NOTABLE_GAP_MS = 3000;

/**
 * Uptime on the boss. The headline percentage is the least useful part; the
 * value is the list of *when* you stopped casting, because that points at a
 * specific mechanic you are handling badly rather than at a vague habit.
 */
export const activeTime: Rule = {
  id: "active-time",
  name: "Uptime and downtime",

  run({ player, reference, bossCasts, enemyAbilities }: RuleContext): Finding[] {
    const findings: Finding[] = [];
    const refActive = reference.medianActiveTimePct;
    const hasBossContext = bossCasts != null && enemyAbilities != null;
    const yourActive = player.activeTimePct;

    if (refActive > 0 && yourActive > 0 && yourActive < refActive - 1) {
      // Damage scales roughly with time spent casting, so the relative shortfall
      // in active time is a reasonable first-order estimate of lost throughput.
      const gainPct = ((refActive - yourActive) / yourActive) * 100;

      findings.push({
        id: "active-time:overall",
        rule: "active-time",
        severity: severityFromGain(gainPct),
        title: `Uptime ${yourActive.toFixed(1)}% vs ${refActive.toFixed(1)}% for top parses`,
        detail:
          `You spent ${formatDuration(player.durationMs - player.activeTimeMs)} of a ` +
          `${formatDuration(player.durationMs)} fight not casting anything. The top parses on ` +
          `this fight averaged ${refActive.toFixed(1)}% uptime.`,
        advice:
          `Downtime is almost always movement without a filler. Work through the gaps one at a time ` +
          `and name the cause; the repeated causes are the ones worth practising.`,
        metric: {
          label: "Active time",
          you: `${yourActive.toFixed(1)}%`,
          reference: `${refActive.toFixed(1)}%`,
        },
        evidence: reference.members.map(
          (m) => `${m.name}: ${m.activeTimePct.toFixed(1)}% (${(m.dps / 1000).toFixed(0)}k DPS)`,
        ),
        estimatedGainPct: gainPct,
        facts: { activePct: yourActive, refActivePct: refActive },
      });
    }

    const notable = player.gaps.filter((g) => g.durationMs >= NOTABLE_GAP_MS);
    if (notable.length > 0) {
      const totalGapMs = notable.reduce((sum, g) => sum + g.durationMs, 0);
      const gainPct = player.durationMs > 0 ? (totalGapMs / player.durationMs) * 100 : 0;

      // With the enemy-side log, each gap is labelled with the boss cast that
      // preceded it. A gap with none is the player's own — a target swap,
      // resource starvation, hesitation — and is counted as such, not guessed at.
      const leads = hasBossContext ? notable.map((g) => mechanicBefore(bossCasts, enemyAbilities, g.startMs)) : [];
      const unexplained = hasBossContext ? leads.filter((l) => l == null).length : 0;

      findings.push({
        id: "active-time:gaps",
        rule: "active-time",
        severity: severityFromGain(gainPct),
        title: `${notable.length} gaps of 3s or more with no casts`,
        detail:
          `These windows total ${formatDuration(totalGapMs)}. Timestamps are relative to the pull start.` +
          (hasBossContext && unexplained > 0
            ? ` ${unexplained} of the ${notable.length} start with no boss cast in the previous ` +
              `${MECHANIC_LOOKBACK_MS / 1000}s — those are not a mechanic, they are you.`
            : ""),
        advice:
          `For each gap, find the instant cast or movement ability you could have used instead of ` +
          `nothing. A gap that repeats at the same point on every pull is a mechanic to plan for.`,
        evidence: notable
          .slice(0, 12)
          .map(
            (g, i) =>
              `${formatDuration(g.startMs)} - ${formatDuration(g.endMs)}  ` +
              `(${(g.durationMs / 1000).toFixed(1)}s, about ${Math.floor(g.durationMs / GCD_MS)} lost GCDs)` +
              (hasBossContext ? ` — ${describeLead(leads[i])}` : ""),
          ),
        estimatedGainPct: gainPct,
        facts: { gapCount: notable.length, gapMs: totalGapMs, unexplainedGaps: unexplained },
        anchors: notable.slice(0, 12).map((g) => ({
          atMs: g.startMs,
          endMs: g.endMs,
          label: `gap at ${formatDuration(g.startMs)}`,
        })),
      });
    }

    return findings;
  },
};
