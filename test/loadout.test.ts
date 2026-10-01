import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTalentBuilds } from "@/lib/talents/builds";
import { decodeLoadout, encodeLoadout, heroTreeOf, loadoutFromTalents } from "@/lib/talents/loadout";
import { specTreeFrom } from "@/lib/talents/talent-data";
import type { RankingRow } from "@/lib/wcl/fetchers";

// The Windwalker part of Raidbots' talents.json (patch 12.1), so this runs offline.
const raw = JSON.parse(readFileSync(new URL("./fixtures/talents-windwalker.json", import.meta.url), "utf8"));
const tree = specTreeFrom(raw, "Monk", "Windwalker")!;
assert.equal(tree.specId, 269);
assert.deepEqual(Object.values(tree.heroTrees).sort(), ["Conduit of the Celestials", "Shado-Pan"]);

// --- The game's own strings round-trip byte for byte -------------------------
// Peak of Serenity's Windwalker builds (12.1), exported from the game. If the
// node order, the field widths or the bit packing were off by anything, one of
// these would come back different — or not decode at all.
const GUIDE: Array<[string, string]> = [
  ["Shado-Pan", "C0QAAAAAAAAAAAAAAAAAAAAAAMzYw2MmhlZGbzAAAAAAAAAAAAsMMaGzwwAmxwMzMDz2wMMLzEAwiZ2mZYmZmBAwGAMLzSzMzsAgBmZAglBiB8B"],
  ["Shado-Pan", "C0QAAAAAAAAAAAAAAAAAAAAAAMzYAjxYbmZ2mBAAAAAAAAAAAYZY0MmhhBMjhZmZGmNmZYWmJAgFmtxMmZmZAAsBAzys0MzMLAGDMzAALDEDYA"],
  ["Shado-Pan", "C0QAAAAAAAAAAAAAAAAAAAAAAMzYw2wMsNzYbGAAAAAAAAAAAglhRzYGGGwMGmZmZY2YmhZZmAAWMz2MzYMzMAA2AgZZWamZmFAMwMDAsMQMgB"],
  ["Conduit of the Celestials", "C0QAAAAAAAAAAAAAAAAAAAAAAMzYM2GmhlZmZbGAAAAAAAAAAAglhRzYGGGwMGmZmZY2GmhZZmAAWMz2MzYmZmBAwiZWmlxEEAAGAzAwyAxMzs5BA"],
  ["Conduit of the Celestials", "C0QAAAAAAAAAAAAAAAAAAAAAAMzYMgxYbmZ2mxAAAAAAAAAAAALDjmxMMMgZMMzMzwsxMDzyMBAsYmtxMmZmZAAsYmlZZMBBAMjBwMAsMQMzMbeA"],
  ["Conduit of the Celestials", "C0QAAAAAAAAAAAAAAAAAAAAAAMzYM2GGjlZmZbGAAAAAAAAAAAglhRzYGGGwMGmZmZY2GmhZZmAAWMz2MzYMzMAAWMzysMmgAAMGAzAwyAxMzs5BA"],
  ["Shado-Pan", "C0QAAAAAAAAAAAAAAAAAAAAAAMzYAMGbzMz2MAAAAAAAAAAAALDzEmxywAmxwMzMDz2wMMLzEAwiZ2mZGzMzMAA2AgZZWamZmFAMwMDAswQMgB"],
  ["Conduit of the Celestials", "C0QAAAAAAAAAAAAAAAAAAAAAAMzYMgxYZmx2MAAAAAAAAAAAALDzEmhhBMjhZmZGmthZYWmJAgFmtxMmZmZAAsYmlZZMBBAMjBwMAjlBiZmZzA"],
  ["Conduit of the Celestials", "C0QAAAAAAAAAAAAAAAAAAAAAAMzYMgxYZmZ2mBAAAAAAAAAAAYZY0MmBMgZMMzMzwsNMDzyMBAswsxMmZmZAAsYmlZZMBBAMjBwMAjlBiZmZzA"],
];

const points = (l: ReturnType<typeof decodeLoadout>) => {
  const p = { class: 0, spec: 0, hero: 0 } as Record<string, number>;
  for (const n of l.nodes) if (n.purchased && tree.section[n.nodeId] in p) p[tree.section[n.nodeId]] += n.ranks;
  return p;
};

for (const [hero, s] of GUIDE) {
  const l = decodeLoadout(tree, s);
  assert.equal(encodeLoadout(tree, l), s, "re-encoding a game string reproduces it exactly");
  assert.equal(l.specId, 269);
  assert.deepEqual(points(l), { class: 34, spec: 34, hero: 13 }, "exactly the game's point budget");
  const selector = l.nodes.find((n) => tree.nodes[n.nodeId]?.type === "subtree")!;
  assert.equal(tree.nodes[selector.nodeId].entries[selector.entryIndex].name, hero);
}
console.log("loadout: 9 game strings round-trip");

assert.throws(() => decodeLoadout(tree, "C0QAAAA"), /ended early/);
assert.throws(() => decodeLoadout(tree, "not a string!"), /not a talent string/);

// --- From WarcraftLogs talents ---------------------------------------------------
// Take a guide build apart into the (entry id, points) list WarcraftLogs gives,
// then rebuild it: the string must come back identical in what was purchased.
function asWclTalents(s: string): Array<{ talentID: number; points: number }> {
  const out: Array<{ talentID: number; points: number }> = [];
  for (const n of decodeLoadout(tree, s).nodes) {
    const node = tree.nodes[n.nodeId];
    if (!node || node.type === "subtree") continue; // the log does not always list the selector
    if (node.type === "tiered") {
      // The log lists a tiered node's ranks entry by entry.
      let left = n.ranks;
      for (const e of node.entries) {
        if (left <= 0) break;
        const take = Math.min(left, e.maxRanks);
        out.push({ talentID: e.id, points: take });
        left -= take;
      }
      continue;
    }
    out.push({ talentID: node.entries[n.entryIndex].id, points: n.ranks });
  }
  return out;
}

for (const [hero, s] of GUIDE) {
  const talents = asWclTalents(s);
  const rebuilt = loadoutFromTalents(tree, talents);
  assert.equal(rebuilt.heroTree, hero, "hero tree read from the hero talents, selector filled in");
  assert.equal(heroTreeOf(tree, talents.map((t) => t.talentID)), hero);
  const purchased = (l: { nodes: Array<{ nodeId: number; purchased: boolean; ranks: number; entryIndex: number }> }) =>
    l.nodes.filter((n) => n.purchased).map((n) => `${n.nodeId}:${n.ranks}:${n.entryIndex}`).join(",");
  assert.equal(purchased(decodeLoadout(tree, encodeLoadout(tree, rebuilt))), purchased(decodeLoadout(tree, s)));
  assert.deepEqual(points(rebuilt as never), { class: 34, spec: 34, hero: 13 });
}
console.log("loadout: WarcraftLogs talents rebuild the same builds");

// A tiered node (Tigereye Brew) listed as two entries is one node with their sum.
{
  const tiered = Object.values(tree.nodes).find((n) => n.type === "tiered")!;
  const l = loadoutFromTalents(tree, [
    { talentID: tiered.entries[0].id, points: 1 },
    { talentID: tiered.entries[1].id, points: 2 },
  ]);
  const n = l.nodes.find((x) => x.nodeId === tiered.id)!;
  assert.equal(n.ranks, 3, "1 + 2 ranks across the tier entries");
  assert.equal(n.entryIndex, 0, "a tiered node is not a choice");
  console.log("loadout: tiered nodes: ok");
}

// --- Builds from rankings -----------------------------------------------------------
{
  const row = (name: string, amount: number, s: string): RankingRow =>
    ({ name, amount, talents: asWclTalents(s) }) as unknown as RankingRow;
  const [, sp1] = GUIDE[0];
  const [, sp2] = GUIDE[1];
  const [, cd1] = GUIDE[3];
  const [, cd2] = GUIDE[4];
  // Conduit: #1 runs cd1, but three others share cd2. Shado-Pan: one of each.
  const rankings = [
    row("Alpha", 300_000, cd1),
    row("Bravo", 299_000, cd2),
    row("Charlie", 298_000, sp1),
    row("Delta", 297_000, cd2),
    row("Echo", 296_000, cd2),
    row("Foxtrot", 295_000, sp2),
    row("Bravo", 1, cd1), // the same character again: counted once
  ];
  const b = buildTalentBuilds(tree, rankings, asWclTalents(cd1))!;
  assert.equal(b.sample, 6);
  assert.equal(b.heroTrees[0].heroTree, "Conduit of the Celestials", "the tree with the stronger top five leads");
  assert.equal(b.heroTrees[0].count, 4);
  assert.equal(b.heroTrees[1].bestRank, 3);

  const cd = b.builds.find((x) => x.heroTree === "Conduit of the Celestials")!;
  assert.equal(cd.mostUsed.string, encodeLoadout(tree, loadoutFromTalents(tree, asWclTalents(cd2))));
  assert.deepEqual(cd.mostUsed.players.map((p) => p.name), ["Bravo", "Delta", "Echo"]);
  assert.equal(cd.best.players[0].name, "Alpha");

  assert.equal(b.yours?.heroTree, "Conduit of the Celestials");
  assert.equal(b.yours?.comparedTo, "Conduit of the Celestials");
  assert.ok(b.yours!.diff.length > 0, "cd1 differs from the most used cd2");
  assert.ok(b.yours!.diff.every((d) => d.you !== d.them));
  console.log("talent builds from rankings: ok");
}

console.log("loadout: all assertions passed");
