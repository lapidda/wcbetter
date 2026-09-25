import assert from "node:assert/strict";
import { emptyProfile } from "@/lib/model/mechanic-profile";
import test from "node:test";
import {
  classify,
  findNotableMechanics,
  noteWorthyWaves,
  waveStats,
  type PullLength,
} from "@/lib/model/notable";
import type { MechanicOccurrence, MechanicSeries, RaidRoster } from "@/lib/model/raid";

const ROSTER: RaidRoster = {
  actors: Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [i + 1, { id: i + 1, name: `P${i + 1}`, className: "Mage" }]),
  ),
  byFight: {},
  tankIds: new Set([1, 2]),
};

const ALL = Array.from({ length: 20 }, (_, i) => i + 1);

function occurrence(
  fightId: number,
  ordinal: number,
  atMs: number,
  hitIds: number[],
  deaths = 0,
): MechanicOccurrence {
  return {
    fightId,
    ordinal,
    atMs,
    hits: hitIds.map((targetId) => ({ targetId, count: 1, amount: 1000, firstAtMs: atMs })),
    eligible: ALL,
    deaths: Array.from({ length: deaths }, (_, i) => ({
      targetId: hitIds[i] ?? 3,
      atMs: atMs + 100,
      byKillingBlow: true,
    })),
  };
}

function series(occurrences: MechanicOccurrence[], name = "Test Mechanic"): MechanicSeries {
  return {
    name,
    castGameIDs: [100],
    damageGameIDs: [100],
    icon: null,
    mappedBy: "name",
    profile: emptyProfile(),
    occurrences,
  };
}

const PULLS: PullLength[] = Array.from({ length: 6 }, (_, i) => ({
  fightId: i + 1,
  durationMs: 600_000,
}));

test("a mechanic hitting nearly everyone is raid-wide, not a failure", () => {
  const occurrences = PULLS.map((p) => occurrence(p.fightId, 1, 10_000, ALL));
  const { classification } = classify(series(occurrences), ROSTER);
  assert.equal(classification, "raid-wide");
});

test("a mechanic that only ever reaches tanks is tank-only", () => {
  const occurrences = PULLS.map((p) => occurrence(p.fightId, 1, 10_000, [1, 2]));
  const { classification } = classify(series(occurrences), ROSTER);
  assert.equal(classification, "tank-only");
});

test("a stable hit count across pulls reads as an assignment, not a mistake", () => {
  // Exactly two people, every pull, but never the same two: a soak rota.
  const occurrences = PULLS.map((p) => occurrence(p.fightId, 1, 10_000, [p.fightId + 2, p.fightId + 3]));
  const { classification } = classify(series(occurrences), ROSTER);
  assert.equal(classification, "assigned");
});

test("a varying minority of the raid is avoidable", () => {
  const counts = [3, 7, 4, 9, 2, 6];
  const occurrences = PULLS.map((p) =>
    occurrence(p.fightId, 1, 10_000, ALL.slice(3, 3 + counts[p.fightId - 1])),
  );
  const { classification } = classify(series(occurrences), ROSTER);
  assert.equal(classification, "avoidable");
});

test("too few pulls is unclear, never a finding", () => {
  const occurrences = [occurrence(1, 1, 10_000, [5]), occurrence(2, 1, 10_000, [6])];
  const { classification } = classify(series(occurrences), ROSTER);
  assert.equal(classification, "unclear");
});

test("a two-pull report still produces calls", () => {
  // The flaw this fixes: demanding three pulls of a two-pull night returned an
  // empty note, for exactly the case a raid leader most wants one — the first
  // night on a boss. The within-pull control group needs no repetition at all.
  const twoPulls = PULLS.slice(0, 2);
  const mechanic = series(
    twoPulls.map((p) => occurrence(p.fightId, 1, 60_000, [5, 6, 7].slice(0, p.fightId), 1)),
    "Ravage",
  );

  const [notable] = findNotableMechanics([mechanic], ROSTER, {
    totalRaidDamageTaken: 1_000_000,
    pulls: twoPulls,
  });

  assert.equal(notable.classification, "avoidable");
  assert.equal(notable.noteWorthy, true, "two pulls of evidence is still evidence");
  assert.equal(notable.minPulls, 2, "never demand more pulls than the night contains");
  assert.equal(notable.thinEvidence, true, "but say that it is thin");
  assert.equal(noteWorthyWaves(notable).length, 1);
});

test("a single pull is enough when the raid disagrees with itself", () => {
  // Four hit, sixteen not: those sixteen proved it was dodgeable, on one pull.
  const onePull = PULLS.slice(0, 1);
  const mechanic = series([occurrence(1, 1, 60_000, [5, 6, 7, 8], 1)], "Ravage");
  const [notable] = findNotableMechanics([mechanic], ROSTER, {
    totalRaidDamageTaken: 1_000_000,
    pulls: onePull,
  });
  assert.equal(notable.noteWorthy, true);
  assert.equal(notable.minPulls, 1);
  assert.equal(notable.thinEvidence, true);
});

test("a short report does not turn every mechanic into a soak", () => {
  // The soak test keeps its three-observation requirement whatever the report
  // length: one or two occurrences have a coefficient of variation of zero for
  // free, so relaxing it would file everything as somebody's assignment.
  const twoPulls = PULLS.slice(0, 2);
  const constant = series(
    twoPulls.map((p) => occurrence(p.fightId, 1, 60_000, [5, 6])),
    "Steady",
  );
  const { classification } = classify(constant, ROSTER, 2);
  assert.equal(classification, "avoidable", "two identical counts are not proof of a rota");
});

test("a long report keeps the full three-pull bar", () => {
  const [notable] = findNotableMechanics(
    [series(PULLS.map((p) => occurrence(p.fightId, 1, 10_000, ALL.slice(3, 3 + p.fightId), 1)))],
    ROSTER,
    { totalRaidDamageTaken: 1_000_000, pulls: PULLS },
  );
  assert.equal(notable.minPulls, 3);
  assert.equal(notable.thinEvidence, false);
});

test("waves survive a mechanic whose burst size changes between pulls", () => {
  // The regression that forced this design. Per-pull ordinals drift by a whole
  // wave when one pull has an extra cast in the first burst: ordinal 3 is at 17s
  // on pull 1 and at 81s on pull 2. Grouping on absolute time must not care.
  const occurrences = [
    // Pull 1: three casts in wave one.
    occurrence(1, 1, 13_000, [5]),
    occurrence(1, 2, 17_000, [6]),
    occurrence(1, 3, 21_000, [7]),
    occurrence(1, 4, 81_000, [8]),
    // Pull 2: only two in wave one, so everything after shifts by one ordinal.
    occurrence(2, 1, 14_000, [5]),
    occurrence(2, 2, 18_000, [6]),
    occurrence(2, 3, 82_000, [8]),
    // Pull 3: likewise.
    occurrence(3, 1, 13_000, [5]),
    occurrence(3, 2, 17_000, [6]),
    occurrence(3, 3, 81_000, [9]),
  ];

  const waves = waveStats(series(occurrences), PULLS.slice(0, 3));
  assert.equal(waves.length, 2, "two bursts, whatever their sizes");
  assert.equal(waves[0].ordinal, 1);
  assert.equal(waves[1].ordinal, 2);

  // The second wave must be timed at ~81s, not smeared across 17s and 81s.
  assert.ok(waves[1].atMs >= 80_000 && waves[1].atMs <= 82_000, `got ${waves[1].atMs}`);
  assert.ok(waves[1].confident, "a wave every pull hits within a second of is confident");
  assert.equal(waves[1].seen, 3);
});

test("a wave is timed by when it starts, not by every cast inside it", () => {
  // Three casts spanning 8s within each pull, but the pulls agree on the start.
  const occurrences = [1, 2, 3].flatMap((fightId) =>
    [81_000, 85_000, 89_000].map((at, i) => occurrence(fightId, i + 1, at, [5])),
  );
  const [wave] = waveStats(series(occurrences), PULLS.slice(0, 3));
  assert.equal(wave.medianCasts, 3);
  assert.equal(wave.atMs, 81_000, "the front of the burst");
  assert.equal(wave.spreadMs, 0);
  assert.ok(wave.confident, "pooling all three casts would call this a 7s spread");
});

test("reached counts pulls long enough to see the wave; seen counts those that did", () => {
  const pulls: PullLength[] = [
    { fightId: 1, durationMs: 600_000 },
    { fightId: 2, durationMs: 600_000 },
    { fightId: 3, durationMs: 600_000 },
    { fightId: 4, durationMs: 30_000 }, // wiped long before the late wave
  ];
  const occurrences = [
    occurrence(1, 1, 300_000, [5]),
    occurrence(2, 1, 301_000, [6]),
    occurrence(3, 1, 302_000, []),
  ];
  const [wave] = waveStats(series(occurrences), pulls);
  assert.equal(wave.reached, 3, "the 30s wipe never got there and must not count against anyone");
  assert.equal(wave.seen, 3);
  assert.equal(wave.failedOn, 2);
  assert.equal(wave.consistency, 2 / 3);
});

test("being clipped twice by one wave is one failure, not two", () => {
  const occurrences = [1, 2, 3].flatMap((fightId) => [
    occurrence(fightId, 1, 81_000, [5]),
    occurrence(fightId, 2, 85_000, [5]),
  ]);
  const [wave] = waveStats(series(occurrences), PULLS.slice(0, 3));
  assert.deepEqual(wave.hitPlayers, [{ actorId: 5, pulls: 3, eligiblePulls: 3 }]);
  assert.equal(wave.medianHitCount, 1);
});

test("only avoidable mechanics that recur and matter become note lines", () => {
  const counts = [3, 7, 4, 9, 2, 6];
  const avoidable = series(
    PULLS.map((p) => occurrence(p.fightId, 1, 10_000, ALL.slice(3, 3 + counts[p.fightId - 1]), 1)),
    "Avoidable",
  );
  const raidWide = series(
    PULLS.map((p) => occurrence(p.fightId, 1, 20_000, ALL)),
    "Unavoidable",
  );

  const notable = findNotableMechanics([avoidable, raidWide], ROSTER, {
    totalRaidDamageTaken: 1_000_000,
    pulls: PULLS,
  });

  assert.equal(notable[0].name, "Avoidable", "note-worthy sorts first");
  assert.equal(notable[0].noteWorthy, true);
  assert.equal(notable[1].noteWorthy, false);
  assert.equal(notable[1].classification, "raid-wide");
  assert.equal(noteWorthyWaves(notable[1]).length, 0, "a raid-wide mechanic yields no lines");
  assert.equal(noteWorthyWaves(notable[0]).length, 1);
});

test("a mechanic nobody fails often enough is explained, not silently dropped", () => {
  // Hit on one pull of six: real, but not a pattern worth a note line.
  const occurrences = PULLS.map((p) => occurrence(p.fightId, 1, 10_000, p.fightId === 1 ? [5] : []));
  const [mechanic] = findNotableMechanics([series(occurrences)], ROSTER, {
    totalRaidDamageTaken: 1_000_000,
    pulls: PULLS,
  });
  assert.equal(mechanic.noteWorthy, false);
  assert.match(mechanic.reason, /too few pulls|too little damage/);
});
