import { BURN_THRESHOLD_PCT } from "@/lib/model/burn";
import { formatDuration, formatNumber, median } from "@/lib/model/stats";
import type { PlayerProfile } from "@/lib/model/types";
import {
  severityFromGain,
  talentHedge,
  valuePerCast,
  type Finding,
  type Rule,
  type RuleContext,
} from "./types";

/** How many casts of the burn sequence to show side by side. */
const SEQUENCE_LENGTH = 10;

/** Fraction of the reference set that must press an ability in their burn before it is expected. */
const CONSENSUS = 0.8;

/** Below this share of the reference rate, being short is a real problem rather than variance. */
const RATE_THRESHOLD = 0.75;

interface Window {
  startMs: number;
  minutes: number;
  casts: Array<{ atMs: number; gameID: number }>;
}

function burnWindow(profile: PlayerProfile): Window | null {
  if (profile.burnStartMs == null) return null;
  const lengthMs = profile.durationMs - profile.burnStartMs;
  if (lengthMs <= 0) return null;
  return {
    startMs: profile.burnStartMs,
    minutes: lengthMs / 60_000,
    casts: profile.castTimeline.filter((c) => c.atMs >= profile.burnStartMs!),
  };
}

function ratesByAbility(w: Window): Map<number, number> {
  const counts = new Map<number, number>();
  for (const cast of w.casts) counts.set(cast.gameID, (counts.get(cast.gameID) ?? 0) + 1);
  const rates = new Map<number, number>();
  for (const [id, n] of counts) rates.set(id, w.minutes > 0 ? n / w.minutes : 0);
  return rates;
}

/**
 * The burn phase: everything after the boss drops below the execute threshold.
 *
 * It is the opener's mirror image, and comparable for the opposite reason. The
 * opener is scripted because nothing has happened yet; the burn is scripted
 * because everything is being spent — held cooldowns, potions, execute-range
 * abilities. Both are windows where every top parse does much the same thing,
 * so a difference is a real decision rather than a reaction.
 *
 * Rates, not counts: burn windows differ in length between pulls and between
 * players, so counting casts would punish anyone whose kill was faster.
 *
 * Pulls that never reached the threshold are skipped entirely. That is most of
 * a progression night, and saying nothing about them is the honest answer —
 * you cannot do a burn phase wrong if you never saw one.
 */
export const burn: Rule = {
  id: "burn",
  name: "Burn phase",

  run({ player, reference }: RuleContext): Finding[] {
    const findings: Finding[] = [];

    const yours = burnWindow(player);
    if (!yours || yours.casts.length === 0) return findings;

    const refWindows = reference.members
      .map((m) => ({ member: m, window: burnWindow(m) }))
      .filter((r): r is { member: PlayerProfile; window: Window } => r.window != null && r.window.casts.length > 0);

    // Without reference burns there is nothing to compare against — a spec's
    // burn is only meaningful next to someone else's.
    if (refWindows.length === 0) return findings;

    const nameOf = (gameID: number) =>
      reference.abilityNames[gameID] ?? player.abilities[gameID]?.name ?? String(gameID);
    const named = (gameID: number) => reference.abilityNames[gameID] != null || player.abilities[gameID] != null;

    const yourRates = ratesByAbility(yours);
    const refRates = refWindows.map((r) => ratesByAbility(r.window));

    // --- Are you pressing buttons at all in the burn? -------------------------
    const yourDensity = yours.casts.filter((c) => named(c.gameID)).length / yours.minutes;
    const refDensity = median(
      refWindows.map((r) => r.window.casts.filter((c) => named(c.gameID)).length / r.window.minutes),
    );

    if (refDensity > 0 && yourDensity < refDensity * RATE_THRESHOLD) {
      const shortfall = (refDensity - yourDensity) / refDensity;
      // Casts scale with damage, so the shortfall in the window is a first-order
      // estimate of what it cost — discounted to the window's share of the pull.
      const windowShare = (player.durationMs - yours.startMs) / player.durationMs;
      const gainPct = shortfall * windowShare * 100;

      findings.push({
        id: "burn:density",
        rule: "burn",
        severity: severityFromGain(gainPct),
        title: `You cast ${Math.round(shortfall * 100)}% less than top parses once the boss is below ${BURN_THRESHOLD_PCT}%`,
        detail:
          `Your burn phase ran from ${formatDuration(yours.startMs)} to the end of the pull ` +
          `(${yours.minutes.toFixed(1)} min) at ${yourDensity.toFixed(1)} casts/min; the top parses ` +
          `median ${refDensity.toFixed(1)} in theirs. The boss dies at the end of the pull, so this ` +
          `is the window where damage decides whether the pull is a kill.`,
        advice:
          `Something is stopping you in the burn — held cooldowns you never spend, movement, or ` +
          `dying. The sequence below shows what the top parses press once the boss is low.`,
        metric: {
          label: `Casts/min below ${BURN_THRESHOLD_PCT}%`,
          you: yourDensity.toFixed(1),
          reference: refDensity.toFixed(1),
        },
        evidence: refWindows.map(
          (r) =>
            `${r.member.name}: ${(r.window.casts.length / r.window.minutes).toFixed(1)}/min over ` +
            `${r.window.minutes.toFixed(1)} min of burn`,
        ),
        estimatedGainPct: gainPct,
        anchors: [{ atMs: yours.startMs, endMs: player.durationMs, label: "burn phase" }],
        facts: { yourDensity, refDensity, burnStartMs: yours.startMs },
      });
    }

    // --- Abilities the top parses press in their burn ------------------------
    const expected = new Map<number, number[]>();
    for (const rates of refRates) {
      for (const [gameID, rate] of rates) {
        if (!named(gameID)) continue;
        expected.set(gameID, [...(expected.get(gameID) ?? []), rate]);
      }
    }

    const needed = Math.ceil(refWindows.length * CONSENSUS);

    for (const [gameID, rates] of expected) {
      if (rates.length < needed) continue;

      const refRate = median(rates);
      const yourRate = yourRates.get(gameID) ?? 0;
      if (refRate <= 0 || yourRate >= refRate * RATE_THRESHOLD) continue;

      const missed = (refRate - yourRate) * yours.minutes;
      const perCast = valuePerCast(player, reference, gameID);
      const gainPct = player.totalDamage > 0 ? ((missed * perCast) / player.totalDamage) * 100 : 0;
      const unmeasurable = perCast <= 0;
      const name = nameOf(gameID);
      // Used elsewhere in the pull but not here is a different mistake from
      // never using it, and the fix differs.
      const usedEarlier = (player.abilities[gameID]?.casts ?? 0) > (yourRates.has(gameID) ? 1 : 0);

      findings.push({
        id: `burn:missing:${gameID}`,
        rule: "burn",
        severity: unmeasurable ? "minor" : severityFromGain(gainPct),
        title:
          yourRate === 0
            ? `${name} missing from your burn phase`
            : `${name} cast ${Math.round((1 - yourRate / refRate) * 100)}% less than top parses in the burn`,
        detail:
          `${rates.length} of ${refWindows.length} reference parses cast ${name} at a median ` +
          `${refRate.toFixed(1)}/min once the boss is below ${BURN_THRESHOLD_PCT}%. You managed ` +
          `${yourRate.toFixed(1)}/min over ${yours.minutes.toFixed(1)} minutes of burn.` +
          (yourRate === 0 && usedEarlier
            ? ` You do cast it earlier in the pull, so this is about saving it for the burn rather than whether you press it.`
            : "") +
          (unmeasurable ? ` It deals no direct damage, so its value cannot be measured here.` : ""),
        advice:
          yourRate === 0 && usedEarlier
            ? `Hold ${name} for the burn, or make sure it is available again once the boss drops below ${BURN_THRESHOLD_PCT}%.`
            : `Get ${name} into the burn phase.${talentHedge(reference)}`,
        metric: {
          label: `${name} casts/min in the burn`,
          you: yourRate.toFixed(1),
          reference: refRate.toFixed(1),
        },
        evidence: [
          ...refWindows.map((r, i) => `${r.member.name}: ${(refRates[i].get(gameID) ?? 0).toFixed(1)}/min`),
          perCast > 0 ? `Estimated value per cast for you: ${formatNumber(perCast)} damage` : "",
        ].filter(Boolean),
        estimatedGainPct: unmeasurable ? undefined : gainPct,
        abilityId: gameID,
        anchors: [{ atMs: yours.startMs, endMs: player.durationMs, label: "burn phase" }],
      });
    }

    // --- Side-by-side sequence ----------------------------------------------
    if (findings.length > 0) {
      const sequence = (w: Window) =>
        w.casts
          .filter((c) => named(c.gameID))
          .slice(0, SEQUENCE_LENGTH)
          .map((c, i) => `${i + 1}. ${nameOf(c.gameID)} (+${((c.atMs - w.startMs) / 1000).toFixed(1)}s)`);

      findings.push({
        id: "burn:sequence",
        rule: "burn",
        severity: "info",
        title: `Your burn phase vs the top parses`,
        detail:
          `The first casts after the boss dropped below ${BURN_THRESHOLD_PCT}%, timed from the ` +
          `moment each pull entered its burn. This is where held cooldowns and potions are meant ` +
          `to land.`,
        advice:
          `Decide before the pull what you are saving for the burn and what you are spending on ` +
          `cooldown. Reading these side by side tells you which the top parses chose.`,
        evidence: [
          "YOURS:",
          ...sequence(yours).map((line) => `  ${line}`),
          "",
          ...refWindows.slice(0, 2).flatMap((r) => [
            `${r.member.name.toUpperCase()}:`,
            ...sequence(r.window).map((line) => `  ${line}`),
            "",
          ]),
        ],
        anchors: [{ atMs: yours.startMs, endMs: player.durationMs, label: "burn phase" }],
      });
    }

    return findings;
  },
};
