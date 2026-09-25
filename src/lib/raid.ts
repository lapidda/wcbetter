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
import type { RaidPayload, RaidReportMeta } from "./model/raid-payload";
import { buildEncounterContext } from "./raid-context";
import { getDamageTakenEvents, getReportMeta, getTable } from "./wcl/fetchers";
import { difficultyName, type WclEvent } from "./wcl/types";

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

  await Promise.all(
    fights.map(async (fight) => {
      const window = { start: fight.startTime, end: fight.endTime };
      const [events, damageTaken, deaths] = await Promise.all([
        getDamageTakenEvents(args.code, fight.id, window),
        // Already on disk whenever this report has been analysed for a player:
        // profile.ts fetches both fight-wide, without a sourceID filter.
        getTable(args.code, fight.id, "DamageTaken"),
        getTable(args.code, fight.id, "Deaths"),
      ]);
      hitsByFight[fight.id] = events;
      deathsByFight[fight.id] = raidDeaths(deaths, fight);
      Object.assign(damageNames, damageAbilityNames(damageTaken));
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
  };
}
