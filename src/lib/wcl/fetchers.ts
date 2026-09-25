import { query } from "./client";
import {
  CHARACTER_RANKINGS,
  COMBATANT_INFO,
  REPORT_EVENTS,
  REPORT_GRAPH,
  REPORT_META,
  REPORT_TABLE,
} from "./queries";
import type { ReportMeta, TableEntry, WclEvent } from "./types";

export interface ReportInput {
  code: string;
  /** From `fight=`; WCL also accepts the literal `last`. */
  fightId?: number | "last";
  /** From `source=` — WCL's report-local actor id, which is exactly what the pickers key on. */
  sourceId?: number;
}

/**
 * Accepts a full warcraftlogs URL or a bare report code. A URL straight out of
 * the address bar carries `fight=` and `source=`, which between them identify
 * the boss and the player — so the pickers can be skipped entirely.
 */
export function parseReportInput(input: string): ReportInput {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/warcraftlogs\.com\/reports\/([a-zA-Z0-9]+)/);
  const code = urlMatch ? urlMatch[1] : trimmed;

  if (!/^[a-zA-Z0-9]{10,}$/.test(code)) {
    throw new Error(`"${input}" is not a WarcraftLogs report URL or code.`);
  }

  const fightMatch = trimmed.match(/[?&#]fight=(\d+|last)\b/);
  const sourceMatch = trimmed.match(/[?&#]source=(\d+)\b/);

  return {
    code,
    fightId: fightMatch ? (fightMatch[1] === "last" ? "last" : Number(fightMatch[1])) : undefined,
    sourceId: sourceMatch ? Number(sourceMatch[1]) : undefined,
  };
}

export async function getReportMeta(code: string): Promise<ReportMeta> {
  const data = await query<{ reportData: { report: ReportMeta | null } }>(
    `meta:${code}`,
    REPORT_META,
    { code },
  );
  const report = data.reportData.report;
  if (!report) throw new Error(`Report ${code} not found, or it is private.`);
  return report;
}

export type TableDataType =
  | "DamageDone"
  | "DamageTaken"
  | "Healing"
  | "Casts"
  | "Buffs"
  | "Debuffs"
  | "Deaths"
  | "Resources"
  | "Summary";

export interface TablePayload {
  entries?: TableEntry[];
  totalTime?: number;
  [key: string]: unknown;
}

export async function getTable(
  code: string,
  fightId: number,
  dataType: TableDataType,
  sourceID?: number,
  hostilityType?: "Friendlies" | "Enemies",
): Promise<TablePayload> {
  const key = `table:${code}:${fightId}:${dataType}:${sourceID ?? "all"}:${hostilityType ?? "-"}`;
  const data = await query<{ reportData: { report: { table: unknown } } }>(key, REPORT_TABLE, {
    code,
    fightIDs: [fightId],
    dataType,
    sourceID: sourceID ?? null,
    hostilityType: hostilityType ?? null,
  });

  const table = data.reportData.report.table as { data?: unknown } | null;
  // The `table` scalar wraps the payload in `data` for most dataTypes.
  const payload = (table && "data" in table ? table.data : table) ?? {};
  return payload as TablePayload;
}

/**
 * One table spanning several fights. Used for the enemy-side cast dictionary:
 * every boss ability seen across the selected pulls, named, in a single query.
 */
export async function getTableForFights(
  code: string,
  fightIds: number[],
  dataType: TableDataType,
  hostilityType?: "Friendlies" | "Enemies",
): Promise<TablePayload> {
  const key = `table:${code}:${fightIds.join("+")}:${dataType}:all:${hostilityType ?? "-"}`;
  const data = await query<{ reportData: { report: { table: unknown } } }>(key, REPORT_TABLE, {
    code,
    fightIDs: fightIds,
    dataType,
    sourceID: null,
    hostilityType: hostilityType ?? null,
  });

  const table = data.reportData.report.table as { data?: unknown } | null;
  const payload = (table && "data" in table ? table.data : table) ?? {};
  return payload as TablePayload;
}

export type EventDataType =
  | "Casts"
  | "DamageDone"
  | "DamageTaken"
  | "Deaths"
  | "Buffs"
  | "Debuffs"
  | "Resources"
  | "Interrupts"
  | "Dispels";

/** Follows `nextPageTimestamp` until the fight window is exhausted. */
export async function getEvents(
  code: string,
  fightId: number,
  dataType: EventDataType,
  window: { start: number; end: number },
  opts: { sourceID?: number; targetID?: number; hostilityType?: "Friendlies" | "Enemies" } = {},
): Promise<WclEvent[]> {
  const all: WclEvent[] = [];
  let start = window.start;

  // Bounded so a pagination bug can never spin forever.
  for (let page = 0; page < 25; page++) {
    const key = `events:${code}:${fightId}:${dataType}:${opts.sourceID ?? "all"}:${
      opts.targetID ?? "all"
    }:${opts.hostilityType ?? "-"}:${start}`;

    const data = await query<{
      reportData: { report: { events: { data: WclEvent[]; nextPageTimestamp: number | null } } };
    }>(key, REPORT_EVENTS, {
      code,
      fightIDs: [fightId],
      dataType,
      sourceID: opts.sourceID ?? null,
      targetID: opts.targetID ?? null,
      hostilityType: opts.hostilityType ?? null,
      startTime: start,
      endTime: window.end,
    });

    const page_ = data.reportData.report.events;
    all.push(...(page_.data ?? []));
    if (!page_.nextPageTimestamp || page_.nextPageTimestamp >= window.end) break;
    start = page_.nextPageTimestamp;
  }

  return all;
}

/**
 * Every hit the raid took on one pull.
 *
 * The fight-wide DamageTaken *table* gives per-player totals but no hit counts
 * and no times, so it can say who ate a mechanic but never when, how often, or
 * whether the people who avoided it were even alive. These events are the only
 * source for that, and they are what makes "4 of 19 players were hit" possible.
 *
 * Deliberately a thin wrapper over the existing REPORT_EVENTS document: adding
 * an argument to that query would change its SHA-1, and the cache key folds the
 * document hash in, so every cached cast stream in the project would be
 * invalidated at once.
 */
export function getDamageTakenEvents(
  code: string,
  fightId: number,
  window: { start: number; end: number },
): Promise<WclEvent[]> {
  return getEvents(code, fightId, "DamageTaken", window, { hostilityType: "Friendlies" });
}

export interface RankingRow {
  name: string;
  class: string;
  spec: string;
  amount: number;
  duration: number;
  report: { code: string; fightID: number; startTime: number };
  /** Present because the query asks for combatant info; hero talents are included. */
  talents?: Array<{ talentID: number; points: number }>;
  /** WCL's ranking bracket, which for retail raids is the item level. */
  bracketData?: number;
  [key: string]: unknown;
}

/**
 * Talent ids per actor for one fight, from the CombatantInfo events. One query
 * covers the whole raid, so profiling several players in a report costs nothing
 * extra.
 */
export async function getTalentsByActor(
  code: string,
  fightId: number,
): Promise<Record<number, number[]>> {
  const data = await query<{
    reportData: { report: { events: { data: WclEvent[] } } };
  }>(`combatantinfo:${code}:${fightId}`, COMBATANT_INFO, { code, fightIDs: [fightId] });

  const byActor: Record<number, number[]> = {};
  for (const event of data.reportData.report.events.data ?? []) {
    const actorId = event.sourceID;
    if (actorId == null) continue;
    const tree = (event.talentTree as Array<{ id?: number }> | undefined) ?? [];
    const ids = tree.map((t) => Number(t.id)).filter((id) => Number.isFinite(id) && id > 0);
    if (ids.length > 0) byActor[actorId] = ids;
  }
  return byActor;
}

export async function getCharacterRankings(
  encounterID: number,
  opts: {
    className?: string;
    specName?: string;
    difficulty?: number;
    metric?: "dps" | "hps" | "bossdps";
    page?: number;
  },
): Promise<RankingRow[]> {
  const key = `rankings:${encounterID}:${opts.className ?? "-"}:${opts.specName ?? "-"}:${
    opts.difficulty ?? "-"
  }:${opts.metric ?? "dps"}:${opts.page ?? 1}`;

  const data = await query<{
    worldData: { encounter: { characterRankings: { rankings?: RankingRow[] } } | null };
  }>(key, CHARACTER_RANKINGS, {
    encounterID,
    className: opts.className ?? null,
    specName: opts.specName ?? null,
    difficulty: opts.difficulty ?? null,
    metric: opts.metric ?? "dps",
    page: opts.page ?? 1,
  });

  return data.worldData.encounter?.characterRankings?.rankings ?? [];
}

export interface GraphSeries {
  name: string;
  /** Report-relative ms of the first point. */
  pointStart: number;
  /** Gap between points, ms. */
  pointInterval: number;
  /** Damage in each bucket — not cumulative. */
  data: number[];
}

/** Raid damage over time for one fight, used to rebuild the boss's health curve. */
export async function getDamageGraph(
  code: string,
  fightId: number,
  window: { start: number; end: number },
): Promise<GraphSeries | null> {
  const data = await query<{ reportData: { report: { graph: unknown } } }>(
    `graph:${code}:${fightId}:damage:friendlies`,
    REPORT_GRAPH,
    { code, fightIDs: [fightId], startTime: window.start, endTime: window.end },
  );

  const graph = data.reportData.report.graph as { data?: unknown } | null;
  const payload = (graph && "data" in graph ? graph.data : graph) as
    | { series?: GraphSeries[] }
    | undefined;

  return payload?.series?.find((s) => s.name === "Total") ?? null;
}
