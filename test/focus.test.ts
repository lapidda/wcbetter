import assert from "node:assert/strict";
import type { AggregatedFinding } from "@/lib/model/aggregate";
import { familyOf, focusGain, isOneOff, sectionize, selectFocus } from "@/lib/model/focus";

function mk(
  id: string,
  rule: string,
  priority: number,
  gain?: number,
  occurrences = 3,
  totalPulls = 3,
  severity: AggregatedFinding["severity"] = "major",
): AggregatedFinding {
  return {
    id,
    rule,
    severity,
    title: id,
    detail: "",
    advice: "",
    evidence: [],
    occurrences,
    totalPulls,
    consistency: occurrences / totalPulls,
    medianGainPct: gain,
    priority,
    representativeFightId: 1,
    perPull: [],
  };
}

// --- familyOf --------------------------------------------------------------
assert.equal(familyOf({ rule: "active-time", id: "active-time:gaps" }), "downtime");
assert.equal(familyOf({ rule: "recurring-downtime", id: "recurring-downtime:3-5" }), "downtime");
assert.equal(familyOf({ rule: "opener", id: "opener:latency" }), "downtime", "a late start is lost time");
assert.equal(familyOf({ rule: "opener", id: "opener:sequence" }), "opener");
assert.equal(familyOf({ rule: "opener", id: "opener:missing:1" }), "rotation");
assert.equal(familyOf({ rule: "cast-frequency", id: "cast-frequency:1" }), "rotation");
assert.equal(familyOf({ rule: "missed-cooldowns", id: "missed-cooldowns:1" }), "rotation");
assert.equal(familyOf({ rule: "deaths", id: "deaths" }), "survival");
assert.equal(familyOf({ rule: "avoidable-damage", id: "avoidable-damage:1" }), "survival");
assert.equal(familyOf({ rule: "consumables", id: "consumables:1" }), "preparation");
console.log("familyOf: ok");

// --- selectFocus -----------------------------------------------------------
// The three top findings are all downtime: uptime, the gap list and the
// recurring window measure the same seconds. Only one of them may lead.
{
  const findings = [
    mk("active-time:overall", "active-time", 10, 10),
    mk("active-time:gaps", "active-time", 9, 9),
    mk("recurring-downtime:1-1", "recurring-downtime", 8, 8),
    mk("cast-frequency:1", "cast-frequency", 5, 5),
    mk("deaths", "deaths", 4, undefined, 3, 3, "critical"),
  ];
  const focus = selectFocus(findings, 100_000, 50_000);

  assert.deepEqual(
    focus.map((f) => f.findingId),
    ["active-time:overall", "cast-frequency:1", "deaths"],
    "one per family, in priority order",
  );
  assert.equal(focus[0].rank, 1);
  assert.equal(focus[0].gainDps, 10_000, "10% of 100k");
  assert.equal(focus[0].gapShare, 0.2, "10k of a 50k gap");
  assert.equal(focus[2].gainDps, undefined, "deaths carry no gain");
  console.log("selectFocus family dedup: ok");
}

// With only two families present the second pass allows a second rotation
// item, but never a second downtime item.
{
  const focus = selectFocus(
    [
      mk("active-time:overall", "active-time", 10, 10),
      mk("active-time:gaps", "active-time", 9, 9),
      mk("cast-frequency:1", "cast-frequency", 5, 5),
      mk("cast-frequency:2", "cast-frequency", 4, 4),
    ],
    100_000,
    50_000,
  );
  assert.deepEqual(
    focus.map((f) => f.findingId),
    ["active-time:overall", "cast-frequency:1", "cast-frequency:2"],
  );
  console.log("selectFocus second pass: ok");
}

// Info findings, the opener sequence card and rule errors never lead.
{
  const focus = selectFocus(
    [
      mk("opener:sequence", "opener", 20, undefined, 3, 3, "info"),
      mk("error:opener", "opener", 15, undefined, 3, 3, "info"),
      mk("cast-frequency:9", "cast-frequency", 1, 0.3, 3, 3, "info"),
      mk("consumables:1", "consumables", 0.5, 2),
    ],
    100_000,
    50_000,
  );
  assert.deepEqual(focus.map((f) => f.findingId), ["consumables:1"]);
  console.log("selectFocus exclusions: ok");
}

// --- focusGain -------------------------------------------------------------
{
  const focus = selectFocus(
    [mk("a", "active-time", 3, 10), mk("b", "cast-frequency", 2, 5), mk("deaths", "deaths", 1)],
    200_000,
    100_000,
  );
  const { pct, dps } = focusGain(focus, 200_000);
  assert.equal(pct, 12.5, "10 + 5/2, diminishing");
  assert.equal(dps, 25_000);
  console.log("focusGain: ok");
}

// --- sectionize ------------------------------------------------------------
{
  const findings = [
    mk("active-time:overall", "active-time", 10, 10, 12, 12),
    mk("active-time:gaps", "active-time", 9, 9, 12, 12),
    mk("cast-frequency:1", "cast-frequency", 5, 5, 12, 12),
    mk("consumables:1", "consumables", 1, 1, 1, 12),
    mk("error:x", "x", 0, undefined, 1, 12),
  ];
  const { sections, oneOffs } = sectionize(findings, new Set(["active-time:overall"]));

  assert.deepEqual(sections.downtime, ["active-time:gaps"], "focus item left out of its section");
  assert.deepEqual(sections.rotation, ["cast-frequency:1"]);
  assert.deepEqual(oneOffs, ["consumables:1"], "1 of 12 is a bad pull, not a habit");
  assert.ok(!Object.values(sections).flat().includes("error:x"), "errors are not findings");
  assert.equal(isOneOff({ occurrences: 1, totalPulls: 2 }), false, "1 of 2 is not enough data to call it a one-off");
  console.log("sectionize: ok");
}

console.log("\nall assertions passed");
