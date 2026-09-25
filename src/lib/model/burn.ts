import type { GraphSeries } from "@/lib/wcl/fetchers";

/**
 * Boss health at which the burn (execute) phase starts.
 *
 * This is a convention, not a measurement — it is the one number in the burn
 * analysis that is chosen rather than derived. 20% is where the game's execute
 * abilities actually switch on (Execute, Kill Shot, Hammer of Wrath, Drain
 * Soul), which makes it the point the burn is genuinely a different rotation
 * rather than just the end of the fight. Change this one constant to move the
 * window.
 */
export const BURN_THRESHOLD_PCT = 20;

/** Below this much time in the window there is nothing to analyse. */
export const MIN_BURN_MS = 15_000;

/**
 * When the boss's health first fell to the burn threshold, fight-relative.
 *
 * WCL exposes no health curve, but it does expose raid damage bucketed over
 * time, and the fight record says what percentage of the boss was left at the
 * end. Cumulative damage as a fraction of the pull's total, scaled by the health
 * the pull actually removed, is the health curve — exactly, and without ever
 * needing to know the boss's hit points.
 *
 * The crossing happens somewhere inside a bucket; the bucket's start is
 * returned, which errs a second or two early rather than clipping the window.
 *
 * Returns null when the pull never got the boss that low, which is the common
 * case on progression and is a fact about the pull rather than a gap in the
 * data: you cannot analyse a burn phase you never reached.
 */
export function burnStart(
  series: GraphSeries | null,
  fight: { startTime: number; endTime: number; bossPercentage: number | null },
  thresholdPct = BURN_THRESHOLD_PCT,
): number | null {
  const points = series?.data ?? [];
  if (points.length === 0) return null;

  const total = points.reduce((sum, v) => sum + v, 0);
  if (total <= 0) return null;

  // The pull reached the burn only if it left the boss below the threshold.
  if ((fight.bossPercentage ?? 0) > thresholdPct) return null;

  // How much of the health bar this pull actually took off. A kill removes
  // ~100%; a wipe at 18.2% removed 81.8%.
  const removedPct = 100 - (fight.bossPercentage ?? 0);

  const durationMs = fight.endTime - fight.startTime;
  const offsetMs = series!.pointStart - fight.startTime;

  let cumulative = 0;
  for (const [i, value] of points.entries()) {
    cumulative += value;
    const health = 100 - (cumulative / total) * removedPct;
    if (health <= thresholdPct) {
      const atMs = offsetMs + i * series!.pointInterval;
      // A window shorter than this is a rounding artefact at the kill moment.
      return durationMs - atMs >= MIN_BURN_MS ? Math.max(0, atMs) : null;
    }
  }

  return null;
}
