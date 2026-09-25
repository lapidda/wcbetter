// Runs a full analysis from the command line and prints what the UI would show,
// plus what it cost. This is the verification harness for every change to the
// analysis: a warm cache makes a run free, so diffs between runs are pure logic.
//
//   npm run analyze -- "<report url or code>" [character] [findingId] [--json]
//
// The character is resolved from `source=` in the URL when present, else by name.
import { analyzeEncounter, summarizeReport } from "@/lib/analyze";
import { getQueryCounts } from "@/lib/wcl/client";
import { parseReportInput } from "@/lib/wcl/fetchers";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [input, characterName, wantFinding] = args.filter((a) => !a.startsWith("--"));

if (!input) {
  console.error('usage: npm run analyze -- "<report url>" [character] [findingId] [--json]');
  process.exit(2);
}

const link = parseReportInput(input);
const summary = await summarizeReport(link.code, link);
const log = (line: string) => {
  if (!flags.has("--json")) console.log(line);
};

log(`report: ${summary.title} (${summary.zone})`);

const player =
  (summary.link.sourceId != null
    ? summary.players.find((p) => p.id === summary.link.sourceId)
    : undefined) ??
  (characterName
    ? summary.players.find((p) => p.name.toLowerCase() === characterName.toLowerCase())
    : undefined);

if (!player) {
  console.error("players in report:", summary.players.map((p) => p.name).join(", "));
  throw new Error(`no player matched (source=${summary.link.sourceId ?? "-"}, name=${characterName ?? "-"})`);
}
log(`player: ${player.name} (${player.className}) id=${player.id}`);

const seed =
  summary.fights.find((f) => f.id === summary.link.fightId) ??
  // No fight in the link: take the last pull the player was in.
  [...summary.fights].reverse().find((f) => f.friendlyPlayers.includes(player.id));
if (!seed) throw new Error("no fight to anchor on");
log(`boss: ${seed.difficulty} ${seed.name} (via fight ${seed.id})`);

const pulls = summary.fights.filter(
  (f) =>
    f.encounterID === seed.encounterID &&
    f.difficulty === seed.difficulty &&
    (f.friendlyPlayers.length === 0 || f.friendlyPlayers.includes(player.id)),
);
log(`pulls: ${pulls.length} (ids ${pulls.map((f) => f.id).join(", ")})`);

const started = Date.now();
const report = await analyzeEncounter({
  code: link.code,
  actorId: player.id,
  fightIds: pulls.map((f) => f.id),
  onProgress: (m) => log(`  ${m}`),
});
const elapsed = (Date.now() - started) / 1000;

if (flags.has("--json")) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const k = (n: number) => `${(n / 1000).toFixed(1)}k`;

console.log("\n================ RESULT ================");
console.log(`${report.encounter.difficulty} ${report.encounter.name}`);
console.log(`${report.player.name} — ${report.player.specName} ${report.player.className}`);
console.log(
  `median ${k(report.totals.medianDps)} dps  |  best ${k(report.totals.bestDps)}  |  ` +
    `reference median ${k(report.reference.medianDps)}  |  headroom +${report.estimatedTotalGainPct.toFixed(1)}%`,
);
console.log(
  `build match: ${report.reference.buildMatch.matched ? `${(report.reference.buildMatch.similarity * 100).toFixed(0)}%` : "none"}` +
    ` | ilvl ${report.player.itemLevel ?? "?"} vs reference ${report.reference.medianItemLevel ?? "?"}` +
    ` | icons ${Object.keys(report.icons).length}`,
);

console.log("\npulls:");
for (const p of report.pulls) {
  console.log(
    `  ${p.label.padEnd(28)} ${k(p.dps).padStart(7)}  ${p.activeTimePct.toFixed(1).padStart(5)}% active  ${p.deaths} deaths`,
  );
}

console.log(`\nreference: ${report.reference.members.map((m) => `${m.name} ${k(m.dps)}`).join(", ")}`);

console.log(
  `\nfix these first: +${k(report.focusGainDps)} DPS (+${report.focusGainPct.toFixed(1)}%)` +
    (report.gap.deltaDps > 0 ? `, ${((report.focusGainDps / report.gap.deltaDps) * 100).toFixed(0)}% of the ${k(report.gap.deltaDps)} gap` : ""),
);
for (const item of report.focus) {
  const f = report.findings.find((x) => x.id === item.findingId)!;
  const dps = item.gainDps != null ? `+${k(item.gainDps)} DPS` : "no gain figure";
  console.log(`  #${item.rank} [${item.family.padEnd(11)}] ${dps.padStart(14)}  ${f.title}`);
}
if (report.warnings.length) console.log(`\nwarnings: ${report.warnings.join(" | ")}`);
console.log(
  report.bossContext
    ? `boss context: ${report.bossContext.abilities} named abilities; mechanic casts per pull: ${report.bossContext.castsPerPull.join(", ")}` +
      (report.bossContext.friendlyExcluded.length
        ? `; dropped as player abilities: ${report.bossContext.friendlyExcluded.join(", ")}`
        : "")
    : "boss context: unavailable",
);
console.log(
  `sections: ${Object.entries(report.sections).map(([fam, ids]) => `${fam} ${ids.length}`).join(", ")}; one-offs ${report.oneOffs.length}`,
);

const burnPulls = report.timelines.filter((t) => t.burnStartMs != null);
console.log(
  `burn phase: ${burnPulls.length}/${report.timelines.length} pulls reached execute range` +
    (burnPulls.length
      ? ` (median ${(burnPulls.reduce((n, t) => n + (t.durationMs - t.burnStartMs!), 0) / burnPulls.length / 1000).toFixed(0)}s of burn)`
      : ""),
);
console.log(
  `timelines: ${report.timelines.length} pulls, ${report.timelines.reduce((n, t) => n + t.casts.length, 0)} casts, ` +
    `${report.timelines.reduce((n, t) => n + t.bossCasts.length, 0)} boss casts; ` +
    `ability table: ${report.abilities.length} rows (${report.abilities.filter((a) => a.findingId).length} flagged)`,
);

console.log(`\nfindings (${report.findings.length}):`);
for (const f of report.findings) {
  const gain = f.medianGainPct != null ? `+${f.medianGainPct.toFixed(1)}%` : "—";
  console.log(`  [${f.severity.padEnd(8)}] ${String(f.occurrences).padStart(2)}/${f.totalPulls} ${gain.padStart(6)}  ${f.title}`);
}

if (wantFinding) {
  const f = report.findings.find((x) => x.id === wantFinding);
  if (!f) console.log(`\n(no finding with id ${wantFinding})`);
  else {
    console.log(`\n---- ${f.id} ----`);
    console.log(f.title);
    console.log(f.detail);
    console.log(`advice: ${f.advice}`);
    if (f.metric) console.log(`metric: ${f.metric.label} — you ${f.metric.you}, reference ${f.metric.reference}`);
    console.log("evidence:");
    for (const e of f.evidence) console.log(`  ${e}`);
    console.log("per pull:");
    for (const p of f.perPull) console.log(`  ${p.label}: ${p.title}`);
  }
}

const counts = getQueryCounts();
const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log("\n---- cost ----");
console.log(`upstream requests: ${total}${total ? "  (" + Object.entries(counts).map(([kind, n]) => `${kind} ${n}`).join(", ") + ")" : "  (all cached)"}`);
console.log(`wall clock:        ${elapsed.toFixed(1)}s`);
console.log(`payload:           ${(JSON.stringify(report).length / 1024).toFixed(0)} KB`);
