// Raid-wide failure analysis from the command line: which mechanics people are
// actually eating, per pull, per occurrence. The verification harness for the
// note generator, exactly as scripts/analyze.ts is for the DPS analysis.
//
//   npm run raid -- "<report url or code>" [--json] [--mechanic "Stone Breaker"]
//
// A warm cache makes a run free, so diffs between runs are pure logic.
import { summarizeReport } from "@/lib/analyze";
import { noteWorthyWaves } from "@/lib/model/notable";
import {
  buildHeader,
  generateLines,
  generatePersonalLines,
  mergeCloseLines,
  renderNote,
} from "@/lib/nsrt/generate";
import { analyzeRaidEncounter } from "@/lib/raid";
import { getQueryCounts } from "@/lib/wcl/client";
import { parseReportInput } from "@/lib/wcl/fetchers";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));
const input = positional[0];
const only = args.includes("--mechanic") ? args[args.indexOf("--mechanic") + 1] : null;

if (!input) {
  console.error('usage: npm run raid -- "<report url>" [--json] [--matrix] [--note] [--as <raidleader>] [--names] [--no-placeholder] [--for <player>] [--mechanic "<name>"]');
  process.exit(2);
}

const link = parseReportInput(input);
const summary = await summarizeReport(link.code, link);
const log = (line: string) => {
  if (!flags.has("--json")) console.log(line);
};

log(`report: ${summary.title} (${summary.zone})`);

const seed =
  summary.fights.find((f) => f.id === summary.link.fightId) ??
  [...summary.fights].reverse().find((f) => f.encounterID > 0);
if (!seed) throw new Error("no boss pull to anchor on");

const pulls = summary.fights.filter(
  (f) => f.encounterID === seed.encounterID && f.difficulty === seed.difficulty,
);
log(`boss: ${seed.difficulty} ${seed.name} — ${pulls.length} pulls (${pulls.map((f) => f.id).join(", ")})`);

const started = Date.now();
const report = await analyzeRaidEncounter({
  code: link.code,
  fightIds: pulls.map((f) => f.id),
  onProgress: (m) => log(`  ${m}`),
});
const elapsed = (Date.now() - started) / 1000;

if (flags.has("--json")) {
  // roster.tankIds is a Set, which JSON.stringify would silently flatten to {}.
  const sets = (_key: string, value: unknown) => (value instanceof Set ? [...value] : value);
  console.log(JSON.stringify(report, sets, 2));
  process.exit(0);
}

const mmss = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(Math.round(n)));

console.log("\n================ RAID ================");
console.log(`${report.encounter.difficulty} ${report.encounter.name} — ${report.pulls.length} pulls`);

const roster = report.roster;
const tanks = [...roster.tankIds].map((id) => roster.actors[id]?.name ?? id).sort();
console.log(
  `roster: ${Object.keys(roster.actors).length} players  |  tanks (derived): ${tanks.join(", ") || "none detected"}`,
);

// The two numbers the plan asks to be measured rather than assumed.
const { nameMatched, timeMatched, unmapped, eventsByFight } = report.stats;
const mapped = nameMatched + timeMatched;
const matchRate = mapped + unmapped > 0 ? (nameMatched / (mapped + unmapped)) * 100 : 0;
console.log(
  `mechanics: ${mapped} mapped (${nameMatched} by name, ${timeMatched} by time), ${unmapped} unmapped` +
    `  |  name-match rate ${matchRate.toFixed(0)}%`,
);

const volumes = Object.values(eventsByFight);
const totalEvents = volumes.reduce((a, b) => a + b, 0);
console.log(
  `damage-taken events: ${totalEvents} total, ${Math.round(totalEvents / (volumes.length || 1))} median-ish per pull` +
    `, max ${Math.max(0, ...volumes)}`,
);

console.log("\n---- verdict ----");
if (report.notable.some((m) => m.thinEvidence)) {
  console.log(
    `  (${report.pulls.length} pulls only — the raid still acts as its own control group ` +
      "within each pull, but nothing here is a trend yet)",
  );
}
for (const m of report.notable) {
  const mark = m.noteWorthy ? "NOTE" : "    ";
  console.log(
    `  ${mark} ${m.name.padEnd(17)} ${m.classification.padEnd(10)} ` +
      `share ${(m.medianHitShare * 100).toFixed(0).padStart(3)}%  ` +
      `${(m.shareOfRaidDamageTaken * 100).toFixed(1).padStart(4)}% of dmg  ` +
      `${m.deaths.toString().padStart(2)} deaths  pri ${m.priority.toFixed(1).padStart(5)}  ${m.reason}`,
  );
  // What it does, measured — the part that tells you what to actually shout.
  console.log(`       ${m.description}`);
  for (const w of noteWorthyWaves(m)) {
    const drift = w.confident ? "" : `±${(w.spreadMs / 1000).toFixed(0)}s `;
    const casts = w.medianCasts > 1 ? ` x${w.medianCasts.toFixed(0)}` : "";
    console.log(
      `         -> #${w.ordinal} at ${mmss(w.atMs)}${casts} ${drift}` +
        `failed ${w.failedOn}/${w.seen} seen (${w.reached} reached), ` +
        `median ${w.medianHitCount.toFixed(0)} hit, ${w.deaths} deaths`,
    );
  }
}

const series = !flags.has("--matrix")
  ? []
  : only
    ? report.series.filter((s) => s.name.toLowerCase().includes(only.toLowerCase()))
    : report.series;

if (!flags.has("--matrix")) console.log("\n(pass --matrix for the per-occurrence breakdown)");
if (series.length) console.log("\nmechanic matrix (hit / eligible per occurrence):");
for (const s of series) {
  const totalDeaths = s.occurrences.reduce((n, o) => n + o.deaths.length, 0);
  const totalDamage = s.occurrences.reduce(
    (n, o) => n + o.hits.reduce((m, h) => m + h.amount, 0),
    0,
  );
  console.log(
    `\n  ${s.name}  [${s.mappedBy}]  casts ${s.castGameIDs.join("/")} -> damage ${s.damageGameIDs.join("/")}` +
      `  |  ${k(totalDamage)} taken, ${totalDeaths} deaths`,
  );

  // One row per ordinal, one column per pull: the shape Phase 2 reduces.
  const ordinals = [...new Set(s.occurrences.map((o) => o.ordinal))].sort((a, b) => a - b);
  for (const ordinal of ordinals) {
    const at = s.occurrences.filter((o) => o.ordinal === ordinal);
    const cells = at.map((o) => {
      const hit = o.hits.length;
      const dead = o.deaths.length;
      return `${hit}/${o.eligible.length}${dead ? `†${dead}` : ""}`;
    });
    const times = at.map((o) => o.atMs).sort((a, b) => a - b);
    const spread = times.length > 1 ? times[times.length - 1] - times[0] : 0;
    console.log(
      `    #${String(ordinal).padEnd(2)} ${mmss(times[Math.floor(times.length / 2)])}` +
        ` (spread ${(spread / 1000).toFixed(0)}s, ${at.length} pulls)  ${cells.join(" ")}`,
    );
  }
}

if (flags.has("--for")) {
  const wanted = args[args.indexOf("--for") + 1] ?? "";
  const actor = Object.values(report.roster.actors).find(
    (a) => a.name.toLowerCase() === wanted.toLowerCase(),
  );
  if (!actor) {
    console.error(
      `\nno player "${wanted}" in this report. roster: ` +
        Object.values(report.roster.actors)
          .map((a) => a.name)
          .sort()
          .join(", "),
    );
    process.exit(2);
  }

  const lines = generatePersonalLines(report.notable, report.roster, actor.id);
  console.log(`\n---- private note for ${actor.name} (${actor.className}) ----`);
  if (lines.length === 0) {
    console.log("nothing to call out: they are not failing anything the rest of the raid dodges.");
  } else {
    process.stdout.write(
      renderNote({ header: buildHeader(report.encounter), lines: mergeCloseLines(lines) }),
    );
    console.log("\nwhy each line is here:");
    for (const l of mergeCloseLines(lines) as typeof lines) {
      const why =
        l.personal.reason === "deaths"
          ? `killed them on ${l.personal.deaths} pulls`
          : `hit them on ${l.personal.hitPulls}/${l.personal.eligiblePulls} pulls they saw it` +
            (l.personal.deaths ? `, killed them ${l.personal.deaths}x` : "");
      console.log(`  ${mmss(l.timeSec * 1000)} ${l.mechanic.padEnd(17)} ${why}`);
    }
  }
}

if (flags.has("--note")) {
  // The raid leader's own note: one line per moment they need to call, not lines
  // handed to the people who keep missing it.
  // Any name, not just a participant: whoever is calling may be sitting out, on
  // an alt, or logged under a name this report never saw. A roster match is used
  // only to fix the capitalisation, never to refuse the name.
  const as = args.includes("--as") ? (args[args.indexOf("--as") + 1] ?? "").trim() : "";
  const match = as
    ? Object.values(report.roster.actors).find((a) => a.name.toLowerCase() === as.toLowerCase())
    : undefined;
  const caller = match?.name ?? as;

  const doc = {
    header: buildHeader(report.encounter),
    lines: mergeCloseLines(
      generateLines(report.notable, report.roster, {
        tag: caller || undefined,
        includeNames: flags.has("--names"),
        placeholder: !flags.has("--no-placeholder"),
      }),
    ),
  };

  console.log(
    `\n---- callout sheet${caller ? ` for ${caller}` : ""} (paste into your own NSRT note) ----`,
  );
  if (caller && !match) {
    console.log(`(${caller} is not in this report — using the name as given)`);
  }
  if (!caller) {
    console.log("(no --as name: tagged `everyone`, which in your own note means only you)");
  }
  process.stdout.write(renderNote(doc));

  console.log("\nwhat each call is for:");
  const describedAlready = new Set<string>();
  for (const l of doc.lines) {
    const drift = l.confident ? "" : ` [±${(l.spreadMs / 1000).toFixed(0)}s, timer drifts]`;
    console.log(
      `  ${mmss(l.timeSec * 1000)} ${l.mechanic.padEnd(17)} ` +
        `${l.medianHitCount.toFixed(0)} of the raid hit on ${l.failedOn}/${l.seen} pulls` +
        `${l.deaths ? `, ${l.deaths} deaths` : ""}${drift}`,
    );
    // The mechanic behaves the same at every wave, so describe it once.
    if (!describedAlready.has(l.mechanic)) {
      describedAlready.add(l.mechanic);
      const m = report.notable.find((x) => x.name === l.mechanic);
      if (m) console.log(`  ${" ".repeat(5)} ${" ".repeat(17)} ${m.description}`);
    }
  }
  if (!flags.has("--names")) console.log("\n(pass --names to put the repeat offenders on each line)");
}

console.log("\n---- cost ----");
const counts = Object.entries(getQueryCounts());
const upstream = counts.reduce((n, [, c]) => n + c, 0);
console.log(
  `upstream requests: ${upstream}` +
    (upstream === 0 ? "  (all cached)" : `  (${counts.map(([kind, c]) => `${kind}:${c}`).join(", ")})`),
);
console.log(`wall clock:        ${elapsed.toFixed(1)}s`);
console.log(`payload:           ${Math.round(JSON.stringify(report).length / 1024)} KB`);
for (const warning of report.warnings) console.log(`warning: ${warning}`);
