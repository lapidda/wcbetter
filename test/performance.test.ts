import assert from "node:assert/strict";
import { buildRaidPerformance, type PerfFight } from "@/lib/model/performance";
import type { RaidActor } from "@/lib/model/raid";
import type { WclEvent } from "@/lib/wcl/types";

// A ten-player raid: two tanks, two healers, six DPS. One mechanic of each kind.
const roster: Array<[number, string, string, string]> = [
  [1, "Tankone", "Warrior", "Protection"],
  [2, "Tanktwo", "DeathKnight", "Blood"],
  [3, "Healone", "Priest", "Holy"],
  [4, "Healtwo", "Shaman", "Restoration"],
  [5, "Orbman", "Hunter", "BeastMastery"],
  [6, "Dpsa", "Mage", "Frost"],
  [7, "Dpsb", "Rogue", "Subtlety"],
  [8, "Dpsc", "Monk", "Windwalker"],
  [9, "Dpsd", "Warlock", "Demonology"],
  [10, "Lowguy", "Priest", "Shadow"],
];
const actors: Record<number, RaidActor> = Object.fromEntries(roster.map(([id, name, className]) => [id, { id, name, className }]));

const ORB = 100; // assigned: always Orbman
const BEAM = 200; // targeted: rotates through everyone, but Dpsc twice as often
const BUSTER = 300; // tank
const CYST = 400; // raid-wide: everyone at once
const PUDDLE = 500; // the raid notes call it avoidable
const BOSS = 999;

function fight(fightId: number): PerfFight {
  const start = fightId * 1_000_000;
  const ev: WclEvent[] = [];
  const debuff = (ability: number, target: number, atMs: number, forMs: number) => {
    ev.push({ timestamp: start + atMs, type: "applydebuff", sourceID: BOSS, targetID: target, abilityGameID: ability });
    ev.push({ timestamp: start + atMs + forMs, type: "removedebuff", sourceID: BOSS, targetID: target, abilityGameID: ability });
  };
  for (let i = 0; i < 4; i++) debuff(ORB, 5, 10_000 + i * 60_000, 20_000);
  const rotation = [6, 7, 8, 9, 10, 8, 3, 8, 4, 8];
  rotation.forEach((target, i) => debuff(BEAM, target, 5_000 + i * 25_000, 6_000));
  for (let i = 0; i < 6; i++) debuff(BUSTER, 1 + (i % 2), 15_000 + i * 40_000, 10_000);
  for (let i = 0; i < 3; i++) for (const [id] of roster) debuff(CYST, id, 30_000 + i * 90_000, 4_000);
  debuff(PUDDLE, 10, 50_000, 3_000);
  // Forbearance-style: a player debuffing themselves is never a mechanic.
  ev.push({ timestamp: start + 1_000, type: "applydebuff", sourceID: 3, targetID: 3, abilityGameID: 777 });
  ev.sort((a, b) => a.timestamp - b.timestamp);

  const dps: Record<number, number> = { 1: 80e3, 2: 85e3, 3: 5e3, 4: 4e3, 5: 190e3, 6: 210e3, 7: 205e3, 8: 200e3, 9: 195e3, 10: 120e3 };
  const heal: Record<number, number> = { 2: 100e3, 3: 300e3, 4: 280e3 };
  const secs = 300;
  return {
    fightId,
    durationMs: secs * 1000,
    startTime: start,
    present: roster.map(([id]) => id),
    damageDone: roster.map(([id, name, cls, spec]) => ({ id, name, type: cls, icon: `${cls}-${spec}`, total: dps[id] * secs, activeTime: 280_000 })),
    healing: roster.map(([id, name]) => ({ id, name, total: (heal[id] ?? 0) * secs, activeTime: heal[id] ? 270_000 : 0 })),
    debuffs: ev,
    deaths: [],
  };
}

const perf = buildRaidPerformance({
  fights: [fight(1), fight(2), fight(3)],
  actors,
  // The derived tank test found nothing — as it did on a real Mythic night.
  tankIds: new Set(),
  debuffNames: { [ORB]: "Orb", [BEAM]: "Beam", [BUSTER]: "Buster", [CYST]: "Cyst", [PUDDLE]: "Puddle", 777: "Forbearance" },
  avoidableNames: new Set(["Puddle", "Buster"]),
  avoidableHits: [
    { name: "Puddle", fightId: 1, targetId: 10, count: 3 },
    { name: "Buster", fightId: 1, targetId: 1, count: 5 }, // the notes' mistake: a tank buster as "avoidable"
  ],
});

const kind = (name: string) => perf.duties.find((d) => d.name === name)?.kind;
assert.equal(kind("Orb"), "assigned");
assert.equal(kind("Beam"), "targeted");
assert.equal(kind("Buster"), "tank", "tanks found by spec, and tank beats the notes' avoidable");
assert.equal(kind("Cyst"), "raid-wide");
assert.equal(kind("Puddle"), "avoidable");
assert.equal(kind("Forbearance"), undefined, "self-applied debuffs are not mechanics");
console.log("performance: classification ok");

const p = (name: string) => perf.players.find((x) => x.name === name)!;
assert.equal(p("Tankone").role, "tank");
assert.equal(p("Tanktwo").role, "tank", "a Blood DK's self-healing does not make them a healer");
assert.equal(p("Healone").role, "healer");
assert.equal(p("Healone").activePct, 90, "a healer's activity is their healing");

assert.deepEqual(p("Orbman").duties.map((d) => [d.name, d.kind, d.perPull]), [["Orb", "assigned", 4]]);
assert.ok(p("Dpsc").duties.some((d) => d.name === "Beam"), "Beam four times a pull against the raid's one");
assert.ok(!p("Dpsa").duties.some((d) => d.name === "Beam"), "one Beam a pull is everyone's share, not a duty");
assert.ok(p("Tankone").duties.some((d) => d.name === "Buster"));
assert.ok(!perf.players.some((x) => x.duties.some((d) => d.name === "Cyst")), "raid-wide is nobody's duty");

assert.equal(p("Orbman").dutySecondsPerPull > p("Dpsa").dutySecondsPerPull, true);
assert.equal(p("Tankone").avoidableHitsPerPull, 0, "a reclassified tank buster is not an avoidable hit");
assert.equal(p("Lowguy").avoidableHitsPerPull, 1);
console.log("performance: crediting ok");

// The readings: Orbman is a touch below the DPS median but carries the orb;
// Lowguy is far below with nothing to explain it.
assert.equal(p("Orbman").read?.tone, "good");
assert.match(p("Orbman").read!.text, /assigned/);
assert.equal(p("Lowguy").read?.tone, "bad");
assert.equal(p("Dpsa").read, null, "an ordinary player gets no reading");
assert.deepEqual(perf.players.slice(0, 6).map((x) => x.role), Array(6).fill("dps"), "DPS first, then tanks, then healers");
console.log("performance: readings ok");

console.log("performance: all assertions passed");
