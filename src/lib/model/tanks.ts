// Tanking: who tanked first, when they taunted, and what was up when the boss
// hit them. Pure, like raid.ts and performance.ts.
//
// What is derived from the log, with no per-boss list:
//   - the swap debuff: a boss debuff that stacks and lands (almost) only on
//     tanks (Mythic Sszorak: Corroding Venom, 13 stacks before the swap)
//   - first and second tank: who gets that debuff first on each pull
//   - each swap taunt and the other tank's stacks when it went out. A swap is
//     read from the taunt, not from the debuff moving: on Mythic Sszorak the
//     taunt at 13 stacks came 25s before the debuff first landed on the new
//     tank, because only some of the boss's hits apply it
//   - tank busters: boss abilities whose hits land on the tanks, melee excluded
//
// What has to be known: which buttons are taunts and which are defensives.
// Those are fixed per class and few, so they are listed by name below.

import type { WclEvent } from "@/lib/wcl/types";
import { median } from "./stats";
import type { RaidActor } from "./raid";

export const TAUNTS = new Set(["Taunt", "Hand of Reckoning", "Dark Command", "Growl", "Provoke", "Torment"]);

/** Personal tank cooldowns, by class. Rotational mitigation (Shield Block, Ignore Pain, Demon Spikes) is left out. */
export const PERSONAL_DEFENSIVES = new Set([
  // Death Knight
  "Icebound Fortitude", "Vampiric Blood", "Anti-Magic Shell", "Lichborne", "Dancing Rune Weapon", "Rune Tap", "Tombstone",
  // Paladin
  // Holy Bulwark is left out: a Templar absorb cast ~20 times a pull, it would make every hit look covered.
  "Ardent Defender", "Guardian of Ancient Kings", "Sentinel", "Divine Shield", "Eye of Tyr", "Lay on Hands", "Blessing of Spellwarding",
  // Warrior
  "Shield Wall", "Last Stand", "Spell Reflection", "Demoralizing Shout",
  // Druid
  "Survival Instincts", "Barkskin", "Rage of the Sleeper", "Frenzied Regeneration", "Renewal",
  // Monk
  "Fortifying Brew", "Celestial Brew", "Celestial Infusion", "Dampen Harm", "Diffuse Magic", "Zen Meditation",
  // Demon Hunter
  "Metamorphosis", "Fiery Brand",
]);

/** Cooldowns other players put on a tank. */
export const EXTERNALS = new Set([
  "Blessing of Sacrifice", "Blessing of Protection", "Ironbark", "Pain Suppression", "Guardian Spirit", "Life Cocoon", "Time Dilation",
]);

export const TANK_SPECS = new Set(["Protection", "Blood", "Guardian", "Brewmaster", "Vengeance"]);

/** A taunt counts as a swap when the other tank has at least this many stacks, and more than the taunter. */
const SWAP_MIN_STACKS = 2;
/** A swap taunt this many stacks past the tank's usual is late. */
const LATE_BY_STACKS = 3;
/** A swap debuff lands on tanks at least this reliably. */
const TANK_SHARE = 0.8;
/** Faster than this per minute on a tank is the boss's melee, not a buster. */
const MELEE_PER_MIN = 10;
/** Hits on a tank this close together are one buster. */
const HIT_CLUSTER_MS = 1_000;
/** A defensive pressed this long before the hit counts as planned for it. */
const DEFENSIVE_LEAD_MS = 3_000;

export interface TankFight {
  fightId: number;
  label: string;
  kill: boolean;
  startTime: number;
  durationMs: number;
  /** Debuff events on friendlies, every source. */
  debuffs: WclEvent[];
  /** Damage-taken events on friendlies, enemy-sourced. */
  hits: WclEvent[];
  /** tankId -> that tank's cast events. */
  casts: Record<number, WclEvent[]>;
  /** tankId -> buffs on that tank with their active windows (report-relative ms). */
  buffs: Record<number, Array<{ name: string; bands: Array<{ startTime: number; endTime: number }> }>>;
  /** Boss mechanic casts, fight-relative. */
  bossCasts: Array<{ atMs: number; name: string; targetId: number | null }>;
  deaths: Array<{ targetId: number; atMs: number; ability: string | null }>;
}

export interface TankInput {
  fights: TankFight[];
  tanks: RaidActor[];
  /** Ability id -> name, for debuffs and damage. */
  names: Record<number, string>;
}

export interface Window {
  tankId: number;
  name: string;
  kind: "personal" | "external";
  startMs: number;
  endMs: number;
}

export interface Taunt {
  tankId: number;
  atMs: number;
  /** The other tank's stacks when the taunt went out. */
  otherStacks: number;
  ownStacks: number;
  /** A taunt off the other tank's stacks — the swap — rather than one for the pull or an add. */
  swap: boolean;
  /** A swap taunt well past this tank's usual stack count. */
  late: boolean;
}

export interface BusterHit {
  atMs: number;
  name: string;
  tankId: number;
  amount: number;
  /** What was up: personal defensives and externals, by name. */
  covered: Array<{ name: string; kind: "personal" | "external" }>;
}

export interface TankPull {
  fightId: number;
  label: string;
  kill: boolean;
  durationMs: number;
  firstTankId: number | null;
  taunts: Taunt[];
  windows: Window[];
  busters: BusterHit[];
  /** tankId -> stack steps, fight-relative: each entry holds until the next. */
  stacks: Record<number, Array<{ atMs: number; stacks: number }>>;
  bossCasts: Array<{ atMs: number; name: string; onTank: number | null }>;
  deaths: Array<{ tankId: number; atMs: number; ability: string | null }>;
}

export interface TankSummary {
  tankId: number;
  firstOn: number;
  tauntsPerPull: number;
  /** Median of the other tank's stacks when this tank taunted for a swap. */
  tauntAtStacks: number | null;
  swapTaunts: number;
  lateTaunts: number;
  /** Highest stacks this tank reached, median over pulls. */
  peakStacks: number | null;
  busterHits: number;
  bustersCovered: number;
  /** Defensive name -> uses per pull. */
  defensives: Array<{ name: string; kind: "personal" | "external"; perPull: number }>;
  deaths: number;
}

export interface TankReport {
  tanks: Array<RaidActor & { spec: string | null }>;
  swapDebuff: string | null;
  busterNames: string[];
  /** Tank ids in the order they most often take the boss: first, second. */
  order: number[];
  pulls: TankPull[];
  summary: TankSummary[];
}

// --- Swap debuff -----------------------------------------------------------------

export function findSwapDebuff(fights: TankFight[], tankIds: Set<number>): number | null {
  const stats = new Map<number, { stacks: number; onTank: number; total: number; tanksHit: Set<number> }>();
  for (const f of fights) {
    for (const e of f.debuffs) {
      const id = Number(e.abilityGameID);
      const target = Number(e.targetID);
      if (!id || (e.type !== "applydebuff" && e.type !== "applydebuffstack")) continue;
      const s = stats.get(id) ?? { stacks: 0, onTank: 0, total: 0, tanksHit: new Set<number>() };
      if (e.type === "applydebuffstack") s.stacks += 1;
      if (e.type === "applydebuff") {
        s.total += 1;
        if (tankIds.has(target)) {
          s.onTank += 1;
          s.tanksHit.add(target);
        }
      }
      stats.set(id, s);
    }
  }
  const candidates = [...stats.entries()].filter(
    ([, s]) => s.stacks > 0 && s.total > 0 && s.onTank / s.total >= TANK_SHARE && s.tanksHit.size >= Math.min(2, tankIds.size),
  );
  candidates.sort((a, b) => b[1].stacks - a[1].stacks);
  return candidates[0]?.[0] ?? null;
}

/** Stack steps per tank for one debuff, fight-relative. */
export function stackSteps(f: TankFight, debuffId: number, tankIds: Set<number>): Record<number, Array<{ atMs: number; stacks: number }>> {
  const out: Record<number, Array<{ atMs: number; stacks: number }>> = {};
  for (const id of tankIds) out[id] = [{ atMs: 0, stacks: 0 }];
  for (const e of f.debuffs) {
    const target = Number(e.targetID);
    if (Number(e.abilityGameID) !== debuffId || !tankIds.has(target)) continue;
    const at = e.timestamp - f.startTime;
    const stacks =
      e.type === "applydebuff" ? 1 : e.type === "applydebuffstack" ? Number(e.stack ?? 0) : e.type === "removedebuff" ? 0 : null;
    if (stacks == null) continue;
    const list = out[target];
    if (list[list.length - 1].stacks !== stacks) list.push({ atMs: at, stacks });
  }
  return out;
}

const stacksAt = (steps: Array<{ atMs: number; stacks: number }> | undefined, atMs: number) => {
  let s = 0;
  for (const step of steps ?? []) {
    if (step.atMs > atMs) break;
    s = step.stacks;
  }
  return s;
};

// --- One pull ---------------------------------------------------------------------

export function analyzeTankPull(f: TankFight, tankIds: Set<number>, swapId: number | null, busterIds: Set<number>, names: Record<number, string>): TankPull {
  const stacks = swapId != null ? stackSteps(f, swapId, tankIds) : {};

  // Taunts.
  const tauntCasts: Array<{ tankId: number; atMs: number }> = [];
  for (const tankId of tankIds) {
    for (const e of f.casts[tankId] ?? []) {
      if (e.type !== "cast") continue;
      if (TAUNTS.has(names[Number(e.abilityGameID)] ?? "")) tauntCasts.push({ tankId, atMs: e.timestamp - f.startTime });
    }
  }
  tauntCasts.sort((a, b) => a.atMs - b.atMs);

  // First tank: whoever the swap debuff lands on first.
  let firstTankId: number | null = null;
  let firstAt = Infinity;
  for (const [id, steps] of Object.entries(stacks)) {
    const start = steps.find((x) => x.stacks > 0);
    if (start && start.atMs < firstAt) {
      firstAt = start.atMs;
      firstTankId = Number(id);
    }
  }

  const taunts: Taunt[] = tauntCasts.map((t) => {
    const other = [...tankIds].find((id) => id !== t.tankId);
    const otherStacks = other != null ? stacksAt(stacks[other], t.atMs) : 0;
    const ownStacks = stacksAt(stacks[t.tankId], t.atMs);
    return { tankId: t.tankId, atMs: t.atMs, otherStacks, ownStacks, swap: otherStacks >= SWAP_MIN_STACKS && ownStacks < otherStacks, late: false };
  });

  // Defensive and external windows on each tank.
  const windows: Window[] = [];
  for (const tankId of tankIds) {
    const cast = new Set((f.casts[tankId] ?? []).map((e) => names[Number(e.abilityGameID)] ?? ""));
    for (const aura of f.buffs[tankId] ?? []) {
      const personal = PERSONAL_DEFENSIVES.has(aura.name) && cast.has(aura.name);
      const external = !personal && (EXTERNALS.has(aura.name) || PERSONAL_DEFENSIVES.has(aura.name));
      if (!personal && !external) continue;
      for (const b of aura.bands) {
        windows.push({
          tankId,
          name: aura.name,
          kind: personal ? "personal" : "external",
          startMs: Math.max(0, b.startTime - f.startTime),
          endMs: Math.min(f.durationMs, b.endTime - f.startTime),
        });
      }
    }
  }
  windows.sort((a, b) => a.startMs - b.startMs);

  // Tank busters: hits from buster abilities on a tank, clustered.
  const busters: BusterHit[] = [];
  const hits = f.hits
    .filter((e) => busterIds.has(Number(e.abilityGameID)) && tankIds.has(Number(e.targetID)))
    .sort((a, b) => a.timestamp - b.timestamp);
  for (const e of hits) {
    const atMs = e.timestamp - f.startTime;
    const tankId = Number(e.targetID);
    const name = names[Number(e.abilityGameID)] ?? `#${e.abilityGameID}`;
    const amount = (Number(e.amount) || 0) + (Number(e.absorbed) || 0);
    const last = busters[busters.length - 1];
    if (last && last.tankId === tankId && last.name === name && atMs - last.atMs <= HIT_CLUSTER_MS) {
      last.amount += amount;
      continue;
    }
    const covered = windows
      .filter((w) => w.tankId === tankId && w.startMs <= atMs + 250 && w.endMs >= atMs && atMs - w.startMs >= -DEFENSIVE_LEAD_MS)
      .map((w) => ({ name: w.name, kind: w.kind }));
    busters.push({ atMs, name, tankId, amount, covered: dedupeBy(covered, (c) => c.name) });
  }

  return {
    fightId: f.fightId,
    label: f.label,
    kill: f.kill,
    durationMs: f.durationMs,
    firstTankId,
    taunts,
    windows,
    busters,
    stacks,
    bossCasts: f.bossCasts.map((c) => ({ atMs: c.atMs, name: c.name, onTank: c.targetId != null && tankIds.has(c.targetId) ? c.targetId : null })),
    deaths: f.deaths.filter((d) => tankIds.has(d.targetId)).map((d) => ({ tankId: d.targetId, atMs: d.atMs, ability: d.ability })),
  };
}

function dedupeBy<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
}

/** Boss abilities that hit tanks almost exclusively, at a rate below melee. */
export function findBusters(fights: TankFight[], tankIds: Set<number>, names: Record<number, string> = {}): Set<number> {
  const stats = new Map<number, { onTank: number; total: number }>();
  let tankMinutes = 0;
  for (const f of fights) {
    tankMinutes += (f.durationMs / 60_000) * tankIds.size;
    for (const e of f.hits) {
      const id = Number(e.abilityGameID);
      if (!id) continue;
      const s = stats.get(id) ?? { onTank: 0, total: 0 };
      s.total += 1;
      if (tankIds.has(Number(e.targetID))) s.onTank += 1;
      stats.set(id, s);
    }
  }
  const out = new Set<number>();
  for (const [id, s] of stats) {
    if (s.onTank === 0 || s.onTank / s.total < TANK_SHARE) continue;
    // WarcraftLogs names every auto-attack "Melee". A boss that swings in bursts
    // with pauses between them slips under the rate test, so the name decides.
    if (names[id] === "Melee") continue;
    if (tankMinutes > 0 && s.onTank / tankMinutes > MELEE_PER_MIN) continue; // the boss swinging
    out.add(id);
  }
  return out;
}

// --- The report -------------------------------------------------------------------

export function buildTankReport(input: TankInput & { specs: Record<number, string | null> }): TankReport | null {
  const tanks = input.tanks;
  if (tanks.length === 0) return null;
  const tankIds = new Set(tanks.map((t) => t.id));
  const swapId = findSwapDebuff(input.fights, tankIds);
  const busterIds = findBusters(input.fights, tankIds, input.names);
  if (swapId != null) busterIds.delete(swapId);
  // A buster nothing names cannot be shown or called out, so it is left out —
  // the same rule the opener and the raid notes follow for unnamed ids.
  for (const id of [...busterIds]) if (!input.names[id]) busterIds.delete(id);
  const pulls = input.fights.map((f) => analyzeTankPull(f, tankIds, swapId, busterIds, input.names));

  // A swap taunt well past the tank's own usual count is late.
  for (const t of tanks) {
    const usual = pulls.flatMap((p) => p.taunts.filter((x) => x.tankId === t.id && x.swap).map((x) => x.otherStacks));
    if (usual.length < 2) continue;
    const med = median(usual);
    for (const p of pulls) for (const x of p.taunts) if (x.tankId === t.id && x.swap && x.otherStacks >= med + LATE_BY_STACKS) x.late = true;
  }

  const firstCounts = new Map<number, number>();
  for (const p of pulls) if (p.firstTankId != null) firstCounts.set(p.firstTankId, (firstCounts.get(p.firstTankId) ?? 0) + 1);
  const order = [...tankIds].sort((a, b) => (firstCounts.get(b) ?? 0) - (firstCounts.get(a) ?? 0));

  const summary: TankSummary[] = tanks.map((t) => {
    const mineTaunts = pulls.flatMap((p) => p.taunts.filter((x) => x.tankId === t.id));
    const swapTaunts = mineTaunts.filter((x) => x.swap);
    const peaks = pulls.map((p) => Math.max(0, ...(p.stacks[t.id] ?? []).map((x) => x.stacks))).filter((x) => x > 0);
    const busters = pulls.flatMap((p) => p.busters.filter((b) => b.tankId === t.id));
    const uses = new Map<string, { kind: "personal" | "external"; n: number }>();
    for (const p of pulls) {
      for (const w of p.windows.filter((x) => x.tankId === t.id)) {
        const u = uses.get(w.name) ?? { kind: w.kind, n: 0 };
        u.n += 1;
        uses.set(w.name, u);
      }
    }
    return {
      tankId: t.id,
      firstOn: firstCounts.get(t.id) ?? 0,
      tauntsPerPull: mineTaunts.length / Math.max(1, pulls.length),
      tauntAtStacks: swapTaunts.length ? median(swapTaunts.map((s) => s.otherStacks)) : null,
      swapTaunts: swapTaunts.length,
      lateTaunts: swapTaunts.filter((x) => x.late).length,
      peakStacks: peaks.length ? median(peaks) : null,
      busterHits: busters.length,
      bustersCovered: busters.filter((b) => b.covered.length > 0).length,
      defensives: [...uses.entries()]
        .map(([name, u]) => ({ name, kind: u.kind, perPull: u.n / Math.max(1, pulls.length) }))
        .sort((a, b) => (a.kind === b.kind ? b.perPull - a.perPull : a.kind === "personal" ? -1 : 1)),
      deaths: pulls.reduce((s, p) => s + p.deaths.filter((d) => d.tankId === t.id).length, 0),
    };
  });

  return {
    tanks: tanks.map((t) => ({ ...t, spec: input.specs[t.id] ?? null })),
    swapDebuff: swapId != null ? input.names[swapId] ?? `#${swapId}` : null,
    busterNames: [...busterIds].map((id) => input.names[id] ?? `#${id}`),
    order,
    pulls,
    summary,
  };
}

// --- Note export --------------------------------------------------------------------

export interface TankNoteLine {
  id: string;
  timeSec: number;
  tag: string;
  text: string;
}

/**
 * Callout lines from one pull: the order at the pull, each taunt, and a
 * defensive call ahead of each buster. NSRT timers are whole seconds,
 * truncated, as the note format wants.
 */
export function tankNoteLines(
  report: TankReport,
  fightId: number,
  opts: { order: boolean; taunts: boolean; defensives: boolean; leadSec?: number },
): TankNoteLine[] {
  const pull = report.pulls.find((p) => p.fightId === fightId);
  if (!pull) return [];
  const nameOf = (id: number | null) => report.tanks.find((t) => t.id === id)?.name ?? "tank";
  const lines: TankNoteLine[] = [];
  if (opts.order && report.order.length >= 2) {
    lines.push({ id: "tank:order:1", timeSec: 0, tag: nameOf(report.order[0]), text: "First tank" });
    lines.push({ id: "tank:order:2", timeSec: 0, tag: nameOf(report.order[1]), text: "Second tank" });
  }
  if (opts.taunts) {
    pull.taunts
      .filter((t) => t.swap)
      .forEach((t, i) => {
        lines.push({
          id: `tank:taunt:${i}`,
          timeSec: Math.max(0, Math.floor(t.atMs / 1000)),
          tag: nameOf(t.tankId),
          text: report.swapDebuff ? `Taunt (${report.swapDebuff} ${t.otherStacks})` : "Taunt",
        });
      });
  }
  if (opts.defensives) {
    const lead = (opts.leadSec ?? 2) * 1000;
    pull.busters.forEach((b, i) => {
      lines.push({
        id: `tank:def:${i}`,
        timeSec: Math.max(0, Math.floor((b.atMs - lead) / 1000)),
        tag: nameOf(b.tankId),
        text: `Defensive (${b.name})`,
      });
    });
  }
  return lines.sort((a, b) => a.timeSec - b.timeSec);
}
