import assert from "node:assert/strict";
import { BURN_THRESHOLD_PCT, MIN_BURN_MS, burnStart } from "@/lib/model/burn";
import type { GraphSeries } from "@/lib/wcl/fetchers";

/** A fight whose raid damage is spread evenly across `points` buckets. */
function evenSeries(points: number, intervalMs: number, startTime: number): GraphSeries {
  return { name: "Total", pointStart: startTime, pointInterval: intervalMs, data: Array(points).fill(1000) };
}

// --- a kill: health falls 100 -> 0, so 20% is crossed at 80% of the damage ---
{
  const fight = { startTime: 1_000_000, endTime: 1_000_000 + 200_000, bossPercentage: 0 };
  const at = burnStart(evenSeries(200, 1000, fight.startTime), fight);

  assert.ok(at != null, "a kill always reaches the burn");
  // 80% of the bar comes off in the first 160 buckets of a flat-damage pull, so
  // the crossing happens inside bucket index 159. The window is reported from
  // that bucket's start: a second early rather than a second late.
  assert.equal(at, 159_000);
  console.log(`kill: burn starts at ${at! / 1000}s of 200s`);
}

// --- a wipe that got there: 15% left, so the boss did drop below 20% ---------
{
  const fight = { startTime: 0, endTime: 300_000, bossPercentage: 15 };
  const at = burnStart(evenSeries(300, 1000, 0), fight);
  assert.ok(at != null, "a wipe below the threshold still had a burn");
  // 85 points of health came off; the 80 that reach the threshold are 94.1% of
  // the damage, i.e. inside bucket index 282 of 300.
  assert.equal(Math.round(at! / 1000), 282);
}

// A wipe that got the boss low but not below the threshold reached no burn.
assert.equal(
  burnStart(evenSeries(300, 1000, 0), { startTime: 0, endTime: 300_000, bossPercentage: 25 }),
  null,
  "25% left is not execute range",
);

// --- a wipe that never got there --------------------------------------------
{
  // Ended at 78.1%: only 21.9% of the bar came off, nowhere near 35% remaining.
  const fight = { startTime: 0, endTime: 129_000, bossPercentage: 78.1 };
  assert.equal(
    burnStart(evenSeries(129, 1000, 0), fight),
    null,
    "you cannot analyse a burn phase you never reached",
  );
}

// Exactly at the threshold is not past it.
assert.equal(
  burnStart(evenSeries(100, 1000, 0), { startTime: 0, endTime: 100_000, bossPercentage: BURN_THRESHOLD_PCT }),
  null,
);

// --- a burn too short to say anything about ---------------------------------
{
  // A pull that only crosses the threshold in its final seconds: the window is
  // a rounding artefact of the kill, not a phase.
  const fight = { startTime: 0, endTime: 100_000, bossPercentage: 0 };
  const series: GraphSeries = {
    name: "Total",
    pointStart: 0,
    pointInterval: 1000,
    // Nothing happens for 95s, then the boss is deleted.
    data: [...Array(95).fill(1), ...Array(5).fill(10_000)],
  };
  const at = burnStart(series, fight);
  assert.equal(at, null, `a window under ${MIN_BURN_MS / 1000}s is not a burn phase`);
}

// --- missing or empty data ---------------------------------------------------
assert.equal(burnStart(null, { startTime: 0, endTime: 100_000, bossPercentage: 0 }), null);
assert.equal(
  burnStart({ name: "Total", pointStart: 0, pointInterval: 1000, data: [] }, { startTime: 0, endTime: 1000, bossPercentage: 0 }),
  null,
);
assert.equal(
  burnStart({ name: "Total", pointStart: 0, pointInterval: 1000, data: [0, 0, 0] }, { startTime: 0, endTime: 3000, bossPercentage: 0 }),
  null,
  "no damage means no curve",
);

console.log("burnStart: ok");
console.log("\nall assertions passed");
