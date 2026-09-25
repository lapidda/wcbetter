// What "the opener" is, defined once for the rule and the side-by-side panel.
//
// The opener is the first OPENER_CASTS rotational casts of the pull — a count,
// not a time window. A time window punishes nothing but haste: a player on
// worse gear fits fewer casts into 60s and "misses" the tail of an opener they
// actually played correctly. Counting casts compares the order of the buttons
// themselves.
//
// Trinkets, potions and racials are left out of the count. Whether a top parse
// has an on-use trinket or plays a Troll says nothing about the player's
// sequencing, and counting them would shift every later cast by a slot. They
// are still carried in the sequence, flagged, so the panel can show where they
// went — they just never use up one of the twelve, and never become a finding.

import type { PlayerProfile, ReferenceProfile } from "./types";

/** How many rotational casts make up the opener. */
export const OPENER_CASTS = 12;

export type ExtraKind = "trinket" | "potion" | "item" | "racial";

/**
 * Racial abilities, by name. The one hardcoded list here — the log has no
 * field that marks a spell as racial, and the icons cannot be trusted for it:
 * Bear Form's icon is `ability_racial_bearform`. Racials change rarely and this
 * list only has to cover the ones pressed in combat.
 */
const RACIALS = new Set([
  "Ancestral Call",
  "Arcane Pulse",
  "Arcane Torrent",
  "Bag of Tricks",
  "Berserking",
  "Blood Fury",
  "Bull Rush",
  "Darkflight",
  "Escape Artist",
  "Every Man for Himself",
  "Fireblood",
  "Gift of the Naaru",
  "Hyper Organic Light Originator",
  "Haymaker",
  "Light's Judgment",
  "Quaking Palm",
  "Regeneratin'",
  "Rocket Barrage",
  "Rocket Jump",
  "Shadowmeld",
  "Spatial Rift",
  "Stoneform",
  "Tail Swipe",
  "War Stomp",
  "Will of the Forsaken",
  "Will to Survive",
  "Wing Buffet",
]);

/**
 * Trinkets and potions are recognised by their icon, which the log does carry:
 * every on-use trinket measured used an icon with `trinket` in the file name,
 * and every combat potion one with `potion`. Name patterns alone would miss
 * both — trinket effects are named after the effect ("Nullsight"), not the item.
 * Other on-use items carry an alchemy or flask icon (Freightrunner's Flask,
 * `inv_alchemy_90_flask_red`); no class spell in the measured logs used one.
 */
export function extraKind(name: string, icon: string | null | undefined): ExtraKind | null {
  if (RACIALS.has(name)) return "racial";
  const file = (icon ?? "").toLowerCase();
  if (file.includes("trinket")) return "trinket";
  if (file.includes("potion") || /\bpotion\b/i.test(name)) return "potion";
  if (file.includes("alchemy") || file.includes("flask")) return "item";
  return null;
}

/**
 * Some buttons log one press under two ids at the same instant — measured:
 * Voidblade at 3.9s and 3.9s, on the player and on the top parse alike. Left
 * alone, one press takes two of the twelve slots. Same name, this close
 * together, is one cast; no GCD ability can be pressed twice inside it.
 */
export const DOUBLE_LOG_MS = 250;

export function isDoubleLogged(
  previous: { name: string; atMs: number } | null,
  name: string,
  atMs: number,
): boolean {
  return previous != null && previous.name === name && atMs - previous.atMs < DOUBLE_LOG_MS;
}

export interface OpenerStep {
  gameID: number;
  atMs: number;
  /** Set for trinkets, potions and racials: shown, never counted. */
  extra: ExtraKind | null;
}

export interface AbilityMeta {
  name: string;
  icon: string | null;
}

/**
 * The opener of one pull: casts in order up to and including the
 * OPENER_CASTS-th rotational one, with any extras that happened before it.
 * Casts `meta` cannot name are dropped — auto attacks and channel ticks, which
 * would otherwise take up slots in a twelve-cast window.
 */
export function openerSequence(
  timeline: Array<{ atMs: number; gameID: number }>,
  meta: (gameID: number) => AbilityMeta | null,
  length = OPENER_CASTS,
): OpenerStep[] {
  const steps: OpenerStep[] = [];
  let core = 0;
  let last: { name: string; atMs: number } | null = null;
  for (const cast of timeline) {
    if (core >= length) break;
    const info = meta(cast.gameID);
    if (!info) continue;
    if (isDoubleLogged(last, info.name, cast.atMs)) continue;
    last = { name: info.name, atMs: cast.atMs };
    const extra = extraKind(info.name, info.icon);
    steps.push({ gameID: cast.gameID, atMs: cast.atMs, extra });
    if (!extra) core += 1;
  }
  return steps;
}

/** The rotational casts only — what the count, the comparison and the rule look at. */
export const coreSteps = (steps: OpenerStep[]) => steps.filter((s) => !s.extra);

// --- Side-by-side alignment --------------------------------------------------

/**
 * How a step compares with the other sequence:
 * - `same`: in both, in the same relative order
 * - `order`: in both, but somewhere else in the other sequence
 * - `missing`: only in theirs — they press it in the opener and you do not
 * - `extra`: only in yours — you press it where they never do
 */
export type StepStatus = "same" | "order" | "missing" | "extra";

export interface AlignedRow {
  yours?: { step: OpenerStep; index: number; status: StepStatus | null };
  theirs?: { step: OpenerStep; index: number; status: StepStatus | null };
}

/**
 * Line two openers up the way a diff does: the longest common subsequence of
 * rotational casts shares a row, and everything else sits on its own side. A
 * position-by-position comparison would mark every cast after one early
 * difference as wrong; this marks only the casts that actually differ.
 *
 * An unmatched cast that the other side also has unmatched is an ordering
 * difference, not a missing button, and is labelled as such. Extras keep
 * their place in time on their own side and carry no status.
 */
export function alignOpeners(yours: OpenerStep[], theirs: OpenerStep[]): AlignedRow[] {
  const a = coreSteps(yours);
  const b = coreSteps(theirs);

  // Longest common subsequence, but openers repeat buttons, so there are often
  // several of the same length — measured: your last three Consumes paired
  // with their first three scored the same as Reap, Soul Immolation, Void Ray
  // at neighbouring positions, and marked everything else out of order. So
  // each match is worth MATCH minus how far apart the two casts sit: the most
  // matches always wins, and among those the one a reader would line up.
  const MATCH = 1000;
  const score: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const skip = Math.max(score[i + 1][j], score[i][j + 1]);
      score[i][j] =
        a[i].gameID === b[j].gameID ? Math.max(skip, MATCH - Math.abs(i - j) + score[i + 1][j + 1]) : skip;
    }
  }

  type Op = { kind: "both"; i: number; j: number } | { kind: "a"; i: number } | { kind: "b"; j: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i >= a.length) ops.push({ kind: "b", j: j++ });
    else if (j >= b.length) ops.push({ kind: "a", i: i++ });
    else if (a[i].gameID === b[j].gameID && score[i][j] === MATCH - Math.abs(i - j) + score[i + 1][j + 1]) {
      ops.push({ kind: "both", i: i++, j: j++ });
    } else if (score[i + 1][j] >= score[i][j + 1]) ops.push({ kind: "a", i: i++ });
    else ops.push({ kind: "b", j: j++ });
  }

  // Unmatched casts of one ability on both sides pair off as ordering differences.
  const unmatchedA = new Map<number, number>();
  const unmatchedB = new Map<number, number>();
  for (const op of ops) {
    if (op.kind === "a") unmatchedA.set(a[op.i].gameID, (unmatchedA.get(a[op.i].gameID) ?? 0) + 1);
    if (op.kind === "b") unmatchedB.set(b[op.j].gameID, (unmatchedB.get(b[op.j].gameID) ?? 0) + 1);
  }
  const orderBudgetA = new Map<number, number>();
  const orderBudgetB = new Map<number, number>();
  for (const [id, n] of unmatchedA) {
    const paired = Math.min(n, unmatchedB.get(id) ?? 0);
    orderBudgetA.set(id, paired);
    orderBudgetB.set(id, paired);
  }
  const take = (budget: Map<number, number>, id: number) => {
    const left = budget.get(id) ?? 0;
    if (left <= 0) return false;
    budget.set(id, left - 1);
    return true;
  };

  // Walk the ops, emitting each side's extras in time order before its next
  // rotational cast. Indices number rotational casts only, from 1.
  const rows: AlignedRow[] = [];
  let ya = 0; // position in `yours` (all steps)
  let tb = 0;
  let coreA = 0;
  let coreB = 0;
  const flushA = (upTo: number) => {
    while (ya < yours.length && yours[ya].extra && ya < upTo) rows.push({ yours: { step: yours[ya++], index: 0, status: null } });
  };
  const flushB = (upTo: number) => {
    while (tb < theirs.length && theirs[tb].extra && tb < upTo) rows.push({ theirs: { step: theirs[tb++], index: 0, status: null } });
  };
  const nextCore = (steps: OpenerStep[], from: number) => {
    let k = from;
    while (k < steps.length && steps[k].extra) k++;
    return k;
  };

  for (const op of ops) {
    if (op.kind !== "b") flushA(nextCore(yours, ya));
    if (op.kind !== "a") flushB(nextCore(theirs, tb));

    const row: AlignedRow = {};
    if (op.kind !== "b") {
      const step = yours[ya++];
      const status: StepStatus = op.kind === "both" ? "same" : take(orderBudgetA, step.gameID) ? "order" : "extra";
      row.yours = { step, index: ++coreA, status };
    }
    if (op.kind !== "a") {
      const step = theirs[tb++];
      const status: StepStatus = op.kind === "both" ? "same" : take(orderBudgetB, step.gameID) ? "order" : "missing";
      row.theirs = { step, index: ++coreB, status };
    }
    rows.push(row);
  }
  // Trailing extras, after the last rotational cast of either side.
  flushA(yours.length);
  flushB(theirs.length);
  return rows;
}

// --- Report payload ----------------------------------------------------------

export interface OpenerLane {
  key: string;
  label: string;
  dps: number;
  kill: boolean;
  steps: OpenerStep[];
  fightId?: number;
  source?: { reportCode: string; fightId: number; actorId: number };
}

export interface OpenerComparison {
  length: number;
  abilities: Record<number, AbilityMeta & { extra: ExtraKind | null }>;
  yours: OpenerLane[];
  reference: OpenerLane[];
}

/**
 * Name and icon for an id, from whichever profile has it, or null when no
 * Casts or damage table names it (auto attacks, channel ticks).
 */
export function abilityMetaFrom(
  profiles: PlayerProfile[],
  names: Record<number, string>,
): (gameID: number) => AbilityMeta | null {
  return (gameID) => {
    const stat = profiles.map((p) => p.abilities[gameID]).find((s) => s != null);
    const name = names[gameID] ?? stat?.name;
    if (!name) return null;
    return { name, icon: profiles.map((p) => p.abilities[gameID]?.icon).find((i) => i != null) ?? stat?.icon ?? null };
  };
}

export function buildOpenerComparison(
  yours: Array<{ profile: PlayerProfile; label: string; kill: boolean }>,
  reference: ReferenceProfile,
): OpenerComparison {
  const meta = abilityMetaFrom([...yours.map((y) => y.profile), ...reference.members], reference.abilityNames);

  const yourLanes: OpenerLane[] = yours.map(({ profile, label, kill }) => ({
    key: `you:${profile.fightId}`,
    label,
    dps: profile.dps,
    kill,
    fightId: profile.fightId,
    steps: openerSequence(profile.castTimeline, meta),
  }));
  const refLanes: OpenerLane[] = reference.members.map((m, i) => ({
    key: `ref:${i}`,
    label: m.name,
    dps: m.dps,
    kill: true,
    source: { reportCode: m.reportCode, fightId: m.fightId, actorId: m.actorId },
    steps: openerSequence(m.castTimeline, meta),
  }));

  const abilities: OpenerComparison["abilities"] = {};
  for (const lane of [...yourLanes, ...refLanes]) {
    for (const step of lane.steps) {
      if (abilities[step.gameID]) continue;
      const info = meta(step.gameID)!;
      abilities[step.gameID] = { ...info, extra: step.extra };
    }
  }

  return { length: OPENER_CASTS, abilities, yours: yourLanes, reference: refLanes };
}
