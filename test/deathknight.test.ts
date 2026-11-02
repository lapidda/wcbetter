import assert from "node:assert/strict";
import { checkedLists, dkRules, frostViolations, unholyViolations } from "@/lib/spec/deathknight";
import { UNHOLY_GUIDE, FROST_GUIDE } from "@/lib/spec/deathknight-guide";
import type { CastResource, PriorityAura, PriorityCast, PriorityInput } from "@/lib/spec/priority";

const RUNES = 5;
const RP = 6;

/** A cast with Runes (before, cost) when it spends them, and Runic Power in tenths like WCL. */
const cast = (t: number, name: string, res: { runes?: [number, number]; rp?: [number, number?] } = {}): PriorityCast => {
  const resources: Record<number, CastResource> = {
    [RP]: { amount: res.rp?.[0] ?? 300, max: 1000, ...(res.rp?.[1] != null ? { cost: res.rp[1] } : {}) },
  };
  if (res.runes) resources[RUNES] = { amount: res.runes[0], max: 6, cost: res.runes[1] };
  return { t, name, energy: null, energyMax: null, chi: null, chiCost: null, chiMax: null, resources };
};
const aura = (t: number, type: string, id: number, name: string, stack?: number): PriorityAura => ({
  t,
  type,
  id,
  name,
  ...(stack != null ? { stack } : {}),
});
const input = (casts: PriorityCast[], auras: PriorityAura[] = [], deathsMs: number[] = []): PriorityInput => ({
  durationMs: 120_000,
  casts: [...casts].sort((x, y) => x.t - y.t),
  // Sorted like the loader sorts them: the stack reader walks them in order.
  auras: [...auras].sort((x, y) => x.t - y.t),
  deathsMs,
});
const tags = (v: Array<{ list?: string; rank: number; kind: string }>) => v.map((x) => `${x.list}#${x.rank}:${x.kind}`);

// --- Unholy ---------------------------------------------------------------------------

const GHOUL = 1254252; // the stacks
const GHOULS = 1242998; // the summoned ghouls, on their own clock
const SD = 81340;
const FK = 1242223;

// Two Lesser Ghoul ids: the stack id is the one Scourge Strike takes from.
const ghoulStacks = (n: number): PriorityAura[] => [
  aura(1_000, "applybuff", GHOUL, "Lesser Ghoul"),
  aura(1_001, "applybuffstack", GHOUL, "Lesser Ghoul", n),
  aura(1_000, "applybuff", GHOULS, "Lesser Ghoul"),
  aura(4_020, "removebuffstack", GHOUL, "Lesser Ghoul", n - 1),
];

{
  // Sudden Doom up: Scourge Strike skips Death Coil (San'layn line 9).
  const auras = [...ghoulStacks(4), aura(2_000, "applybuff", SD, "Sudden Doom"), aura(8_000, "removebuff", SD, "Sudden Doom")];
  const v = unholyViolations(input([cast(4_000, "Scourge Strike", { runes: [4, 1] }), cast(8_000, "Death Coil", { rp: [500, 300] })], auras), "sanlayn");
  assert.deepEqual(tags(v), ["uh-st-sanlayn#9:skipped"]);
  // Rider numbers the same line 8.
  assert.deepEqual(tags(unholyViolations(input([cast(4_000, "Scourge Strike", { runes: [4, 1] }), cast(8_000, "Death Coil")], auras), "rider")), [
    "uh-st-rider#8:skipped",
  ]);
}

{
  // Sudden Doom ran out with no Death Coil: wasted. Consumed: not.
  const auras = [aura(2_000, "applybuff", SD, "Sudden Doom"), aura(12_000, "removebuff", SD, "Sudden Doom")];
  assert.deepEqual(tags(unholyViolations(input([], auras), "sanlayn")), ["uh-st-sanlayn#9:wasted"]);
  assert.deepEqual(tags(unholyViolations(input([cast(12_000, "Death Coil")], auras), "sanlayn")), []);
}

{
  // Scourge Strike with no Lesser Ghoul and Runes for Festering Strike: line 10.
  const auras = [
    aura(500, "applybuff", GHOUL, "Lesser Ghoul"),
    aura(2_020, "removebuff", GHOUL, "Lesser Ghoul"), // taken by the Strike at 2.0s
    aura(500, "applybuff", GHOULS, "Lesser Ghoul"),
  ];
  const v = unholyViolations(
    input([cast(2_000, "Scourge Strike", { runes: [4, 1] }), cast(5_000, "Scourge Strike", { runes: [3, 1] }), cast(6_000, "Scourge Strike", { runes: [1, 1] })], auras),
    "sanlayn",
  );
  assert.deepEqual(tags(v), ["uh-st-sanlayn#10:skipped"], "at 1 Rune Festering Strike was not an option");
}

{
  // A plain Death Coil with stacks and a Rune left over: Scourge Strike first (line 11).
  const v = unholyViolations(input([cast(4_000, "Scourge Strike", { runes: [4, 1] }), cast(5_000, "Death Coil")], ghoulStacks(4)), "sanlayn");
  assert.deepEqual(tags(v), ["uh-st-sanlayn#11:skipped"]);
}

{
  // San'layn only: Dark Transformation at 3 or fewer stacks wanted a Festering Strike first.
  const v = unholyViolations(input([cast(4_000, "Scourge Strike", { runes: [4, 1] }), cast(5_000, "Dark Transformation")], ghoulStacks(3)), "sanlayn");
  assert.deepEqual(tags(v), ["uh-st-sanlayn#1:skipped"]);
  assert.deepEqual(tags(unholyViolations(input([cast(4_000, "Scourge Strike", { runes: [4, 1] }), cast(5_000, "Dark Transformation")], ghoulStacks(3)), "rider")), []);
}

{
  // In Forbidden Knowledge: a Strike with the Runic Power for Necrotic Coil skips it (line 6).
  const auras = [...ghoulStacks(4), aura(2_000, "applybuff", FK, "Forbidden Knowledge"), aura(30_000, "removebuff", FK, "Forbidden Knowledge")];
  const casts = [cast(3_000, "Necrotic Coil", { rp: [900, 300] }), cast(4_000, "Vampiric Strike", { runes: [4, 1], rp: [600] }), cast(6_000, "Vampiric Strike", { runes: [3, 1], rp: [200] })];
  assert.deepEqual(tags(unholyViolations(input(casts, auras), "sanlayn")), ["uh-st-sanlayn-fk#6:skipped"], "at 20 Runic Power Necrotic Coil was not an option");
}

// --- Frost ------------------------------------------------------------------------------

const KM = 51124;
const RIME = 59052;

{
  // Two Killing Machine stacks and Runes: Frost Strike skips Obliterate (Rider line 5).
  const auras = [aura(1_000, "applybuff", KM, "Killing Machine"), aura(1_500, "applybuffstack", KM, "Killing Machine", 2)];
  const v = frostViolations(input([cast(1_800, "Obliterate", { runes: [6, 2] }), cast(2_000, "Frost Strike", { rp: [500, 300] })], auras), "rider");
  assert.deepEqual(tags(v), ["fr-st-rider#5:skipped"]);
}

{
  // Rime up: an Obliterate without Killing Machine skips Howling Blast. With Killing Machine it is
  // not marked — Method puts that Obliterate first.
  const auras = [aura(1_000, "applybuff", RIME, "Rime"), aura(9_000, "removebuff", RIME, "Rime")];
  const casts = [cast(2_000, "Obliterate", { runes: [5, 2] }), cast(9_000, "Howling Blast")];
  assert.deepEqual(tags(frostViolations(input(casts, auras), "deathbringer")), ["fr-st-deathbringer#7:skipped"]);
  const withKm = [...auras, aura(1_500, "applybuff", KM, "Killing Machine"), aura(2_020, "removebuff", KM, "Killing Machine")];
  assert.deepEqual(tags(frostViolations(input(casts, withKm), "deathbringer")), []);
}

{
  // Full Runic Power: an Obliterate without Killing Machine skips Frost Strike (line 7).
  const v = frostViolations(input([cast(2_000, "Obliterate", { runes: [5, 2], rp: [980] })]), "rider");
  assert.deepEqual(tags(v), ["fr-st-rider#7:skipped"]);
  // Empower Rune Weapon at full Runic Power is not marked: its "2 charges" line may apply.
  assert.deepEqual(tags(frostViolations(input([cast(2_000, "Empower Rune Weapon", { rp: [990] })]), "rider")), []);
}

{
  // Exterminate fires on its own: never judged as a press.
  const auras = [aura(1_000, "applybuff", KM, "Killing Machine"), aura(1_500, "applybuffstack", KM, "Killing Machine", 2)];
  assert.deepEqual(tags(frostViolations(input([cast(2_000, "Exterminate", { rp: [990] })], auras), "deathbringer")), []);
}

{
  // Rime and Killing Machine running out unused are wasted.
  const auras = [aura(1_000, "applybuff", RIME, "Rime"), aura(16_000, "removebuff", RIME, "Rime"), aura(1_000, "applybuff", KM, "Killing Machine"), aura(20_000, "removebuff", KM, "Killing Machine")];
  assert.deepEqual(tags(frostViolations(input([], auras), "rider")), ["fr-st-rider#6:wasted", "fr-st-rider#5:wasted"]);
}

// --- Rules and guide agree ---------------------------------------------------------------

{
  for (const [spec, tree, guide] of [
    ["unholy", "sanlayn", UNHOLY_GUIDE],
    ["unholy", "rider", UNHOLY_GUIDE],
    ["frost", "deathbringer", FROST_GUIDE],
    ["frost", "rider", FROST_GUIDE],
  ] as const) {
    const rules = dkRules(spec, tree);
    const lists = checkedLists(spec, tree);
    assert.ok(lists.every((id) => guide.checked.includes(id)), `${spec}/${tree}: the card marks the checked lists`);
    for (const r of rules) {
      const line = guide.lists.find((l) => l.id === r.list)!.lines[r.rank - 1];
      assert.equal(r.action, line.action, `${r.list}#${r.rank} is the guide's line`);
      assert.ok(r.checked ? r.fix : r.why, `${r.list}#${r.rank} says what to do or why it is not checked`);
    }
  }
  assert.equal(dkRules("unholy", "sanlayn").filter((r) => r.checked).length, 6);
  assert.equal(dkRules("frost", "deathbringer").filter((r) => r.checked).length, 4);
}

console.log("deathknight: ok");
