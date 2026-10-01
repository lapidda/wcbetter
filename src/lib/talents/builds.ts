// Which hero tree, and which exact build, the top players run on this boss —
// with in-game strings to copy. Built from the rankings page the reference set
// already fetched (top 100, talents inline), so it costs no extra queries.

import type { RankingRow } from "@/lib/wcl/fetchers";
import { encodeLoadout, loadoutFromTalents, type Loadout, type NodeChoice, type SpecTree } from "./loadout";

/** Builds this close to the most-used one count as "nearly the same". */
const NEAR_NODES = 2;

export interface BuildPlayer {
  name: string;
  rank: number;
  amount: number;
}

export interface BuildOption {
  heroTree: string;
  string: string;
  /** Who runs exactly this build, best first. */
  players: BuildPlayer[];
  /** Players within NEAR_NODES differing nodes of it, itself excluded. */
  near: number;
}

export interface HeroTreeStat {
  heroTree: string;
  count: number;
  share: number;
  bestRank: number;
  /** Median amount of the tree's five best players. */
  top5: number;
}

export interface TalentDiff {
  section: "class" | "spec" | "hero" | "subtree";
  /** What you have there, or null when you skipped the node. */
  you: string | null;
  /** What the compared build has there. */
  them: string | null;
}

export interface TalentBuilds {
  sample: number;
  heroTrees: HeroTreeStat[];
  builds: Array<{ heroTree: string; mostUsed: BuildOption; best: BuildOption }>;
  yours: { string: string; heroTree: string | null; diff: TalentDiff[]; comparedTo: string | null } | null;
  /** Entry ids the tree data did not know — a log from another patch. */
  unknownTalents: number;
}

/** Purchased choices only: granted nodes are the same for everyone and do not make a build. */
function purchased(l: Loadout): Map<number, NodeChoice> {
  return new Map(l.nodes.filter((n) => n.purchased).map((n) => [n.nodeId, n]));
}

const keyOf = (l: Loadout) =>
  [...purchased(l).values()].map((n) => `${n.nodeId}:${n.ranks}:${n.entryIndex}`).join(",");

function distance(a: Loadout, b: Loadout): number {
  const x = purchased(a);
  const y = purchased(b);
  let d = 0;
  for (const id of new Set([...x.keys(), ...y.keys()])) {
    const p = x.get(id);
    const q = y.get(id);
    if (!p || !q || p.ranks !== q.ranks || p.entryIndex !== q.entryIndex) d += 1;
  }
  return d;
}

function label(tree: SpecTree, n: NodeChoice | undefined): string | null {
  if (!n) return null;
  const node = tree.nodes[n.nodeId];
  if (!node) return `node ${n.nodeId}`;
  const name = node.type === "choice" || node.type === "subtree" ? node.entries[n.entryIndex]?.name ?? node.name : node.name.split(" / ")[0];
  return node.maxRanks > 1 ? `${name} (${n.ranks}/${node.maxRanks})` : name;
}

export function diffBuilds(tree: SpecTree, yours: Loadout, theirs: Loadout): TalentDiff[] {
  const x = purchased(yours);
  const y = purchased(theirs);
  const out: TalentDiff[] = [];
  for (const id of tree.nodeOrder) {
    const p = x.get(id);
    const q = y.get(id);
    if (!p && !q) continue;
    if (p && q && p.ranks === q.ranks && p.entryIndex === q.entryIndex) continue;
    out.push({ section: tree.section[id] ?? "class", you: label(tree, p), them: label(tree, q) });
  }
  const order = { subtree: 0, hero: 1, spec: 2, class: 3 };
  return out.sort((a, b) => order[a.section] - order[b.section]);
}

export function buildTalentBuilds(
  tree: SpecTree,
  rankings: RankingRow[],
  yourTalents: Array<{ talentID: number; points: number }> | null,
): TalentBuilds | null {
  const seen = new Set<string>();
  let unknownTalents = 0;
  const players: Array<{ row: RankingRow; rank: number; loadout: Loadout; heroTree: string }> = [];
  for (const row of rankings) {
    if (!row.talents?.length || seen.has(row.name)) continue;
    seen.add(row.name);
    const l = loadoutFromTalents(tree, row.talents);
    unknownTalents += l.unknown.length;
    if (!l.heroTree) continue;
    players.push({ row, rank: players.length + 1, loadout: l, heroTree: l.heroTree });
  }
  if (players.length === 0) return null;

  const byTree = new Map<string, typeof players>();
  for (const p of players) (byTree.get(p.heroTree) ?? byTree.set(p.heroTree, []).get(p.heroTree)!).push(p);

  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const heroTrees: HeroTreeStat[] = [...byTree.entries()]
    .map(([heroTree, ps]) => ({
      heroTree,
      count: ps.length,
      share: ps.length / players.length,
      bestRank: ps[0].rank,
      top5: median(ps.slice(0, 5).map((p) => p.row.amount)),
    }))
    .sort((a, b) => b.top5 - a.top5);

  const asPlayer = (p: (typeof players)[number]): BuildPlayer => ({ name: p.row.name, rank: p.rank, amount: p.row.amount });

  const builds = heroTrees.map(({ heroTree }) => {
    const ps = byTree.get(heroTree)!;
    // Most used: the exact build the most players share; ties go to the one
    // whose best player ranks highest, since players arrive in rank order.
    const groups = new Map<string, typeof ps>();
    for (const p of ps) {
      const k = keyOf(p.loadout);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(p);
    }
    const top = [...groups.values()].reduce((best, g) => (g.length > best.length ? g : best));
    const mostUsed: BuildOption = {
      heroTree,
      string: encodeLoadout(tree, top[0].loadout),
      players: top.map(asPlayer),
      near: ps.filter((p) => !top.includes(p) && distance(p.loadout, top[0].loadout) <= NEAR_NODES).length,
    };
    const first = ps[0];
    const firstGroup = groups.get(keyOf(first.loadout))!;
    const best: BuildOption = {
      heroTree,
      string: encodeLoadout(tree, first.loadout),
      players: firstGroup.map(asPlayer),
      near: ps.filter((p) => !firstGroup.includes(p) && distance(p.loadout, first.loadout) <= NEAR_NODES).length,
    };
    return { heroTree, mostUsed, best, mostUsedLoadout: top[0].loadout };
  });

  let yours: TalentBuilds["yours"] = null;
  if (yourTalents?.length) {
    const l = loadoutFromTalents(tree, yourTalents);
    const compare = builds.find((b) => b.heroTree === l.heroTree) ?? builds[0];
    yours = {
      string: encodeLoadout(tree, l),
      heroTree: l.heroTree,
      diff: compare ? diffBuilds(tree, l, compare.mostUsedLoadout) : [],
      comparedTo: compare ? compare.heroTree : null,
    };
  }

  return {
    sample: players.length,
    heroTrees,
    builds: builds.map(({ heroTree, mostUsed, best }) => ({ heroTree, mostUsed, best })),
    yours,
    unknownTalents,
  };
}
