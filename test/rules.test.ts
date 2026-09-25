import assert from "node:assert/strict";
import { findGaps } from "@/lib/model/profile";
import { runRules } from "@/lib/rules";
import type { PlayerProfile, ReferenceProfile } from "@/lib/model/types";
import { BURN_THRESHOLD_PCT } from "@/lib/model/burn";
import { talentHedge } from "@/lib/rules/types";

// --- findGaps --------------------------------------------------------------
{
  const timeline = [{ atMs: 2000 }, { atMs: 3000 }, { atMs: 9000 }];
  const gaps = findGaps(timeline, 12_000, []);

  assert.deepEqual(
    gaps.map((g) => [g.startMs, g.durationMs]),
    [
      [3000, 6000],
      [9000, 3000],
      [0, 2000],
    ],
    "sub-GCD gap dropped; opener and trailing gaps counted; sorted longest first",
  );

  const withDeath = findGaps(timeline, 12_000, [
    { timestampMs: 0, atMs: 5000, killingAbility: "X", deadMs: 7000, rezzed: false, rewind: [] },
  ]);
  assert.ok(
    !withDeath.some((g) => g.startMs === 3000),
    "the gap spanning the death is excluded, not double-charged",
  );
  assert.equal(withDeath.length, 2);
  console.log("findGaps: ok");
}

// --- rule layer against a synthetic reference ------------------------------
const FIVE_MIN = 300_000;

function member(name: string, overrides: Partial<PlayerProfile> = {}): PlayerProfile {
  return {
    key: `ref:${name}`,
    name,
    actorId: 1,
    className: "Paladin",
    specName: "Retribution",
    reportCode: "ref",
    fightId: 1,
    durationMs: FIVE_MIN,
    itemLevel: 320,
    burnStartMs: null,
    totalDamage: 300_000_000,
    dps: 1_000_000,
    activeTimeMs: 291_000,
    activeTimePct: 97,
    abilities: {},
    damageTaken: {},
    buffs: {},
    deaths: [],
    talents: [1, 2, 3],
    gaps: [],
    castTimeline: [],
    ...overrides,
  };
}

// The rules re-derive consensus from the member profiles rather than trusting
// the pre-aggregated medians, so the fixture has to be internally consistent.
const members = ["A", "B", "C", "D", "E"].map((n) =>
  member(n, {
    buffs: {
      400: { gameID: 400, name: "Flask of Testing", uptimeMs: FIVE_MIN, uptimePct: 100 },
    },
  }),
);

const reference: ReferenceProfile = {
  encounterID: 1,
  encounterName: "Test Boss",
  difficulty: 5,
  className: "Paladin",
  specName: "Retribution",
  members,
  medianDps: 1_000_000,
  medianActiveTimePct: 97,
  medianCpm: { 100: 0.6, 200: 10 },
  usageCount: { 100: 5, 200: 5 },
  medianDamagePerCast: { 100: 2_000_000, 200: 200_000 },
  abilityNames: { 100: "Big Cooldown", 200: "Filler" },
  medianDamageTakenDpm: { 300: 0 },
  damageTakenNames: { 300: "Avoidable Swirly" },
  estimatedCooldownMs: { 100: 120_000 },
  medianBuffUptime: { 400: 100 },
  buffNames: { 400: "Flask of Testing" },
  buildMatch: { matched: true, similarity: 1 },
  medianItemLevel: 320,
};

const player: PlayerProfile = member("Subject", {
  key: "player",
  totalDamage: 200_000_000,
  dps: 666_666,
  activeTimeMs: 270_000,
  activeTimePct: 90,
  abilities: {
    100: {
      gameID: 100,
      name: "Big Cooldown",
      icon: null,
      casts: 1,
      castsPerMinute: 0.2,
      damage: 2_000_000,
      damagePerCast: 2_000_000,
      interCastGaps: [],
    },
    200: {
      gameID: 200,
      name: "Filler",
      icon: null,
      casts: 25,
      castsPerMinute: 5,
      damage: 5_000_000,
      damagePerCast: 200_000,
      interCastGaps: [],
    },
  },
  damageTaken: {
    300: {
      gameID: 300,
      name: "Avoidable Swirly",
      total: 4_000_000,
      damagePerMinute: 800_000,
      shareOfDamageTaken: 0.4,
    },
  },
  buffs: {},
  gaps: [{ startMs: 150_000, endMs: 158_000, durationMs: 8000 }],
});

const fight = {
  id: 1,
  encounterID: 1,
  name: "Test Boss",
  difficulty: 5,
  kill: false,
  startTime: 0,
  endTime: FIVE_MIN,
  bossPercentage: 12,
  fightPercentage: 12,
  friendlyPlayers: [1],
};

const findings = runRules({ player, reference, fight });
const byId = new Map(findings.map((f) => [f.id, f]));

assert.ok(!findings.some((f) => f.id.startsWith("error:")), "no rule threw");

{
  // 5min fight, 120s cooldown -> floor(300/120)+1 = 3 possible, 1 cast, 2 missed.
  const f = byId.get("missed-cooldowns:100");
  assert.ok(f, "missed cooldown detected");
  assert.match(f.title, /2 missed casts of Big Cooldown/);
  // 2 missed x 2M damage / 200M total = 2%
  assert.equal(Number(f.estimatedGainPct!.toFixed(2)), 2);
  assert.equal(f.severity, "major");
}

// A cooldown whose next slot would land as the boss dies is not a missed cast.
// Without the tail margin every long cooldown picks up a phantom miss.
{
  const withCasts = (durationMs: number, casts: number): PlayerProfile => ({
    ...player,
    durationMs,
    abilities: { ...player.abilities, 100: { ...player.abilities[100], casts } },
  });

  assert.ok(
    !runRules({ player: withCasts(245_000, 2), reference, fight }).some((f) => f.id === "missed-cooldowns:100"),
    "245s fight, 120s cooldown, 2 casts: the third slot at 4:00 has no fight left",
  );
  assert.ok(
    !runRules({ player: withCasts(125_000, 1), reference, fight }).some((f) => f.id === "missed-cooldowns:100"),
    "125s fight: only the opening slot fits",
  );
  assert.ok(
    runRules({ player: withCasts(260_000, 2), reference, fight }).some((f) => f.id === "missed-cooldowns:100"),
    "260s fight: the slot at 4:00 leaves 20s, so the third cast is real",
  );
  console.log("cooldown fencepost: ok");
}

{
  // 5 cpm vs reference 10: below the 75% threshold.
  const f = byId.get("cast-frequency:200");
  assert.ok(f, "cast frequency gap detected");
  assert.match(f.title, /Filler cast 50% less/);
  // (10-5) x 5min = 25 missed casts x 200k / 200M = 2.5%
  assert.equal(Number(f.estimatedGainPct!.toFixed(2)), 2.5);
}

{
  const f = byId.get("avoidable-damage:300");
  assert.ok(f, "avoidable damage detected");
  assert.match(f.title, /Avoidable Swirly — 4\.0M damage taken \(5\/5 top parses took none\)/);
  assert.equal(f.severity, "critical", "nobody in the reference set took it, and it is 40% of your damage taken");
}

// Damage everyone eats is not a mistake: unavoidable raid damage must filter itself out.
{
  const unavoidable: ReferenceProfile = {
    ...reference,
    medianDamageTakenDpm: { 300: 800_000 },
    members: members.map((m) => ({
      ...m,
      damageTaken: {
        300: {
          gameID: 300,
          name: "Avoidable Swirly",
          total: 4_000_000,
          damagePerMinute: 800_000,
          shareOfDamageTaken: 0.4,
        },
      },
    })),
  };
  assert.ok(
    !runRules({ player, reference: unavoidable, fight }).some((f) => f.id === "avoidable-damage:300"),
    "not flagged when the reference set took it too",
  );
  console.log("unavoidable-damage guard: ok");
}

{
  const f = byId.get("consumables:400");
  assert.ok(f, "missing consumable detected");
  assert.match(f.title, /Flask of Testing missing entirely/);
  assert.equal(f.severity, "major", "consumables are graded as a flat major, not by gain");
}

{
  const f = byId.get("active-time:overall");
  assert.ok(f, "uptime shortfall detected");
  // (97-90)/90 = 7.8%
  assert.equal(Number(f.estimatedGainPct!.toFixed(1)), 7.8);
  assert.equal(f.severity, "critical");
}

// An ability you never cast is valued from the reference median — which comes
// from much better geared players. Scaling by your share of their output is what
// stops a Heroic progression player being told a missed cast is worth 37% of
// their total damage.
{
  const neverCast: PlayerProfile = {
    ...player,
    abilities: { 200: player.abilities[200] }, // ability 100 never pressed
  };
  const out = runRules({ player: neverCast, reference, fight });
  const f = out.find((x) => x.id === "cast-frequency:100" || x.id === "missed-cooldowns:100");
  assert.ok(f, "never-cast ability is still flagged");

  // player 666,666 dps / reference 1,000,000 = 0.667 of their output.
  // Unscaled this would claim 3 x 2M / 200M = 3%.
  assert.equal(
    Number(f.estimatedGainPct!.toFixed(2)),
    2,
    "3 missed x (2M x 0.667) / 200M = 2%, not the unscaled 3%",
  );
  console.log("gear-normalised cast value: ok");
}

// --- opener ----------------------------------------------------------------
{
  const timeline = (spec: Array<[number, number]>) =>
    spec.map(([atMs, gameID]) => ({ atMs, gameID }));

  // Reference opens: Big Cooldown once, then Filler x4. Plus an unnamed id
  // (auto attacks) firing constantly, which must never reach a finding.
  const refOpen = timeline([
    [500, 100],
    [2000, 200],
    [4000, 200],
    [6000, 200],
    [8000, 200],
    ...Array.from({ length: 40 }, (_, i) => [500 + i * 1000, 999999] as [number, number]),
  ]);

  const openReference: ReferenceProfile = {
    ...reference,
    members: members.map((m) => ({ ...m, castTimeline: refOpen })),
  };

  // Player starts 4s late, skips the cooldown, and only gets 2 fillers out.
  const latePlayer: PlayerProfile = {
    ...player,
    castTimeline: timeline([
      [4500, 200],
      [7000, 200],
    ]),
  };

  const out = runRules({ player: latePlayer, reference: openReference, fight });
  const ids = out.map((f) => f.id);

  assert.ok(ids.includes("opener:latency"), "late start detected");
  assert.match(
    out.find((f) => f.id === "opener:latency")!.title,
    /4\.0s later/,
    "4.5s vs reference median 0.5s",
  );

  assert.ok(ids.includes("opener:missing:100"), "cooldown absent from opener detected");
  assert.match(out.find((f) => f.id === "opener:missing:100")!.title, /missing from your opener/);

  assert.ok(ids.includes("opener:missing:200"), "filler shortfall detected (2 of 4)");
  assert.ok(ids.includes("opener:sequence"), "side-by-side sequence emitted");

  assert.ok(
    !ids.some((id) => id.includes("999999")),
    "unnamed ids (auto attacks) never produce a finding",
  );
  assert.ok(
    !out.find((f) => f.id === "opener:sequence")!.evidence.some((e) => e.includes("999999")),
    "unnamed ids are kept out of the sequence card too",
  );
  console.log("opener: ok");
}

// A clean opener produces nothing at all, including no sequence card.
{
  const same = timelineOf([
    [500, 100],
    [2000, 200],
  ]);
  const clean = runRules({
    player: { ...player, castTimeline: same },
    reference: { ...reference, members: members.map((m) => ({ ...m, castTimeline: same })) },
    fight,
  });
  assert.ok(
    !clean.some((f) => f.rule === "opener"),
    "matching the reference opener yields no opener findings",
  );
  console.log("clean-opener guard: ok");
}

function timelineOf(spec: Array<[number, number]>) {
  return spec.map(([atMs, gameID]) => ({ atMs, gameID }));
}

// --- deaths: what the time dead actually cost ------------------------------
// The estimate is the player's own alive-rate applied to the seconds they were
// dead — not "the rest of the fight", which is what made an earlier version of
// this claim +71%.
{
  const died = (deadMs: number, rezzed: boolean): PlayerProfile => ({
    ...player,
    deaths: [
      {
        timestampMs: 0,
        atMs: 200_000,
        killingAbility: "Stone Breaker",
        deadMs,
        rezzed,
        rewind: [{ atMs: 199_000, ability: "Stone Breaker", amount: 900_000 }],
      },
    ],
  });
  const find = (p: PlayerProfile) => runRules({ player: p, reference, fight }).find((f) => f.id === "deaths")!;

  // Dead 30s of a 300s pull: alive 270s, so 30/270 = 11.1% more damage.
  const rezzedFast = find(died(30_000, true));
  assert.equal(Number(rezzedFast.estimatedGainPct!.toFixed(1)), 11.1);
  assert.match(rezzedFast.detail, /battle-rezzed, so the clock stops at the rez/);
  assert.match(rezzedFast.detail, /0:30 of a 5:00 pull dead/);
  assert.equal(rezzedFast.facts?.deadMs, 30_000);

  // No rez, dead for the last 100s: 100/200 = 50%.
  const noRez = find(died(100_000, false));
  assert.equal(Number(noRez.estimatedGainPct!.toFixed(1)), 50);
  assert.match(noRez.detail, /no rez, so it ran to the end of the pull/);
  assert.equal(noRez.severity, "critical");

  // Even a cheap death stays major: it is a wipe risk, not just a DPS number.
  const trivial = find(died(1000, true));
  assert.ok(trivial.estimatedGainPct! < 0.5, "a 1s death is worth almost nothing");
  assert.equal(trivial.severity, "major", "but it is never graded below major");
  console.log("death cost: ok");
}

// --- copy that does the reading for the user ------------------------------
// Deaths: one big hit vs chip damage is decided in code, not left as homework.
{
  const died = (rewind: PlayerProfile["deaths"][number]["rewind"], killer: string | null): PlayerProfile => ({
    ...player,
    deaths: [
      { timestampMs: 0, atMs: 100_000, killingAbility: killer, deadMs: 20_000, rezzed: true, rewind },
    ],
  });
  const adviceFor = (p: PlayerProfile) => runRules({ player: p, reference, fight }).find((f) => f.id === "deaths")!;

  const oneShot = adviceFor(
    died(
      [
        { atMs: 95_000, ability: "Chip", amount: 100_000 },
        { atMs: 99_000, ability: "Stone Breaker", amount: 900_000 },
      ],
      "Stone Breaker",
    ),
  );
  assert.match(oneShot.advice, /One hit did it: Stone Breaker for 900\.0k, 90%/);
  assert.deepEqual(oneShot.facts?.killingAbilities, ["Stone Breaker"]);

  const chip = adviceFor(
    died(
      [
        { atMs: 92_000, ability: "Ooze", amount: 300_000 },
        { atMs: 95_000, ability: "Ooze", amount: 300_000 },
        { atMs: 99_000, ability: "Melee", amount: 350_000 },
      ],
      "Melee",
    ),
  );
  assert.match(chip.advice, /No single hit did it — 3 hits over 7\.0s, the largest Melee at 37%/);

  assert.match(adviceFor(died([], null)).advice, /not visible in the log/);
  console.log("deaths advice: ok");
}

// The talent hedge only appears when build matching could not vouch for the reference set.
{
  assert.equal(talentHedge({ buildMatch: { matched: true, similarity: 0.9 } }), "");
  assert.match(talentHedge({ buildMatch: { matched: true, similarity: 0.6 } }), /not talented/);
  assert.match(talentHedge({ buildMatch: { matched: false, similarity: 0 } }), /not talented/);

  const weak: ReferenceProfile = { ...reference, buildMatch: { matched: true, similarity: 0.6 } };
  // Ability 200 is the no-cooldown filler; never casting it is cast-frequency's
  // territory (100 has a 120s cooldown and belongs to missed-cooldowns).
  const neverCast: PlayerProfile = { ...player, abilities: { 100: player.abilities[100] } };
  const strongAdvice = runRules({ player: neverCast, reference, fight }).find((f) => f.id === "cast-frequency:200")!.advice;
  const weakAdvice = runRules({ player: neverCast, reference: weak, fight }).find((f) => f.id === "cast-frequency:200")!.advice;
  assert.ok(!/not talented/.test(strongAdvice), "96% build match: no hedge");
  assert.match(weakAdvice, /not talented/);
  console.log("talent hedge: ok");
}

// Missed cooldowns say where the cast went instead of stating a rotational opinion.
{
  const refWithTimeline: ReferenceProfile = {
    ...reference,
    members: members.map((m) => ({ ...m, castTimeline: [{ atMs: 1000, gameID: 100 }] })),
  };
  // 300s fight, 120s cooldown: 3 possible; 2 casts -> 1 missed.
  const cd = (timeline: Array<{ atMs: number; gameID: number }>, gaps: number[]): PlayerProfile => ({
    ...player,
    castTimeline: timeline,
    abilities: { ...player.abilities, 100: { ...player.abilities[100], casts: 2, interCastGaps: gaps } },
  });
  const find = (p: PlayerProfile) =>
    runRules({ player: p, reference: refWithTimeline, fight }).find((f) => f.id === "missed-cooldowns:100")!;

  const late = find(cd([{ atMs: 20_000, gameID: 100 }, { atMs: 140_000, gameID: 100 }], [120_000]));
  assert.match(late.advice, /Your first Big Cooldown landed at 0:20; the top parses' median is 0:01/);

  const held = find(cd([{ atMs: 1000, gameID: 100 }, { atMs: 131_000, gameID: 100 }], [130_000, 128_000]));
  assert.match(held.advice, /a median 9\.0s after it came off cooldown/);
  // 1 missed cast x 2M / 200M total = 1%: a real finding, graded minor by gain.
  assert.equal(held.severity, "minor");
  assert.equal(Number(held.estimatedGainPct!.toFixed(2)), 1);

  const prompt = find(cd([{ atMs: 1000, gameID: 100 }, { atMs: 122_000, gameID: 100 }], [121_000]));
  assert.match(prompt.advice, /press Big Cooldown promptly/);
  assert.equal(prompt.severity, "info", "pressing it on time is not a mistake");
  assert.equal(prompt.estimatedGainPct, undefined);
  assert.deepEqual(prompt.facts, { ability: "Big Cooldown", missed: 1, possible: 3 });
  console.log("cooldown advice: ok");
}

// --- burn phase -------------------------------------------------------------
// Rates, not counts: burn windows differ in length, so a faster kill must not
// look like a worse burn.
{
  const timeline = (spec: Array<[number, number]>) => spec.map(([atMs, gameID]) => ({ atMs, gameID }));

  // Reference burns start at 4:00 of a 5:00 pull and spam Filler 10x + the cooldown once.
  const refBurn = timeline([
    [240_000, 100],
    ...Array.from({ length: 10 }, (_, i) => [242_000 + i * 5000, 200] as [number, number]),
  ]);
  const burnReference: ReferenceProfile = {
    ...reference,
    members: members.map((m) => ({ ...m, burnStartMs: 240_000, castTimeline: refBurn })),
  };

  // The player reaches the burn but only presses the filler twice and never the cooldown.
  const weak: PlayerProfile = {
    ...player,
    burnStartMs: 240_000,
    castTimeline: timeline([
      [245_000, 200],
      [260_000, 200],
    ]),
  };

  const out = runRules({ player: weak, reference: burnReference, fight });
  const ids = out.map((f) => f.id);

  assert.ok(ids.includes("burn:density"), "casting far less in the burn is flagged");
  assert.match(
    out.find((f) => f.id === "burn:density")!.title,
    new RegExp(`You cast \\d+% less than top parses once the boss is below ${BURN_THRESHOLD_PCT}%`),
  );
  assert.ok(ids.includes("burn:missing:100"), "a cooldown the reference spends in the burn");
  assert.ok(ids.includes("burn:missing:200"), "and the filler they press ten times");
  assert.ok(ids.includes("burn:sequence"), "side-by-side sequence emitted");

  // A pull that never reached execute range says nothing at all.
  const neverGotThere: PlayerProfile = { ...weak, burnStartMs: null };
  assert.equal(
    runRules({ player: neverGotThere, reference: burnReference, fight }).filter((f) => f.rule === "burn").length,
    0,
    "no burn phase, no burn findings",
  );

  // Neither does a reference set that never reached it — nothing to compare to.
  const noRefBurn: ReferenceProfile = { ...reference, members: members.map((m) => ({ ...m, burnStartMs: null })) };
  assert.equal(
    runRules({ player: weak, reference: noRefBurn, fight }).filter((f) => f.rule === "burn").length,
    0,
  );

  // Matching the reference rate over a shorter window is not a finding.
  const fastKill: PlayerProfile = {
    ...player,
    durationMs: FIVE_MIN,
    burnStartMs: 270_000,
    castTimeline: timeline([
      [271_000, 100],
      ...Array.from({ length: 5 }, (_, i) => [272_000 + i * 5000, 200] as [number, number]),
    ]),
  };
  const fastOut = runRules({ player: fastKill, reference: burnReference, fight }).filter((f) => f.rule === "burn");
  assert.equal(fastOut.length, 0, "same casts/min over half the window is the same performance");
  console.log("burn phase: ok");
}

// A cooldown the reference set barely uses must not be flagged as a mistake:
// that is a talent difference, not a missed press.
{
  const narrow: ReferenceProfile = { ...reference, usageCount: { 100: 2, 200: 5 } };
  const out = runRules({ player, reference: narrow, fight });
  assert.ok(
    !out.some((f) => f.id === "missed-cooldowns:100"),
    "abilities used by <60% of the reference set are ignored",
  );
  console.log("talent-difference guard: ok");
}

console.log(`rules: ok (${findings.length} findings, top = ${findings[0].id})`);
console.log("\nall assertions passed");
