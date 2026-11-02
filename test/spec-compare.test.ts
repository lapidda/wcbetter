import assert from "node:assert/strict";
import {
  bossWinner,
  columnAverage,
  parseCollector,
  summarizeCell,
  type CompareColumn,
  type ParseRow,
} from "@/lib/model/spec-compare";
import { specChoicesFrom } from "@/lib/talents/talent-data";
import { rankingsKey } from "@/lib/wcl/fetchers";

// Rankings expire: the same page gets a new key in a new week or day, not within one.
{
  const DAY = 24 * 60 * 60 * 1000;
  const opts = { className: "Monk", specName: "Windwalker", difficulty: 5, page: 1 };
  const t = 2_000 * 7 * DAY;
  assert.equal(rankingsKey(1, opts, "week", t), rankingsKey(1, opts, "week", t + 6 * DAY));
  assert.notEqual(rankingsKey(1, opts, "week", t), rankingsKey(1, opts, "week", t + 7 * DAY));
  assert.equal(rankingsKey(1, opts, "day", t), rankingsKey(1, opts, "day", t + DAY - 1));
  assert.notEqual(rankingsKey(1, opts, "day", t), rankingsKey(1, opts, "day", t + DAY));
}

interface Row extends ParseRow {
  tree: string;
}
const row = (name: string, amount: number, tree: string, startTime = 1_000): Row => ({ name, amount, duration: 300_000, startTime, tree, server: { name: "S" } });
const COLUMNS: CompareColumn[] = [
  { className: "Monk", specName: "Windwalker", heroTree: null },
  { className: "Monk", specName: "Windwalker", heroTree: "Conduit" },
  { className: "Monk", specName: "Windwalker", heroTree: "Shado-Pan" },
];

// Any takes the top regardless of tree; a tree column keeps going until it has its own.
{
  const c = parseCollector<Row>(COLUMNS, 2, null, (r) => r.tree);
  c.add([row("a", 900_000, "Conduit"), row("b", 800_000, "Conduit"), row("c", 700_000, "Conduit")]);
  assert.deepEqual(c.picked.map((p) => p.map((r) => r.name)), [["a", "b"], ["a", "b"], []]);
  assert.equal(c.full(), false, "Shado-Pan still needs parses");
  c.add([row("d", 600_000, "Shado-Pan"), row("e", 500_000, "Shado-Pan")]);
  assert.deepEqual(c.picked[2].map((r) => r.name), ["d", "e"]);
  assert.equal(c.full(), true);
}

// Too old, junk parses and a player seen twice do not count.
{
  const c = parseCollector<Row>(COLUMNS.slice(0, 1), 5, 500, (r) => r.tree);
  c.add([row("old", 900_000, "Conduit", 100), row("junk", 2, "Conduit"), row("a", 800_000, "Conduit"), row("a", 700_000, "Conduit")]);
  assert.deepEqual(c.picked[0].map((r) => r.amount), [800_000]);
}

// The median shrugs off an outlier.
{
  const cell = summarizeCell([100, 200, 300, 400, 10_000].map((amount) => ({ name: "x", amount, duration: 1, bracketData: 330 })));
  assert.equal(cell.median, 300);
  assert.equal(cell.best, 10_000);
  assert.equal(cell.itemLevel, 330);
  assert.equal(summarizeCell([]).median, null);
}

// A thin cell cannot win a boss, and a column with one has no average.
{
  const cell = (n: number, median: number | null) => ({ n, median, best: median, itemLevel: null, durationMs: null });
  const bosses = [
    { id: 1, name: "A", cells: [cell(10, 100), cell(2, 999)] },
    { id: 2, name: "B", cells: [cell(10, 300), cell(10, 400)] },
  ];
  assert.equal(bossWinner(bosses[0], 10), 0);
  assert.equal(bossWinner(bosses[1], 10), 1);
  const table = { difficulty: 5, difficultyName: "Mythic", bosses };
  assert.equal(columnAverage(table, 0, 10), 200);
  assert.equal(columnAverage(table, 1, 10), null);
}

// Spec choices use WarcraftLogs' names, and hero trees come from the talent data.
{
  const raw = [
    {
      className: "Death Knight",
      specName: "Frost",
      specId: 251,
      classNodes: [],
      specNodes: [],
      heroNodes: [],
      subTreeNodes: [{ id: 1, name: "x", type: "subtree", entries: [{ id: 1, name: "Deathbringer", traitSubTreeId: 9 }, { id: 2, name: "Rider of the Apocalypse", traitSubTreeId: 8 }] }],
      fullNodeOrder: [],
    },
  ];
  assert.deepEqual(specChoicesFrom(raw), [{ className: "DeathKnight", specName: "Frost", heroTrees: ["Deathbringer", "Rider of the Apocalypse"] }]);
}

console.log("spec-compare: ok");
