import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeRaid,
  buildActorIndex,
  damageAbilityNames,
  deadIntervals,
  mapDamageToMechanics,
  raidDeaths,
  type RaidInput,
} from "@/lib/model/raid";
import type { Actor, Fight, WclEvent } from "@/lib/wcl/types";

// The fixtures are deliberately small and hand-written: every number below is
// chosen to sit on one side of a threshold, so a regression moves a count rather
// than merely perturbing a total.

const FIGHT: Fight = {
  id: 1,
  encounterID: 9000,
  name: "Test Boss",
  difficulty: 5,
  kill: false,
  startTime: 1_000_000,
  endTime: 1_060_000, // one minute
  bossPercentage: 40,
  fightPercentage: 40,
  friendlyPlayers: [1, 2, 3, 4],
};

const ACTORS: Actor[] = [
  { id: 1, name: "Tank", type: "Player", subType: "Warrior", server: null },
  { id: 2, name: "Alyx", type: "Player", subType: "Mage", server: null },
  { id: 3, name: "Ren", type: "Player", subType: "Rogue", server: null },
  { id: 4, name: "Vex", type: "Player", subType: "Priest", server: null },
  { id: 90, name: "Test Boss", type: "NPC", subType: "Boss", server: null },
];

const MELEE = 100; // 40 swings in a minute on one target: unmistakably melee
const BREAKER = 200; // cast and damage share an id, so it maps by name
const MISSILE_CAST = 300; // cast id with no damage under the same name
const MISSILE_DAMAGE = 301; // ...its damage, which only the time fallback can find

function hit(abilityGameID: number, targetID: number, atMs: number, amount = 1000): WclEvent {
  return { timestamp: FIGHT.startTime + atMs, type: "damage", abilityGameID, targetID, amount };
}

function baseInput(overrides: Partial<RaidInput> = {}): RaidInput {
  const events: WclEvent[] = [];
  for (let i = 0; i < 40; i++) events.push(hit(MELEE, 1, i * 1500, 500));
  // Breaker at 10s: two of the four get hit, twice each.
  events.push(hit(BREAKER, 2, 10_200), hit(BREAKER, 2, 10_900));
  events.push(hit(BREAKER, 3, 10_400));
  // Breaker at 40s: only one.
  events.push(hit(BREAKER, 3, 40_300));
  // Missile damage, always just after its cast.
  events.push(hit(MISSILE_DAMAGE, 2, 20_600), hit(MISSILE_DAMAGE, 3, 20_700));
  events.push(hit(MISSILE_DAMAGE, 4, 50_500));

  return {
    fights: [FIGHT],
    actors: ACTORS,
    context: {
      abilities: {
        [BREAKER]: { gameID: BREAKER, name: "Stone Breaker", icon: "b.jpg", casters: [], casts: 2 },
        [MISSILE_CAST]: { gameID: MISSILE_CAST, name: "Coiling Ichor", icon: null, casters: [], casts: 2 },
      },
      castsByFight: {
        1: [
          { atMs: 10_000, gameID: BREAKER, sourceId: 90, telegraphed: true, targetId: null, castMs: null },
          { atMs: 20_000, gameID: MISSILE_CAST, sourceId: 90, telegraphed: false, targetId: null, castMs: null },
          { atMs: 40_000, gameID: BREAKER, sourceId: 90, telegraphed: true, targetId: null, castMs: null },
          { atMs: 50_000, gameID: MISSILE_CAST, sourceId: 90, telegraphed: false, targetId: null, castMs: null },
        ],
      },
    },
    hitsByFight: { 1: events },
    deathsByFight: { 1: [] },
    damageAbilityNames: {
      [MELEE]: "Cleave",
      [BREAKER]: "Stone Breaker",
      [MISSILE_DAMAGE]: "Ichor Splash",
    },
    ...overrides,
  };
}

test("buildActorIndex keeps players and drops NPCs", () => {
  const index = buildActorIndex(ACTORS);
  assert.equal(Object.keys(index).length, 4);
  assert.equal(index[2].className, "Mage");
  assert.equal(index[90], undefined);
});

test("tanks are whoever eats the high-rate ability, not a spec lookup", () => {
  const { roster } = analyzeRaid(baseInput());
  assert.deepEqual([...roster.tankIds], [1]);
  assert.deepEqual(roster.byFight[1], [1, 2, 3, 4]);
});

test("a raid-wide tick is not melee however fast it lands", () => {
  const input = baseInput();
  // Same 40-per-minute rate as the melee, but on everyone: a damage aura.
  const ticks: WclEvent[] = [];
  for (let i = 0; i < 40; i++) {
    for (const target of [1, 2, 3, 4]) ticks.push(hit(400, target, i * 1500, 100));
  }
  input.hitsByFight[1] = [...input.hitsByFight[1], ...ticks];
  const { roster } = analyzeRaid(input);
  assert.deepEqual([...roster.tankIds], [1], "the aura must not make the whole raid tanks");
});

test("self-inflicted damage is never a mechanic and never makes a tank", () => {
  const input = baseInput();
  // A warlock hurting themselves faster than the boss swings: the exact shape
  // that put nine of twenty players in the tank list on a real log.
  const self: WclEvent[] = [];
  for (let i = 0; i < 60; i++) {
    self.push({
      timestamp: FIGHT.startTime + i * 900,
      type: "damage",
      abilityGameID: 777,
      sourceID: 2,
      targetID: 2,
      amount: 200,
    });
  }
  input.hitsByFight[1] = [...input.hitsByFight[1], ...self];
  input.damageAbilityNames[777] = "Stone Breaker"; // even under a mechanic's own name

  const { roster, series } = analyzeRaid(input);
  assert.deepEqual([...roster.tankIds], [1], "hurting yourself does not make you a tank");
  const breaker = series.find((s) => s.name === "Stone Breaker");
  assert.equal(breaker?.occurrences[0].hits.length, 2, "self-damage must not count as a hit");
});

test("damage is mapped by name first, and by time only as a fallback", () => {
  const input = baseInput();
  const mapping = mapDamageToMechanics(input, ["Stone Breaker", "Coiling Ichor"]);

  const breaker = mapping.get("Stone Breaker");
  assert.equal(breaker?.mappedBy, "name");
  assert.deepEqual([...(breaker?.damageGameIDs ?? [])], [BREAKER]);

  const ichor = mapping.get("Coiling Ichor");
  assert.equal(ichor?.mappedBy, "time", "no name match, so the cast timing has to carry it");
  assert.deepEqual([...(ichor?.damageGameIDs ?? [])], [MISSILE_DAMAGE]);
});

test("melee is never mapped to a mechanic by the time fallback", () => {
  const mapping = mapDamageToMechanics(baseInput(), ["Stone Breaker", "Coiling Ichor"]);
  for (const [, mapped] of mapping) assert.ok(!mapped.damageGameIDs.has(MELEE));
});

test("occurrences are ordinal-numbered per pull and carry their own hits", () => {
  const { series } = analyzeRaid(baseInput());
  const breaker = series.find((s) => s.name === "Stone Breaker");
  assert.ok(breaker);
  assert.deepEqual(
    breaker.occurrences.map((o) => o.ordinal),
    [1, 2],
  );

  const first = breaker.occurrences[0];
  assert.equal(first.atMs, 10_000);
  assert.equal(first.hits.length, 2, "two of the four were hit");
  assert.equal(first.hits.find((h) => h.targetId === 2)?.count, 2, "hit counts, which tables lack");
  assert.equal(first.eligible.length, 4);

  assert.equal(breaker.occurrences[1].hits.length, 1);
});

test("a hit outside the damage window belongs to no occurrence", () => {
  const input = baseInput();
  // 9s after the second Breaker: past MECHANIC_DAMAGE_WINDOW_MS.
  input.hitsByFight[1] = [...input.hitsByFight[1], hit(BREAKER, 4, 49_000)];
  const { series } = analyzeRaid(input);
  const breaker = series.find((s) => s.name === "Stone Breaker");
  assert.equal(breaker?.occurrences[1].hits.length, 1, "the late hit must not be attributed");
});

test("the window never reaches into the next occurrence", () => {
  const input = baseInput();
  // Breaker hits only: with the missile events still present they would time-map
  // onto Breaker here and land inside the second window, testing the wrong thing.
  input.hitsByFight[1] = input.hitsByFight[1].filter((e) => e.abilityGameID === BREAKER);
  input.context.castsByFight[1] = [
    { atMs: 10_000, gameID: BREAKER, sourceId: 90, telegraphed: true, targetId: null, castMs: null },
    // 4s later, well inside the 8s window: the hits at 10.2-10.9s stay with #1.
    { atMs: 14_000, gameID: BREAKER, sourceId: 90, telegraphed: true, targetId: null, castMs: null },
  ];
  const { series } = analyzeRaid(input);
  const breaker = series.find((s) => s.name === "Stone Breaker");
  assert.equal(breaker?.occurrences[0].hits.length, 2);
  assert.equal(breaker?.occurrences[1].hits.length, 0, "no double counting across occurrences");
});

test("the dead are not eligible, and a rez puts them back", () => {
  const deaths = raidDeaths(
    {
      entries: [
        {
          name: "Vex",
          id: 4,
          timestamp: FIGHT.startTime + 5_000,
          killingBlow: { name: "Stone Breaker", guid: BREAKER },
        },
      ],
    },
    FIGHT,
  );
  assert.equal(deaths[0].atMs, 5_000);
  assert.equal(deaths[0].killingAbilityGameID, BREAKER);

  // No damage after the death: still dead at 10s and at 40s.
  const dead = deadIntervals(deaths, [], FIGHT);
  assert.deepEqual(dead[4], [{ startMs: 5_000, endMs: 60_000 }]);

  const input = baseInput({ deathsByFight: { 1: deaths } });
  const { series } = analyzeRaid(input);
  const breaker = series.find((s) => s.name === "Stone Breaker");
  assert.deepEqual(breaker?.occurrences[0].eligible, [1, 2, 3], "Vex is dead for #1");

  // Vex takes damage at 50.5s in the base fixture, so a rez is visible there.
  const rezzed = deadIntervals(deaths, input.hitsByFight[1], FIGHT);
  assert.equal(rezzed[4][0].endMs, 50_500);

  // That hit is the Coiling Ichor at 50s landing: the rez is only detectable
  // from the hit itself, half a second after the cast it belongs to. Being hit
  // is what restores eligibility here, not the interval.
  const ichor = series.find((s) => s.name === "Coiling Ichor");
  assert.ok(ichor?.occurrences[1].hits.some((h) => h.targetId === 4));
  assert.ok(
    ichor?.occurrences[1].eligible.includes(4),
    "a player the mechanic hit cannot be counted as absent from it",
  );
});

test("hits are always a subset of eligible", () => {
  const deaths = raidDeaths(
    { entries: [{ name: "Vex", id: 4, timestamp: FIGHT.startTime + 5_000 }] },
    FIGHT,
  );
  const { series } = analyzeRaid(baseInput({ deathsByFight: { 1: deaths } }));
  for (const s of series) {
    for (const o of s.occurrences) {
      for (const h of o.hits) {
        assert.ok(o.eligible.includes(h.targetId), `${s.name} #${o.ordinal}: ${h.targetId}`);
      }
    }
  }
});

test("a death inside the window is credited to the mechanic that dealt it", () => {
  const deaths = raidDeaths(
    {
      entries: [
        {
          name: "Ren",
          id: 3,
          timestamp: FIGHT.startTime + 40_500,
          killingBlow: { name: "Stone Breaker", guid: BREAKER },
        },
      ],
    },
    FIGHT,
  );
  const { series } = analyzeRaid(baseInput({ deathsByFight: { 1: deaths } }));
  const breaker = series.find((s) => s.name === "Stone Breaker");
  assert.deepEqual(breaker?.occurrences[1].deaths, [
    { targetId: 3, atMs: 40_500, byKillingBlow: true },
  ]);
  assert.equal(breaker?.occurrences[0].deaths.length, 0);
});

test("a named cast with no damage anywhere is dropped, not guessed at", () => {
  const input = baseInput();
  input.context.abilities[500] = {
    gameID: 500,
    name: "Unknowable Roar",
    icon: null,
    casters: [],
    casts: 1,
  };
  input.context.castsByFight[1] = [
    ...input.context.castsByFight[1],
    { atMs: 30_000, gameID: 500, sourceId: 90, telegraphed: false, targetId: null, castMs: null },
  ];
  const { series, stats } = analyzeRaid(input);
  assert.ok(!series.some((s) => s.name === "Unknowable Roar"));
  assert.equal(stats.unmapped, 1);
  assert.equal(stats.nameMatched, 1);
  assert.equal(stats.timeMatched, 1);
});

test("damageAbilityNames reads both table shapes", () => {
  const flat = damageAbilityNames({ entries: [{ name: "Cleave", guid: 100 }] });
  assert.equal(flat[100], "Cleave");
  const nested = damageAbilityNames({
    entries: [{ name: "Alyx", id: 2, abilities: [{ name: "Stone Breaker", guid: 200 }] }],
  });
  assert.equal(nested[200], "Stone Breaker");
});

test("event volume is reported per pull so cost stays measured", () => {
  const { stats } = analyzeRaid(baseInput());
  assert.equal(stats.eventsByFight[1], baseInput().hitsByFight[1].length);
});
