import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  EVERYONE,
  emitLine,
  emitNote,
  parseNote,
  sanitizeText,
  toNoteTime,
  type CooldownLine,
  type TextLine,
} from "@/lib/nsrt/note-syntax";

const FIXTURE = readFileSync("test/fixtures/nsrt-cd-note.txt", "utf8");

test("the real note round-trips byte for byte", () => {
  // The strongest test available: anything the parser misreads or the emitter
  // spells differently shows up as a diff against a note NSRT actually produced.
  assert.equal(emitNote(parseNote(FIXTURE)), FIXTURE);
});

test("the header is read as the fight it describes", () => {
  const { header } = parseNote(FIXTURE);
  assert.equal(header?.encounterId, 3420);
  assert.equal(header?.difficulty, "Heroic");
  assert.equal(header?.name, "Sszorak");
});

test("every body line of the real note is understood", () => {
  const { lines } = parseNote(FIXTURE);
  assert.equal(lines.length, 378);
  const opaque = lines.filter((l) => l.kind === "opaque");
  assert.deepEqual(opaque, [], "nothing in the sample should need the fallback");
});

test("reminder lines are read as text, addressed to the raid or one player", () => {
  const text = parseNote(FIXTURE).lines.filter((l): l is TextLine => l.kind === "text");
  assert.equal(text.length, 2);

  assert.deepEqual(
    { ...text[0], extra: [] },
    { kind: "text", timeSec: 133, phase: 1, tag: EVERYONE, text: "Test Reminder Everyone", extra: [] },
  );
  assert.equal(text[1].tag, "Ennuvathar", "a character name addresses one player");
  assert.equal(text[1].text, "Text Reminder Person");
});

test("a text line emits with text where a cooldown puts spellid", () => {
  const line: TextLine = {
    kind: "text",
    timeSec: 133,
    phase: 1,
    tag: EVERYONE,
    text: "Test Reminder Everyone",
    extra: [],
  };
  assert.equal(emitLine(line), "time:133;ph:1;tag:everyone;text:Test Reminder Everyone;");
});

test("a semicolon in text is stripped, because it would split the line", () => {
  // No escape was visible in the sample, and `;` is the field separator, so
  // emitting one raw would corrupt the note.
  assert.equal(sanitizeText("Stone Breaker; move out"), "Stone Breaker move out");
  const line: TextLine = {
    kind: "text",
    timeSec: 5,
    phase: 1,
    tag: EVERYONE,
    text: "a;b\nc",
    extra: [],
  };
  assert.equal(emitLine(line), "time:5;ph:1;tag:everyone;text:a b c;");
  // And the result must survive a round trip as one line.
  assert.equal(parseNote(emitLine(line)).lines.length, 1);
});

test("cooldown fields are typed, not left as strings", () => {
  const { lines } = parseNote(FIXTURE);
  const first = lines[0] as CooldownLine;
  assert.equal(first.kind, "cooldown");
  assert.equal(first.timeSec, 0);
  assert.equal(first.phase, 1);
  assert.equal(first.tag, "Niome");
  assert.equal(first.spellId, 1276452);
});

test("non-ASCII character names survive intact", () => {
  const { lines } = parseNote(FIXTURE);
  const tags = new Set(lines.filter((l): l is CooldownLine => l.kind === "cooldown").map((l) => l.tag));
  for (const name of ["Âmâterasu", "Киалра", "Tinalthéa"]) {
    assert.ok(tags.has(name), `${name} must parse unescaped`);
  }
  assert.equal(tags.size, 20);
});

test("an unrecognised line is preserved verbatim rather than dropped", () => {
  // The whole point of parsing is to splice into a note someone already has:
  // destroying a line we do not understand would destroy raid assignments.
  const text = [
    "EncounterID:3420;Difficulty:Heroic;Name:Sszorak",
    "time:5;ph:1;tag:Niome;spellid:1276452;",
    "{time:0:12} something we have never seen |cffff0000red|r",
    "",
    "time:9;ph:2;tag:Yami;spellid:205180;",
  ].join("\n");

  const note = parseNote(text);
  assert.deepEqual(
    note.lines.map((l) => l.kind),
    ["cooldown", "opaque", "opaque", "cooldown"],
  );
  assert.equal(emitNote(note), text);
});

test("unknown keys on a known line are kept in order", () => {
  const raw = "time:5;ph:1;tag:Niome;spellid:1276452;colour:ff0000;";
  const note = parseNote(raw);
  const line = note.lines[0] as CooldownLine;
  assert.equal(line.kind, "cooldown");
  assert.deepEqual(line.extra, [["colour", "ff0000"]]);
  assert.equal(emitNote(note), raw);
});

test("a line missing a required field is not mistaken for a cooldown", () => {
  for (const raw of ["time:5;ph:1;tag:Niome;", "ph:1;tag:Niome;spellid:12;", "time:x;tag:A;spellid:1;"]) {
    assert.equal(parseNote(raw).lines[0].kind, "opaque", raw);
  }
});

test("note times truncate, because that is what the format does", () => {
  // Measured on the real note: every offset was +0.1s to +0.9s, so the writer
  // floors. Rounding would put half the timers a second late.
  assert.equal(toNoteTime(0), 0);
  assert.equal(toNoteTime(999), 0);
  assert.equal(toNoteTime(1000), 1);
  assert.equal(toNoteTime(14_900), 14);
  assert.equal(toNoteTime(-50), 0);
});

test("emitting a line without a phase omits ph entirely", () => {
  const line: CooldownLine = {
    kind: "cooldown",
    timeSec: 12,
    phase: null,
    tag: "Alyx",
    spellId: 740,
    extra: [],
  };
  assert.equal(emitLine(line), "time:12;tag:Alyx;spellid:740;");
});
