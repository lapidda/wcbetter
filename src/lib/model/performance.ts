// Raid performance with mechanics in view: damage done per player, next to
// what the boss made them do. The question it answers is the one a damage
// meter cannot — "was this player low because they were carrying a mechanic?"
//
// Pure, like raid.ts: it takes already-fetched payloads, so it runs the same in
// the route, the CLI and a test.
//
// Mechanics come from boss-applied debuffs on players, classified by *who gets
// them* rather than by name — no per-boss list:
//
//   assigned   one or two non-tank players take most of it, pull after pull
//              (measured on Mythic Sszorak: Serpent's Fury, 6 of 7 on one player)
//   targeted   a few players at a time, rotating through the raid
//              (Raging Crosswinds: 12 applications to 10 different players)
//   tank       only ever on the tanks (Ravage, Mutilated Gash)
//   raid-wide  lands on most of the raid at once — nobody's job (Viscous Cyst)
//
// A debuff sharing its name with a mechanic the raid notes call avoidable is a
// failure, not a duty, and is counted as an avoidable hit instead.
//
// Most targeted mechanics rotate through everyone about equally — on Mythic
// Sszorak every player had Virulence and Mutilated Gash 2-3 times a pull. That
// says nothing about any one player, so a player is only credited with a
// mechanic when they carried it: an assignee of an assigned one, or clearly
// more of a targeted one than the raid's median. Everyone's total time under
// mechanics stays visible as a number.

import type { TableEntry, WclEvent } from "@/lib/wcl/types";
import { median } from "./stats";
import type { RaidActor, RaidDeath } from "./raid";
import { TANK_SPECS } from "./tanks";

/** Debuffs landing this close together are one occurrence of the mechanic. */
const CLUSTER_MS = 2_000;
/** An occurrence reaching this share of the raid is raid-wide damage, not a selection. */
const RAID_WIDE_SHARE = 0.5;
/** Tank mechanics land on the tanks this reliably; busters splash onto melee now and then (Ravage: 31 of 36). */
const TANK_SHARE = 0.8;
/** One or two players taking this share of the non-tank applications is an assignment. */
const ASSIGNED_SHARE = 0.6;
/** ...and only once it has happened often enough to be a pattern. */
const MIN_ASSIGNED = 3;
/** A targeted mechanic rotates through at least this many different players. */
const MIN_TARGETED_PLAYERS = 4;
/** A debuff still running at the end of a pull is counted until then, capped here. */
const MAX_DEBUFF_MS = 60_000;
/** A player holding this share of an assigned mechanic is one of its assignees. */
const ASSIGNEE_SHARE = 0.25;
/** Carrying this multiple of the raid's median of a targeted mechanic is "more than most". */
const EXTRA_FACTOR = 1.5;

/**
 * Roles by spec. The log names each player's spec, and the tank and healer
 * specs are a short, fixed, unambiguous list. The raid notes derive tanks from
 * who eats the boss's melee instead; measured on a Mythic Sszorak night that
 * test found no tanks at all, and a Blood Death Knight's self-healing then made
 * them a "healer". The derived test stays as the fallback for unknown specs.
 */
const HEALER_SPECS = new Set(["Restoration", "Holy", "Discipline", "Mistweaver", "Preservation"]);

export type DutyKind = "assigned" | "targeted" | "tank" | "raid-wide" | "avoidable";
export type Role = "tank" | "healer" | "dps";

export interface PerfFight {
  fightId: number;
  durationMs: number;
  startTime: number;
  /** Players present on this pull. */
  present: number[];
  /** Fight-wide DamageDone table rows: one per actor, with `total` and `activeTime`. */
  damageDone: TableEntry[];
  /** Fight-wide Healing table rows. */
  healing: TableEntry[];
  /** Debuff events on friendlies, every source. */
  debuffs: WclEvent[];
  deaths: RaidDeath[];
}

export interface PerfInput {
  fights: PerfFight[];
  actors: Record<number, RaidActor>;
  tankIds: Set<number>;
  /** Debuff id -> name, from the Debuffs table. */
  debuffNames: Record<number, string>;
  /** Names of mechanics the raid analysis calls avoidable. */
  avoidableNames: Set<string>;
  /**
   * Hits from mechanics the raid analysis calls avoidable, by name, so a name
   * this module reclassifies as a tank mechanic can be left out.
   */
  avoidableHits: Array<{ name: string; fightId: number; targetId: number; count: number }>;
}

export interface Duty {
  name: string;
  kind: DutyKind;
  applications: number;
  players: number;
  /** Who carried it most, for the legend. */
  top: Array<{ id: number; count: number }>;
}

export interface PlayerPerformance {
  id: number;
  name: string;
  className: string;
  spec: string | null;
  role: Role;
  pulls: number;
  /** Median over the pulls the player was in. */
  dps: number;
  hps: number;
  activePct: number;
  /**
   * Mechanics this player carried more of than the raid: assigned ones they
   * were an assignee of, targeted ones well above the median, tank ones for tanks.
   */
  duties: Array<{ name: string; kind: DutyKind; perPull: number; share: number; vsMedian: number | null }>;
  /** Seconds per pull spent under an assigned or targeted debuff. */
  dutySecondsPerPull: number;
  deaths: number;
  avoidableHitsPerPull: number;
  /** One-line reading of DPS against mechanics; DPS players only. */
  read: { tone: "good" | "neutral" | "warn" | "bad"; text: string } | null;
}

export interface RaidPerformance {
  players: PlayerPerformance[];
  duties: Duty[];
}

// --- Debuff classification -----------------------------------------------------

interface Application {
  fightId: number;
  ability: number;
  target: number;
  atMs: number;
  durationMs: number;
}

/** Boss-applied debuffs on players, with how long each one stayed. */
export function applicationsOf(fight: PerfFight, actors: Record<number, RaidActor>): Application[] {
  const open = new Map<string, number>();
  const out: Application[] = [];
  const end = fight.startTime + fight.durationMs;
  for (const e of fight.debuffs) {
    const target = Number(e.targetID);
    const ability = Number(e.abilityGameID);
    if (!actors[target] || !ability) continue;
    // Self- and player-applied debuffs (Forbearance, Exhaustion) are not mechanics.
    if (e.sourceID != null && actors[Number(e.sourceID)]) continue;
    const key = `${ability}:${target}`;
    if (e.type === "applydebuff") open.set(key, e.timestamp);
    if (e.type === "removedebuff" && open.has(key)) {
      const at = open.get(key)!;
      open.delete(key);
      out.push({ fightId: fight.fightId, ability, target, atMs: at - fight.startTime, durationMs: Math.min(MAX_DEBUFF_MS, e.timestamp - at) });
    }
  }
  for (const [key, at] of open) {
    const [ability, target] = key.split(":").map(Number);
    out.push({ fightId: fight.fightId, ability, target, atMs: at - fight.startTime, durationMs: Math.min(MAX_DEBUFF_MS, end - at) });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

export function classifyDuty(
  apps: Application[],
  presentByFight: Record<number, number>,
  tankIds: Set<number>,
): DutyKind {
  if (apps.length === 0) return "raid-wide";
  const onTanks = apps.filter((a) => tankIds.has(a.target)).length;
  if (tankIds.size > 0 && onTanks / apps.length >= TANK_SHARE) return "tank";

  // Occurrence sizes, as a share of who was there.
  const shares: number[] = [];
  const byFight = new Map<number, Application[]>();
  for (const a of apps) (byFight.get(a.fightId) ?? byFight.set(a.fightId, []).get(a.fightId)!).push(a);
  for (const [fightId, list] of byFight) {
    let cluster: Application[] = [];
    const flush = () => {
      if (cluster.length) shares.push(new Set(cluster.map((c) => c.target)).size / Math.max(1, presentByFight[fightId] ?? 1));
      cluster = [];
    };
    for (const a of list) {
      if (cluster.length && a.atMs - cluster[0].atMs > CLUSTER_MS) flush();
      cluster.push(a);
    }
    flush();
  }
  if (median(shares) >= RAID_WIDE_SHARE) return "raid-wide";

  const nonTank = apps.filter((a) => !tankIds.has(a.target));
  const counts = new Map<number, number>();
  for (const a of nonTank) counts.set(a.target, (counts.get(a.target) ?? 0) + 1);
  const ranked = [...counts.values()].sort((a, b) => b - a);
  const topTwo = (ranked[0] ?? 0) + (ranked[1] ?? 0);
  if (nonTank.length >= MIN_ASSIGNED && topTwo / nonTank.length >= ASSIGNED_SHARE) return "assigned";
  if (counts.size >= MIN_TARGETED_PLAYERS) return "targeted";
  return "raid-wide";
}

// --- Per player ----------------------------------------------------------------

const rowsById = (rows: TableEntry[]) => new Map(rows.map((r) => [Number(r.id), r]));

export function buildRaidPerformance(input: PerfInput): RaidPerformance {
  const { fights, actors } = input;
  const presentByFight = Object.fromEntries(fights.map((f) => [f.fightId, f.present.length]));

  const specOf = new Map<number, string>();
  for (const f of fights) {
    for (const row of f.damageDone) {
      const icon = typeof row.icon === "string" ? row.icon : "";
      const spec = icon.split("-")[1];
      if (spec && !specOf.has(Number(row.id))) specOf.set(Number(row.id), spec);
    }
  }
  const tankIds = new Set(
    Object.values(actors)
      .map((a) => a.id)
      .filter((id) => (specOf.has(id) ? TANK_SPECS.has(specOf.get(id)!) : input.tankIds.has(id))),
  );

  const apps = fights.flatMap((f) => applicationsOf(f, actors));
  const byAbility = new Map<number, Application[]>();
  for (const a of apps) (byAbility.get(a.ability) ?? byAbility.set(a.ability, []).get(a.ability)!).push(a);

  // Variants of one mechanic often log under several ids with one name
  // (four Raging Crosswinds on Mythic Sszorak): classify and count by name.
  const byName = new Map<string, Application[]>();
  for (const [ability, list] of byAbility) {
    const name = input.debuffNames[ability] ?? `#${ability}`;
    byName.set(name, [...(byName.get(name) ?? []), ...list]);
  }

  const duties: Duty[] = [];
  const kindOf = new Map<string, DutyKind>();
  for (const [name, list] of byName) {
    // Tank first: a tank buster is the tanks' job even if the notes, with no
    // tanks detected, filed it under avoidable.
    const classified = classifyDuty(list, presentByFight, tankIds);
    const kind: DutyKind = classified !== "tank" && input.avoidableNames.has(name) ? "avoidable" : classified;
    kindOf.set(name, kind);
    const counts = new Map<number, number>();
    for (const a of list) counts.set(a.target, (counts.get(a.target) ?? 0) + 1);
    duties.push({
      name,
      kind,
      applications: list.length,
      players: counts.size,
      top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, count]) => ({ id, count })),
    });
  }
  const order: Record<DutyKind, number> = { assigned: 0, targeted: 1, tank: 2, avoidable: 3, "raid-wide": 4 };
  duties.sort((a, b) => order[a.kind] - order[b.kind] || b.applications - a.applications);

  // Applications per pull of each mechanic for every player who was there:
  // the baseline a player's share is compared against.
  const ratesByName = new Map<string, Map<number, number>>();
  for (const [name, list] of byName) {
    const counts = new Map<number, number>();
    for (const a of list) counts.set(a.target, (counts.get(a.target) ?? 0) + 1);
    const rates = new Map<number, number>();
    for (const actor of Object.values(actors)) {
      const pulls = fights.filter((f) => f.present.includes(actor.id)).length;
      if (pulls > 0) rates.set(actor.id, (counts.get(actor.id) ?? 0) / pulls);
    }
    ratesByName.set(name, rates);
  }
  const totals = new Map([...byName.entries()].map(([n, l]) => [n, l.length]));

  const players: PlayerPerformance[] = [];
  for (const actor of Object.values(actors)) {
    const inFights = fights.filter((f) => f.present.includes(actor.id) || rowsById(f.damageDone).has(actor.id));
    if (inFights.length === 0) continue;

    const dps: number[] = [];
    const hps: number[] = [];
    const active: number[] = [];
    const activeHealing: number[] = [];
    let spec: string | null = null;
    let damage = 0;
    let healing = 0;
    for (const f of inFights) {
      const d = rowsById(f.damageDone).get(actor.id);
      const h = rowsById(f.healing).get(actor.id);
      const secs = f.durationMs / 1000;
      dps.push(Number(d?.total ?? 0) / secs);
      hps.push(Number(h?.total ?? 0) / secs);
      active.push(f.durationMs > 0 ? (Number(d?.activeTime ?? 0) / f.durationMs) * 100 : 0);
      activeHealing.push(f.durationMs > 0 ? (Number(h?.activeTime ?? 0) / f.durationMs) * 100 : 0);
      damage += Number(d?.total ?? 0);
      healing += Number(h?.total ?? 0);
      const icon = typeof d?.icon === "string" ? d.icon : "";
      spec ??= icon.split("-")[1] ?? null;
    }
    if (damage === 0 && healing === 0) continue;

    const mine = apps.filter((a) => a.target === actor.id);
    const perName = new Map<string, number>();
    let dutyMs = 0;
    for (const a of mine) {
      const name = input.debuffNames[a.ability] ?? `#${a.ability}`;
      const kind = kindOf.get(name);
      if (kind !== "assigned" && kind !== "targeted" && kind !== "tank") continue;
      perName.set(name, (perName.get(name) ?? 0) + 1);
      if (kind !== "tank") dutyMs += a.durationMs;
    }
    const isTank = tankIds.has(actor.id);
    const carried: PlayerPerformance["duties"] = [];
    for (const [name, n] of perName) {
      const kind = kindOf.get(name)!;
      const share = n / (totals.get(name) ?? n);
      const perPull = n / inFights.length;
      // The baseline is the player's peers: tanks against tanks, everyone else against everyone else.
      const peers = [...(ratesByName.get(name)?.entries() ?? [])].filter(([id]) => tankIds.has(id) === isTank).map(([, r]) => r);
      const med = peers.length ? median(peers) : 0;
      const vsMedian = med > 0 ? perPull / med : null;
      const credited =
        (kind === "tank" && isTank) ||
        (kind === "assigned" && share >= ASSIGNEE_SHARE) ||
        (kind === "targeted" && perPull >= 1 && (med === 0 || perPull >= med * EXTRA_FACTOR));
      if (credited) carried.push({ name, kind, perPull, share, vsMedian });
    }

    const fightIds = new Set(inFights.map((f) => f.fightId));
    const avoidable = input.avoidableHits
      .filter((h) => h.targetId === actor.id && fightIds.has(h.fightId) && kindOf.get(h.name) !== "tank")
      .reduce((s, h) => s + h.count, 0);

    const role: Role = isTank
      ? "tank"
      : spec && specOf.has(actor.id)
        ? HEALER_SPECS.has(spec)
          ? "healer"
          : "dps"
        : healing > damage
          ? "healer"
          : "dps";

    players.push({
      id: actor.id,
      name: actor.name,
      className: actor.className,
      spec,
      role,
      pulls: inFights.length,
      dps: median(dps),
      hps: median(hps),
      // A healer's activity is their healing, not their damage casts.
      activePct: role === "healer" ? median(activeHealing) : median(active),
      duties: carried.sort((a, b) => order[a.kind] - order[b.kind] || b.perPull - a.perPull),
      dutySecondsPerPull: dutyMs / 1000 / inFights.length,
      deaths: fights.reduce((s, f) => s + f.deaths.filter((d) => d.targetId === actor.id).length, 0),
      avoidableHitsPerPull: avoidable / inFights.length,
      read: null,
    });
  }

  annotate(players);

  const roleOrder: Record<Role, number> = { dps: 0, tank: 1, healer: 2 };
  players.sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || (a.role === "healer" ? b.hps - a.hps : b.dps - a.dps));
  return { players, duties };
}

/**
 * The one-line reading for each DPS player: low or fine against the other
 * DPS, and whether mechanics explain it. Deliberately coarse — spec and gear
 * move DPS too, and this cannot see either.
 */
function annotate(players: PlayerPerformance[]) {
  const dps = players.filter((p) => p.role === "dps");
  if (dps.length < 3) return;
  const medDps = median(dps.map((p) => p.dps));
  const medDuty = median(dps.map((p) => p.dutySecondsPerPull));
  for (const p of dps) {
    const low = p.dps < medDps * 0.85;
    const assigned = p.duties.some((d) => d.kind === "assigned");
    const heavy = assigned || p.dutySecondsPerPull > Math.max(5, medDuty * 1.4);
    const dead = p.deaths > 0 && p.deaths >= p.pulls;
    if (low && heavy) {
      p.read = { tone: "neutral", text: assigned ? "low DPS — carried an assigned mechanic" : "low DPS — carried more mechanics than most" };
    } else if (low && dead) {
      p.read = { tone: "warn", text: "low DPS — died on most pulls" };
    } else if (low) {
      p.read = { tone: "bad", text: "low DPS — no extra mechanic load to explain it" };
    } else if (heavy) {
      p.read = { tone: "good", text: assigned ? "carried an assigned mechanic, DPS still fine" : "extra mechanics, DPS still fine" };
    }
  }
}
