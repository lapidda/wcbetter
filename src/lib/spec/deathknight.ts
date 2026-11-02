// Unholy and Frost Death Knight: Wowhead's single-target priority (patch
// 12.1.5), checked press by press, the same way the Windwalker list is.
//
// A press is only marked when the log proves a higher line applied. What the
// log has exactly: every proc as a buff with its stacks (Sudden Doom, Lesser
// Ghoul, Forbidden Knowledge, Killing Machine, Rime, Exterminate), Runic Power
// on every cast, and Runes on every cast that spends them. What it does not
// have: cooldown readiness (Army, Dark Transformation, Pillar, Putrefy and
// Empower Rune Weapon charges are all reduced or refunded by procs), the
// target's health, and the target's diseases. Lines that need those are listed
// as not checked, never guessed.
//
// Runes between spenders are a lower bound: what the last spender left, with
// regeneration ignored. So "you had a Rune for Scourge Strike" is only claimed
// when even the lower bound says so.
//
// Where the three guides disagree, the disputed order is not flagged:
// - Frost: Method puts Obliterate with Killing Machine above Howling Blast with
//   Rime, and Frost Strike at 1 Rune or less above Killing Machine.
// - Unholy: Icy Veins builds Lesser Ghoul with Festering Strike at up to 3
//   stacks, so Festering Strike *with* stacks is never marked.

import type { BuildEvidence } from "./guide";
import { FROST_LISTS, UNHOLY_LISTS } from "./deathknight-guide";
import {
  auraIdsNamed,
  auraWindows,
  clock,
  stacksAt,
  summarizeRules,
  upUntil,
  type PriorityCast,
  type PriorityInput,
  type PriorityRule,
  type PrioritySummary,
  type PriorityViolation,
} from "./priority";
import type { PlayerProfile } from "@/lib/model/types";

export type DkSpec = "unholy" | "frost";
export type DkTree = "sanlayn" | "rider" | "deathbringer";

export const DK_TREE_LABEL: Record<DkTree, string> = {
  sanlayn: "San'layn",
  rider: "Rider of the Apocalypse",
  deathbringer: "Deathbringer",
};

export function dkSpecOf(profile: Pick<PlayerProfile, "className" | "specName">): DkSpec | null {
  if (!/death\s*knight/i.test(profile.className ?? "")) return null;
  if (/unholy/i.test(profile.specName ?? "")) return "unholy";
  if (/frost/i.test(profile.specName ?? "")) return "frost";
  return null;
}

const used = (profile: PlayerProfile, name: string) =>
  Object.values(profile.abilities).some((a) => a.name === name && (a.casts > 0 || a.damage > 0)) ||
  Object.values(profile.buffs).some((b) => b.name === name);

/** Hero tree from what the log shows the player doing — no talent ids needed. */
export function detectDkTree(profile: PlayerProfile, spec: DkSpec): { tree: DkTree | null; evidence: string } {
  if (spec === "unholy") {
    if (used(profile, "Vampiric Strike") || used(profile, "Essence of the Blood Queen")) {
      return { tree: "sanlayn", evidence: "casts Vampiric Strike" };
    }
  } else if (used(profile, "Reaper's Mark") || used(profile, "Exterminate")) {
    return { tree: "deathbringer", evidence: "casts Reaper's Mark" };
  }
  const rider = Object.values(profile.abilities).find((a) => /Mograine|Whitemane|Trollbane|Nazgrim|Apocalyptic|Rider/i.test(a.name));
  if (rider) return { tree: "rider", evidence: `${rider.name} in the log` };
  return { tree: null, evidence: "no hero-tree ability in the log" };
}

// --- The rules: the guide's lines, with what the log can prove ---------------------

const NOT_IN_LOG = {
  cooldown: "procs and refunds change its cooldown, so the log cannot show when it was ready",
  charges: "its charges are not in the log",
  health: "needs the target's health, which this check does not read",
  disease: "Virulent Plague is on the target; this check reads only your own buffs",
  timing: "a timing guideline, not a rule the log can prove",
  scythe: "the log does not show when Festering Scythe can be cast",
  last: "the last line: nothing below it to skip",
  disputed: "the guides disagree on this order (Method puts Obliterate above Frost Strike)",
} as const;

function whyNot(spec: DkSpec, line: { action: string; when?: string }): string {
  const w = line.when ?? "";
  if (line.action === "Soul Reaper") return /35%/.test(w) ? NOT_IN_LOG.health : NOT_IN_LOG.timing;
  if (line.action === "Blightfall") return NOT_IN_LOG.timing;
  if (line.action === "Outbreak") return NOT_IN_LOG.disease;
  if (line.action === "Festering Scythe") return NOT_IN_LOG.scythe;
  if (line.action === "Putrefy" || line.action === "Empower Rune Weapon") return NOT_IN_LOG.charges;
  if (spec === "frost" && line.action === "Frost Strike" && !w) return NOT_IN_LOG.disputed;
  if (!w && /Death Coil|Howling Blast|Vampiric Strike/.test(line.action)) return NOT_IN_LOG.last;
  return NOT_IN_LOG.cooldown;
}

/** The provable lines, by list and rank, with the advice shown when you break them more than the top parses. */
const CHECKED: Record<string, Record<number, string>> = {
  "uh-st-sanlayn": {
    1: "Before Dark Transformation, top Lesser Ghoul up with Festering Strike: San'layn wants more than 3 stacks going in.",
    9: "Spend Sudden Doom on Death Coil before Festering Strike or Scourge Strike, and never let a proc run out.",
    10: "With no Lesser Ghoul stacks, Festering Strike builds them; Scourge Strike has nothing to burst.",
    11: "With Lesser Ghoul stacks and a Rune, Scourge Strike beats a plain Death Coil.",
  },
  "uh-st-sanlayn-fk": {
    6: "In Forbidden Knowledge, Necrotic Coil comes before Festering Strike and Vampiric Strike whenever you have the Runic Power.",
    7: "With no Lesser Ghoul stacks, Festering Strike builds them; Scourge Strike and Vampiric Strike have nothing to burst.",
  },
  "uh-st-rider": {
    8: "Spend Sudden Doom on Death Coil before Festering Strike or Scourge Strike, and never let a proc run out.",
    9: "With no Lesser Ghoul stacks, Festering Strike builds them; Scourge Strike has nothing to burst.",
    10: "With Lesser Ghoul stacks and a Rune, Scourge Strike beats a plain Death Coil.",
  },
  "uh-st-rider-fk": {
    4: "In Forbidden Knowledge, Necrotic Coil comes before Festering Strike and Scourge Strike whenever you have the Runic Power.",
    5: "With no Lesser Ghoul stacks, Festering Strike builds them; Scourge Strike has nothing to burst.",
  },
  "fr-st-deathbringer": {
    6: "At 2 Killing Machine stacks (or 1 with Exterminate), Obliterate first — a third proc is lost.",
    7: "Howling Blast with Rime before a Frost Strike or an Obliterate without Killing Machine, and never let Rime run out.",
    8: "At full Runic Power, Frost Strike before an Obliterate without Killing Machine, a plain Howling Blast or Empower Rune Weapon.",
    9: "With Killing Machine up and Runes to spare, Obliterate beats Frost Strike.",
  },
  "fr-st-rider": {
    5: "At 2 Killing Machine stacks, Obliterate first — a third proc is lost.",
    6: "Howling Blast with Rime before a Frost Strike or an Obliterate without Killing Machine, and never let Rime run out.",
    7: "At full Runic Power, Frost Strike before an Obliterate without Killing Machine, a plain Howling Blast or Empower Rune Weapon.",
    8: "With Killing Machine up and Runes to spare, Obliterate beats Frost Strike.",
  },
};

/** The single-target lists the check judges, for a spec and tree. */
export function checkedLists(spec: DkSpec, tree: DkTree | null): string[] {
  if (spec === "unholy") return tree === "sanlayn" ? ["uh-st-sanlayn", "uh-st-sanlayn-fk"] : ["uh-st-rider", "uh-st-rider-fk"];
  return tree === "deathbringer" ? ["fr-st-deathbringer"] : ["fr-st-rider"];
}

export function dkRules(spec: DkSpec, tree: DkTree | null): PriorityRule[] {
  const lists = (spec === "unholy" ? UNHOLY_LISTS : FROST_LISTS).filter((l) => checkedLists(spec, tree).includes(l.id));
  return lists.flatMap((list) =>
    list.lines.map((line, i) => {
      const fix = CHECKED[list.id]?.[i + 1];
      return {
        list: list.id,
        rank: i + 1,
        action: line.action,
        when: line.when ?? "",
        checked: fix != null,
        ...(fix ? { fix } : { why: whyNot(spec, line) }),
      };
    }),
  );
}

export const DK_LIST_LABEL: Record<string, string> = {
  "uh-st-sanlayn": "",
  "uh-st-sanlayn-fk": "FK",
  "uh-st-rider": "",
  "uh-st-rider-fk": "FK",
  "fr-st-deathbringer": "",
  "fr-st-rider": "",
};

// --- Shared reading of a pull --------------------------------------------------------

const RUNES = 5;
const RP = 6;

/** Drop the second id of a press logged twice at once. */
function pressesOf(casts: PriorityCast[]): PriorityCast[] {
  const out: PriorityCast[] = [];
  for (const c of casts) {
    const last = out[out.length - 1];
    if (last && last.name === c.name && c.t - last.t < 30) continue;
    out.push(c);
  }
  return out;
}

/** Runes as a lower bound: exact on a Rune spender, else what the last one left. */
function runeTracker() {
  let left: number | null = null;
  return (p: PriorityCast) => {
    const r = p.resources?.[RUNES];
    const before = r ? r.amount : left;
    if (r) left = Math.max(0, r.amount - (r.cost ?? 0));
    return before;
  };
}

function wastedProcs(
  input: PriorityInput,
  presses: PriorityCast[],
  ids: number[],
  consumers: string[],
  line: { list: string; rank: number },
  label: string,
): PriorityViolation[] {
  const out: PriorityViolation[] = [];
  for (const e of input.auras) {
    if (e.type !== "removebuff" || !ids.includes(e.id)) continue;
    if (e.t > input.durationMs - 500) continue;
    if (input.deathsMs.some((d) => e.t >= d - 1_000 && e.t <= d + 2_000)) continue;
    if (presses.some((p) => consumers.includes(p.name) && Math.abs(p.t - e.t) <= 400)) continue;
    out.push({ ...line, kind: "wasted", t: e.t, pressed: null, note: `${label} ran out unused at ${clock(e.t)}` });
  }
  return out;
}

// --- Unholy ----------------------------------------------------------------------------

const UH_STRIKES = new Set(["Festering Strike", "Scourge Strike", "Vampiric Strike"]);
const SD_CONSUMERS = ["Death Coil", "Epidemic", "Necrotic Coil"];

export function unholyViolations(input: PriorityInput, tree: DkTree | null): PriorityViolation[] {
  const san = tree === "sanlayn";
  const L = san
    ? { out: "uh-st-sanlayn", fk: "uh-st-sanlayn-fk", sd: 9, fsNone: 10, ssGhoul: 11, fkNc: 6, fkFsNone: 7 }
    : { out: "uh-st-rider", fk: "uh-st-rider-fk", sd: 8, fsNone: 9, ssGhoul: 10, fkNc: 4, fkFsNone: 5 };

  const windows = auraWindows(input.auras, input.durationMs);
  const presses = pressesOf(input.casts);
  const fk = auraIdsNamed(input.auras, "Forbidden Knowledge");
  const sd = auraIdsNamed(input.auras, "Sudden Doom");

  // Lesser Ghoul comes in two ids: the stacks Festering Strike builds, and the
  // ghouls they summon. The stacks are the id each Scourge Strike or Vampiric
  // Strike takes one from, a few milliseconds after it lands; the summoned
  // ghouls come and go on their own clock.
  const ghoulIds = auraIdsNamed(input.auras, "Lesser Ghoul");
  const strikeTimes = presses.filter((p) => p.name === "Scourge Strike" || p.name === "Vampiric Strike").map((p) => p.t);
  const ghoul = ghoulIds
    .map((id) => ({
      id,
      hits: input.auras.filter(
        (a) =>
          a.id === id &&
          (a.type === "removebuffstack" || a.type === "removebuff") &&
          strikeTimes.some((t) => a.t >= t && a.t - t <= 100),
      ).length,
    }))
    .sort((a, b) => b.hits - a.hits)[0];
  const ghoulAt = (t: number) => (ghoul == null || ghoul.hits === 0 ? null : stacksAt(input.auras, [ghoul.id], t));

  // Necrotic Coil's cost, from the player's own presses of it.
  const ncCosts = presses.filter((p) => p.name === "Necrotic Coil" && p.resources?.[RP]?.cost != null).map((p) => p.resources![RP].cost!);
  const ncCost = ncCosts.length ? Math.min(...ncCosts) : null;

  const runesOf = runeTracker();
  const out: PriorityViolation[] = [];
  for (const p of presses) {
    const runes = runesOf(p);
    const exactRunes = p.resources?.[RUNES]?.amount ?? null;
    const inFk = upUntil(windows, fk, p.t) != null;
    const doom = stacksAt(input.auras, sd, p.t) > 0;
    const stacks = ghoulAt(p.t);
    const rp = p.resources?.[RP]?.amount ?? null;
    const at = (list: string, rank: number, note: string) => out.push({ list, rank, kind: "skipped", t: p.t, pressed: p.name, note });

    if (!inFk) {
      if (san && p.name === "Dark Transformation" && stacks != null && stacks <= 3) {
        at(L.out, 1, `Dark Transformation at ${stacks} Lesser Ghoul — Festering Strike first`);
      } else if (doom && UH_STRIKES.has(p.name)) {
        at(L.out, L.sd, `${p.name} with Sudden Doom up`);
      } else if (stacks === 0 && (p.name === "Scourge Strike" || p.name === "Vampiric Strike") && exactRunes != null && exactRunes >= 2) {
        at(L.out, L.fsNone, `${p.name} with no Lesser Ghoul stacks and ${exactRunes} Runes`);
      } else if (p.name === "Death Coil" && !doom && stacks != null && stacks > 0 && runes != null && runes >= 1) {
        at(L.out, L.ssGhoul, `Death Coil with ${stacks} Lesser Ghoul and at least ${runes} Rune${runes === 1 ? "" : "s"}`);
      }
    } else if (UH_STRIKES.has(p.name)) {
      if (ncCost != null && rp != null && rp >= ncCost) {
        at(L.fk, L.fkNc, `${p.name} in Forbidden Knowledge at ${Math.round(rp / 10)} Runic Power`);
      } else if (stacks === 0 && p.name !== "Festering Strike" && exactRunes != null && exactRunes >= 2) {
        at(L.fk, L.fkFsNone, `${p.name} in Forbidden Knowledge with no Lesser Ghoul stacks`);
      }
    }
  }

  out.push(...wastedProcs(input, presses, sd, SD_CONSUMERS, { list: L.out, rank: L.sd }, "Sudden Doom"));
  return out.sort((a, b) => a.t - b.t);
}

// --- Frost -------------------------------------------------------------------------------

const OBLITERATES = new Set(["Obliterate", "Frostscythe"]);
/**
 * Not a button: Deathbringer's Exterminate fires on its own after Obliterate
 * and Empower Rune Weapon, and refreshes Killing Machine as it does. Judging it
 * as a press would blame the player for the proc.
 */
const NOT_PRESSES = new Set(["Exterminate"]);
const RP_SPENDERS = new Set(["Frost Strike", "Glacial Advance"]);

export function frostViolations(input: PriorityInput, tree: DkTree | null): PriorityViolation[] {
  const db = tree === "deathbringer";
  const list = db ? "fr-st-deathbringer" : "fr-st-rider";
  const R = db ? { km2: 6, rime: 7, waste: 8, km: 9 } : { km2: 5, rime: 6, waste: 7, km: 8 };

  const windows = auraWindows(input.auras, input.durationMs);
  const presses = pressesOf(input.casts.filter((c) => !NOT_PRESSES.has(c.name)));
  const km = auraIdsNamed(input.auras, "Killing Machine");
  const rime = auraIdsNamed(input.auras, "Rime");
  const ext = auraIdsNamed(input.auras, "Exterminate");

  const runesOf = runeTracker();
  const out: PriorityViolation[] = [];
  for (const p of presses) {
    const runes = runesOf(p);
    const machines = stacksAt(input.auras, km, p.t);
    const rimeUp = upUntil(windows, rime, p.t) != null;
    const extUp = db && upUntil(windows, ext, p.t) != null;
    const rp = p.resources?.[RP];
    // At the cap: within 5 Runic Power of full (WCL counts it in tenths).
    const capped = rp != null && rp.amount >= rp.max - 50;
    const at = (rank: number, note: string) => out.push({ list, rank, kind: "skipped", t: p.t, pressed: p.name, note });
    const isOblit = OBLITERATES.has(p.name);
    const isSpender = RP_SPENDERS.has(p.name);

    if ((machines >= 2 || (extUp && machines >= 1)) && (isSpender || p.name === "Howling Blast") && runes != null && runes >= 2) {
      at(R.km2, `${p.name} at ${machines} Killing Machine${extUp ? " with Exterminate" : ""} and ${runes}+ Runes`);
    } else if (rimeUp && ((isOblit && machines === 0) || (isSpender && runes != null && runes >= 2))) {
      at(R.rime, `${p.name} with Rime up`);
    } else if (capped && ((isOblit && machines === 0) || (p.name === "Howling Blast" && !rimeUp))) {
      // Empower Rune Weapon is left out: its top line ("at 2 charges") may be
      // what the press was, and charges are not in the log.
      at(R.waste, `${p.name} at ${Math.round(rp!.amount / 10)}/${Math.round(rp!.max / 10)} Runic Power`);
    } else if (machines >= 1 && isSpender && !capped && runes != null && runes >= 2) {
      at(R.km, `${p.name} with Killing Machine up and ${runes}+ Runes`);
    }
  }

  // Killing Machine lost to overcapping is not counted: a proc at 2 stacks and
  // a refresh from Exterminate look the same in the log. Running out does not.
  out.push(...wastedProcs(input, presses, km, [...OBLITERATES], { list, rank: R.km2 }, "Killing Machine"));
  out.push(...wastedProcs(input, presses, rime, ["Howling Blast"], { list, rank: R.rime }, "Rime"));
  return out.sort((a, b) => a.t - b.t);
}

// --- The report ---------------------------------------------------------------------------

export interface DkPull {
  fightId: number;
  label: string;
  kill: boolean;
  dps: number;
  durationMs: number;
  startTime?: number;
  violations: PriorityViolation[];
}

export interface DeathKnightReport {
  spec: DkSpec;
  tree: DkTree | null;
  treeEvidence: string;
  /** The hero tree the top parses play, by majority. */
  referenceTree: DkTree | null;
  pulls: DkPull[];
  priority: PrioritySummary | null;
  build: BuildEvidence;
}

export function dkViolations(spec: DkSpec, input: PriorityInput, tree: DkTree | null): PriorityViolation[] {
  return spec === "unholy" ? unholyViolations(input, tree) : frostViolations(input, tree);
}

export function buildDeathKnightReport(
  yours: Array<{ profile: PlayerProfile; label: string; kill: boolean; startTime?: number; input: PriorityInput | null }>,
  refs: Array<{ profile: PlayerProfile; input: PriorityInput | null }>,
  build: BuildEvidence,
): DeathKnightReport | null {
  const spec = yours.length ? dkSpecOf(yours[0].profile) : null;
  if (!spec) return null;

  const detected = yours.map((y) => detectDkTree(y.profile, spec));
  const tree = majority(detected.map((d) => d.tree));
  const referenceTree = majority(refs.map((r) => detectDkTree(r.profile, spec).tree));

  const pulls: DkPull[] = yours.map((y) => ({
    fightId: y.profile.fightId,
    label: y.label,
    kill: y.kill,
    dps: y.profile.dps,
    durationMs: y.profile.durationMs,
    startTime: y.startTime,
    violations: y.input ? dkViolations(spec, y.input, tree) : [],
  }));

  // The top parses are judged against your tree's list, so every row compares
  // the same lines. A parse on the other tree simply never triggers the lines
  // only your tree has.
  const judged = refs.flatMap((r) => (r.input ? [{ durationMs: r.input.durationMs, violations: dkViolations(spec, r.input, tree) }] : []));
  const withInput = yours.filter((y) => y.input);
  const priority = withInput.length
    ? summarizeRules(
        dkRules(spec, tree),
        pulls.filter((_, i) => yours[i].input).map((p) => ({ fightId: p.fightId, label: p.label, durationMs: p.durationMs, violations: p.violations })),
        judged,
      )
    : null;

  return {
    spec,
    tree,
    treeEvidence: detected.find((d) => d.tree === tree)?.evidence ?? detected[0]?.evidence ?? "",
    referenceTree,
    pulls,
    priority,
    build,
  };
}

function majority<T>(values: Array<T | null>): T | null {
  const counts = new Map<T, number>();
  for (const v of values) if (v != null) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

