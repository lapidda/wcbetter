import {
  columnKey,
  parseCollector,
  summarizeCell,
  type CompareArgs,
  type CompareColumn,
  type CompareReport,
  type CompareTable,
} from "./model/spec-compare";
import { heroTreeOf } from "./talents/loadout";
import { getSpecTree } from "./talents/talent-data";
import { raidZones } from "./tank-lookup";
import { getRankingsPage, type RankingRow } from "./wcl/fetchers";
import { difficultyName } from "./wcl/types";

/** Per spec, per boss. A rare hero tree on a popular spec is the deep case. */
const MAX_PAGES = 25;

/** Fills the columns of one spec on one boss, reading no further than they need. */
async function scanSpec(
  encounterID: number,
  difficulty: number,
  columns: CompareColumn[],
  args: Pick<CompareArgs, "topN">,
  since: number | null,
) {
  const { className, specName } = columns[0];
  const tree = columns.some((c) => c.heroTree != null) ? await getSpecTree(className, specName) : null;
  const collector = parseCollector<RankingRow>(columns, args.topN, since, (row) =>
    tree && row.talents?.length ? heroTreeOf(tree, row.talents.map((t) => t.talentID)) : null,
  );
  for (let page = 1; page <= MAX_PAGES && !collector.full(); page++) {
    const { rows, hasMore } = await getRankingsPage(encounterID, { className, specName, difficulty, metric: "dps", page });
    collector.add(rows);
    if (!hasMore) break;
  }
  return collector.picked;
}

export async function compareSpecs(args: CompareArgs, progress: (m: string) => void = () => {}): Promise<CompareReport> {
  const zone = (await raidZones()).find((z) => z.id === args.zoneId);
  if (!zone) throw new Error(`Raid zone ${args.zoneId} not found.`);
  const since = args.days != null ? Date.now() - args.days * 24 * 60 * 60 * 1000 : null;

  // One scan per spec, however many of its hero trees are columns.
  const specs = new Map<string, CompareColumn[]>();
  for (const c of args.columns) {
    const key = `${c.className}|${c.specName}`;
    (specs.get(key) ?? specs.set(key, []).get(key)!).push(c);
  }

  const tables: CompareTable[] = [];
  for (const difficulty of args.difficulties) {
    const name = difficultyName(difficulty);
    let done = 0;
    const bosses = await Promise.all(
      zone.encounters.map(async (e) => {
        const picked = new Map<string, Parameters<typeof summarizeCell>[0]>();
        for (const columns of specs.values()) {
          const rows = await scanSpec(e.id, difficulty, columns, args, since);
          columns.forEach((c, i) => picked.set(columnKey(c), rows[i]));
        }
        progress(`${name}: ${++done}/${zone.encounters.length} bosses (${e.name})`);
        return { id: e.id, name: e.name, cells: args.columns.map((c) => summarizeCell(picked.get(columnKey(c)) ?? [])) };
      }),
    );
    tables.push({ difficulty, difficultyName: name, bosses });
  }

  return {
    zone: zone.name,
    columns: args.columns,
    days: args.days,
    topN: args.topN,
    fetchedAt: new Date().toISOString(),
    tables,
  };
}
