// The Conduit of the Celestials single-target priority, checked press by press.
//
// Source: Peak of Serenity's Windwalker PvE guide, updated for patch 12.1
// (23 September 2026), "Default Conduit" single-target list. The labels below
// are paraphrased.
//
// A priority list says "press the highest line whose condition holds". To call
// a press wrong, the log has to prove that a higher line's condition held at
// that moment. Some conditions are in the log exactly: proc buffs, Energy on
// every cast, the Heart of the Jade Serpent buff, when Xuen was pressed. Others
// are not:
//
// - Cooldown readiness of Fists of Fury and Rising Sun Kick. Their cooldowns
//   are reset and shortened by procs (Fists of Fury measured 4.2s apart), so
//   "it was ready and you pressed something else" cannot be proven.
// - Chi between spenders. The log carries Chi only on casts that spend it, so
//   "under 2 Chi" or "more than 4 Chi" is unknown on most presses.
//
// Every unknown condition is given the benefit of the doubt: a press is only
// marked when a *provable* higher line was skipped. The same pass runs on the
// top parses, so each line shows how often they "break" it too — the honest
// baseline for what is a habit to fix and what is noise.

import { WW, type Press } from "./windwalker";

export interface PriorityRule {
  rank: number;
  action: string;
  /** When the line applies; empty for an unconditional line. */
  when: string;
  /** Whether the log can prove a violation of this line. */
  checked: boolean;
  /** Why not, when it cannot. */
  why?: string;
  /** What to do differently, shown when you break it more than the top parses. */
  fix?: string;
}

const COOLDOWN_UNKNOWN = "procs reset its cooldown, so the log cannot show when it was ready";
const CHI_UNKNOWN = "the log carries Chi only on presses that spend it";

export const CONDUIT_PRIORITY: PriorityRule[] = [
  {
    rank: 1,
    action: WW.WDP,
    when: "Xuen is more than 10s away",
    checked: true,
    fix: "When Xuen is under 10s away, hold Whirling Dragon Punch for the window.",
  },
  {
    rank: 2,
    action: WW.CONDUIT,
    when: "no Heart of the Jade Serpent from Whirling Dragon Punch or Strike of the Windlord is up",
    checked: true,
    fix: "Wait for Heart of the Jade Serpent from Whirling Dragon Punch to run out before Conduit; the two do not stack.",
  },
  {
    rank: 3,
    action: WW.STOMP,
    when: "Chi is low, Zenith is about to end, or during Conduit",
    checked: false,
    why: CHI_UNKNOWN,
  },
  {
    rank: 4,
    action: WW.FOF,
    when: "Heart of the Jade Serpent has under 1s left",
    checked: false,
    why: `Fists of Fury: ${COOLDOWN_UNKNOWN}`,
  },
  {
    rank: 5,
    action: WW.TP,
    when: "Energy would cap outside Zenith and Bloodlust, or there is not enough Chi for Fists of Fury",
    checked: true,
    fix: "At full Energy outside Zenith and Bloodlust, press Tiger Palm before anything below it — the Energy is lost otherwise.",
  },
  { rank: 6, action: WW.FOF, when: "", checked: false, why: `Fists of Fury: ${COOLDOWN_UNKNOWN}` },
  {
    rank: 7,
    action: WW.RWK,
    when: "the Rushing Wind Kick proc is up",
    checked: true,
    fix: "Rushing Wind Kick comes right after Fists of Fury: press it as soon as it lights up, before Crane Kick, Rising Sun Kick or Blackout Kick.",
  },
  {
    rank: 8,
    action: WW.SCK,
    when: "Unbroken Rhythm (Season 2 four-piece) is up",
    checked: true,
    fix: "With Unbroken Rhythm up after Fists of Fury, Spinning Crane Kick beats Rising Sun Kick, Blackout Kick and Tiger Palm.",
  },
  { rank: 9, action: WW.RSK, when: "", checked: false, why: `Rising Sun Kick: ${COOLDOWN_UNKNOWN}` },
  {
    rank: 10,
    action: WW.BOK,
    when: "Combo Breaker (Blackout Kick!) is up",
    checked: true,
    fix: "Spend Blackout Kick! procs before filler Tiger Palm or a Crane Kick without Dance of Chi-Ji, and never let one run out.",
  },
  { rank: 11, action: WW.SCK, when: "in Zenith with more than 4 Chi or Dance of Chi-Ji", checked: false, why: CHI_UNKNOWN },
  { rank: 12, action: WW.TP, when: "under 2 Chi", checked: false, why: CHI_UNKNOWN },
  {
    rank: 13,
    action: WW.SCK,
    when: "Dance of Chi-Ji is up",
    checked: true,
    fix: "Use Dance of Chi-Ji before filler Tiger Palm or a plain Blackout Kick, and never let it run out.",
  },
  { rank: 14, action: WW.TP, when: "it does not overcap Chi", checked: false, why: CHI_UNKNOWN },
  { rank: 15, action: WW.BOK, when: "", checked: false, why: "the last line: nothing below it to skip" },
];

/** Aura names, as the log shows them. */
const AURA = {
  BOK_PROC: "Blackout Kick!",
  DANCE: "Dance of Chi-Ji",
  RHYTHM: "Unbroken Rhythm",
  RWK_PROC: "Rushing Wind Kick",
  HOTJS: "Heart of the Jade Serpent",
  ZENITH: "Zenith",
} as const;
const LUST = /^(Bloodlust|Heroism|Time Warp|Primal Rage|Fury of the Aspects|Ancient Hysteria|Netherwinds|Harrier's Cry|Feral Hide Drums|Drums of .+)$/;

/** Presses the priority list is about. Anything else (cooldowns, items, utility) is never judged. */
const ROTATION = new Set<string>([WW.TP, WW.BOK, WW.RSK, WW.RWK, WW.FOF, WW.SCK, WW.WDP, WW.CONDUIT, WW.STOMP]);

export interface PriorityCast {
  /** Fight-relative ms. */
  t: number;
  name: string;
  energy: number | null;
  energyMax: number | null;
  /** Chi when the press began; only on presses that spend Chi. */
  chi: number | null;
  chiCost: number | null;
  chiMax: number | null;
}

export interface PriorityAura {
  /** Fight-relative ms. */
  t: number;
  type: string;
  /** Aura id; Heart of the Jade Serpent comes in several, from different buttons. */
  id: number;
  name: string;
}

export interface PriorityInput {
  durationMs: number;
  casts: PriorityCast[];
  /** The player's own buff events. */
  auras: PriorityAura[];
  /** Fight-relative death times: buffs dropping then are not wasted procs. */
  deathsMs: number[];
}

export interface PriorityViolation {
  rank: number;
  /** "skipped": a lower press while this line provably applied. "wasted": its proc ran out unused. */
  kind: "skipped" | "wasted";
  t: number;
  /** What was pressed instead; null for a wasted proc. */
  pressed: string | null;
  note: string;
}

type Windows = Map<number, Array<[number, number]>>;

function auraWindows(auras: PriorityAura[], durationMs: number): Windows {
  const out: Windows = new Map();
  const open = new Map<number, number>();
  const push = (id: number, a: number, b: number) => (out.get(id) ?? out.set(id, []).get(id)!).push([a, b]);
  for (const e of auras) {
    if (e.type === "applybuff") {
      if (!open.has(e.id)) open.set(e.id, e.t);
    } else if (e.type === "removebuff") {
      push(e.id, open.get(e.id) ?? 0, e.t);
      open.delete(e.id);
    }
  }
  for (const [id, from] of open) push(id, from, durationMs);
  return out;
}

/** End of the window covering t, or null when the aura was not up. Touching the edge does not count. */
function upUntil(windows: Windows, ids: number[], t: number): number | null {
  let best: number | null = null;
  for (const id of ids) for (const [a, b] of windows.get(id) ?? []) if (t > a && t < b) best = Math.max(best ?? 0, b);
  return best;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

/** One pull's violations of the provable lines. */
export function priorityViolations(input: PriorityInput): PriorityViolation[] {
  const windows = auraWindows(input.auras, input.durationMs);
  const idsNamed = (name: string) => [...new Set(input.auras.filter((a) => a.name === name).map((a) => a.id))];
  const lust = [...new Set(input.auras.filter((a) => LUST.test(a.name)).map((a) => a.id))];

  // One press logged under two ids (Spinning Crane Kick and Chi Explosion)
  // arrives at the same millisecond: keep the first.
  const presses: PriorityCast[] = [];
  for (const c of input.casts) {
    const last = presses[presses.length - 1];
    if (last && c.t - last.t < 30) continue;
    presses.push(c);
  }

  // Which Heart of the Jade Serpent ids come from Whirling Dragon Punch or
  // Strike of the Windlord: the ones applied as those land. Read from the log,
  // since the ids differ by source and by patch.
  const fromWdp = idsNamed(AURA.HOTJS).filter((id) => {
    const applies = input.auras.filter((a) => a.id === id && a.type === "applybuff");
    const after = applies.filter((a) =>
      presses.some((p) => (p.name === WW.WDP || p.name === WW.SOTW) && a.t >= p.t - 50 && a.t - p.t <= 300),
    );
    return applies.length > 0 && after.length * 2 >= applies.length;
  });

  const ids = {
    bok: idsNamed(AURA.BOK_PROC),
    dance: idsNamed(AURA.DANCE),
    rhythm: idsNamed(AURA.RHYTHM),
    rwk: idsNamed(AURA.RWK_PROC),
    zenith: idsNamed(AURA.ZENITH),
  };
  const up = (list: number[], t: number) => upUntil(windows, list, t) != null;

  const out: PriorityViolation[] = [];
  const xuens = presses.filter((p) => p.name === WW.XUEN).map((p) => p.t);
  let chi: number | null = null; // a lower bound: only Tiger Palm's +2 is added between spenders
  let prev: PriorityCast | null = null;

  for (const p of presses) {
    if (p.chi != null) chi = Math.max(0, p.chi - (p.chiCost ?? 0));

    if (ROTATION.has(p.name)) {
      const zenith = up(ids.zenith, p.t);
      const capped =
        p.t > 2_000 && p.energy != null && p.energyMax != null && p.energy >= p.energyMax - 2 && !zenith && !up(lust, p.t);
      const chiBefore = p.chi ?? chi;
      const repeat = (name: string) => prev?.name === name;

      // Line 1 and 2 are judged on the press itself.
      if (p.name === WW.WDP) {
        const next = xuens.find((x) => x > p.t);
        if (next != null && next - p.t <= 10_000) {
          out.push({ rank: 1, kind: "skipped", t: p.t, pressed: p.name, note: `Whirling Dragon Punch ${secs(next - p.t)} before Xuen` });
        }
      }
      if (p.name === WW.CONDUIT) {
        const until = upUntil(windows, fromWdp, p.t);
        if (until != null) {
          out.push({
            rank: 2,
            kind: "skipped",
            t: p.t,
            pressed: p.name,
            note: `Conduit with ${secs(until - p.t)} of Heart of the Jade Serpent from Whirling Dragon Punch left`,
          });
        }
      }

      // The highest line this press could belong to, unknowns in its favour.
      const rhythm = up(ids.rhythm, p.t);
      const dance = up(ids.dance, p.t);
      let rank: number;
      switch (p.name) {
        case WW.WDP:
          rank = 1;
          break;
        case WW.CONDUIT:
          rank = 2;
          break;
        case WW.STOMP:
          rank = 3;
          break;
        case WW.FOF: {
          const until = upUntil(windows, fromWdp, p.t);
          rank = until != null && until - p.t < 1_000 ? 4 : 6;
          break;
        }
        case WW.TP:
          rank = capped || chiBefore == null || chiBefore < 3 ? 5 : 14;
          break;
        case WW.RWK:
          rank = 7;
          break;
        case WW.SCK:
          rank = rhythm ? 8 : zenith ? 11 : dance ? 13 : 16;
          break;
        case WW.RSK:
          rank = 9;
          break;
        case WW.BOK:
          rank = up(ids.bok, p.t) || zenith ? 10 : 15;
          break;
        default:
          rank = 0;
      }

      // The provable lines that applied, best first. A line whose button was
      // the previous press is skipped: pressing it again would break Combo Strikes.
      const alternatives: Array<{ rank: number; note: string }> = [];
      if (capped && !repeat(WW.TP)) alternatives.push({ rank: 5, note: `at ${p.energy}/${p.energyMax} Energy outside Zenith — Tiger Palm first` });
      if (up(ids.rwk, p.t)) alternatives.push({ rank: 7, note: "with the Rushing Wind Kick proc up" });
      if (rhythm && !repeat(WW.SCK)) alternatives.push({ rank: 8, note: "with Unbroken Rhythm up" });
      if (up(ids.bok, p.t) && !repeat(WW.BOK)) alternatives.push({ rank: 10, note: "with a Blackout Kick! proc up" });
      if (dance && !repeat(WW.SCK)) alternatives.push({ rank: 13, note: "with Dance of Chi-Ji up" });

      const best = alternatives.find((a) => a.rank < rank);
      if (rank > 0 && best) {
        out.push({ rank: best.rank, kind: "skipped", t: p.t, pressed: p.name, note: `${p.name} ${best.note}` });
      }

      if (p.name === WW.TP && chi != null && p.chiMax != null) chi = Math.min(p.chiMax, chi + 2);
      prev = p;
    } else if (p.name === WW.ZENITH || p.name === WW.XUEN) {
      // Pressing anything between two of the same button keeps Combo Strikes.
      prev = p;
    }
  }

  // Procs that ran out unused.
  const consumers: Record<string, { rank: number; by: string; ids: number[] }> = {
    bok: { rank: 10, by: WW.BOK, ids: ids.bok },
    dance: { rank: 13, by: WW.SCK, ids: ids.dance },
    rwk: { rank: 7, by: WW.RWK, ids: ids.rwk },
  };
  for (const c of Object.values(consumers)) {
    for (const e of input.auras) {
      if (e.type !== "removebuff" || !c.ids.includes(e.id)) continue;
      if (e.t > input.durationMs - 500) continue;
      if (input.deathsMs.some((d) => e.t >= d - 1_000 && e.t <= d + 2_000)) continue;
      if (presses.some((p) => p.name === c.by && Math.abs(p.t - e.t) <= 400)) continue;
      out.push({ rank: c.rank, kind: "wasted", t: e.t, pressed: null, note: `${e.name} ran out unused at ${clock(e.t)}` });
    }
  }

  return out.sort((a, b) => a.t - b.t);
}

export interface PriorityRow extends PriorityRule {
  you: { count: number; perMin: number; skipped: number; wasted: number };
  /** Median per minute across the top parses; null when there were none to check. */
  topPerMin: number | null;
  /** you − top, per minute. What the ranking is by. */
  excessPerMin: number;
  examples: Array<{ fightId: number; label: string; t: number; note: string }>;
}

export interface PrioritySummary {
  rows: PriorityRow[];
  /** How many top parses the baseline came from. */
  referenceCount: number;
}

/** Your violations per line against the top parses', worst excess first. */
export function summarizePriority(
  yours: Array<{ fightId: number; label: string; durationMs: number; violations: PriorityViolation[] }>,
  refs: Array<{ durationMs: number; violations: PriorityViolation[] }>,
): PrioritySummary {
  const minutes = yours.reduce((s, p) => s + p.durationMs, 0) / 60_000;
  const rows: PriorityRow[] = CONDUIT_PRIORITY.map((rule) => {
    const mine = yours.flatMap((p) => p.violations.filter((v) => v.rank === rule.rank).map((v) => ({ ...v, pull: p })));
    const perMin = minutes > 0 ? mine.length / minutes : 0;
    const refRates = refs
      .filter((r) => r.durationMs > 0)
      .map((r) => r.violations.filter((v) => v.rank === rule.rank).length / (r.durationMs / 60_000))
      .sort((a, b) => a - b);
    const topPerMin = refRates.length
      ? refRates.length % 2
        ? refRates[(refRates.length - 1) / 2]
        : (refRates[refRates.length / 2 - 1] + refRates[refRates.length / 2]) / 2
      : null;
    return {
      ...rule,
      you: {
        count: mine.length,
        perMin,
        skipped: mine.filter((v) => v.kind === "skipped").length,
        wasted: mine.filter((v) => v.kind === "wasted").length,
      },
      topPerMin,
      excessPerMin: perMin - (topPerMin ?? 0),
      examples: mine.slice(0, 6).map((v) => ({ fightId: v.pull.fightId, label: v.pull.label, t: v.t, note: v.note })),
    };
  });

  rows.sort((a, b) => Number(b.checked) - Number(a.checked) || b.excessPerMin - a.excessPerMin || a.rank - b.rank);
  return { rows, referenceCount: refs.length };
}

/**
 * Marks each skipped line on the press where it happened, so the press list
 * shows it in context. Line 1 is already marked by the Xuen-window check, and
 * a wasted proc has no press to sit on — the summary lists those by time.
 */
export function markPriority(presses: Press[], violations: PriorityViolation[]): void {
  for (const v of violations) {
    if (v.kind !== "skipped" || v.rank === 1) continue;
    const press = presses.find((p) => Math.abs(p.t - v.t) <= 1 && p.name === v.pressed);
    if (!press || press.marks.some((m) => m.code === "priority")) continue;
    const rule = CONDUIT_PRIORITY.find((r) => r.rank === v.rank);
    press.marks.push({
      level: "warn",
      code: "priority",
      note: `Priority #${v.rank} skipped: ${v.note}.${rule?.fix ? ` ${rule.fix}` : ""}`,
    });
  }
}
