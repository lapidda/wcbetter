import assert from "node:assert/strict";
import { parseReportInput } from "@/lib/wcl/fetchers";

// The URL straight out of a raider's address bar: fight and player both present.
{
  const parsed = parseReportInput(
    "https://www.warcraftlogs.com/reports/D4K7nTaXtvr9L2Zk?fight=22&source=20&type=damage-done",
  );
  assert.equal(parsed.code, "D4K7nTaXtvr9L2Zk");
  assert.equal(parsed.fightId, 22);
  assert.equal(parsed.sourceId, 20, "source= is the report-local actor id");
}

// WCL uses a hash fragment for the same parameters on some pages.
{
  const parsed = parseReportInput("https://www.warcraftlogs.com/reports/D4K7nTaXtvr9L2Zk#fight=last&source=7");
  assert.equal(parsed.fightId, "last");
  assert.equal(parsed.sourceId, 7);
}

// A bare code, with surrounding whitespace.
{
  const parsed = parseReportInput("  D4K7nTaXtvr9L2Zk \n");
  assert.equal(parsed.code, "D4K7nTaXtvr9L2Zk");
  assert.equal(parsed.fightId, undefined);
  assert.equal(parsed.sourceId, undefined);
}

// `fight=` must not swallow a following parameter name.
{
  const parsed = parseReportInput("https://www.warcraftlogs.com/reports/D4K7nTaXtvr9L2Zk?fight=3&source=12");
  assert.equal(parsed.fightId, 3);
  assert.equal(parsed.sourceId, 12);
}

assert.throws(() => parseReportInput("not-a-log"), /not a WarcraftLogs report/);
assert.throws(() => parseReportInput("https://example.com/reports/abc"), /not a WarcraftLogs report/);

console.log("parseReportInput: ok");
console.log("\nall assertions passed");
