import assert from "node:assert/strict";
import { emptyProfile } from "@/lib/model/mechanic-profile";
import test from "node:test";
import {
  addLine,
  applyStored,
  fromGenerated,
  isUnwritten,
  mergeDocInto,
  mergeGenerated,
  removeLine,
  renderDoc,
  setCaller,
  setText,
  setTime,
  storageKey,
  textOf,
  toStored,
  toggleEnabled,
  type DocLine,
} from "@/lib/model/note-doc";
import {
  CALL_PLACEHOLDER,
  buildHeader,
  generateLines,
  type GeneratedLine,
} from "@/lib/nsrt/generate";
import type { MechanicSeries, RaidRoster } from "@/lib/model/raid";
import { findNotableMechanics } from "@/lib/model/notable";

/** One avoidable mechanic at 60s: a varying minority hit on every pull. */
function mechanicNamed(name: string) {
  const pulls = Array.from({ length: 6 }, (_, i) => ({ fightId: i + 1, durationMs: 600_000 }));
  const counts = [3, 7, 4, 9, 2, 6];
  const series: MechanicSeries = {
    name,
    castGameIDs: [100],
    damageGameIDs: [100],
    icon: null,
    mappedBy: "name",
    profile: emptyProfile(),
    occurrences: pulls.map((p) => ({
      fightId: p.fightId,
      ordinal: 1,
      atMs: 60_000,
      hits: [5, 6, 7, 8, 9, 10]
        .slice(0, counts[p.fightId - 1])
        .map((targetId) => ({ targetId, count: 1, amount: 5000, firstAtMs: 60_000 })),
      eligible: Array.from({ length: 20 }, (_, i) => i + 1),
      deaths: [{ targetId: 5, atMs: 60_000, byKillingBlow: true }],
    })),
  };
  const roster: RaidRoster = { actors: {}, byFight: {}, tankIds: new Set() };
  return findNotableMechanics([series], roster, { totalRaidDamageTaken: 1_000_000, pulls })[0];
}
import { parseNote } from "@/lib/nsrt/note-syntax";

function generated(over: Partial<GeneratedLine> = {}): GeneratedLine {
  return {
    id: "Stone Breaker#1@everyone",
    source: { mechanic: "Stone Breaker", ordinal: 1 },
    enabled: true,
    timeSec: 57,
    tag: "everyone",
    text: `Stone Breaker ${CALL_PLACEHOLDER}`,
    mechanic: "Stone Breaker",
    spellId: 100,
    priority: 10,
    seen: 6,
    reached: 6,
    failedOn: 5,
    deaths: 1,
    medianHitCount: 4,
    confident: true,
    spreadMs: 0,
    offenders: [],
    ...over,
  };
}

const HEADER = buildHeader({ id: 3421, name: "The Twin Fangs", difficulty: "Heroic" });

test("an edited call survives regeneration", () => {
  // The whole point of the editor: the log can re-derive when a mechanic lands,
  // but never that the answer is "Move to Soak".
  let lines = [fromGenerated(generated())];
  lines = setText(lines, lines[0].id, "Move to Soak");

  // Next week's log: same mechanic, new numbers, slightly different timing.
  const fresh = generated({ timeSec: 59, deaths: 4, failedOn: 6 });
  lines = mergeGenerated(lines, [fresh]);

  assert.equal(textOf(lines[0]), "Move to Soak", "the wording is the user's");
  assert.equal(lines[0].deaths, 4, "the evidence is the log's");
  assert.equal(lines[0].timeSec, 59, "and so is the timing, until it is edited");
});

test("renaming the caller does not destroy the calls already written", () => {
  // Found in the browser: the line id used to fold in the tag, so typing a name
  // into "Calling:" changed every id, the merge matched nothing, and every
  // rewritten call was silently replaced by the generated wording again.
  const roster: RaidRoster = { actors: {}, byFight: {}, tankIds: new Set() };
  const notable = [mechanicNamed("Caustic Globule")];

  const asEveryone = generateLines(notable, roster);
  let lines = [fromGenerated(asEveryone[0])];
  lines = setText(lines, lines[0].id, "Move to Soak");

  const asRaidlead = generateLines(notable, roster, { tag: "Raidlead" });
  assert.equal(asRaidlead[0].id, asEveryone[0].id, "the id must not depend on who is reading it");

  lines = mergeGenerated(lines, asRaidlead);
  assert.equal(textOf(lines[0]), "Move to Soak");
  assert.equal(lines[0].tag, "Raidlead", "the tag still follows the caller");
});

test("a hand-nudged timer is not overwritten by regeneration", () => {
  let lines = [fromGenerated(generated())];
  lines = setTime(lines, lines[0].id, 52);
  lines = mergeGenerated(lines, [generated({ timeSec: 59 })]);
  assert.equal(lines[0].timeSec, 52);
});

test("a call switched off stays off across regeneration", () => {
  let lines = [fromGenerated(generated())];
  lines = toggleEnabled(lines, lines[0].id);
  lines = mergeGenerated(lines, [generated()]);
  assert.equal(lines[0].enabled, false);
});

test("hand-added calls are never lost to regeneration", () => {
  let lines = [fromGenerated(generated())];
  lines = addLine(lines, { timeSec: 120, tag: "everyone" });
  lines = setText(lines, lines[1].id, "Pre-pot now");

  lines = mergeGenerated(lines, [generated()]);
  assert.equal(lines.length, 2);
  assert.ok(lines.some((l) => textOf(l) === "Pre-pot now"));
});

test("a mechanic that stops being a problem drops out, edits and all", () => {
  // Regeneration is the source of truth for *which* calls exist; only their
  // wording belongs to the user.
  let lines = [fromGenerated(generated())];
  lines = setText(lines, lines[0].id, "Move to Soak");
  lines = mergeGenerated(lines, []);
  assert.deepEqual(lines, []);
});

test("restoring the generated wording clears the override", () => {
  const base = generated();
  let lines = [fromGenerated(base)];
  lines = setText(lines, base.id, "Something else");
  assert.equal(lines[0].custom, "Something else");

  lines = setText(lines, base.id, base.text);
  assert.equal(lines[0].custom, undefined, "no phantom override to carry forward");
  assert.equal(textOf(lines[0]), base.text);
});

test("an unwritten call is detectable so the UI can say so", () => {
  const lines = [fromGenerated(generated())];
  assert.equal(isUnwritten(lines[0]), true);
  assert.equal(isUnwritten(setText(lines, lines[0].id, "Move to Soak")[0]), false);
});

test("lines stay in time order however they are edited", () => {
  let lines = [
    fromGenerated(generated({ id: "a", timeSec: 10 })),
    fromGenerated(generated({ id: "b", timeSec: 200 })),
  ];
  lines = setTime(lines, "b", 5);
  assert.deepEqual(lines.map((l) => l.id), ["b", "a"]);

  lines = addLine(lines, { timeSec: 7, tag: "everyone" });
  assert.deepEqual(lines.map((l) => l.timeSec), [5, 7, 10]);
});

test("re-tagging moves the whole note to a new caller at once", () => {
  const lines = setCaller([fromGenerated(generated())], "Raidlead");
  assert.equal(lines[0].tag, "Raidlead");
  assert.equal(setCaller(lines, "   ")[0].tag, "everyone", "a blank name is not a tag");
});

test("only enabled lines reach the note", () => {
  let lines = [
    fromGenerated(generated({ id: "a", timeSec: 10 })),
    fromGenerated(generated({ id: "b", timeSec: 20 })),
  ];
  lines = toggleEnabled(lines, "b");
  const note = renderDoc(HEADER, lines);
  assert.equal(note.split("\n").filter((l) => l.startsWith("time:")).length, 1);
  assert.match(note.split("\n")[0], /^EncounterID:3421;/);
});

test("the note renders as lines NSRT can read back", () => {
  const lines = [fromGenerated(generated())];
  const parsed = parseNote(renderDoc(HEADER, lines));
  assert.equal(parsed.header?.encounterId, 3421);
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].kind, "text");
});

test("splicing into an existing note keeps every cooldown assignment", () => {
  const existing = parseNote(
    [
      "EncounterID:3421;Difficulty:Heroic;Name:The Twin Fangs",
      "time:1;ph:1;tag:Niome;spellid:1276452;",
      "time:80;ph:1;tag:Yami;spellid:205180;",
      "",
    ].join("\n"),
  );
  const merged = mergeDocInto(existing, [fromGenerated(generated())]);
  assert.equal(merged.lines.filter((l) => l.kind === "cooldown").length, 2);
  assert.equal(merged.lines.filter((l) => l.kind === "text").length, 1);
});

test("splicing twice does not duplicate our calls", () => {
  const existing = parseNote("EncounterID:1;Difficulty:Heroic;Name:B\ntime:1;ph:1;tag:N;spellid:5;\n");
  const lines = [fromGenerated(generated())];
  const once = mergeDocInto(existing, lines);
  const twice = mergeDocInto(once, lines);
  assert.equal(
    twice.lines.filter((l) => l.kind === "text").length,
    once.lines.filter((l) => l.kind === "text").length,
  );
});

test("only decisions are persisted, never the evidence", () => {
  // The numbers come back from the log on every run; a stored copy could only
  // ever go stale and disagree with the analysis.
  let lines = [fromGenerated(generated())];
  lines = setText(lines, lines[0].id, "Move to Soak");
  const stored = toStored({ caller: "Raidlead", includeNames: true, placeholder: true, lines });

  assert.deepEqual(stored.edits, [
    { id: "Stone Breaker#1@everyone", enabled: true, custom: "Move to Soak", timeSec: undefined },
  ]);
  const json = JSON.stringify(stored);
  assert.ok(!json.includes("deaths"), json);
  assert.ok(!json.includes("medianHitCount"));
});

test("an untouched note stores nothing", () => {
  const lines = [fromGenerated(generated())];
  assert.deepEqual(toStored({ caller: "", includeNames: false, placeholder: true, lines }).edits, []);
});

test("stored edits reapply to a fresh analysis", () => {
  let lines: DocLine[] = [fromGenerated(generated())];
  lines = setText(lines, lines[0].id, "Move to Soak");
  lines = setTime(lines, lines[0].id, 52);
  const stored = toStored({ caller: "", includeNames: false, placeholder: true, lines });

  // A week later, from scratch.
  const restored = applyStored([fromGenerated(generated({ timeSec: 61 }))], stored);
  assert.equal(textOf(restored[0]), "Move to Soak");
  assert.equal(restored[0].timeSec, 52);
  assert.equal(restored[0].timeEdited, true);
});

test("removing a call removes exactly one", () => {
  const lines = [
    fromGenerated(generated({ id: "a" })),
    fromGenerated(generated({ id: "b" })),
  ];
  assert.deepEqual(removeLine(lines, "a").map((l) => l.id), ["b"]);
});

test("the storage key separates reports and bosses", () => {
  assert.notEqual(storageKey("AAA", 1), storageKey("AAA", 2));
  assert.notEqual(storageKey("AAA", 1), storageKey("BBB", 1));
});
