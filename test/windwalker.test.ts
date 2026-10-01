import assert from "node:assert/strict";
import type { AbilityStat, PlayerProfile } from "@/lib/model/types";
import { analyzePull, buildChecks, detectTree, isWindwalker, WW } from "@/lib/spec/windwalker";

let nextId = 1;
const ids: Record<string, number> = {};
const idOf = (name: string) => (ids[name] ??= nextId++);

function profile(casts: Array<[number, string]>, extra: Partial<PlayerProfile> = {}, damageOnly: string[] = []): PlayerProfile {
  const abilities: Record<number, AbilityStat> = {};
  const add = (name: string, n: number, damage = 0, icon: string | null = null) => {
    const id = idOf(name);
    abilities[id] = { gameID: id, name, icon, casts: n, castsPerMinute: n, damage, damagePerCast: 0, interCastGaps: [] };
  };
  for (const [, name] of casts) add(name, casts.filter(([, n]) => n === name).length, 1, name === "Nullsight" ? "inv_trinket_x.jpg" : null);
  for (const name of damageOnly) add(name, 0, 1_000);
  return {
    key: "p", name: "Monk", actorId: 7, className: "Monk", specName: "Windwalker", reportCode: "r", fightId: 3,
    durationMs: 120_000, itemLevel: 326, burnStartMs: null, totalDamage: 1, dps: 1, activeTimeMs: 0, activeTimePct: 0,
    abilities, damageTaken: {}, buffs: {}, deaths: [], talents: [], gaps: [],
    castTimeline: casts.map(([t, name]) => ({ atMs: t, gameID: idOf(name) })),
    ...extra,
  };
}

// --- Detection -------------------------------------------------------------------
assert.ok(isWindwalker({ className: "Monk", specName: "Windwalker" }));
assert.ok(!isWindwalker({ className: "Monk", specName: "Brewmaster" }));
assert.equal(detectTree(profile([[0, WW.XUEN]])).tree, "conduit");
assert.equal(detectTree(profile([[0, WW.TP]], {}, ["Flurry Strikes"])).tree, "shado-pan");
assert.equal(detectTree(profile([[0, WW.TP]])).tree, "unknown");
console.log("windwalker detection: ok");

// --- A textbook window: nothing is marked --------------------------------------
{
  const clean = profile([
    [0, WW.TP],
    [1_000, WW.XUEN],
    [1_100, "Nullsight"],
    [1_200, WW.ZENITH],
    [1_800, WW.FOF],
    [3_200, WW.SCK],
    [4_300, WW.RSK],
    [5_300, WW.WDP],
    [6_400, WW.SCK],
    [7_400, WW.BOK],
    [8_500, WW.FOF],
    [10_000, WW.SCK],
    [11_200, WW.RSK],
    [12_500, WW.CONDUIT],
    [13_200, WW.UNITY],
    [13_400, WW.FOF],
    [14_800, WW.SCK],
  ]);
  const pull = analyzePull(clean, "conduit", { label: "Pull 1", kill: true });
  const marked = pull.presses.filter((p) => p.marks.length > 0);
  assert.deepEqual(marked.map((p) => `${p.name}:${p.marks.map((m) => m.code)}`), [], "a textbook window has no marks");
  const [w] = pull.windows;
  assert.equal(w.zenith, true);
  assert.equal(w.items, true);
  assert.equal(w.fof, 2, "the Fists of Fury after Conduit is not counted in the window");
  assert.equal(w.wdp, 1);
  assert.equal(w.tigerPalms, 0, "the Tiger Palm before Xuen is the entry, not a burst press");
  assert.equal(w.conduitMs, 11_500);
  assert.equal(w.sinceWdpMs, 7_200);
  assert.equal(w.fofAfterConduit, true);
  console.log("windwalker clean window: ok");
}

// --- Every mistake the module knows, each marked where it happened -------------
{
  const messy = profile([
    [0, WW.TP],
    [500, WW.WDP], // 4.5s before Xuen: should have been held
    [5_000, WW.XUEN], // no Zenith with it
    [6_000, WW.TP], // Tiger Palm inside the window
    [7_000, WW.FOF],
    [8_000, WW.RSK],
    [9_000, WW.RSK], // Combo Strikes break
    [10_000, WW.WDP],
    [12_000, WW.CONDUIT], // 7s after Xuen (early) and 2s after WDP (overlap)
    [12_700, WW.UNITY],
    [13_000, WW.BOK], // not Fists of Fury after Conduit: shown, never marked
    [14_000, WW.ZENITH],
    [14_500, WW.BOK], // Blackout Kick again, but with Zenith between: not a break
  ]);
  const pull = analyzePull(messy, "conduit", { label: "Pull 2", kill: false });
  const codes = (name: string, t: number) =>
    pull.presses.find((p) => p.name === name && p.t === t)!.marks.map((m) => m.code).sort();
  assert.deepEqual(codes(WW.WDP, 500), ["wdp-before-xuen"]);
  assert.deepEqual(codes(WW.XUEN, 5_000), ["no-zenith-with-xuen"]);
  assert.deepEqual(codes(WW.TP, 6_000), ["tp-in-burst"]);
  assert.deepEqual(codes(WW.RSK, 9_000), ["combo-break"]);
  assert.deepEqual(codes(WW.CONDUIT, 12_000), ["conduit-overlap", "conduit-timing"]);
  assert.deepEqual(codes(WW.BOK, 13_000), [], "the top parses skip this half the time, so it is not a mistake");
  assert.deepEqual(codes(WW.BOK, 14_500), [], "a repeat with Zenith between is how the top parses do it");
  assert.deepEqual(codes(WW.TP, 0), [], "Tiger Palm before Xuen is fine");

  assert.equal(pull.metrics.wdpBeforeXuen, 1);
  assert.equal(pull.metrics.windows, 1);
  assert.equal(pull.metrics.zenithPairedPct, 0);
  assert.equal(pull.metrics.fofAfterConduitPct, 0, "still measured, for the window table");
  assert.equal(pull.metrics.comboBreaksPerMin, 0.5, "one break in a two-minute pull");
  console.log("windwalker mistakes: ok");
}

// --- One press logged under two ids is one press, not a Combo Strikes break ------
{
  const doubled = profile([
    [0, WW.RSK],
    [1_000, "Voidblade"],
    [1_050, "Voidblade"],
    [2_000, WW.TP],
  ]);
  // Voidblade is not a Windwalker button, but the double-log rule is generic.
  const pull = analyzePull(doubled, "conduit", { label: "x", kill: true });
  assert.equal(pull.presses.length, 3);
  assert.ok(!pull.presses.some((p) => p.marks.length), "no break from a double-logged press");
  console.log("windwalker double-log: ok");
}

// --- Xuen cadence: room for windows the pull did not use --------------------------
{
  const long = profile([[1_000, WW.XUEN], [1_200, WW.ZENITH]], { durationMs: 300_000 });
  const pull = analyzePull(long, "conduit", { label: "x", kill: true, xuenCooldownMs: 90_000 });
  assert.equal(pull.metrics.possibleWindows, 4, "5:00 at a 90s cooldown has room for 4 windows");
  assert.equal(pull.metrics.windows, 1);
  console.log("windwalker cadence: ok");
}

// --- Scorecard statuses -------------------------------------------------------------
{
  const good = analyzePull(
    profile([[0, WW.TP], [1_000, WW.XUEN], [1_200, WW.ZENITH], [1_800, WW.FOF], [3_000, WW.SCK]]),
    "conduit",
    { label: "x", kill: true },
  ).metrics;
  const bad = { ...good, comboBreaksPerMin: 3, tigerPalmsPerWindow: 2.5 };
  const checks = buildChecks("conduit", [bad], [good]);
  const status = (id: string) => checks.find((c) => c.id === id)!.status;
  assert.equal(status("combo-breaks"), "bad");
  assert.equal(status("tp-in-burst"), "bad", "2.5 a window against a clean reference");
  assert.equal(status("zenith-with-xuen"), "good");
  assert.ok(checks.every((c) => c.you && c.top && c.advice), "every check says what, against what, and what to do");
  assert.ok(!buildChecks("shado-pan", [good], [good]).some((c) => c.id === "tp-in-burst"), "Conduit checks stay off Shado-Pan");
  console.log("windwalker checks: ok");
}

console.log("windwalker: all assertions passed");
