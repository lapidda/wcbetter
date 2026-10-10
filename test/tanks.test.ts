import assert from "node:assert/strict";
import { addLine, addToStored, applyStored, toStored, type DocLine } from "@/lib/model/note-doc";
import { buildTankReport, tankNoteLines, type TankFight } from "@/lib/model/tanks";
import type { WclEvent } from "@/lib/wcl/types";

const PALADIN = 16;
const DK = 40;
const DPS = 7;
const BOSS = 466;
const VENOM = 1; // stacks on tanks only: the swap debuff
const RAVAGE = 2; // hits tanks: a buster
const MELEE = 3;
const CYST = 4; // on everyone
const names: Record<number, string> = {
  [VENOM]: "Corroding Venom",
  [RAVAGE]: "Ravage",
  [MELEE]: "Melee",
  [CYST]: "Viscous Cyst",
  100: "Hand of Reckoning",
  101: "Dark Command",
  102: "Vampiric Blood",
  103: "Sentinel",
};

function fight(fightId: number, first: number): TankFight {
  const start = fightId * 1_000_000;
  const second = first === PALADIN ? DK : PALADIN;
  const debuffs: WclEvent[] = [];
  const venom = (target: number, atMs: number, stacks: number, removeAt: number) => {
    debuffs.push({ timestamp: start + atMs, type: "applydebuff", sourceID: BOSS, targetID: target, abilityGameID: VENOM });
    for (let s = 2; s <= stacks; s++) debuffs.push({ timestamp: start + atMs + (s - 1) * 2000, type: "applydebuffstack", sourceID: BOSS, targetID: target, abilityGameID: VENOM, stack: s });
    debuffs.push({ timestamp: start + removeAt, type: "removedebuff", sourceID: BOSS, targetID: target, abilityGameID: VENOM });
  };
  venom(first, 2_000, 6, 40_000); // 6 stacks by 12s
  venom(second, 32_000, 5, 70_000);
  for (const id of [PALADIN, DK, DPS]) debuffs.push({ timestamp: start + 5_000, type: "applydebuff", sourceID: BOSS, targetID: id, abilityGameID: CYST });
  debuffs.sort((a, b) => a.timestamp - b.timestamp);

  const hits: WclEvent[] = [];
  for (let t = 1_000; t < 90_000; t += 1_800) hits.push({ timestamp: start + t, type: "damage", sourceID: BOSS, targetID: t < 30_000 ? first : second, abilityGameID: MELEE, amount: 50_000 });
  hits.push({ timestamp: start + 20_000, type: "damage", sourceID: BOSS, targetID: first, abilityGameID: RAVAGE, amount: 900_000 });
  hits.push({ timestamp: start + 60_000, type: "damage", sourceID: BOSS, targetID: second, abilityGameID: RAVAGE, amount: 1_100_000 });

  const cast = (abilityGameID: number, atMs: number): WclEvent => ({ timestamp: start + atMs, type: "cast", abilityGameID });
  const tauntOf = (id: number) => (id === PALADIN ? 100 : 101);
  return {
    fightId,
    label: `Pull ${fightId}`,
    kill: fightId === 3,
    startTime: start,
    durationMs: 90_000,
    debuffs,
    hits,
    casts: {
      // The second tank taunts at the first one's 6 stacks; the first taunts back late on pull 3.
      [second]: [cast(tauntOf(second), 30_000)],
      [first]: [cast(tauntOf(first), 0), cast(tauntOf(first), fightId === 3 ? 66_000 : 60_000), cast(first === DK ? 102 : 103, 18_000)],
    },
    buffs: {
      [first]: [{ name: first === DK ? "Vampiric Blood" : "Sentinel", bands: [{ startTime: start + 18_000, endTime: start + 28_000 }] }],
      [second]: [],
    },
    bossCasts: [{ atMs: 19_500, name: "Ravage", targetId: first }],
    deaths: [],
  };
}

const report = buildTankReport({
  fights: [fight(1, PALADIN), fight(2, PALADIN), fight(3, PALADIN), fight(4, DK)],
  tanks: [
    { id: PALADIN, name: "Zicia", className: "Paladin" },
    { id: DK, name: "Lybrris", className: "DeathKnight" },
  ],
  names,
  specs: { [PALADIN]: "Protection", [DK]: "Blood" },
})!;

assert.equal(report.swapDebuff, "Corroding Venom", "the stacking debuff on tanks only");
assert.deepEqual(report.busterNames, ["Ravage"], "the boss's swings are not a buster, by name");
assert.deepEqual(report.order, [PALADIN, DK], "first tank on 3 of 4 pulls");
assert.equal(report.summary.find((s) => s.tankId === PALADIN)!.firstOn, 3);
console.log("tanks: swap debuff, busters, order ok");

const p1 = report.pulls[0];
const swap = p1.taunts.find((t) => t.tankId === DK)!;
assert.equal(swap.swap, true);
assert.equal(swap.otherStacks, 6, "the DK taunted off the Paladin's 6 stacks");
assert.equal(p1.taunts.find((t) => t.tankId === PALADIN && t.atMs === 0)!.swap, false, "the pull taunt is not a swap");

const ravageOnFirst = p1.busters.find((b) => b.tankId === PALADIN)!;
assert.deepEqual(ravageOnFirst.covered, [{ name: "Sentinel", kind: "personal" }]);
assert.equal(p1.busters.find((b) => b.tankId === DK)!.covered.length, 0, "the second Ravage met nothing");
console.log("tanks: taunts and busters ok");

// Pull 3: the Paladin taunts back at 66s, when the DK is at 5 — the same as
// usual here, so it is not late; a taunt well past the usual count would be.
const zSummary = report.summary.find((s) => s.tankId === PALADIN)!;
assert.ok(zSummary.tauntAtStacks != null);
assert.equal(zSummary.busterHits, 4);
assert.equal(zSummary.bustersCovered, 3, "three Ravages under Sentinel, one under nothing on pull 4");

// --- Note export --------------------------------------------------------------
const lines = tankNoteLines(report, 3, { order: true, taunts: true, defensives: true });
assert.deepEqual(lines.slice(0, 2).map((l) => `${l.tag}:${l.text}`), ["Zicia:First tank", "Lybrris:Second tank"]);
assert.ok(lines.some((l) => l.tag === "Lybrris" && l.text === "Taunt (Corroding Venom 6)" && l.timeSec === 30));
assert.ok(lines.some((l) => l.text === "Defensive (Ravage)" && l.timeSec === 18), "2s ahead of the 20s Ravage");
assert.ok(lines.every((l) => Number.isInteger(l.timeSec)));
console.log("tanks: note lines ok");

// --- Added lines survive in the stored note --------------------------------------
{
  const stored = addToStored(null, lines.map((l) => ({ ...l, enabled: true })), "tank:");
  const again = addToStored(stored, lines.slice(0, 1).map((l) => ({ ...l, enabled: true })), "tank:");
  assert.equal(again.added!.length, 1, "exporting again replaces the earlier tank lines");

  const restored = applyStored([], stored);
  assert.equal(restored.length, lines.length);
  assert.ok(restored.every((l) => l.source == null && l.custom), "restored as hand-added lines with their text");

  // A line typed by hand survives a save and a reload — it used to be lost.
  let doc: DocLine[] = addLine([], { timeSec: 42, tag: "everyone" });
  doc = doc.map((l) => ({ ...l, custom: "Spread" }));
  const saved = toStored({ caller: "", includeNames: false, placeholder: true, lines: doc });
  const back = applyStored([], saved);
  assert.equal(back.length, 1);
  assert.equal(back[0].custom, "Spread");
  assert.equal(back[0].timeSec, 42);
  console.log("tanks: stored note lines ok");
}

console.log("tanks: all assertions passed");
