// In-game talent loadout strings ("C0QAAAA…"), read and written.
//
// The format is the game's own export (ClassTalentImportExportMixin): a
// header, then a few bits per node of the class tree in a fixed node order,
// packed least-significant-bit first into base64 characters.
//
//   header   version (8 bits) · spec id (16) · tree hash (128, zeros accepted)
//   per node selected (1)
//            └ purchased (1)            — a granted node is selected, not purchased
//              └ partially ranked (1)   └ ranks purchased (6)
//                choice node (1)        └ entry index (2)
//
// The node order and every node's entries come from the tree data
// (`talent-data.ts`). Verified by round-tripping the Peak of Serenity
// Windwalker strings byte for byte (test/loadout.test.ts).

export const LOADOUT_VERSION = 2;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const RANK_BITS = 6;
const CHOICE_BITS = 2;

export interface TreeEntry {
  id: number;
  name: string;
  maxRanks: number;
  spellId?: number;
  /** Hero tree selector entries only. */
  traitSubTreeId?: number;
}

export interface TreeNode {
  id: number;
  name: string;
  type: string;
  maxRanks: number;
  entries: TreeEntry[];
  /** Set on hero nodes: which hero tree they belong to. */
  subTreeId?: number;
  freeNode?: boolean;
}

export interface SpecTree {
  className: string;
  specName: string;
  specId: number;
  /** Every node of the class tree, in the order the game serializes them. */
  nodeOrder: number[];
  nodes: Record<number, TreeNode>;
  /** Which part of the tree a node belongs to, for point totals. */
  section: Record<number, "class" | "spec" | "hero" | "subtree">;
  /** Hero tree id -> name. */
  heroTrees: Record<number, string>;
}

/** One node's state in a loadout. */
export interface NodeChoice {
  nodeId: number;
  /** Granted nodes are selected but not purchased. */
  purchased: boolean;
  ranks: number;
  /** Index into the node's entries (choice and hero-tree nodes). */
  entryIndex: number;
}

export interface Loadout {
  specId: number;
  nodes: NodeChoice[];
}

// --- Bit stream ----------------------------------------------------------------

class BitWriter {
  private bits: number[] = [];
  write(width: number, value: number) {
    for (let i = 0; i < width; i++) this.bits.push((value >> i) & 1);
  }
  toString(): string {
    let out = "";
    for (let i = 0; i < this.bits.length; i += 6) {
      let v = 0;
      for (let b = 0; b < 6 && i + b < this.bits.length; b++) v |= this.bits[i + b] << b;
      out += ALPHABET[v];
    }
    return out;
  }
}

class BitReader {
  private pos = 0;
  private readonly values: number[];
  constructor(values: number[]) {
    this.values = values;
  }
  read(width: number): number {
    let v = 0;
    for (let i = 0; i < width; i++) {
      const at = this.pos + i;
      const char = this.values[Math.floor(at / 6)];
      if (char === undefined) throw new Error("talent string ended early");
      v |= ((char >> at % 6) & 1) << i;
    }
    this.pos += width;
    return v;
  }
  get remainingBits() {
    return this.values.length * 6 - this.pos;
  }
}

// --- Encode / decode -----------------------------------------------------------

const isChoice = (node: TreeNode) => node.type === "choice" || node.type === "subtree";

export function encodeLoadout(tree: SpecTree, loadout: Loadout): string {
  const w = new BitWriter();
  w.write(8, LOADOUT_VERSION);
  w.write(16, loadout.specId);
  for (let i = 0; i < 16; i++) w.write(8, 0); // tree hash: zeros skip the game's tree check

  const byNode = new Map(loadout.nodes.map((n) => [n.nodeId, n]));
  for (const nodeId of tree.nodeOrder) {
    const choice = byNode.get(nodeId);
    const node = tree.nodes[nodeId];
    w.write(1, choice ? 1 : 0);
    if (!choice) continue;
    w.write(1, choice.purchased ? 1 : 0);
    if (!choice.purchased) continue;
    const max = node?.maxRanks ?? 1;
    const partial = choice.ranks !== max;
    w.write(1, partial ? 1 : 0);
    if (partial) w.write(RANK_BITS, choice.ranks);
    const choiceNode = node ? isChoice(node) : false;
    w.write(1, choiceNode ? 1 : 0);
    if (choiceNode) w.write(CHOICE_BITS, choice.entryIndex);
  }
  return w.toString();
}

export function decodeLoadout(tree: SpecTree, text: string): Loadout {
  const values = [...text.trim()].map((c) => {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error(`not a talent string: unexpected "${c}"`);
    return v;
  });
  const r = new BitReader(values);
  const version = r.read(8);
  if (version !== LOADOUT_VERSION) throw new Error(`talent string version ${version}, expected ${LOADOUT_VERSION}`);
  const specId = r.read(16);
  for (let i = 0; i < 16; i++) r.read(8);

  const nodes: NodeChoice[] = [];
  for (const nodeId of tree.nodeOrder) {
    if (!r.read(1)) continue;
    const purchased = r.read(1) === 1;
    const node = tree.nodes[nodeId];
    if (!purchased) {
      nodes.push({ nodeId, purchased: false, ranks: node?.maxRanks ?? 1, entryIndex: 0 });
      continue;
    }
    const ranks = r.read(1) ? r.read(RANK_BITS) : node?.maxRanks ?? 1;
    const entryIndex = r.read(1) ? r.read(CHOICE_BITS) : 0;
    nodes.push({ nodeId, purchased: true, ranks, entryIndex });
  }
  // Anything left is the zero padding of the last character.
  if (r.remainingBits >= 6) throw new Error("talent string is longer than this tree");
  return { specId, nodes };
}

// --- From WarcraftLogs talents -------------------------------------------------

/**
 * WarcraftLogs lists a player's talents as (entry id, points). Turn that into
 * node choices: find each entry's node, take the entry's index for choice
 * nodes, and mark free nodes as granted rather than purchased. The hero-tree
 * selector is filled in from whichever hero tree the hero talents belong to,
 * since the log does not always list the selector itself.
 */
export function loadoutFromTalents(
  tree: SpecTree,
  talents: Array<{ talentID: number; points: number }>,
): Loadout & { heroTree: string | null; unknown: number[] } {
  const entryToNode = new Map<number, { node: TreeNode; index: number }>();
  for (const node of Object.values(tree.nodes)) node.entries.forEach((e, index) => entryToNode.set(e.id, { node, index }));

  const nodes = new Map<number, NodeChoice>();
  const unknown: number[] = [];
  let heroSubTree: number | null = null;
  for (const t of talents) {
    const hit = entryToNode.get(t.talentID);
    if (!hit) {
      unknown.push(t.talentID);
      continue;
    }
    const { node, index } = hit;
    if (node.subTreeId != null) heroSubTree = node.subTreeId;
    if (node.type === "subtree") heroSubTree = node.entries[index].traitSubTreeId ?? heroSubTree;
    // A tiered node (an apex talent such as Tigereye Brew) spreads its ranks
    // over several entries, and the log lists each one: the node's rank is
    // their sum, and it is not a choice.
    if (node.type === "tiered") {
      const prev = nodes.get(node.id)?.ranks ?? 0;
      nodes.set(node.id, {
        nodeId: node.id,
        purchased: !node.freeNode,
        ranks: Math.min(node.maxRanks, prev + Math.max(1, t.points || 1)),
        entryIndex: 0,
      });
      continue;
    }
    nodes.set(node.id, {
      nodeId: node.id,
      purchased: !node.freeNode,
      ranks: Math.max(1, Math.min(t.points || 1, node.maxRanks)),
      entryIndex: index,
    });
  }

  // The hero-tree selector node.
  const selector = Object.values(tree.nodes).find((n) => n.type === "subtree");
  if (selector && heroSubTree != null && !nodes.has(selector.id)) {
    const index = selector.entries.findIndex((e) => e.traitSubTreeId === heroSubTree);
    if (index >= 0) nodes.set(selector.id, { nodeId: selector.id, purchased: true, ranks: 1, entryIndex: index });
  }

  return {
    specId: tree.specId,
    nodes: tree.nodeOrder.filter((id) => nodes.has(id)).map((id) => nodes.get(id)!),
    heroTree: heroSubTree != null ? tree.heroTrees[heroSubTree] ?? null : null,
    unknown,
  };
}

/** Hero tree of a talent list, straight from the tree data — no measured signatures needed. */
export function heroTreeOf(tree: SpecTree, talentIds: number[]): string | null {
  const ids = new Set(talentIds);
  const counts = new Map<number, number>();
  for (const node of Object.values(tree.nodes)) {
    if (node.subTreeId == null) continue;
    if (node.entries.some((e) => ids.has(e.id))) counts.set(node.subTreeId, (counts.get(node.subTreeId) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? tree.heroTrees[best[0]] ?? null : null;
}

/** A stable key for "the same build": every node and its choice, granted nodes included. */
export function buildKey(loadout: Loadout): string {
  return loadout.nodes.map((n) => `${n.nodeId}:${n.ranks}:${n.entryIndex}`).join(",");
}
