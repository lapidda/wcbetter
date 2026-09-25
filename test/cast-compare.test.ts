import assert from "node:assert/strict";
import { buildCastComparison, defaultComparePull, laneCpm } from "@/lib/model/cast-compare";
import type { AbilityStat, PlayerProfile, ReferenceProfile } from "@/lib/model/types";

const stat = (gameID: number, name: string, casts: number): AbilityStat => ({
  gameID,
  name,
  icon: null,
  casts,
  castsPerMinute: casts,
  damage: 0,
  damagePerCast: 0,
  interCastGaps: [],
});

const profile = (
  name: string,
  fightId: number,
  durationMs: number,
  dps: number,
  castTimeline: Array<{ atMs: number; gameID: number }>,
  abilities: Record<number, AbilityStat>,
): PlayerProfile => ({
  key: name,
  name,
  actorId: 7,
  className: "Mage",
  specName: "Fire",
  reportCode: `r-${name}`,
  fightId,
  durationMs,
  itemLevel: null,
  burnStartMs: null,
  totalDamage: dps * (durationMs / 1000),
  dps,
  activeTimeMs: durationMs,
  activeTimePct: 100,
  abilities,
  damageTaken: {},
  buffs: {},
  deaths: [{ timestampMs: 0, atMs: 90_000.4, killingAbility: null, deadMs: 0, rezzed: false, rewind: [] }].slice(
    0,
    name === "you-wipe" ? 1 : 0,
  ),
  talents: [],
  gaps: [],
  castTimeline,
});

const FIREBALL = 1;
const COMBUST = 2;
const MELEE = 3; // in the cast stream, never in the Casts table
const FIREBALL_EMPOWERED = 4; // same button, second id

const reference = (members: PlayerProfile[]): ReferenceProfile => ({
  encounterID: 1,
  encounterName: "Boss",
  difficulty: 4,
  className: "Mage",
  specName: "Fire",
  members,
  medianDps: 0,
  medianActiveTimePct: 0,
  medianCpm: {},
  usageCount: {},
  medianDamagePerCast: {},
  abilityNames: { [FIREBALL]: "Fireball", [COMBUST]: "Combustion" },
  medianDamageTakenDpm: {},
  damageTakenNames: {},
  estimatedCooldownMs: { [FIREBALL]: 2_000, [COMBUST]: 120_000 },
  medianBuffUptime: {},
  buffNames: {},
  buildMatch: { matched: true, similarity: 0.9 },
  medianItemLevel: null,
});

const wipe = profile(
  "you-wipe",
  11,
  240_000,
  90_000,
  [
    { atMs: 1_234.4, gameID: FIREBALL },
    { atMs: 1_500, gameID: MELEE },
    { atMs: 3_000, gameID: COMBUST },
  ],
  { [FIREBALL]: stat(FIREBALL, "Fireball", 1), [COMBUST]: stat(COMBUST, "Combustion", 1), [MELEE]: stat(MELEE, "Melee", 0) },
);
const kill = profile(
  "you-kill",
  12,
  200_000,
  100_000,
  [{ atMs: 500, gameID: FIREBALL }],
  { [FIREBALL]: stat(FIREBALL, "Fireball", 1) },
);
const top = profile(
  "Topmage",
  3,
  180_000,
  150_000,
  [
    { atMs: 100, gameID: COMBUST },
    { atMs: 600, gameID: FIREBALL },
    { atMs: 2_600, gameID: FIREBALL },
    { atMs: 1_800, gameID: FIREBALL_EMPOWERED },
    { atMs: 1_850, gameID: FIREBALL }, // the same press, logged under the other id
  ],
  {
    [FIREBALL]: stat(FIREBALL, "Fireball", 2),
    [COMBUST]: stat(COMBUST, "Combustion", 1),
    [FIREBALL_EMPOWERED]: stat(FIREBALL_EMPOWERED, "Fireball", 1),
  },
);

const comparison = buildCastComparison(
  [
    { profile: wipe, label: "Pull 1", kill: false },
    { profile: kill, label: "Pull 2", kill: true },
  ],
  reference([top]),
);

// Only pressed buttons become rows: the melee swings in the event stream would
// otherwise bury the rotation under twice-a-second noise.
assert.deepEqual(
  comparison.abilities.map((a) => a.gameID),
  [COMBUST, FIREBALL],
  "cooldowns first, auto attacks dropped",
);
assert.equal(comparison.abilities[0].cooldownMs, 120_000);
assert.equal(comparison.abilities[1].cooldownMs, null, "a 2s filler is not drawn as a cooldown");
assert.equal(comparison.yours[0].casts[MELEE], undefined);

// Two ids with one name are one button, merged into the more-cast id's row, in time order.
assert.deepEqual(comparison.reference[0].casts[FIREBALL], [600, 1_800, 2_600]);
assert.equal(comparison.reference[0].casts[FIREBALL_EMPOWERED], undefined);

// Times are rounded to 10ms; deaths are carried for the "all casts" row.
assert.deepEqual(comparison.yours[0].casts[FIREBALL], [1_230]);
assert.deepEqual(comparison.yours[0].deaths, [90_000]);

// Your lanes know their fight (for boss casts); reference lanes know their log.
assert.equal(comparison.yours[1].fightId, 12);
assert.deepEqual(comparison.reference[0].source, { reportCode: "r-Topmage", fightId: 3, actorId: 7 });
assert.equal(comparison.reference[0].kill, true);

// Rates, not counts: the faster kill must not look like fewer casts.
assert.equal(laneCpm(comparison.reference[0], FIREBALL), 1);

// Open on your best kill, which is the pull most like a ranked parse...
assert.equal(defaultComparePull(comparison.yours)?.key, "you:12");
// ...and on a night without one, the longest pull.
assert.equal(defaultComparePull([comparison.yours[0]])?.key, "you:11");
assert.equal(defaultComparePull([]), null);

console.log("cast-compare: all assertions passed");
