import assert from "node:assert/strict";
import { alignOpeners, extraKind, openerSequence, type OpenerStep } from "@/lib/model/opener";

// --- What counts as an extra ------------------------------------------------
assert.equal(extraKind("Nullsight", "inv_12_trinket_raid_voidspire_int1_voiddragoneye.jpg"), "trinket");
assert.equal(extraKind("Potion of Recklessness", "inv_12_profession_alchemy_voidpotion_red.jpg"), "potion");
assert.equal(extraKind("Light's Potential", "inv_12_profession_alchemy_lightpotion_yellow.jpg"), "potion");
assert.equal(extraKind("Berserking", "racial_troll_berserk.jpg"), "racial");
assert.equal(extraKind("Fireblood", "ability_racial_fireblood.jpg"), "racial");
// This expansion's class spells use inv_ icons, and Bear Form's icon says
// "racial": neither may be mistaken for an extra.
assert.equal(extraKind("Reap", "inv_12_dh_void_ability_reap.jpg"), null);
assert.equal(extraKind("Bear Form", "ability_racial_bearform.jpg"), null);
console.log("extraKind: ok");

// --- The twelve-cast window -------------------------------------------------
const names: Record<number, { name: string; icon: string | null }> = {
  1: { name: "Filler", icon: null },
  2: { name: "Cooldown", icon: null },
  3: { name: "Other", icon: null },
  4: { name: "Spender", icon: null },
  90: { name: "Nullsight", icon: "inv_12_trinket_x.jpg" },
  91: { name: "Berserking", icon: null },
};
const meta = (id: number) => names[id] ?? null;

{
  const timeline = [
    { atMs: 0, gameID: 90 }, // trinket before the first cast
    ...Array.from({ length: 6 }, (_, i) => ({ atMs: 1000 + i * 1000, gameID: 1 })),
    { atMs: 6500, gameID: 999 }, // unnamed: an auto attack
    { atMs: 6600, gameID: 91 },
    ...Array.from({ length: 10 }, (_, i) => ({ atMs: 7000 + i * 1000, gameID: 1 })),
  ];
  const steps = openerSequence(timeline, meta);
  assert.equal(steps.filter((s) => !s.extra).length, 12, "exactly twelve rotational casts");
  assert.equal(steps.length, 14, "plus the two extras, which take no slot");
  assert.deepEqual(
    steps.filter((s) => s.extra).map((s) => s.extra),
    ["trinket", "racial"],
  );
  assert.ok(!steps.some((s) => s.gameID === 999), "unnamed ids are dropped");
  assert.equal(steps[steps.length - 1].atMs, 12_000, "ends on the twelfth rotational cast");
  console.log("openerSequence: ok");
}

{
  // One press logged under two ids at the same instant is one cast (measured on
  // Voidblade); two real presses a GCD apart are still two.
  const doubled: Record<number, { name: string; icon: string | null }> = {
    ...names,
    5: { name: "Voidblade", icon: null },
    6: { name: "Voidblade", icon: null },
  };
  const steps = openerSequence(
    [
      { atMs: 3900, gameID: 5 },
      { atMs: 3900, gameID: 6 },
      { atMs: 5400, gameID: 5 },
    ],
    (id) => doubled[id] ?? null,
  );
  assert.deepEqual(steps.map((s) => s.atMs), [3900, 5400]);
  console.log("openerSequence, double-logged casts: ok");
}

// --- Alignment ----------------------------------------------------------------
const seq = (ids: number[], extras: Array<[number, number]> = []): OpenerStep[] => {
  const core = ids.map((gameID, i) => ({ gameID, atMs: (i + 1) * 1000, extra: null }));
  const ex = extras.map(([gameID, atMs]) => ({ gameID, atMs, extra: "trinket" as const }));
  return [...core, ...ex].sort((a, b) => a.atMs - b.atMs);
};

{
  // One inserted cast early on must not mark every later cast as different.
  const rows = alignOpeners(seq([2, 1, 1, 4]), seq([2, 3, 1, 1, 4]));
  const yours = rows.filter((r) => r.yours).map((r) => r.yours!.status);
  const theirs = rows.filter((r) => r.theirs).map((r) => r.theirs!.status);
  assert.deepEqual(yours, ["same", "same", "same", "same"]);
  assert.deepEqual(theirs, ["same", "missing", "same", "same", "same"]);
  assert.equal(rows.length, 5, "shared casts share a row");
  console.log("align, insertion: ok");
}

{
  // The same button at a different point is an ordering difference, not missing.
  const rows = alignOpeners(seq([1, 2, 1, 1]), seq([2, 1, 1, 1]));
  const statuses = rows.flatMap((r) => [r.yours?.status, r.theirs?.status]).filter(Boolean);
  assert.ok(statuses.includes("order"));
  assert.ok(!statuses.includes("missing") && !statuses.includes("extra"), "a swap is only an ordering difference");
  console.log("align, reorder: ok");
}

{
  // Among equally long matches, prefer casts at neighbouring positions. Both
  // pairings below match three casts; lining up the tail Consumes (5) with the
  // head of theirs would mark everything else out of order. Shape taken from a
  // real Devourer opener where exactly that happened.
  const CONSUME = 5;
  const REAP = 6;
  const IMMOLATE = 7;
  const RAY = 8;
  const rows = alignOpeners(
    seq([IMMOLATE, 1, REAP, IMMOLATE, RAY, CONSUME, CONSUME, CONSUME]),
    seq([CONSUME, CONSUME, REAP, IMMOLATE, RAY, 1, 1, 1]),
  );
  const shared = rows.filter((r) => r.yours?.status === "same").map((r) => r.yours!.step.gameID);
  assert.deepEqual(shared, [REAP, IMMOLATE, RAY]);
  console.log("align, nearest pairing: ok");
}

assert.equal(extraKind("Freightrunner's Flask", "inv_alchemy_90_flask_red.jpg"), "item");

{
  // Extras sit on their own side, unnumbered and without a status.
  const rows = alignOpeners(seq([1, 1], [[90, 1500]]), seq([1, 4]));
  const extraRow = rows.find((r) => r.yours?.step.extra);
  assert.ok(extraRow && !extraRow.theirs, "an extra occupies its own row");
  assert.equal(extraRow!.yours!.status, null);
  assert.equal(extraRow!.yours!.index, 0);
  assert.equal(rows.indexOf(extraRow!), 1, "and keeps its place in time: after the first cast, before the second");
  const numbered = rows.filter((r) => r.yours && !r.yours.step.extra).map((r) => r.yours!.index);
  assert.deepEqual(numbered, [1, 2], "numbering skips extras");
  assert.equal(rows.find((r) => r.yours?.index === 2)?.yours?.status, "extra");
  assert.equal(rows.find((r) => r.theirs?.index === 2)?.theirs?.status, "missing");
  console.log("align, extras: ok");
}

console.log("opener: all assertions passed");
