import { abilityMetaFrom, coreSteps, OPENER_CASTS, openerSequence } from "@/lib/model/opener";
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

/** Fraction of the reference set that must open with an ability before it is expected. */
const CONSENSUS = 0.8;

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

    // The first twelve rotational casts. Trinkets, potions and racials are
    // skipped: owning a trinket or a race is not a sequencing decision, and
    // counting them would shift every later cast by a slot. Casts nothing
    // names (auto attacks, channel ticks) are dropped the same way.
    const meta = abilityMetaFrom([player, ...reference.members], reference.abilityNames);
    const openerOf = (profile: PlayerProfile) => coreSteps(openerSequence(profile.castTimeline, meta));

    const yours = openerOf(player);
    // Reference members without a timeline cannot contribute; ignore them
    // entirely rather than letting them read as "opened with nothing".
    const refOpeners = reference.members
      .map((m) => ({ member: m, casts: openerOf(m) }))
      .filter((r) => r.casts.length > 0);

    if (yours.length === 0 || refOpeners.length === 0) return findings;
    const window = { atMs: 0, endMs: yours[yours.length - 1].atMs, label: "opener" };

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
        anchors: [window],
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
          `${entry.users} of ${refOpeners.length} reference parses cast ${name} ${refCount}x in their ` +
          `first ${OPENER_CASTS} casts. You cast it ${yourCount}x.` +
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
          label: `${name} in first ${OPENER_CASTS} casts`,
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
        anchors: [window],
      });
    }

    // The side-by-side sequence is not a finding: the report carries every
    // opener structured (buildOpenerComparison) and the panel renders it.

    return findings;
  },
};
