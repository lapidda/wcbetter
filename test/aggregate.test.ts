import assert from "node:assert/strict";
import {
  aggregateFindings,
  findRecurringDowntime,
  type PullSummary,
} from "@/lib/model/aggregate";
import { talentSimilarity } from "@/lib/model/benchmark";

// --- talent matching -------------------------------------------------------
// Hero trees are disjoint node sets, so two builds on different trees must score
// clearly apart even when their class talents are identical.
{
  const classTalents = Array.from({ length: 60 }, (_, i) => 1000 + i);
  const riderTree = Array.from({ length: 11 }, (_, i) => 2000 + i);
  const deathbringerTree = Array.from({ length: 11 }, (_, i) => 3000 + i);

  const rider = [...classTalents, ...riderTree];
  const deathbringer = [...classTalents, ...deathbringerTree];
  // Same hero tree, a couple of different class picks.
  const otherRider = [...classTalents.slice(0, 58), 9001, 9002, ...riderTree];

  const sameTree = talentSimilarity(rider, otherRider);
  const crossTree = talentSimilarity(rider, deathbringer);

  assert.ok(sameTree > crossTree, "same hero tree scores higher than a different one");
  assert.ok(sameTree > 0.9, `same tree should be a close match, got ${sameTree.toFixed(2)}`);
  assert.ok(crossTree < 0.8, `different tree should be clearly apart, got ${crossTree.toFixed(2)}`);

  assert.equal(talentSimilarity([], [1, 2]), 0, "no talent data means no claimed match");
  assert.equal(talentSimilarity([1, 2], [1, 2]), 1, "identical builds score 1");
  console.log(
    `talentSimilarity: ok (same tree ${sameTree.toFixed(2)}, cross tree ${crossTree.toFixed(2)})`,
  );
}

function pull(n: number, durationMs = 300_000): PullSummary {
  return {
    fightId: n,
    label: `Pull ${n}`,
    durationMs,
    kill: false,
    bossPercentage: 20,
    dps: 100_000,
    activeTimePct: 90,
    deaths: 0,
  };
}

function finding(id: string, gain?: number, severity: any = "major") {
  return {
    id,
    rule: id.split(":")[0],
    severity,
    title: `${id} @${gain}`,
    detail: "d",
    advice: "a",
    evidence: ["e"],
    estimatedGainPct: gain,
  };
}

// --- aggregateFindings -----------------------------------------------------
{
  const out = aggregateFindings([
    { pull: pull(1), findings: [finding("cd:1", 2), finding("cd:2", 10)] },
    { pull: pull(2), findings: [finding("cd:1", 4)] },
    { pull: pull(3), findings: [finding("cd:1", 6)] },
  ]);

  const consistent = out.find((f) => f.id === "cd:1")!;
  const oneOff = out.find((f) => f.id === "cd:2")!;

  assert.equal(consistent.occurrences, 3, "consistent seen on 3 pulls");
  assert.equal(consistent.totalPulls, 3);
  assert.equal(consistent.consistency, 1);
  assert.equal(consistent.medianGainPct, 4, "median of [2,4,6]");
  assert.equal(consistent.priority, 4, "4 * (0.4 + 0.6*1)");
  assert.match(consistent.title, /@4/, "representative is the median pull, not the worst");
  assert.equal(consistent.perPull.length, 3);
  assert.match(consistent.evidence[0], /3 of 3 pulls/);

  assert.equal(oneOff.occurrences, 1);
  assert.equal(Math.round(oneOff.consistency * 100), 33);
  assert.equal(Number(oneOff.priority.toFixed(2)), 6, "10 * (0.4 + 0.6/3)");

  // A 10% one-off still outranks a 4% habit, but the gap has narrowed from
  // 2.5x to 1.5x. That is the intended discount, not a suppression.
  assert.equal(out[0].id, "cd:2", "ranked by priority");
  console.log("aggregateFindings: ok");
}

// Aggregated titles: a group of pulls gets a title about the group, built from
// the facts each rule left behind, instead of one pull's wording next to an
// "every pull" badge.
{
  const withFacts = (id: string, facts: Record<string, number | string | string[]>, gain?: number) => ({
    ...finding(id, gain, "critical"),
    facts,
  });

  const deaths = aggregateFindings([
    { pull: pull(1), findings: [withFacts("deaths", { deaths: 1, deadMs: 30_000, killingAbilities: ["Stone Breaker"] })] },
    { pull: pull(2), findings: [withFacts("deaths", { deaths: 2, deadMs: 60_000, killingAbilities: ["Stone Breaker", "Toxic Fumes"] })] },
    { pull: pull(3), findings: [] },
  ]);
  assert.equal(deaths[0].title, "Died on 2 of 3 pulls — Stone Breaker (2), Toxic Fumes (1)");

  const single = aggregateFindings([
    { pull: pull(1), findings: [withFacts("deaths", { deaths: 1, killingAbilities: ["X"] })] },
    { pull: pull(2), findings: [] },
  ]);
  assert.match(single[0].title, /^deaths @/, "a single pull keeps the representative title");

  const cooldown = aggregateFindings([
    { pull: pull(1), findings: [withFacts("missed-cooldowns:1", { ability: "Eye Beam", missed: 2, possible: 4 }, 3)] },
    { pull: pull(2), findings: [withFacts("missed-cooldowns:1", { ability: "Eye Beam", missed: 2, possible: 4 }, 3)] },
    { pull: pull(3), findings: [withFacts("missed-cooldowns:1", { ability: "Eye Beam", missed: 1, possible: 3 }, 2)] },
  ]);
  assert.equal(cooldown[0].title, "Missed casts of Eye Beam on 3 of 3 pulls (median 2 of 4 possible)");

  const noFacts = aggregateFindings([
    { pull: pull(1), findings: [finding("consumables:1", 2)] },
    { pull: pull(2), findings: [finding("consumables:1", 2)] },
  ]);
  assert.match(noFacts[0].title, /^consumables:1 @/, "rules without facts keep the representative title");
  console.log("aggregateTitle: ok");
}

// Severity fallback for rules with no throughput estimate (deaths, avoidable damage).
{
  const out = aggregateFindings([
    { pull: pull(1), findings: [finding("deaths:x", undefined, "critical")] },
    { pull: pull(2), findings: [finding("deaths:x", undefined, "critical")] },
    { pull: pull(3), findings: [] },
  ]);
  const f = out[0];
  assert.equal(f.medianGainPct, undefined, "no invented gain number");
  assert.equal(Number(f.priority.toFixed(2)), 4.8, "6 * (0.4 + 0.6*2/3)");
  console.log("severity fallback: ok");
}

// --- findRecurringDowntime -------------------------------------------------
function profile(durationMs: number, gapStarts: number[], gapMs = 5000) {
  return {
    durationMs,
    gaps: gapStarts.map((startMs) => ({ startMs, endMs: startMs + gapMs, durationMs: gapMs })),
  } as any;
}

{
  // A stall at ~2:30 on 3 of 4 pulls, plus scattered noise that must not fire.
  const out = findRecurringDowntime([
    { pull: pull(1), profile: profile(300_000, [152_000, 40_000]) },
    { pull: pull(2), profile: profile(300_000, [155_000, 88_000]) },
    { pull: pull(3), profile: profile(300_000, [150_500, 210_000]) },
    { pull: pull(4), profile: profile(300_000, [20_000]) },
  ]);

  assert.equal(out.length, 1, "only the repeated window fires");
  assert.equal(out[0].id, "recurring-downtime:10-10", "150s / 15s bucket");
  assert.equal(out[0].occurrences, 3);
  assert.equal(out[0].totalPulls, 4);
  assert.match(out[0].title, /2:30/);
  console.log("findRecurringDowntime: ok");
}

{
  // Short pulls that ended before the window must not dilute the denominator.
  const out = findRecurringDowntime([
    { pull: pull(1), profile: profile(300_000, [152_000]) },
    { pull: pull(2), profile: profile(300_000, [155_000]) },
    { pull: pull(3), profile: profile(60_000, [20_000]) },
    { pull: pull(4), profile: profile(60_000, [30_000]) },
  ]);

  const recurring = out.find((f) => f.id === "recurring-downtime:10-10");
  assert.ok(recurring, "fires despite 2 of 4 pulls ending early");
  assert.equal(recurring.totalPulls, 2, "short pulls excluded from denominator");
  assert.equal(recurring.consistency, 1);
  console.log("short-pull denominator: ok");
}

{
  // A player who struggles through a whole phase lights up consecutive buckets.
  // That is one behaviour and must be reported as one finding, not four.
  const out = findRecurringDowntime([
    { pull: pull(1), profile: profile(300_000, [45_000, 62_000, 78_000, 91_000]) },
    { pull: pull(2), profile: profile(300_000, [47_000, 61_000, 76_000, 93_000]) },
    { pull: pull(3), profile: profile(300_000, [200_000]) },
  ]);

  assert.equal(out.length, 1, "consecutive buckets merge into one finding");
  assert.equal(out[0].id, "recurring-downtime:3-6");
  assert.match(out[0].title, /between 0:45 and 1:45/);
  assert.equal(out[0].occurrences, 2, "counts affected pulls, not gaps");
  console.log("bucket-run merge: ok");
}

// The reference set is checked in the same window, and the advice changes
// depending on whether the top parses stop there too.
{
  const pulls = [
    { pull: pull(1), profile: profile(300_000, [152_000]) },
    { pull: pull(2), profile: profile(300_000, [155_000]) },
    { pull: pull(3), profile: profile(300_000, [150_500]) },
  ];

  const forced = findRecurringDowntime(pulls, {
    members: [profile(300_000, [151_000]), profile(300_000, [153_000]), profile(300_000, []), profile(300_000, [])],
  })[0];
  assert.equal(forced.metric?.reference, "2/4 top parses", "measured, not the old hardcoded 0");
  assert.match(forced.advice, /stop here as well/);

  // The mechanic stops the top parses too, so the player is charged only for
  // the time they lose beyond them — and it never outranks something they chose.
  const avoidableOne = findRecurringDowntime(pulls, {
    members: [profile(300_000, []), profile(300_000, []), profile(300_000, []), profile(300_000, [])],
  })[0];
  assert.equal(forced.severity, "minor", "not the individual's call, so never major");
  assert.equal(avoidableOne.severity, "major", "the same window is major when only you stop");
  assert.ok(
    forced.medianGainPct! < avoidableOne.medianGainPct!,
    "forced downtime is worth less than the same gap nobody else takes",
  );
  // Both sides lose 5s in the window, so nothing is recoverable.
  assert.equal(forced.medianGainPct, 0);
  assert.equal(forced.facts?.forced, 1);
  assert.equal(forced.facts?.recoverableMs, 0);
  assert.match(forced.title, /^Forced downtime /);
  assert.match(forced.advice, /only the 0.0s difference is worth chasing/);

  // Losing more than the top parses in the same window: the excess is yours.
  const partlyYours = findRecurringDowntime(
    [
      { pull: pull(1), profile: profile(300_000, [152_000], 11_000) },
      { pull: pull(2), profile: profile(300_000, [155_000], 11_000) },
      { pull: pull(3), profile: profile(300_000, [150_500], 11_000) },
    ],
    { members: [profile(300_000, [151_000]), profile(300_000, [153_000]), profile(300_000, []), profile(300_000, [])] },
  )[0];
  assert.equal(partlyYours.facts?.recoverableMs, 6000, "11s yours minus 5s theirs");
  assert.equal(Number(partlyYours.medianGainPct!.toFixed(1)), 2, "6s of a 300s pull");
  assert.match(partlyYours.detail, /counts only the 6.0s difference/);

  const avoidable = findRecurringDowntime(pulls, {
    members: [profile(300_000, []), profile(300_000, []), profile(300_000, []), profile(300_000, [])],
  })[0];
  assert.equal(avoidable.metric?.reference, "0/4 top parses");
  assert.match(avoidable.advice, /keep casting through/);

  const unknown = findRecurringDowntime(pulls)[0];
  assert.equal(unknown.metric?.reference, "not measured", "no reference given, so say so");
  console.log("recurring-downtime reference: ok");
}

// With the enemy-side log, a recurring window is labelled with the boss cast
// that precedes it — but only when most affected pulls agree on which.
{
  const pulls = [
    { pull: pull(1), profile: profile(300_000, [152_000]) },
    { pull: pull(2), profile: profile(300_000, [155_000]) },
    { pull: pull(3), profile: profile(300_000, [150_500]) },
  ];
  const abilities = {
    7: { gameID: 7, name: "Stone Breaker", icon: null, casters: ["Ithraz"], casts: 3 },
    8: { gameID: 8, name: "Toxic Fumes", icon: null, casters: ["Vexhul"], casts: 1 },
  };
  const cast = (atMs: number, gameID: number) => ({ atMs, gameID, sourceId: 1, telegraphed: true, targetId: null, castMs: null });

  const unanimous = findRecurringDowntime(pulls, undefined, {
    abilities,
    castsByFight: { 1: [cast(150_000, 7)], 2: [cast(153_000, 7)], 3: [cast(149_000, 7)] },
  })[0];
  assert.match(unanimous.title, /right after Stone Breaker$/);
  assert.match(unanimous.detail, /On 3 of 3 affected pulls the gap starts a median 2\.0s after Stone Breaker/);
  assert.match(unanimous.advice, /keep casting through Stone Breaker/);
  assert.equal(unanimous.facts?.mechanic, "Stone Breaker");

  const mixed = findRecurringDowntime(pulls, undefined, {
    abilities,
    castsByFight: { 1: [cast(150_000, 7)], 2: [cast(153_000, 8)], 3: [] },
  })[0];
  assert.ok(!/right after/.test(mixed.title), "no consensus, no claim");
  assert.match(mixed.detail, /No single boss cast precedes it consistently/);
  assert.match(mixed.advice, /Find out what the boss does/, "falls back to the unlabelled advice");
  console.log("recurring-downtime mechanic label: ok");
}

{
  // Two pulls is below the sample floor: no pattern claims from n=2.
  assert.equal(
    findRecurringDowntime([
      { pull: pull(1), profile: profile(300_000, [152_000]) },
      { pull: pull(2), profile: profile(300_000, [153_000]) },
    ]).length,
    0,
    "needs at least 3 pulls",
  );
  console.log("sample floor: ok");
}

console.log("\nall assertions passed");
