import assert from "node:assert/strict";
import { emptyProfile } from "@/lib/model/mechanic-profile";
import { readFileSync } from "node:fs";
import test from "node:test";
import { findNotableMechanics, type PullLength } from "@/lib/model/notable";
import type { MechanicOccurrence, MechanicSeries, RaidRoster } from "@/lib/model/raid";
import {
  buildHeader,
  CALL_PLACEHOLDER,
  generateLines,
  generatePersonalLines,
  mergeIntoNote,
  renderNote,
  LEAD_SECONDS,
  MAX_NAMES,
} from "@/lib/nsrt/generate";
import { EVERYONE, emitLine, emitNote, parseNote, type TextLine } from "@/lib/nsrt/note-syntax";

/** The same shape renderNote emits, for asserting on a single line. */
function toTextLineFor(line: { timeSec: number; tag: string; text: string }): TextLine {
  return { kind: "text", timeSec: line.timeSec, phase: 1, tag: line.tag, text: line.text, extra: [] };
}

const ROSTER: RaidRoster = {
  actors: Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [i + 1, { id: i + 1, name: `P${i + 1}`, className: "Mage" }]),
  ),
  byFight: {},
  tankIds: new Set([1, 2]),
};

const PULLS: PullLength[] = Array.from({ length: 6 }, (_, i) => ({
  fightId: i + 1,
  durationMs: 600_000,
}));

function occurrence(fightId: number, atMs: number, hitIds: number[], deaths = 0): MechanicOccurrence {
  return {
    fightId,
    ordinal: 1,
    atMs,
    hits: hitIds.map((targetId) => ({ targetId, count: 1, amount: 5000, firstAtMs: atMs })),
    eligible: Array.from({ length: 20 }, (_, i) => i + 1),
    deaths: Array.from({ length: deaths }, () => ({ targetId: 5, atMs, byKillingBlow: true })),
  };
}

function series(name: string, occurrences: MechanicOccurrence[], castId = 100): MechanicSeries {
  return {
    name,
    castGameIDs: [castId],
    damageGameIDs: [castId],
    icon: null,
    mappedBy: "name",
    profile: emptyProfile(),
    occurrences,
  };
}

/** One avoidable mechanic: a varying minority hit, every pull, at ~60s. */
function avoidable(name = "Stone Breaker", atMs = 60_000): MechanicSeries {
  const counts = [3, 7, 4, 9, 2, 6];
  return series(
    name,
    PULLS.map((p) => occurrence(p.fightId, atMs, [5, 6, 7, 8, 9, 10].slice(0, counts[p.fightId - 1]), 1)),
  );
}

function notableFrom(...all: MechanicSeries[]) {
  return findNotableMechanics(all, ROSTER, { totalRaidDamageTaken: 1_000_000, pulls: PULLS });
}

test("a warning fires before its mechanic, never on top of it", () => {
  const [line] = generateLines(notableFrom(avoidable()), ROSTER, { placeholder: false });
  assert.equal(line.timeSec, 60 - LEAD_SECONDS);
  assert.equal(line.tag, EVERYONE);
  assert.equal(line.text, "Stone Breaker");
});

test("a burst says how many casts are coming", () => {
  const burst = series(
    "Caustic Globule",
    PULLS.flatMap((p) =>
      [60_000, 63_000, 67_000].map((at) => occurrence(p.fightId, at, [5, 6, 7].slice(0, (p.fightId % 3) + 1))),
    ),
  );
  const [line] = generateLines(notableFrom(burst), ROSTER, { placeholder: false });
  assert.equal(line.text, "Caustic Globule x3");
});

test("the note carries no invented instruction", () => {
  // "move out" vs "soak" vs "spread" are indistinguishable in a damage log, so
  // the generator emits the mechanic and leaves the verb to the raid leader.
  const [line] = generateLines(notableFrom(avoidable()), ROSTER);
  assert.doesNotMatch(line.text, /move|soak|spread|dodge|stack|out|away/i);
});

test("tanks are never named as offenders", () => {
  // Measured on a real log: the top offenders for two mechanics were both tanks,
  // who are supposed to be standing in it.
  // Both tanks and P5 eat it every pull; a crowd of others only sometimes, which
  // is what keeps it "avoidable" rather than a soak.
  const splash = [11, 12, 13, 14, 15, 16];
  const tankMechanic = series(
    "Tank Buster",
    PULLS.map((p) =>
      occurrence(p.fightId, 60_000, [1, 2, 5, ...(p.fightId % 3 === 0 ? splash : [])]),
    ),
  );
  const [line] = generateLines(notableFrom(tankMechanic), ROSTER, { includeNames: true });
  assert.ok(!line.offenders.includes("P1"), "P1 is a tank");
  assert.ok(!line.offenders.includes("P2"), "P2 is a tank");
  assert.deepEqual(line.offenders, ["P5"], "the one non-tank who keeps eating it");
});

/** Six people miss it every pull; six more only sometimes, so it stays avoidable. */
function missedByMany(): MechanicSeries {
  const regulars = [3, 4, 5, 6, 7, 8];
  const occasional = [11, 12, 13, 14, 15, 16];
  return series(
    "Caustic Globule",
    PULLS.map((p) =>
      occurrence(p.fightId, 60_000, [...regulars, ...(p.fightId % 3 === 0 ? occasional : [])]),
    ),
  );
}

test("a mechanic six people miss is one call, not six warnings", () => {
  // The note belongs to the person running the raid: the call is made once, out
  // loud, by one person. Handing a line to each player who missed it is the
  // wrong artifact however many of them there are.
  const lines = generateLines(notableFrom(missedByMany()), ROSTER, { includeNames: true });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].tag, EVERYONE, "no line is addressed to an offender");
});

test("the offenders ride on the call, so the caller knows who to watch", () => {
  const notable = notableFrom(missedByMany());
  const [plain] = generateLines(notable, ROSTER, { placeholder: false });
  assert.equal(plain.text, "Caustic Globule", "names are opt-in");

  const [named] = generateLines(notable, ROSTER, { includeNames: true, placeholder: false });
  assert.match(named.text, /^Caustic Globule - /);
  const listed = named.text.split(" - ")[1].split(", ");
  assert.equal(listed.length, MAX_NAMES, "naming half the raid helps nobody");
  // P11-style occasional victims never reach the share threshold.
  assert.ok(listed.every((n) => ["P3", "P4", "P5", "P6", "P7", "P8"].includes(n)));
});

test("an unwritten call says so on screen", () => {
  // A bare mechanic name reads as finished. `<call>` is a reminder to go and
  // write the instruction the log cannot supply.
  const [line] = generateLines(notableFrom(avoidable()), ROSTER);
  assert.equal(line.text, `Stone Breaker ${CALL_PLACEHOLDER}`);

  const [named] = generateLines(notableFrom(missedByMany()), ROSTER, { includeNames: true });
  assert.match(named.text, /^Caustic Globule <call> - /, "the call slot comes before the names");
});

test("the caller need not be anyone the log has heard of", () => {
  // They may be sitting out, on an alt, or logged under another name.
  const [line] = generateLines(notableFrom(avoidable()), ROSTER, { tag: "Sneakybank" });
  assert.equal(line.tag, "Sneakybank");
  assert.equal(parseNote(emitLine(toTextLineFor(line))).lines[0].kind, "text");
});

test("a name that would corrupt the line is defused, not emitted", () => {
  // `;` ends a field, so one in a hand-typed name would swallow the text.
  const [line] = generateLines(notableFrom(avoidable()), ROSTER, { tag: "Bad;Name" });
  const emitted = emitLine(toTextLineFor(line));
  assert.equal(emitted.split(";").filter(Boolean).length, 4, emitted);
  assert.match(emitted, /tag:Bad Name;/);
});

test("a blank caller name falls back rather than emitting an unaddressed line", () => {
  const [line] = generateLines(notableFrom(avoidable()), ROSTER, { tag: "   " });
  assert.equal(line.tag, EVERYONE);
});

test("the sheet is addressed to whoever is calling", () => {
  const [line] = generateLines(notableFrom(avoidable()), ROSTER, {
    tag: "Raidlead",
    placeholder: false,
  });
  assert.equal(line.tag, "Raidlead");
  assert.equal(
    line.text,
    "Stone Breaker",
    "the call text does not change with who is reading it",
  );
});

test("names never crowd out other mechanics", () => {
  // The cap counts moments. Names live on the line, so they cannot consume the
  // budget and delete another mechanic's call.
  const deadly = avoidable("Deadly", 60_000);
  const other = avoidable("Other", 120_000);
  const lines = generateLines(notableFrom(deadly, other), ROSTER, {
    includeNames: true,
    maxLines: 2,
  });
  const mechanics = new Set(lines.map((l) => l.mechanic));
  assert.deepEqual([...mechanics].sort(), ["Deadly", "Other"]);
});

test("lines come out in time order, whatever their priority", () => {
  const lines = generateLines(
    notableFrom(avoidable("Late", 200_000), avoidable("Early", 30_000)),
    ROSTER,
  );
  const times = lines.map((l) => l.timeSec);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test("the rendered note parses back to exactly what was emitted", () => {
  const doc = {
    header: buildHeader({ id: 3421, name: "The Twin Fangs", difficulty: "Heroic" }),
    lines: generateLines(notableFrom(avoidable()), ROSTER),
  };
  const rendered = renderNote(doc);
  assert.match(rendered.split("\n")[0], /^EncounterID:3421;Difficulty:Heroic;Name:The Twin Fangs$/);

  const reparsed = parseNote(rendered);
  assert.equal(reparsed.header?.encounterId, 3421);
  assert.ok(reparsed.lines.every((l) => l.kind === "text"));
  assert.equal(emitNote(reparsed), rendered, "our own output must round-trip");
});

test("disabled lines are left out of the note", () => {
  const lines = generateLines(notableFrom(avoidable()), ROSTER);
  lines[0].enabled = false;
  const rendered = renderNote({
    header: buildHeader({ id: 1, name: "B", difficulty: "Heroic" }),
    lines,
  });
  assert.equal(rendered.split("\n").filter((l) => l.startsWith("time:")).length, lines.length - 1);
});

test("merging into a real note preserves every existing assignment", () => {
  // The safe export path: the raid's own cooldown note must survive untouched.
  const existing = parseNote(readFileSync("test/fixtures/nsrt-cd-note.txt", "utf8"));
  const cooldownsBefore = existing.lines.filter((l) => l.kind === "cooldown").length;

  const doc = {
    header: buildHeader({ id: 3420, name: "Sszorak", difficulty: "Heroic" }),
    lines: generateLines(notableFrom(avoidable()), ROSTER, { placeholder: false }),
  };
  const merged = mergeIntoNote(existing, doc);

  assert.equal(
    merged.lines.filter((l) => l.kind === "cooldown").length,
    cooldownsBefore,
    "not one cooldown assignment may be lost",
  );
  assert.equal(merged.header?.name, "Sszorak", "the user's own header wins");
  assert.ok(
    merged.lines.some((l) => l.kind === "text" && l.text === "Stone Breaker"),
    "and our line is actually in there",
  );
});

test("a private note is addressed to its owner, never to the raid", () => {
  // If a private note is ever pasted into a shared one, it must still only speak
  // to the person it was written for.
  const lines = generatePersonalLines(notableFrom(avoidable()), ROSTER, 5);
  assert.ok(lines.length > 0);
  assert.ok(
    lines.every((l) => l.tag === "P5"),
    "no everyone lines in a personal note",
  );
});

test("a private note only carries what that player is failing", () => {
  // P5 eats it on every pull; P10 only on the one pull the wave is widest.
  const counts = [1, 1, 1, 1, 1, 6];
  const mechanic = series(
    "Caustic Globule",
    PULLS.map((p) => occurrence(p.fightId, 60_000, [5, 6, 7, 8, 9, 10].slice(0, counts[p.fightId - 1]))),
  );
  const notable = notableFrom(mechanic);

  assert.equal(generatePersonalLines(notable, ROSTER, 5).length, 1, "P5 eats it every pull");
  assert.equal(generatePersonalLines(notable, ROSTER, 10).length, 0, "P10 ate it once");
});

test("a mechanic that keeps killing you is in your note even when the raid eats it too", () => {
  // Raid-wide, so the shared note deliberately stays silent — but it killed this
  // player repeatedly, which is exactly what a private callout is for.
  const raidWide = series(
    "Ravenous Feast",
    PULLS.map((p) => ({
      ...occurrence(p.fightId, 90_000, Array.from({ length: 20 }, (_, i) => i + 1)),
      deaths: p.fightId <= 3 ? [{ targetId: 7, atMs: 90_000, byKillingBlow: true }] : [],
    })),
  );
  const notable = notableFrom(raidWide);
  assert.equal(notable[0].classification, "raid-wide");
  assert.equal(generateLines(notable, ROSTER).length, 0, "nothing for the raid to read");

  const mine = generatePersonalLines(notable, ROSTER, 7);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].personal.reason, "deaths");
  assert.equal(mine[0].personal.deaths, 3);

  // ...but not for someone it merely hit along with everyone else.
  assert.equal(generatePersonalLines(notable, ROSTER, 8).length, 0);
});

test("a tank is not told off for eating the tank mechanic", () => {
  // Two tanks in twenty take 40% of these hits — four times their headcount —
  // so it is theirs to eat. A raw majority test would miss this, since 40% is
  // under half; the same shape on a real fight put the tank buster in a tank's
  // private note.
  const splash = [11, 12, 13, 14, 15, 16];
  const tankMechanic = series(
    "Tank Buster",
    PULLS.map((p) => occurrence(p.fightId, 60_000, [1, 2, 5, ...(p.fightId % 3 === 0 ? splash : [])])),
  );
  const notable = notableFrom(tankMechanic);
  assert.ok(notable[0].tankFocus >= 2, `tankFocus was ${notable[0].tankFocus}`);
  assert.ok(notable[0].tankShare < 0.5, "and a raw share test would have let it through");

  assert.deepEqual(generatePersonalLines(notable, ROSTER, 1), [], "P1 is a tank");
  assert.equal(
    generatePersonalLines(notable, ROSTER, 5).length,
    1,
    "but a non-tank eating it every pull still hears about it",
  );
});

test("a tank still hears about what kills them", () => {
  const deadly = series(
    "Tank Buster",
    PULLS.map((p) => ({
      ...occurrence(p.fightId, 60_000, [1, 2, 5]),
      deaths: p.fightId <= 3 ? [{ targetId: 1, atMs: 60_000, byKillingBlow: true }] : [],
    })),
  );
  const mine = generatePersonalLines(notableFrom(deadly), ROSTER, 1);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].personal.reason, "deaths");
});

test("a player who is failing nothing gets an empty note, not a filler one", () => {
  const lines = generatePersonalLines(notableFrom(avoidable()), ROSTER, 19);
  assert.deepEqual(lines, []);
});

test("an unknown actor yields nothing rather than an untagged note", () => {
  assert.deepEqual(generatePersonalLines(notableFrom(avoidable()), ROSTER, 999), []);
});

test("a private note renders as valid NSRT lines", () => {
  const lines = generatePersonalLines(notableFrom(avoidable()), ROSTER, 5);
  const rendered = renderNote({
    header: buildHeader({ id: 3421, name: "The Twin Fangs", difficulty: "Heroic" }),
    lines,
  });
  const reparsed = parseNote(rendered);
  assert.ok(reparsed.lines.every((l) => l.kind === "text" && l.tag === "P5"));
  assert.equal(emitNote(reparsed), rendered);
});

test("merging twice does not duplicate our lines", () => {
  const existing = parseNote("EncounterID:1;Difficulty:Heroic;Name:B\ntime:1;ph:1;tag:Niome;spellid:5;\n");
  const doc = {
    header: buildHeader({ id: 1, name: "B", difficulty: "Heroic" }),
    lines: generateLines(notableFrom(avoidable()), ROSTER),
  };
  const once = mergeIntoNote(existing, doc);
  const twice = mergeIntoNote(once, doc);
  assert.equal(emitNote(twice), emitNote(once));
});
