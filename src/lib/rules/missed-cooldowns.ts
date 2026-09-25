import { formatDuration, formatNumber, median } from "@/lib/model/stats";
import { severityFromGain, valuePerCast, type Finding, type Rule, type RuleContext } from "./types";

/**
 * A cooldown pressed in the last seconds of a pull does nothing, so the final
 * slot only counts if this much fight remains after it comes up. 10s is roughly
 * the time a burst cooldown's damage takes to actually land.
 */
const TAIL_MARGIN_MS = 10_000;

/** Starting a cooldown this much later than the reference is a sequencing problem, not variance. */
const LATE_START_MS = 5000;
/** Holding a cooldown this long past ready, as a median, is where a missing cast goes. */
const HELD_MS = 5000;

/**
 * Abilities with a long empirical cooldown are the highest-confidence findings
 * available: the fight length dictates how many casts were possible, so "you got
 * 3 of 5" is arithmetic rather than opinion.
 *
 * The advice is measured too. Whether to hold a cooldown for a window is a
 * rotational opinion this project deliberately does not hardcode; what the log
 * can say is *where the missing cast went* — a late first press, or a delay
 * after each one came off cooldown — and that is what gets reported.
 */
export const missedCooldowns: Rule = {
  id: "missed-cooldowns",
  name: "Missed cooldowns",

  run({ player, reference }: RuleContext): Finding[] {
    const findings: Finding[] = [];
    const minutes = player.durationMs / 60_000;
    if (minutes <= 0) return findings;

    for (const [idStr, cooldownMs] of Object.entries(reference.estimatedCooldownMs)) {
      const gameID = Number(idStr);

      // Under 30s of cooldown it is filler, not a cooldown, and the "expected
      // casts" arithmetic stops being meaningful.
      if (cooldownMs < 30_000) continue;

      // Only trust abilities most of the reference set actually used, so we do
      // not flag a talent the player simply did not pick.
      const users = reference.usageCount[gameID] ?? 0;
      if (users < Math.ceil(reference.members.length * 0.6)) continue;

      // Slots at 0, cd, 2cd, ... — the first is free at the pull, hence the +1.
      // The last slot only counts if enough fight remains after it to matter;
      // without the margin a 4:00 pull with a 120s cooldown "allows" a third
      // cast at exactly 4:00, and every long cooldown gets a phantom miss.
      const usableMs = Math.max(0, player.durationMs - TAIL_MARGIN_MS);
      const possible = Math.floor(usableMs / cooldownMs) + 1;
      const actual = player.abilities[gameID]?.casts ?? 0;
      const missed = possible - actual;
      if (missed < 1) continue;

      const name = reference.abilityNames[gameID] ?? player.abilities[gameID]?.name ?? String(gameID);
      const perCast = valuePerCast(player, reference, gameID);
      const gainPct = player.totalDamage > 0 ? ((missed * perCast) / player.totalDamage) * 100 : 0;

      // On-use trinkets, stat buffs and defensives deal no direct damage, so
      // there is nothing to value them by. Reporting a gain of 0 buried an
      // unused on-use trinket at `info`, below genuinely trivial findings.
      // Leaving the gain undefined lets it rank on severity instead, which is
      // honest: we know it was missed, we cannot say what it was worth.
      const unmeasurable = perCast <= 0;

      // --- Where did the missing cast go? -------------------------------------
      const yourCasts = player.castTimeline.filter((c) => c.gameID === gameID);
      const firstCastMs = yourCasts[0]?.atMs;
      const refFirsts = reference.members
        .map((m) => m.castTimeline.find((c) => c.gameID === gameID)?.atMs)
        .filter((t): t is number => t != null);
      const refFirstMs = refFirsts.length > 0 ? median(refFirsts) : undefined;
      const gaps = player.abilities[gameID]?.interCastGaps ?? [];
      const heldMs = gaps.length > 0 ? median(gaps.map((g) => Math.max(0, g - cooldownMs))) : 0;

      let advice: string;
      let pressedPromptly = false;

      if (player.castTimeline.length === 0) {
        // No timeline for this profile; the count is all we have.
        advice = `Getting every cast of ${name} in means pressing it the moment it is up; the missing cast is somewhere in the delays between them.`;
      } else if (firstCastMs == null) {
        advice = `${name} was never pressed on this pull. ${users} of ${reference.members.length} reference parses use it; if it is on your bars, it belongs in the opener.`;
      } else if (refFirstMs != null && firstCastMs - refFirstMs > LATE_START_MS) {
        advice =
          `Your first ${name} landed at ${formatDuration(firstCastMs)}; the top parses' median is ` +
          `${formatDuration(refFirstMs)}. Starting it that late pushes every later cast back and ` +
          `drops the last one off the end of the pull.`;
      } else if (heldMs > HELD_MS) {
        advice =
          `You pressed ${name} a median ${(heldMs / 1000).toFixed(1)}s after it came off cooldown. ` +
          `That delay, repeated, is where the missing cast went.`;
      } else {
        // Pressed on time, every time: the pull simply ended before the last
        // window. That is not a mistake, so it must not rank as one.
        pressedPromptly = true;
        advice =
          `You press ${name} promptly when it is up, so the missing cast is the pull ending before ` +
          `the last window. Nothing to change unless the pull gets longer.`;
      }

      findings.push({
        id: `missed-cooldowns:${gameID}`,
        rule: "missed-cooldowns",
        // An unmeasurable cooldown the whole reference set presses is still a
        // real miss; grade it on that rather than on a gain of zero.
        severity: pressedPromptly
          ? "info"
          : unmeasurable
            ? missed >= 2
              ? "major"
              : "minor"
            : severityFromGain(gainPct),
        title: `${missed} missed cast${missed === 1 ? "" : "s"} of ${name}`,
        detail:
          `${name} has an observed cooldown of about ${Math.round(cooldownMs / 1000)}s. Over a ` +
          `${minutes.toFixed(1)} minute fight that fits ${possible} casts (the last needs about ` +
          `${TAIL_MARGIN_MS / 1000}s of fight left to be worth pressing); you used ${actual}.` +
          (unmeasurable
            ? ` It deals no direct damage in the log — typically an on-use trinket, a stat buff or a ` +
              `defensive — so the throughput it cost cannot be measured here, only that it was missed.`
            : ""),
        advice,
        metric: { label: `${name} casts`, you: String(actual), reference: `${possible} possible` },
        evidence: [
          `Observed cooldown across top parses: ~${Math.round(cooldownMs / 1000)}s`,
          `${users}/${reference.members.length} reference parses used this ability`,
          firstCastMs != null ? `Your first cast: ${formatDuration(firstCastMs)}` : "",
          refFirstMs != null ? `Top parses' median first cast: ${formatDuration(refFirstMs)}` : "",
          gaps.length > 0 ? `Median delay after it came off cooldown: ${(heldMs / 1000).toFixed(1)}s` : "",
          perCast > 0
            ? `Estimated value per cast for you: ${formatNumber(perCast)} damage`
            : `No direct damage attributed to it, so its value cannot be estimated from the log`,
        ].filter(Boolean),
        // Undefined rather than 0: "we cannot measure this" is not "worth nothing".
        estimatedGainPct: unmeasurable || pressedPromptly ? undefined : gainPct,
        facts: { ability: name, missed, possible },
        abilityId: gameID,
      });
    }

    return findings;
  },
};
