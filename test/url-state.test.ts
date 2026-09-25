import assert from "node:assert/strict";
import { decodeState, defaultSelection, encodeState } from "@/lib/url-state";

// --- round trip -------------------------------------------------------------
{
  const state = { report: "D4K7nTaXtvr9L2Zk", source: 20, fight: 22, pulls: [11, 12, 22] };
  const encoded = encodeState(state);
  assert.equal(encoded, "?report=D4K7nTaXtvr9L2Zk&source=20&fight=22&pulls=11%2C12%2C22");
  assert.deepEqual(decodeState(encoded), state);
  console.log("url round trip: ok");
}

// A pasted WCL-style link prefills but carries no `pulls`, which is the signal
// that it is not a finished report and must not auto-run.
{
  const state = decodeState("?report=abc1234567&source=20&fight=22");
  assert.equal(state.pulls, undefined);
  assert.equal(state.fight, 22);
}

// Junk is dropped rather than trusted.
{
  const state = decodeState("?report=abc1234567&source=notanumber&fight=-3&pulls=1,x,,3");
  assert.equal(state.source, undefined);
  assert.equal(state.fight, undefined, "negative fight ids are not fight ids");
  assert.deepEqual(state.pulls, [1, 3], "unparseable entries are skipped");
}

assert.deepEqual(decodeState(""), { report: undefined, source: undefined, fight: undefined, pulls: undefined });
assert.equal(encodeState({}), "");

// --- defaultSelection -------------------------------------------------------
{
  // A night of real attempts plus one 20s accident.
  const fights = [
    { id: 1, durationMs: 129_000 },
    { id: 2, durationMs: 430_000 },
    { id: 3, durationMs: 490_000 },
    { id: 4, durationMs: 20_000 },
  ];
  const { selected, short } = defaultSelection(fights);
  assert.deepEqual(selected, [1, 2, 3]);
  assert.deepEqual(short, [4], "a 20s pull is not an attempt");
}

// Everything short means the floor was wrong: take them all rather than nothing.
{
  const { selected, short } = defaultSelection([
    { id: 1, durationMs: 12_000 },
    { id: 2, durationMs: 15_000 },
  ]);
  assert.deepEqual(selected, [1, 2]);
  assert.deepEqual(short, []);
}

assert.deepEqual(defaultSelection([]), { selected: [], short: [] });
console.log("defaultSelection: ok");

console.log("\nall assertions passed");
