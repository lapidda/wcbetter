import { formatNumber } from "@/lib/model/stats";
import type { PlayerProfile } from "@/lib/model/types";
import {
  severityFromGain,
  talentHedge,
  valuePerCast,
  type Finding,
  type Rule,
  type RuleContext,
} from "./types";

/**
 * How much of the pull counts as "the opener".
 *
 * Openers vary by spec and fight, so any fixed number is a compromise. 60s is
 * long enough to contain the full burst window on essentially every spec — most
 * major cooldowns are 60-180s and all of them go out at the start — and short
 * enough that it is still the scripted part of the fight, where every top parse
 * does the same thing and a difference is a genuine sequencing mistake rather
 * than a reaction to a mechanic.
 */
const OPENER_MS = 60_000;

/** How many casts of the sequence to show side by side. */
const SEQUENCE_LENGTH = 10;

/** Fraction of the reference set that must open with an ability before it is expected. */
const CONSENSUS = 0.8;

function openerCasts(profile: PlayerProfile): Array<{ atMs: number; gameID: number }> {
  return profile.castTimeline.filter((c) => c.atMs < OPENER_MS);
}

function countByAbility(casts: Array<{ gameID: number }>): Map<number, number> {
  const counts = new Map<number, number>();
  for (const cast of casts) counts.set(cast.gameID, (counts.get(cast.gameID) ?? 0) + 1);
  return counts;
}

/**
 * The opener is the most comparable part of any pull: it is scripted, everyone
 * starts from full resources with every cooldown available, and nothing has gone
 * wrong yet. A difference here is almost always a real sequencing mistake rather
 * than a reaction to a mechanic — which makes it the easiest thing in the whole
 * report to actually practise.
 */
export const opener: Rule = {
  id: "opener",
  name: "Opener",

  run({ player, reference }: RuleContext): Finding[] {
    const findings: Finding[] = [];

    const yours = openerCasts(player);
    // Reference members without a timeline cannot contribute; ignore them
    // entirely rather than letting them read as "opened with nothing".
    const refOpeners = reference.members
      .map((m) => ({ member: m, casts: openerCasts(m) }))
      .filter((r) => r.casts.length > 0);

    if (yours.length === 0 || refOpeners.length === 0) return findings;

    const yourCounts = countByAbility(yours);
    const nameOf = (gameID: number) =>
      reference.abilityNames[gameID] ?? player.abilities[gameID]?.name ?? String(gameID);

    // --- Pull latency --------------------------------------------------------
    const yourFirst = yours[0].atMs;
    const refFirsts = refOpeners.map((r) => r.casts[0].atMs).sort((a, b) => a - b);
    const refFirst = refFirsts[Math.floor(refFirsts.length / 2)];

    // 1.5s of slack: a GCD of variance is normal, and log timestamps are not
    // precise enough to argue about less than that.
    if (yourFirst > refFirst + 1500) {
      const lostSeconds = (yourFirst - refFirst) / 1000;
      const gainPct = player.durationMs > 0 ? ((yourFirst - refFirst) / player.durationMs) * 100 : 0;

      findings.push({
        id: "opener:latency",
        rule: "opener",
        severity: severityFromGain(gainPct),
        title: `You start ${lostSeconds.toFixed(1)}s later than the top parses`,
        detail:
          `Your first cast lands ${(yourFirst / 1000).toFixed(1)}s into the pull; the reference ` +
          `median is ${(refFirst / 1000).toFixed(1)}s. That is dead time at the point in the fight ` +
          `where every cooldown you own is available.`,
        advice:
          `Pre-cast into the pull timer rather than reacting to it, and make sure you are already ` +
          `in range when the count hits zero.`,
        metric: {
          label: "First cast",
          you: `${(yourFirst / 1000).toFixed(1)}s`,
          reference: `${(refFirst / 1000).toFixed(1)}s`,
        },
        evidence: refOpeners.map(
          (r) => `${r.member.name}: first cast at ${(r.casts[0].atMs / 1000).toFixed(1)}s`,
        ),
        estimatedGainPct: gainPct,
        facts: { lateMs: yourFirst - refFirst },
        anchors: [{ atMs: 0, endMs: OPENER_MS, label: "opener" }],
      });
    }

    // --- Abilities the reference set always opens with -----------------------
    const expected = new Map<number, { users: number; counts: number[] }>();
    for (const { casts } of refOpeners) {
      for (const [gameID, count] of countByAbility(casts)) {
        const entry = expected.get(gameID) ?? { users: 0, counts: [] };
        entry.users += 1;
        entry.counts.push(count);
        expected.set(gameID, entry);
      }
    }

    const needed = Math.ceil(refOpeners.length * CONSENSUS);

    for (const [gameID, entry] of expected) {
      if (entry.users < needed) continue;

      // The cast event stream carries more than the Casts table does — auto
      // attacks and channel ticks among it, which surface as unnamed ids firing
      // twice a second. If we cannot name it, we cannot give advice about it.
      if (!reference.abilityNames[gameID] && !player.abilities[gameID]) continue;

      const sorted = [...entry.counts].sort((a, b) => a - b);
      const refCount = sorted[Math.floor(sorted.length / 2)];
      const yourCount = yourCounts.get(gameID) ?? 0;

      // Either you skipped it entirely, or you are meaningfully short. Being one
      // filler cast down over a minute is variance, not a sequencing mistake.
      if (yourCount > 0 && yourCount >= refCount * 0.85) continue;
      if (yourCount >= refCount) continue;

      const missed = refCount - yourCount;
      const perCast = valuePerCast(player, reference, gameID);
      const gainPct =
        player.totalDamage > 0 ? ((missed * perCast) / player.totalDamage) * 100 : 0;

      // Casting it later in the fight is a different mistake from never casting
      // it, and the advice differs, so distinguish the two.
      const castLater = (player.abilities[gameID]?.casts ?? 0) > yourCount;
      const unmeasurable = perCast <= 0;
      const name = nameOf(gameID);

      findings.push({
        id: `opener:missing:${gameID}`,
        rule: "opener",
        severity: unmeasurable ? "minor" : severityFromGain(gainPct),
        title:
          yourCount === 0
            ? `${name} missing from your opener`
            : `${name} used ${yourCount}x in your opener, top parses use ${refCount}x`,
        detail:
          `${entry.users} of ${refOpeners.length} reference parses cast ${name} ${refCount}x in the ` +
          `first ${OPENER_MS / 1000}s. You cast it ${yourCount}x.` +
          (castLater
            ? ` You do use it later in the fight, so this is about when rather than whether — the ` +
              `opener is when your damage buffs and trinkets all line up.`
            : "") +
          (unmeasurable
            ? ` It deals no direct damage, so its value cannot be measured here.`
            : ""),
        advice: castLater
          ? `Move ${name} into your opening sequence so it lands inside your burst window.`
          : `Add ${name} to your opener.${talentHedge(reference)}`,
        metric: {
          label: `${name} in first ${OPENER_MS / 1000}s`,
          you: String(yourCount),
          reference: String(refCount),
        },
        evidence: [
          ...refOpeners.map((r) => {
            const count = countByAbility(r.casts).get(gameID) ?? 0;
            return `${r.member.name}: ${count}x`;
          }),
          perCast > 0 ? `Estimated value per cast for you: ${formatNumber(perCast)} damage` : "",
        ].filter(Boolean),
        estimatedGainPct: unmeasurable ? undefined : gainPct,
        abilityId: gameID,
        anchors: [{ atMs: 0, endMs: OPENER_MS, label: "opener" }],
      });
    }

    // --- Side-by-side sequence ----------------------------------------------
    // Only worth showing once something above has actually flagged; on a clean
    // opener it is noise.
    if (findings.length > 0) {
      // Same filter as above: auto attacks and channel ticks would otherwise
      // fill the sequence with raw ids and bury the actual buttons pressed.
      const named = (casts: Array<{ atMs: number; gameID: number }>) =>
        casts.filter((c) => reference.abilityNames[c.gameID] || player.abilities[c.gameID]);

      const sequence = (casts: Array<{ atMs: number; gameID: number }>) =>
        named(casts)
          .slice(0, SEQUENCE_LENGTH)
          .map((c, i) => `${i + 1}. ${nameOf(c.gameID)} (${(c.atMs / 1000).toFixed(1)}s)`);

      findings.push({
        id: "opener:sequence",
        rule: "opener",
        severity: "info",
        title: `Your opening casts vs the top parses`,
        detail:
          `The opener is the most comparable part of the pull — it is scripted, and everyone starts ` +
          `with full resources and every cooldown up. Read these side by side and copy the order.`,
        advice:
          `Write the reference order down and drill it on a target dummy until it is automatic. ` +
          `Nothing in the first 60s reacts to the fight, so what you practise is exactly what you ` +
          `will do on the pull.`,
        evidence: [
          "YOURS:",
          ...sequence(yours).map((line) => `  ${line}`),
          "",
          ...refOpeners.slice(0, 2).flatMap((r) => [
            `${r.member.name.toUpperCase()}:`,
            ...sequence(r.casts).map((line) => `  ${line}`),
            "",
          ]),
        ],
        anchors: [{ atMs: 0, endMs: OPENER_MS, label: "opener" }],
      });
    }

    return findings;
  },
};
