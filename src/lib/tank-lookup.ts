// "What do the best tanks of my spec do on this boss?" — no report needed.
//
// Takes the top-ranked parses for a tank spec on one boss and difficulty,
// picks one (the highest DPS by default — for a tank the ranking barely
// matters, any top log shows the job being done), and runs the same raid
// analysis on that single fight. Both tanks of that raid are in it, so swaps,
// taunt stacks and the co-tank's side come out exactly as for your own log.

import { query } from "./wcl/client";
import { getCharacterRankings, getReportMeta } from "./wcl/fetchers";
import { analyzeRaidEncounter, toRaidPayload } from "./raid";
import type { RaidPayload } from "./model/raid-payload";

/** The tank specs, as WarcraftLogs names class and spec. */
export const TANK_CHOICES = [
  { className: "DeathKnight", specName: "Blood", label: "Blood Death Knight" },
  { className: "DemonHunter", specName: "Vengeance", label: "Vengeance Demon Hunter" },
  { className: "Druid", specName: "Guardian", label: "Guardian Druid" },
  { className: "Monk", specName: "Brewmaster", label: "Brewmaster Monk" },
  { className: "Paladin", specName: "Protection", label: "Protection Paladin" },
  { className: "Warrior", specName: "Protection", label: "Protection Warrior" },
] as const;

/** How many of the top parses to offer. */
const TOP = 10;

export interface RaidZone {
  id: number;
  name: string;
  expansion: string;
  difficulties: Array<{ id: number; name: string }>;
  encounters: Array<{ id: number; name: string }>;
}

/**
 * Raid zones with their bosses, newest expansion first. WarcraftLogs lists some
 * zones twice, once with 5xxxx encounter ids that hold no rankings; the copy
 * with the plain ids is the one kept.
 */
export async function raidZones(): Promise<RaidZone[]> {
  const data = await query<{
    worldData: {
      expansions: Array<{
        id: number;
        name: string;
        zones: Array<{ id: number; name: string; difficulties: RaidZone["difficulties"]; encounters: RaidZone["encounters"] }>;
      }>;
    };
  }>(
    "research:expansions-zones",
    `query { worldData { expansions { id name zones { id name difficulties { id name } encounters { id name } } } } }`,
    {},
  );
  const zones: RaidZone[] = [];
  for (const ex of [...data.worldData.expansions].sort((a, b) => b.id - a.id)) {
    const byName = new Map<string, RaidZone>();
    for (const z of ex.zones ?? []) {
      const encounters = (z.encounters ?? []).filter((e) => e.id < 50_000);
      // A raid has a Mythic difficulty and more than one boss; dungeons and
      // single-boss events are left out, and so are the "Complete Raids"
      // full-clear categories, which rank whole clears rather than bosses.
      if (encounters.length < 2 || !(z.difficulties ?? []).some((d) => d.name === "Mythic" || d.id === 5)) continue;
      if (/^complete raids/i.test(z.name)) continue;
      const prev = byName.get(z.name);
      if (!prev || encounters.length > prev.encounters.length) {
        byName.set(z.name, { id: z.id, name: z.name, expansion: ex.name, difficulties: z.difficulties ?? [], encounters });
      }
    }
    zones.push(...byName.values());
  }
  return zones;
}

export interface TankLookupArgs {
  encounterID: number;
  difficulty: number;
  className: string;
  specName: string;
  /** Index into the top parses; 0 is the highest DPS. */
  pick?: number;
  onProgress?: (message: string) => void;
}

export interface TankLookup {
  top: Array<{ rank: number; name: string; amount: number; reportCode: string; fightId: number; server: string | null }>;
  pick: number;
  /** The ranked tank's actor id in that report, so the view can open on them. */
  tankId: number | null;
  payload: RaidPayload;
}

export async function lookupTopTank(args: TankLookupArgs): Promise<TankLookup> {
  const progress = args.onProgress ?? (() => {});
  progress(`Fetching the top ${args.specName} ${args.className} parses...`);
  const rows = await getCharacterRankings(args.encounterID, {
    className: args.className,
    specName: args.specName,
    difficulty: args.difficulty,
    metric: "dps",
  });
  const seen = new Set<string>();
  const top = rows
    .filter((r) => r.report?.code && !seen.has(r.name) && seen.add(r.name))
    .slice(0, TOP)
    .map((r, i) => ({
      rank: i + 1,
      name: r.name,
      amount: r.amount,
      reportCode: r.report.code,
      fightId: r.report.fightID,
      server: (r.server as { name?: string } | undefined)?.name ?? null,
    }));
  if (top.length === 0) throw new Error("No ranked parses for that spec on this boss and difficulty yet.");

  const pick = Math.min(Math.max(0, args.pick ?? 0), top.length - 1);
  const chosen = top[pick];
  progress(`Analysing #${chosen.rank} ${chosen.name}'s log...`);

  const meta = await getReportMeta(chosen.reportCode);
  const actor = meta.masterData.actors.find((a) => a.type === "Player" && a.name === chosen.name);
  const raid = await analyzeRaidEncounter({ code: chosen.reportCode, fightIds: [chosen.fightId], onProgress: progress });

  // Only the tank half crosses the wire: the rest of the raid analysis is not shown here.
  const payload = toRaidPayload(raid);
  return {
    top,
    pick,
    tankId: actor?.id ?? null,
    payload: { ...payload, notable: [], performance: { players: [], duties: [] } },
  };
}
