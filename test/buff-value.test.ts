import assert from "node:assert/strict";
import { auraWindows, computeBuffValue, RAID_BUFFS, type BuffActor, type BuffFightInput } from "@/lib/model/buff-value";
import type { WclEvent } from "@/lib/wcl/types";

const MT = 113746;
const BRAND = 1490;
const MELEE = 1; // physical
const FIREBALL = 133; // fire
const CHAOS = 162794; // chaos, all schools

const actors: Record<number, BuffActor> = {
  1: { id: 1, name: "Monky", type: "Player", subType: "Monk" },
  2: { id: 2, name: "Warry", type: "Player", subType: "Warrior" },
  3: { id: 3, name: "Magey", type: "Player", subType: "Mage" },
  4: { id: 4, name: "Wolf", type: "Pet", subType: "Pet", petOwner: 2 },
  5: { id: 5, name: "Demony", type: "Player", subType: "DemonHunter" },
  100: { id: 100, name: "Boss", type: "NPC", subType: "Boss" },
  101: { id: 101, name: "Add", type: "NPC", subType: "NPC" },
};
const schools = { [MELEE]: 1, [FIREBALL]: 4, [CHAOS]: 127 };

const hit = (t: number, source: number, target: number, ability: number, amount: number): WclEvent => ({
  timestamp: t,
  type: "damage",
  sourceID: source,
  targetID: target,
  abilityGameID: ability,
  amount,
});
const aura = (t: number, type: string, source: number, target: number, ability = MT): WclEvent => ({
  timestamp: t,
  type,
  sourceID: source,
  targetID: target,
  abilityGameID: ability,
});

// 10s pull. Mystic Touch on the boss for the whole pull, on the add only from 5s.
const fight: BuffFightInput = {
  fightId: 1,
  startTime: 0,
  endTime: 10_000,
  auras: [aura(0, "applydebuff", 1, 100), aura(5_000, "applydebuff", 1, 101), aura(9_000, "removedebuff", 1, 101)],
  damage: [
    hit(1_000, 2, 100, MELEE, 1050), // covered
    hit(2_000, 4, 100, MELEE, 1050), // pet, covered, counts for Warry
    hit(3_000, 2, 101, MELEE, 1000), // add before the debuff: not covered
    hit(6_000, 2, 101, MELEE, 1050), // add during the debuff
    hit(9_500, 2, 101, MELEE, 1000), // after it fell off
    hit(4_000, 3, 100, FIREBALL, 5000), // magic: never eligible
    hit(4_000, 1, 100, MELEE, 2100), // the monk's own
    hit(4_000, 2, 3, MELEE, 999), // friendly target: ignored
  ],
};

// Windows: an unmatched remove starts at the pull start.
{
  const w = auraWindows([aura(3_000, "removedebuff", 1, 100)], MT, 0, 10_000);
  assert.deepEqual(w.get("100:0"), [[0, 3_000]]);
}

{
  const r = computeBuffValue([fight], actors, schools);
  assert.equal(r.buffs.length, 1, "Chaos Brand was never applied, so it is not reported");
  const mt = r.buffs[0];
  assert.equal(mt.def.auraId, MT);

  // Covered physical: 1050 + 1050 + 1050 (Warry) + 2100 (monk) = 5250 → loss 250.
  assert.ok(Math.abs(mt.lossDps - 250 / 10) < 1e-9, `lossDps ${mt.lossDps}`);
  assert.ok(Math.abs(mt.lossDpsOthers - 150 / 10) < 1e-9, "the monk's own 100 is not 'everyone else'");
  // Eligible physical 7250, covered 5250.
  assert.ok(Math.abs(mt.coverage - 5250 / 7250) < 1e-9);

  const warry = r.players.find((p) => p.id === 2)!;
  assert.equal(warry.physicalShare, 1);
  assert.ok(Math.abs(warry.dps - 5150 / 10) < 1e-9, "pet damage folds into its owner, friendly hits do not count");
  assert.ok(Math.abs(warry.lossDps[MT] - 150 / 10) < 1e-9);

  const monk = r.players.find((p) => p.id === 1)!;
  assert.deepEqual(mt.providers.map((p) => p.id), [1]);
  assert.ok(Math.abs(mt.breakEvenDps! - (monk.dps + mt.lossDpsOthers)) < 1e-9);

  assert.equal(r.players.find((p) => p.id === 3)!.magicShare, 1);
  assert.equal(r.players.find((p) => p.id === 3)!.lossDps[MT], undefined);
}

// Chaos damage is both: Mystic Touch counts it as mixed, Chaos Brand (all schools) counts every hit.
{
  const both: BuffFightInput = {
    fightId: 2,
    startTime: 0,
    endTime: 10_000,
    auras: [aura(0, "applydebuff", 1, 100), aura(0, "applydebuff", 5, 100, BRAND), aura(0, "applydebuff", 6, 100, BRAND)],
    damage: [hit(1_000, 5, 100, CHAOS, 1050), hit(1_000, 3, 100, FIREBALL, 1030)],
  };
  const withSecondDh = { ...actors, 6: { id: 6, name: "Demtwo", type: "Player", subType: "DemonHunter" } };
  const r = computeBuffValue([both], withSecondDh, schools, { defs: RAID_BUFFS });
  const dh = r.players.find((p) => p.id === 5)!;
  assert.equal(dh.mixedShare, 1);
  const mt = r.buffs.find((b) => b.def.auraId === MT)!;
  assert.ok(Math.abs(mt.lossDps * 10 - 50) < 1e-9, "chaos overlaps physical");
  const brand = r.buffs.find((b) => b.def.auraId === BRAND)!;
  assert.ok(Math.abs(brand.lossDps * 10 - (1050 * 0.03) / 1.03 - 30) < 1e-9);
  assert.equal(brand.breakEvenDps, null, "two Demon Hunters: losing one keeps the debuff");
}

// Player buffs: Battle Shout from the pull start (CombatantInfo), lost at 5s; pets use their owner's.
{
  const SHOUT = 6673;
  const INTELLECT = 1459;
  const MARK = 257284;
  const f: BuffFightInput = {
    fightId: 3,
    startTime: 0,
    endTime: 10_000,
    initial: [
      { target: 2, ability: SHOUT, source: 2 },
      { target: 3, ability: SHOUT, source: 2 },
      { target: 3, ability: INTELLECT, source: 3 },
    ],
    auras: [
      { timestamp: 5_000, type: "removebuff", sourceID: 2, targetID: 2, abilityGameID: SHOUT },
      aura(0, "applydebuff", 7, 100, MARK),
    ],
    damage: [
      hit(1_000, 4, 100, MELEE, 1050), // pet, owner shouted
      hit(6_000, 2, 100, MELEE, 1000), // shout gone
      hit(2_000, 3, 100, FIREBALL, 1030), // the mage: Intellect, and Battle Shout does nothing for them
    ],
  };
  const withHunter = { ...actors, 7: { id: 7, name: "Huntey", type: "Player", subType: "Hunter" } };
  const r = computeBuffValue([f], withHunter, schools, {
    primaryStats: { 2: "strength", 3: "intellect", 7: "agility" },
  });
  const shout = r.buffs.find((b) => b.def.auraId === SHOUT)!;
  assert.ok(Math.abs(shout.lossDps * 10 - 50) < 1e-9, "only the pet's hit had Battle Shout behind it");
  assert.ok(Math.abs(shout.eligibleShare - 2050 / 3080) < 1e-9, "the mage's damage is not eligible");
  assert.equal(r.players.find((p) => p.id === 3)!.lossDps[SHOUT], undefined);
  const int = r.buffs.find((b) => b.def.auraId === INTELLECT)!;
  assert.ok(Math.abs(int.lossDps * 10 - 30) < 1e-9);
  assert.equal(int.lossDpsOthers, 0, "the mage's own Intellect is not 'everyone else'");

  const mark = r.buffs.find((b) => b.def.auraId === MARK)!;
  // Every hit on the marked boss, whatever its health.
  assert.ok(Math.abs(mark.lossDps * 10 - ((1050 + 1000 + 1030) * 0.03) / 1.03) < 1e-9, `mark ${mark.lossDps}`);

  // Warry is the only source of Battle Shout; Magey of Arcane Intellect.
  const warry = r.soleProviders.find((s) => s.id === 2)!;
  assert.deepEqual(warry.auraIds, [SHOUT]);
  assert.equal(warry.othersDps, 0, "the pet's hit is Warry's own damage");
  assert.ok(r.soleProviders.some((s) => s.id === 7 && s.auraIds.includes(MARK)));
}

console.log("buff-value: ok");
