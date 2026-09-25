import assert from "node:assert/strict";
import { wclUrl, wowheadSpellUrl } from "@/lib/wcl/links";

// A pull, the player selected.
assert.equal(
  wclUrl("D4K7nTaXtvr9L2Zk", 22, { source: 20 }),
  "https://www.warcraftlogs.com/reports/D4K7nTaXtvr9L2Zk#fight=22&source=20&type=casts",
);

// A window: WCL wants report-relative ms, so the fight's start is added, and
// the default 2s of padding gives the event context in the replay.
assert.equal(
  wclUrl("D4K7nTaXtvr9L2Zk", 22, { source: 20, window: { startTime: 4_505_290, startMs: 152_000, endMs: 158_000 } }),
  "https://www.warcraftlogs.com/reports/D4K7nTaXtvr9L2Zk#fight=22&source=20&start=4655290&end=4665290&type=casts",
);

// Padding never runs before the pull started; a point in time is a window too.
assert.equal(
  wclUrl("abc1234567", 3, { window: { startTime: 1000, startMs: 500 }, padMs: 1000, type: "deaths" }),
  "https://www.warcraftlogs.com/reports/abc1234567#fight=3&start=1000&end=2500&type=deaths",
);

assert.equal(wowheadSpellUrl(1290516), "https://www.wowhead.com/spell=1290516");

console.log("links: ok");
console.log("\nall assertions passed");
