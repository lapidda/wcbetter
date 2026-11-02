// The top parses of any specs side by side, boss by boss. Pure, so the browser
// can import the types and the table's arithmetic without the WCL client.

export interface CompareColumn {
  /** As WarcraftLogs names them: "DeathKnight", "Frost". */
  className: string;
  specName: string;
  /** Null for the spec's best parses whichever hero tree they played. */
  heroTree: string | null;
}

export interface CompareArgs {
  zoneId: number;
  /** WarcraftLogs difficulty ids: 4 Heroic, 5 Mythic. */
  difficulties: number[];
  columns: CompareColumn[];
  /** Only parses this recent; null for the whole patch. */
  days: number | null;
  topN: number;
}

export interface CompareCell {
  /** Parses found, at most topN. */
  n: number;
  /** Null when no parse qualified. */
  median: number | null;
  best: number | null;
  itemLevel: number | null;
  durationMs: number | null;
}

export interface CompareBoss {
  id: number;
  name: string;
  cells: CompareCell[];
}

export interface CompareTable {
  difficulty: number;
  difficultyName: string;
  bosses: CompareBoss[];
}

export interface CompareReport {
  zone: string;
  columns: CompareColumn[];
  days: number | null;
  topN: number;
  fetchedAt: string;
  tables: CompareTable[];
}

/** Anything below this is a parse that barely played (a real one logged 1.7 DPS). */
export const MIN_PARSE_DPS = 1_000;

export const columnKey = (c: CompareColumn) => `${c.className}|${c.specName}|${c.heroTree ?? ""}`;

export interface ParseRow {
  name: string;
  amount: number;
  duration: number;
  startTime?: number;
  bracketData?: number;
  server?: { name?: string } | null;
}

/** Sorts ranking pages into columns, top down: first qualifying parses of unique players, until each is full. */
export function parseCollector<R extends ParseRow>(
  columns: CompareColumn[],
  topN: number,
  since: number | null,
  heroTreeOfRow: (row: R) => string | null,
) {
  const picked: R[][] = columns.map(() => []);
  const seen = new Set<string>();
  return {
    picked,
    add(rows: R[]) {
      for (const row of rows) {
        const id = `${row.name}-${row.server?.name ?? ""}`;
        if (seen.has(id)) continue;
        seen.add(id);
        if (row.amount < MIN_PARSE_DPS) continue;
        if (since != null && (row.startTime == null || row.startTime < since)) continue;
        columns.forEach((c, i) => {
          if (picked[i].length >= topN) return;
          if (c.heroTree == null || heroTreeOfRow(row) === c.heroTree) picked[i].push(row);
        });
      }
    },
    full: () => picked.every((p) => p.length >= topN),
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function summarizeCell(rows: ParseRow[]): CompareCell {
  return {
    n: rows.length,
    median: median(rows.map((r) => r.amount)),
    best: rows.length ? Math.max(...rows.map((r) => r.amount)) : null,
    itemLevel: median(rows.map((r) => r.bracketData ?? 0).filter((x) => x > 0)),
    durationMs: median(rows.map((r) => r.duration)),
  };
}

/** The column with the highest median among full cells: a median of 2 parses cannot win a boss. */
export function bossWinner(boss: CompareBoss, topN: number): number | null {
  let winner: number | null = null;
  boss.cells.forEach((c, i) => {
    if (c.n < topN || c.median == null) return;
    if (winner == null || c.median > boss.cells[winner].median!) winner = i;
  });
  return winner;
}

/** Average across bosses, only when the column is full on all of them; otherwise it is not comparable. */
export function columnAverage(table: CompareTable, column: number, topN: number): number | null {
  const cells = table.bosses.map((b) => b.cells[column]);
  if (cells.length === 0 || cells.some((c) => c.n < topN || c.median == null)) return null;
  return cells.reduce((s, c) => s + c.median!, 0) / cells.length;
}
