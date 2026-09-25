// Phase-3 step 0: where do boss ability NAMES come from?
//
// Cast events carry only abilityGameID. Before building boss-ability context
// this checks, against a real fight, whether the enemy-side Casts table names
// enough of what the events reference — and falls back to masterData.abilities
// if not. Nothing here is hardcoded; the decision is printed as data.
//
//   node --env-file=.env.local --import ./test/ts-resolve.mjs scripts/probe-enemies.ts [code] [fightId]
import { query } from "@/lib/wcl/client";
import { getEvents, getReportMeta, getTable } from "@/lib/wcl/fetchers";

const code = process.argv[2] ?? "D4K7nTaXtvr9L2Zk";
const fightId = Number(process.argv[3] ?? 22);

const meta = await getReportMeta(code);
const fight = meta.fights.find((f) => f.id === fightId);
if (!fight) throw new Error(`fight ${fightId} not in ${code}`);
console.log(`${fight.name} fight ${fightId}: ${fight.endTime - fight.startTime}ms`);

// 1. Enemy-side Casts table
const table = await getTable(code, fightId, "Casts", undefined, "Enemies");
console.log("\n=== Casts table, hostilityType Enemies ===");
console.log("top-level keys:", Object.keys(table).join(", "));
const rows = (table.entries ?? []) as any[];
console.log(`entries: ${rows.length}`);
const nested = rows.some((r) => Array.isArray(r.abilities));
console.log(`nested actor rows: ${nested}`);
const abilityRows: any[] = nested ? rows.flatMap((r) => (r.abilities ?? []).map((a: any) => ({ ...a, actorName: r.name }))) : rows;
console.log(`ability rows: ${abilityRows.length}`);
if (abilityRows[0]) console.log("row[0] keys:", Object.keys(abilityRows[0]).join(", "));
for (const r of abilityRows.slice(0, 8)) {
  console.log(`  ${String(r.guid ?? r.id).padEnd(9)} ${String(r.name).padEnd(28)} total=${r.total ?? r.uses ?? "-"} icon=${r.abilityIcon ?? r.icon ?? "-"} actor=${r.actorName ?? r.sources?.[0]?.name ?? "-"}`);
}
const tableIds = new Set(abilityRows.map((r) => Number(r.guid ?? r.id)));

// 2. Enemy-side cast events
const events = await getEvents(code, fightId, "Casts", { start: fight.startTime, end: fight.endTime }, { hostilityType: "Enemies" });
console.log("\n=== Cast events, hostilityType Enemies ===");
console.log(`events: ${events.length}`);
console.log("types:", [...new Set(events.map((e) => e.type))].join(", "));
const counts = new Map<number, number>();
const sources = new Map<number, Set<number>>();
for (const e of events) {
  const id = Number(e.abilityGameID);
  if (!id) continue;
  counts.set(id, (counts.get(id) ?? 0) + 1);
  if (e.sourceID != null) (sources.get(id) ?? sources.set(id, new Set()).get(id)!).add(e.sourceID);
}
const minutes = (fight.endTime - fight.startTime) / 60_000;
console.log(`distinct ability ids: ${counts.size}`);
console.log("id         casts   /min   named-in-table  sources");
for (const [id, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  const name = abilityRows.find((r) => Number(r.guid ?? r.id) === id)?.name;
  console.log(`${String(id).padEnd(10)} ${String(n).padStart(5)} ${(n / minutes).toFixed(1).padStart(6)}   ${(name ?? "—").padEnd(16).slice(0, 16)} ${[...(sources.get(id) ?? [])].join(",")}`);
}

// 3. masterData.abilities as the fallback dictionary
const md = await query<any>(
  `probe:masterdata:${code}`,
  `query($code:String!){reportData{report(code:$code){masterData{abilities{gameID name icon type} actors(type:"NPC"){id name gameID subType}}}}}`,
  { code },
);
const abilities = md.reportData.report.masterData.abilities as any[];
const npcs = md.reportData.report.masterData.actors as any[];
console.log("\n=== masterData ===");
console.log(`abilities: ${abilities.length}, NPC actors: ${npcs.length}`);
console.log("ability sample:", JSON.stringify(abilities.slice(0, 3)));
console.log("npc sample:", JSON.stringify(npcs.slice(0, 5)));
const mdIds = new Set(abilities.map((a) => Number(a.gameID)));

// 4. Decision
const total = [...counts.values()].reduce((a, b) => a + b, 0);
const coveredTable = [...counts.entries()].filter(([id]) => tableIds.has(id)).reduce((s, [, n]) => s + n, 0);
const coveredMd = [...counts.entries()].filter(([id]) => mdIds.has(id)).reduce((s, [, n]) => s + n, 0);
console.log("\n=== coverage of event ability ids (weighted by cast count) ===");
console.log(`Enemies Casts table:  ${((coveredTable / total) * 100).toFixed(1)}%`);
console.log(`masterData.abilities: ${((coveredMd / total) * 100).toFixed(1)}%`);
console.log(
  `\nDECISION: ${coveredTable / total >= 0.95 ? "use the Enemies Casts table as the dictionary (one query per selected fight set)" : "use masterData.abilities via a new REPORT_ABILITIES document (one query per report)"}`,
);
