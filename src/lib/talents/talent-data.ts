// Talent tree layout, from Raidbots' public talent data — the same file the
// SimulationCraft tools read. WarcraftLogs names no nodes and gives no node
// order, and both are needed to write an in-game talent string. Fetched once
// and kept in the response cache, like the WarcraftLogs data.

import { cached } from "@/lib/wcl/cache";
import type { SpecTree, TreeNode } from "./loadout";

export const TALENT_DATA_URL = "https://www.raidbots.com/static/data/live/talents.json";

interface RawNode {
  id: number;
  name: string;
  type: string;
  maxRanks?: number;
  freeNode?: boolean;
  subTreeId?: number;
  entries: Array<{ id: number; name: string; maxRanks?: number; spellId?: number; traitSubTreeId?: number }>;
}

interface RawSpec {
  className: string;
  specName: string;
  specId: number;
  classNodes: RawNode[];
  specNodes: RawNode[];
  heroNodes: RawNode[];
  subTreeNodes: RawNode[];
  fullNodeOrder: number[];
}

/** Build a spec's tree from the raw data. Pure, so tests can feed a local copy. */
export function specTreeFrom(raw: RawSpec[], className: string, specName: string): SpecTree | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const spec = raw.find((s) => norm(s.className) === norm(className) && norm(s.specName) === norm(specName));
  if (!spec) return null;

  const nodes: Record<number, TreeNode> = {};
  const section: SpecTree["section"] = {};
  const add = (list: RawNode[], part: "class" | "spec" | "hero" | "subtree") => {
    for (const n of list) {
      nodes[n.id] = {
        id: n.id,
        name: n.name,
        type: n.type,
        maxRanks: n.maxRanks ?? 1,
        freeNode: n.freeNode,
        subTreeId: n.subTreeId,
        entries: n.entries.map((e) => ({
          id: e.id,
          name: e.name,
          maxRanks: e.maxRanks ?? 1,
          spellId: e.spellId,
          traitSubTreeId: e.traitSubTreeId,
        })),
      };
      section[n.id] = part;
    }
  };
  add(spec.classNodes, "class");
  add(spec.specNodes, "spec");
  add(spec.heroNodes, "hero");
  add(spec.subTreeNodes, "subtree");

  const heroTrees: Record<number, string> = {};
  for (const n of spec.subTreeNodes) for (const e of n.entries) if (e.traitSubTreeId != null) heroTrees[e.traitSubTreeId] = e.name;

  return {
    className: spec.className,
    specName: spec.specName,
    specId: spec.specId,
    nodeOrder: spec.fullNodeOrder,
    nodes,
    section,
    heroTrees,
  };
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
let memo: { week: number; data: Promise<RawSpec[]> } | null = null;

/**
 * Unlike a log, the tree changes with every patch, so the cached copy is keyed
 * by week: it refreshes on its own, at a cost of one 3 MB download a week.
 */
function talentData(): Promise<RawSpec[]> {
  const week = Math.floor(Date.now() / WEEK_MS);
  if (memo?.week !== week) {
    memo = {
      week,
      data: cached<RawSpec[]>(`raidbots:talents:week-${week}`, async () => {
        const res = await fetch(TALENT_DATA_URL);
        if (!res.ok) throw new Error(`talent data: HTTP ${res.status}`);
        return (await res.json()) as RawSpec[];
      }),
    };
    memo.data.catch(() => (memo = null));
  }
  return memo.data;
}

export async function getSpecTree(className: string, specName: string): Promise<SpecTree | null> {
  return specTreeFrom(await talentData(), className, specName);
}
