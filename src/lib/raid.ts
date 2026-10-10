import { findNotableMechanics, type NotableMechanic } from "./model/notable";
import {
  analyzeRaid,
  buildActorIndex,
  damageAbilityNames,
  enemySourced,
  raidDeaths,
  type RaidAnalysis,
  type RaidDeath,
} from "./model/raid";
import { buildRaidPerformance, type PerfFight, type RaidPerformance } from "./model/performance";
import { buildTankReport, TANK_SPECS, type TankFight, type TankReport } from "./model/tanks";
import type { RaidPayload, RaidReportMeta } from "./model/raid-payload";
import { buildEncounterContext } from "./raid-context";
import { getDamageTakenEvents, getEvents, getReportMeta, getTable } from "./wcl/fetchers";
import { difficultyName, type TableEntry, type WclEvent } from "./wcl/types";

/**
 * The raid-wide pass: which mechanics people actually fail, across every pull.
 *
 * Deliberately separate from `analyzeEncounter`. This needs no subject player,
 * no rankings and no reference parses — so it costs about a third as much — and
 * overloading the DPS entry point would mean a nullable `actorId` and a union
 * return type infecting every consumer of `AnalysisReport`.
 *
 * On a cache already warmed by a DPS analysis of the same pulls, the only new
 * requests are the damage-taken events: the fight-wide DamageTaken and Deaths
 * tables were fetched without a `sourceID` filter and so already hold the whole raid.
 */
export interface RaidArgs {
  code: string;
  fightIds: number[];
  onProgress?: (message: string) => void;
}

export type { RaidPayload, RaidReportMeta } from "./model/raid-payload";
export { rosterFromPayload } from "./model/raid-payload";

export type RaidReport = RaidReportMeta &
  RaidAnalysis & {
    /** Mechanics ranked by how much they are costing the raid, note-worthy first. */
    notable: NotableMechanic[];
    /** Every hit the raid took across the pulls, the denominator for the share test. */
    totalRaidDamageTaken: number;
    /** Damage per player next to the mechanics they carried. */
    performance: RaidPerformance;
    /** Taunts, swaps, defensives and busters for the tanks; null when no tank was found. */
    tanks: TankReport | null;
  };

export function toRaidPayload(report: RaidReport): RaidPayload {
  return {
    report: report.report,
    encounter: report.encounter,
    pulls: report.pulls,
    warnings: report.warnings,
    roster: { actors: report.roster.actors, tankIds: [...report.roster.tankIds] },
    notable: report.notable,
    stats: report.stats,
    totalRaidDamageTaken: report.totalRaidDamageTaken,
    performance: report.performance,
    tanks: report.tanks,
  };
}

export async function analyzeRaidEncounter(args: RaidArgs): Promise<RaidReport> {
  const progress = args.onProgress ?? (() => {});
  if (args.fightIds.length === 0) throw new Error("Select at least one pull to analyse.");

  progress("Loading report...");
  const meta = await getReportMeta(args.code);

  const fights = args.fightIds
    .map((id) => {
      const fight = meta.fights.find((f) => f.id === id);
      if (!fight) throw new Error(`Fight ${id} is not in report ${args.code}.`);
      return fight;
    })
    .sort((a, b) => a.startTime - b.startTime);

  const encounterID = fights[0].encounterID;
  const difficulty = fights[0].difficulty;
  if (fights.some((f) => f.encounterID !== encounterID || f.difficulty !== difficulty)) {
    throw new Error("All selected pulls must be the same boss at the same difficulty.");
  }

  const encounter = await buildEncounterContext(args.code, fights, progress);
  const warnings = [...encounter.warnings];
  if (!encounter.context) {
    throw new Error(
      "The boss-ability timeline is unavailable, and without it there is nothing to write a note about.",
    );
  }

  progress(`Fetching damage taken across ${fights.length} pulls...`);
  const hitsByFight: Record<number, WclEvent[]> = {};
  const deathsByFight: Record<number, RaidDeath[]> = {};
  const damageNames: Record<number, string> = {};
  const perfFights: PerfFight[] = [];
  const debuffNames: Record<number, string> = {};

  await Promise.all(
    fights.map(async (fight) => {
      const window = { start: fight.startTime, end: fight.endTime };
      const [events, damageTaken, deaths, damageDone, healing, debuffTable, debuffs] = await Promise.all([
        getDamageTakenEvents(args.code, fight.id, window),
        // Already on disk whenever this report has been analysed for a player:
        // profile.ts fetches these fight-wide, without a sourceID filter.
        getTable(args.code, fight.id, "DamageTaken"),
        getTable(args.code, fight.id, "Deaths"),
        getTable(args.code, fight.id, "DamageDone"),
        // The performance view's own cost: who healed, and who the boss put a
        // debuff on — one table and one event stream per pull.
        getTable(args.code, fight.id, "Healing"),
        getTable(args.code, fight.id, "Debuffs", undefined, "Friendlies"),
        getEvents(args.code, fight.id, "Debuffs", window, { hostilityType: "Friendlies" }),
      ]);
      hitsByFight[fight.id] = events;
      deathsByFight[fight.id] = raidDeaths(deaths, fight);
      Object.assign(damageNames, damageAbilityNames(damageTaken));
      const auras = ((debuffTable as { auras?: TableEntry[] }).auras ?? []) as TableEntry[];
      for (const a of auras) if (a.guid != null) debuffNames[Number(a.guid)] = String(a.name);
      perfFights.push({
        fightId: fight.id,
        durationMs: fight.endTime - fight.startTime,
        startTime: fight.startTime,
        present: fight.friendlyPlayers ?? [],
        damageDone: damageDone.entries ?? [],
        healing: healing.entries ?? [],
        debuffs,
        deaths: deathsByFight[fight.id],
      });
    }),
  );

  const analysis = analyzeRaid({
    fights,
    actors: meta.masterData.actors,
    context: encounter.context,
    hitsByFight,
    deathsByFight,
    damageAbilityNames: damageNames,
  });

  // Every hit the boss landed, not just the mapped ones: a mechanic's share has
  // to be measured against all the damage the raid took, or the shares would not
  // sum sensibly. Self-inflicted damage is excluded here for the same reason it
  // is excluded from attribution — it would inflate the denominator and quietly
  // shrink every mechanic's share.
  const players = buildActorIndex(meta.masterData.actors);
  const totalRaidDamageTaken = fights
    .flatMap((f) => enemySourced(hitsByFight[f.id] ?? [], players))
    .reduce((n, e) => n + (Number(e.amount) || 0) + (Number(e.absorbed) || 0), 0);

  const notable = findNotableMechanics(analysis.series, analysis.roster, {
    totalRaidDamageTaken,
    pulls: fights.map((f) => ({ fightId: f.id, durationMs: f.endTime - f.startTime })),
  });

  // Avoidable hits per player per pull, from the mechanics the notes call avoidable.
  const avoidable = new Set(notable.filter((m) => m.classification === "avoidable").map((m) => m.name));
  const avoidableHits: Array<{ name: string; fightId: number; targetId: number; count: number }> = [];
  for (const series of analysis.series) {
    if (!avoidable.has(series.name)) continue;
    for (const o of series.occurrences) {
      for (const h of o.hits) avoidableHits.push({ name: series.name, fightId: o.fightId, targetId: h.targetId, count: h.count });
    }
  }
  const performance = buildRaidPerformance({
    fights: perfFights.sort((a, b) => a.startTime - b.startTime),
    actors: players,
    tankIds: analysis.roster.tankIds,
    debuffNames,
    avoidableNames: avoidable,
    avoidableHits,
  });

  // --- Tanks ----------------------------------------------------------------------
  // Tanks by spec, as in the performance view; the derived test is the fallback.
  const specOf: Record<number, string | null> = {};
  for (const f of perfFights) {
    for (const row of f.damageDone) {
      const spec = typeof row.icon === "string" ? row.icon.split("-")[1] ?? null : null;
      if (spec && specOf[Number(row.id)] == null) specOf[Number(row.id)] = spec;
    }
  }
  const tankActors = Object.values(players).filter((a) =>
    specOf[a.id] != null ? TANK_SPECS.has(specOf[a.id]!) : analysis.roster.tankIds.has(a.id),
  );
  let tanks: TankReport | null = null;
  if (tankActors.length > 0) {
    progress(`Reading taunts and defensives for ${tankActors.map((t) => t.name).join(" and ")}...`);
    const abilityNames: Record<number, string> = { ...damageNames, ...debuffNames };
    const tankFights: TankFight[] = await Promise.all(
      fights.map(async (fight, i) => {
        const window = { start: fight.startTime, end: fight.endTime };
        const casts: TankFight["casts"] = {};
        const buffs: TankFight["buffs"] = {};
        await Promise.all(
          tankActors.map(async (tank) => {
            const [castTable, castEvents, buffTable] = await Promise.all([
              // Cast table and buffs are what profile.ts fetches per player — often cached.
              getTable(args.code, fight.id, "Casts", tank.id),
              getEvents(args.code, fight.id, "Casts", window, { sourceID: tank.id }),
              getTable(args.code, fight.id, "Buffs", tank.id),
            ]);
            for (const e of castTable.entries ?? []) {
              for (const a of (Array.isArray(e.abilities) ? e.abilities : [e]) as TableEntry[]) {
                const id = Number(a.guid ?? a.id ?? 0);
                if (id && a.name) abilityNames[id] = String(a.name);
              }
            }
            casts[tank.id] = castEvents;
            const auras = ((buffTable as { auras?: TableEntry[] }).auras ?? []) as TableEntry[];
            buffs[tank.id] = auras.map((a) => ({
              name: String(a.name),
              bands: (Array.isArray(a.bands) ? a.bands : []) as Array<{ startTime: number; endTime: number }>,
            }));
          }),
        );
        return {
          fightId: fight.id,
          label: `Pull ${i + 1}${fight.kill ? " (kill)" : ""}`,
          kill: fight.kill === true,
          startTime: fight.startTime,
          durationMs: fight.endTime - fight.startTime,
          debuffs: perfFights.find((p) => p.fightId === fight.id)?.debuffs ?? [],
          hits: enemySourced(hitsByFight[fight.id] ?? [], players),
          casts,
          buffs,
          bossCasts: (encounter.context!.castsByFight[fight.id] ?? []).map((c) => ({
            atMs: c.atMs,
            name: encounter.context!.abilities[c.gameID]?.name ?? `#${c.gameID}`,
            targetId: c.targetId,
          })),
          deaths: (deathsByFight[fight.id] ?? []).map((d) => ({ targetId: d.targetId, atMs: d.atMs, ability: d.killingAbility })),
        };
      }),
    );
    tanks = buildTankReport({ fights: tankFights, tanks: tankActors, names: abilityNames, specs: specOf });
  }

  return {
    report: { code: meta.code, title: meta.title },
    encounter: {
      id: encounterID,
      name: fights[0].name,
      difficulty: difficultyName(difficulty),
    },
    pulls: fights.map((f, i) => ({
      fightId: f.id,
      label: `Pull ${i + 1}${f.kill ? " (kill)" : ""}`,
      durationMs: f.endTime - f.startTime,
      kill: f.kill === true,
    })),
    warnings,
    ...analysis,
    notable,
    totalRaidDamageTaken,
    performance,
    tanks,
  };
}
