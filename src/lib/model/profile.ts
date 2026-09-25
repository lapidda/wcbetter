import { getDamageGraph, getEvents, getTable, getTalentsByActor } from "@/lib/wcl/fetchers";
import { burnStart } from "./burn";
import type { Actor, Fight, TableEntry } from "@/lib/wcl/types";
import type { AbilityStat, BuffStat, CastGap, DamageTakenStat, DeathInfo, PlayerProfile } from "./types";

/** A single GCD. Anything longer than this between casts is downtime worth looking at. */
export const GCD_MS = 1500;

/**
 * A cast this soon after the death timestamp is one that was already in flight,
 * not a resurrection. Anything later means the player was brought back.
 */
const REZ_GRACE_MS = 2000;

/**
 * WCL table payloads nest abilities under an actor entry for most dataTypes,
 * but not all, and the shape has moved between API revisions. Rather than
 * assert one layout, accept either and flatten.
 */
function abilityRows(payload: { entries?: TableEntry[] }, actorId?: number): TableEntry[] {
  const entries = payload.entries ?? [];
  if (entries.length === 0) return [];

  const hasNestedAbilities = entries.some((e) => Array.isArray(e.abilities));
  if (!hasNestedAbilities) return entries;

  const relevant =
    actorId != null && entries.some((e) => e.id === actorId)
      ? entries.filter((e) => e.id === actorId)
      : entries;

  return relevant.flatMap((e) => e.abilities ?? []);
}

function actorRow(payload: { entries?: TableEntry[] }, actorId: number): TableEntry | undefined {
  return (payload.entries ?? []).find((e) => e.id === actorId);
}

function idOf(row: TableEntry): number {
  return Number(row.guid ?? row.id ?? 0);
}

/** Casts rows call it abilityIcon, damage rows icon; either is a bare file name. */
function iconOf(row: TableEntry): string | null {
  if (typeof row.abilityIcon === "string") return row.abilityIcon;
  if (typeof row.icon === "string") return row.icon;
  return null;
}

function castCountOf(row: TableEntry): number {
  return Number(row.uses ?? row.total ?? row.hitCount ?? 0) || 0;
}

/**
 * Spec is not in masterData. It lives on the actor row of a fight-wide damage
 * table, where `type` is the class and `icon` is "Class-Spec". We need it before
 * we can ask for rankings, which is why the subject profile is built first.
 */
function detectClassSpec(row: TableEntry | undefined): { className: string | null; specName: string | null } {
  if (!row) return { className: null, specName: null };

  const icon = typeof row.icon === "string" ? row.icon : "";
  const [iconClass, iconSpec] = icon.split("-");
  const type = typeof row.type === "string" && row.type !== "Player" ? row.type : null;

  return {
    className: type ?? iconClass ?? null,
    specName: iconSpec ?? null,
  };
}

export interface BuildProfileArgs {
  key: string;
  reportCode: string;
  fight: Fight;
  actor: Pick<Actor, "id" | "name" | "subType" | "type">;
  className?: string | null;
  specName?: string | null;
  /** Cast events cost an extra query per player; skip for cheap passes. */
  withTimeline?: boolean;
  /** The raid damage graph, for the burn window. One query per fight, shared across players. */
  withBurndown?: boolean;
  /**
   * Pre-supplied talent ids. Reference parses get theirs free with the rankings
   * row, and the subject's only need fetching once for the session, so passing
   * them in avoids a CombatantInfo query per profile.
   */
  talents?: number[];
}

export async function buildPlayerProfile(args: BuildProfileArgs): Promise<PlayerProfile> {
  const { key, reportCode, fight, actor, withTimeline = true } = args;
  const fightId = fight.id;
  const durationMs = fight.endTime - fight.startTime;
  const minutes = durationMs / 60_000;

  const [damageDone, damageDoneWide, casts, damageTakenTable, buffs, deathsTable, talentsByActor, damageGraph] =
    await Promise.all([
      getTable(reportCode, fightId, "DamageDone", actor.id),
      // The fight-wide fetches below are shared by every player we profile in
      // this report, so the cache dedupes them across the whole run.
      getTable(reportCode, fightId, "DamageDone"),
      getTable(reportCode, fightId, "Casts", actor.id),
      getTable(reportCode, fightId, "DamageTaken"),
      getTable(reportCode, fightId, "Buffs", actor.id),
      getTable(reportCode, fightId, "Deaths"),
      args.talents ? Promise.resolve(null) : getTalentsByActor(reportCode, fightId),
      args.withBurndown === false
        ? Promise.resolve(null)
        : getDamageGraph(reportCode, fightId, { start: fight.startTime, end: fight.endTime }),
    ]);

  // --- Damage and active time ------------------------------------------------
  // Filtering DamageDone by sourceID returns ability rows with no actor row at
  // all, so totals, active time and spec have to come from the fight-wide table,
  // where each entry *is* an actor.
  const selfRow = actorRow(damageDoneWide, actor.id);
  const damageRows = abilityRows(damageDone, actor.id);
  const totalDamage =
    Number(selfRow?.total ?? 0) || damageRows.reduce((sum, r) => sum + Number(r.total ?? 0), 0);

  // WCL reports activeTime in ms; it is the canonical not-standing-around number.
  // Never fall back to totalTime — that is the fight length, which would silently
  // report 100% uptime for everyone.
  const activeTimeMs = Number(selfRow?.activeTime ?? 0);

  const damageByAbility = new Map<number, { name: string; damage: number; icon: string | null }>();
  for (const row of damageRows) {
    const gameID = idOf(row);
    if (!gameID) continue;
    const damage = Number(row.total ?? 0);
    const existing = damageByAbility.get(gameID);
    if (existing) existing.damage += damage;
    else damageByAbility.set(gameID, { name: String(row.name ?? gameID), damage, icon: iconOf(row) });
  }

  // --- Casts -----------------------------------------------------------------
  const abilities: Record<number, AbilityStat> = {};
  for (const row of abilityRows(casts, actor.id)) {
    const gameID = idOf(row);
    if (!gameID) continue;
    const count = castCountOf(row);
    const damage = damageByAbility.get(gameID)?.damage ?? 0;
    abilities[gameID] = {
      gameID,
      name: String(row.name ?? damageByAbility.get(gameID)?.name ?? gameID),
      icon: iconOf(row) ?? damageByAbility.get(gameID)?.icon ?? null,
      casts: count,
      castsPerMinute: minutes > 0 ? count / minutes : 0,
      damage,
      damagePerCast: count > 0 ? damage / count : 0,
      interCastGaps: [],
    };
  }

  // Damaging abilities with no cast row (procs, passives, DoT ticks) still matter
  // for value-per-cast attribution, so fold them in with zero casts.
  for (const [gameID, info] of damageByAbility) {
    if (abilities[gameID]) continue;
    abilities[gameID] = {
      gameID,
      name: info.name,
      icon: info.icon,
      casts: 0,
      castsPerMinute: 0,
      damage: info.damage,
      damagePerCast: 0,
      interCastGaps: [],
    };
  }

  // --- Damage taken ----------------------------------------------------------
  // These rows carry totals only — no hit counts — so everything downstream is
  // expressed in damage rather than number of hits.
  const takenRows = abilityRows(damageTakenTable, actor.id);
  const totalTaken = takenRows.reduce((sum, r) => sum + Number(r.total ?? 0), 0);

  const damageTaken: Record<number, DamageTakenStat> = {};
  for (const row of takenRows) {
    const gameID = idOf(row);
    if (!gameID) continue;
    const total = Number(row.total ?? 0);
    damageTaken[gameID] = {
      gameID,
      name: String(row.name ?? gameID),
      total,
      damagePerMinute: minutes > 0 ? total / minutes : 0,
      shareOfDamageTaken: totalTaken > 0 ? total / totalTaken : 0,
    };
  }

  // --- Buff uptime -----------------------------------------------------------
  // The Buffs table returns `auras`, not `entries`, unlike every other dataType.
  const auraRows = ((buffs as { auras?: TableEntry[] }).auras ?? buffs.entries ?? []) as TableEntry[];

  const buffStats: Record<number, BuffStat> = {};
  for (const row of auraRows) {
    const gameID = idOf(row);
    if (!gameID) continue;
    const uptimeMs = Number(row.totalUptime ?? row.uptime ?? 0) || 0;
    buffStats[gameID] = {
      gameID,
      name: String(row.name ?? gameID),
      uptimeMs,
      uptimePct: durationMs > 0 ? (uptimeMs / durationMs) * 100 : 0,
    };
  }

  // --- Deaths ----------------------------------------------------------------
  const deaths: DeathInfo[] = [];
  for (const row of deathsTable.entries ?? []) {
    if (row.id !== actor.id) continue;
    const deathTime = Number(row.timestamp ?? row.deathTime ?? 0);
    const rewindEvents = (row.events as Array<Record<string, unknown>> | undefined) ?? [];
    deaths.push({
      timestampMs: deathTime,
      atMs: deathTime - fight.startTime,
      // The field is `killingBlow`, and it is the ability object itself.
      killingAbility: (row.killingBlow as { name?: string } | undefined)?.name ?? null,
      // Filled in below, once the cast timeline is available to spot a rez.
      deadMs: 0,
      rezzed: false,
      rewind: rewindEvents
        .filter((e) => e.type === "damage" && Number(e.amount ?? 0) > 0)
        .slice(-8)
        .map((e) => ({
          atMs: Number(e.timestamp ?? 0) - fight.startTime,
          ability: String((e.ability as { name?: string } | undefined)?.name ?? "Unknown"),
          amount: Number(e.amount ?? 0),
        })),
    });
  }

  // --- Cast timeline and downtime gaps --------------------------------------
  let castTimeline: PlayerProfile["castTimeline"] = [];
  let gaps: CastGap[] = [];

  if (withTimeline) {
    const events = await getEvents(
      reportCode,
      fightId,
      "Casts",
      { start: fight.startTime, end: fight.endTime },
      { sourceID: actor.id },
    );

    castTimeline = events
      .filter((e) => e.type === "cast" && e.abilityGameID != null)
      .map((e) => ({ atMs: e.timestamp - fight.startTime, gameID: e.abilityGameID as number }))
      .sort((a, b) => a.atMs - b.atMs);

    // Per-ability gaps feed the empirical cooldown estimate.
    const byAbility = new Map<number, number[]>();
    for (const cast of castTimeline) {
      const list = byAbility.get(cast.gameID);
      if (list) list.push(cast.atMs);
      else byAbility.set(cast.gameID, [cast.atMs]);
    }
    for (const [gameID, times] of byAbility) {
      const stat = abilities[gameID];
      if (!stat) continue;
      for (let i = 1; i < times.length; i++) stat.interCastGaps.push(times[i] - times[i - 1]);
      stat.interCastGaps.sort((a, b) => a - b);
    }

    gaps = findGaps(castTimeline, durationMs, deaths);
  }

  // How long each death actually cost. A cast afterwards means a battle rez
  // brought the player back; without one, the death ran to the end of the pull.
  // Measuring the rez is what makes the DPS estimate defensible — "the rest of
  // the fight" overstates most deaths on a night where rezzes get used.
  for (const death of deaths) {
    const back = castTimeline.find((c) => c.atMs > death.atMs + REZ_GRACE_MS);
    death.rezzed = back != null;
    death.deadMs = Math.max(0, (back?.atMs ?? durationMs) - death.atMs);
  }

  const detected = detectClassSpec(selfRow);

  return {
    key,
    name: actor.name,
    actorId: actor.id,
    className: args.className ?? detected.className ?? actor.subType ?? null,
    specName: args.specName ?? detected.specName ?? null,
    reportCode,
    fightId,
    durationMs,
    itemLevel: Number(selfRow?.itemLevel) || null,
    burnStartMs: burnStart(damageGraph, fight),
    totalDamage,
    dps: durationMs > 0 ? totalDamage / (durationMs / 1000) : 0,
    activeTimeMs,
    activeTimePct: durationMs > 0 ? (activeTimeMs / durationMs) * 100 : 0,
    abilities,
    damageTaken,
    buffs: buffStats,
    deaths,
    talents: args.talents ?? talentsByActor?.[actor.id] ?? [],
    gaps,
    castTimeline,
  };
}

/**
 * Downtime windows: stretches longer than one GCD with no cast. Gaps spanning a
 * death are excluded, because being dead is already its own finding and counting
 * it here would charge the player twice for one mistake.
 */
export function findGaps(
  timeline: Array<{ atMs: number }>,
  durationMs: number,
  deaths: DeathInfo[],
): CastGap[] {
  const gaps: CastGap[] = [];
  const deathTimes = deaths.map((d) => d.atMs);

  const push = (startMs: number, endMs: number) => {
    const gapMs = endMs - startMs;
    if (gapMs <= GCD_MS) return;
    if (deathTimes.some((t) => t >= startMs - 1000 && t <= endMs + 1000)) return;
    gaps.push({ startMs, endMs, durationMs: gapMs });
  };

  if (timeline.length === 0) return gaps;

  // Opener delay counts: pulling in late is real lost time.
  push(0, timeline[0].atMs);
  for (let i = 1; i < timeline.length; i++) push(timeline[i - 1].atMs, timeline[i].atMs);
  push(timeline[timeline.length - 1].atMs, durationMs);

  return gaps.sort((a, b) => b.durationMs - a.durationMs);
}
