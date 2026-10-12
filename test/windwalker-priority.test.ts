import assert from "node:assert/strict";
import {
  priorityViolations,
  summarizePriority,
  type PriorityAura,
  type PriorityCast,
  type PriorityInput,
} from "@/lib/spec/windwalker-priority";

const cast = (t: number, name: string, extra: Partial<PriorityCast> = {}): PriorityCast => ({
  t,
  name,
  energy: 80,
  energyMax: 150,
  chi: null,
  chiCost: null,
  chiMax: 6,
  ...extra,
});
const aura = (t: number, type: string, id: number, name: string): PriorityAura => ({ t, type, id, name });
const input = (casts: PriorityCast[], auras: PriorityAura[] = [], deathsMs: number[] = []): PriorityInput => ({
  durationMs: 120_000,
  casts,
  auras,
  deathsMs,
});
const ranks = (i: PriorityInput) => priorityViolations(i).map((v) => `${v.rank}:${v.kind}`);

const BOK_PROC = 116768;
const DANCE = 325202;
const ZENITH = 1249625;
const HOTJS_WDP = 443421;
const HOTJS_ZENITH = 1238904;

// Energy cap: a filler at full Energy outside Zenith skips line 5; inside Zenith it does not.
{
  assert.deepEqual(ranks(input([cast(10_000, "Blackout Kick", { energy: 150 })])), ["5:skipped"]);
  assert.deepEqual(
    ranks(input([cast(10_000, "Blackout Kick", { energy: 150 })], [aura(9_000, "applybuff", ZENITH, "Zenith")])),
    [],
  );
  assert.deepEqual(ranks(input([cast(10_000, "Tiger Palm", { energy: 150 })])), [], "Tiger Palm is the fix");
  assert.deepEqual(ranks(input([cast(1_000, "Blackout Kick", { energy: 150 })])), [], "pull start: everyone is full");
}

// Blackout Kick!: Tiger Palm with the proc up is only provably wrong when Chi was known to be enough.
{
  const proc = [aura(5_000, "applybuff", BOK_PROC, "Blackout Kick!"), aura(20_000, "removebuff", BOK_PROC, "Blackout Kick!")];
  const spendThenPalm = [cast(6_000, "Rising Sun Kick", { chi: 6, chiCost: 2 }), cast(8_000, "Tiger Palm"), cast(20_000, "Blackout Kick")];
  assert.deepEqual(ranks(input(spendThenPalm, proc)), ["10:skipped"]);
  // Chi never seen: Tiger Palm might have been for Chi (line 5), so it is not marked.
  assert.deepEqual(ranks(input([cast(8_000, "Tiger Palm"), cast(20_000, "Blackout Kick")], proc)), []);
  // Spinning Crane Kick without Dance of Chi-Ji is below line 10.
  assert.deepEqual(ranks(input([cast(8_000, "Spinning Crane Kick"), cast(20_000, "Blackout Kick")], proc)), ["10:skipped"]);
  // Right after a Blackout Kick, a second one would break Combo Strikes: not a skip.
  assert.deepEqual(
    ranks(input([cast(7_000, "Blackout Kick"), cast(8_000, "Spinning Crane Kick"), cast(20_000, "Blackout Kick")], proc)),
    [],
  );
}

// Line 8: Unbroken Rhythm alone (the Season 2 four-piece) puts Crane Kick above Rising Sun Kick —
// Dance of Chi-Ji is not required on Conduit.
{
  const rhythm = [aura(5_000, "applybuff", 1297033, "Unbroken Rhythm"), aura(9_000, "removebuff", 1297033, "Unbroken Rhythm")];
  assert.deepEqual(ranks(input([cast(6_000, "Rising Sun Kick", { chi: 4, chiCost: 2 }), cast(7_000, "Spinning Crane Kick")], rhythm)), ["8:skipped"]);
  assert.deepEqual(ranks(input([cast(6_000, "Spinning Crane Kick"), cast(7_000, "Rising Sun Kick", { chi: 4, chiCost: 2 })], rhythm)), [], "right after a Crane Kick: a second would break Combo Strikes");
}

// Procs that run out unused are wasted; consumed or dropped by a death they are not.
{
  const proc = [aura(5_000, "applybuff", DANCE, "Dance of Chi-Ji"), aura(20_000, "removebuff", DANCE, "Dance of Chi-Ji")];
  assert.deepEqual(ranks(input([], proc)), ["13:wasted"]);
  assert.deepEqual(ranks(input([cast(20_000, "Spinning Crane Kick")], proc)), []);
  assert.deepEqual(ranks(input([], proc, [19_500])), []);
}

// Line 2: Conduit with Whirling Dragon Punch's Heart of the Jade Serpent still running. The id is
// learned from what Whirling Dragon Punch applies; Zenith's own Heart of the Jade Serpent does not count.
{
  const auras = [
    aura(10_010, "applybuff", HOTJS_WDP, "Heart of the Jade Serpent"),
    aura(16_000, "removebuff", HOTJS_WDP, "Heart of the Jade Serpent"),
    aura(30_010, "applybuff", HOTJS_ZENITH, "Heart of the Jade Serpent"),
    aura(34_000, "removebuff", HOTJS_ZENITH, "Heart of the Jade Serpent"),
  ];
  const v = priorityViolations(
    input([cast(10_000, "Whirling Dragon Punch"), cast(13_000, "Celestial Conduit"), cast(30_000, "Zenith"), cast(31_000, "Celestial Conduit")], auras),
  );
  assert.deepEqual(v.map((x) => x.rank), [2]);
  assert.match(v[0].note, /3\.0s of Heart of the Jade Serpent/);
}

// Line 1: Whirling Dragon Punch inside the 10s before Xuen.
{
  assert.deepEqual(ranks(input([cast(10_000, "Whirling Dragon Punch"), cast(15_000, "Invoke Xuen, the White Tiger")])), ["1:skipped"]);
  assert.deepEqual(ranks(input([cast(10_000, "Whirling Dragon Punch"), cast(25_000, "Invoke Xuen, the White Tiger")])), []);
}

// Two ids for one press at the same millisecond are one press.
{
  const proc = [aura(5_000, "applybuff", BOK_PROC, "Blackout Kick!"), aura(20_000, "removebuff", BOK_PROC, "Blackout Kick!")];
  const v = priorityViolations(
    input([cast(8_000, "Spinning Crane Kick"), cast(8_000, "Chi Explosion"), cast(20_000, "Blackout Kick")], proc),
  );
  assert.equal(v.length, 1);
}

// The summary ranks the checkable lines by how far you are over the top parses.
{
  const mine = [
    { rank: 5, kind: "skipped" as const, t: 1, pressed: "Blackout Kick", note: "" },
    { rank: 5, kind: "skipped" as const, t: 2, pressed: "Blackout Kick", note: "" },
    { rank: 10, kind: "skipped" as const, t: 3, pressed: "Tiger Palm", note: "" },
    { rank: 10, kind: "wasted" as const, t: 4, pressed: null, note: "" },
    { rank: 10, kind: "skipped" as const, t: 5, pressed: "Tiger Palm", note: "" },
  ];
  const top = [{ rank: 10, kind: "skipped" as const, t: 1, pressed: "Tiger Palm", note: "" }];
  const s = summarizePriority(
    [{ fightId: 1, label: "Pull 1", durationMs: 60_000, violations: mine }],
    [{ durationMs: 60_000, violations: top }],
  );
  assert.deepEqual(s.rows.slice(0, 2).map((r) => r.rank), [5, 10], "both +2/min over the top parses: the higher line first");
  const ten = s.rows.find((r) => r.rank === 10)!;
  assert.equal(ten.you.wasted, 1);
  assert.equal(ten.topPerMin, 1);
  const lastChecked = s.rows.map((r) => r.checked).lastIndexOf(true);
  assert.ok(s.rows.findIndex((r) => !r.checked) > lastChecked, "unchecked lines come last");
}

console.log("windwalker-priority: ok");
