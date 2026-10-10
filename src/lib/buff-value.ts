import {
  computeBuffValue,
  RAID_BUFFS,
  type BuffActor,
  type BuffFightInput,
  type BuffValuePayload,
  type PrimaryStat,
} from "./model/buff-value";
import {
  getActorsAndAbilities,
  getAuraEvents,
  getCombatantInfo,
  getEvents,
  getReportMeta,
  getTable,
} from "./wcl/fetchers";
import { difficultyName } from "./wcl/types";

/**
 * What each raid buff and debuff was worth on the selected pulls.
 *
 * Its own pass rather than part of the raid analysis: it needs every damage
 * event of the raid (around 75k on a seven-minute Mythic pull, eight pages),
 * which nothing else in the tool reads, and the raid notes should not pay for it.
 */
export interface BuffValueArgs {
  code: string;
  fightIds: number[];
  onProgress?: (message: string) => void;
}

export type { BuffValuePayload } from "./model/buff-value";

const STATS: PrimaryStat[] = ["strength", "agility", "intellect"];

export async function analyzeBuffValue(args: BuffValueArgs): Promise<BuffValuePayload> {
  const progress = args.onProgress ?? (() => {});
  if (args.fightIds.length === 0) throw new Error("Select at least one pull to analyse.");

  progress("Loading report...");
  const [meta, master] = await Promise.all([getReportMeta(args.code), getActorsAndAbilities(args.code)]);
  const fights = args.fightIds
    .map((id) => {
      const fight = meta.fights.find((f) => f.id === id);
      if (!fight) throw new Error(`Fight ${id} is not in report ${args.code}.`);
      return fight;
    })
    .sort((a, b) => a.startTime - b.startTime);

  const actors: Record<number, BuffActor> = Object.fromEntries(master.actors.map((a) => [a.id, a]));
  const specs: Record<number, string | null> = {};
  const primaryStats: Record<number, PrimaryStat | null> = {};

  let done = 0;
  progress(`Fetching every damage event across ${fights.length} pull${fights.length === 1 ? "" : "s"}...`);
  const inputs: BuffFightInput[] = await Promise.all(
    fights.map(async (fight) => {
      const window = { start: fight.startTime, end: fight.endTime };
      const [damage, table, combatants, ...auras] = await Promise.all([
        getEvents(args.code, fight.id, "DamageDone", window, { hostilityType: "Friendlies" }),
        // Spec names only; usually already cached by the report summary.
        getTable(args.code, fight.id, "DamageDone"),
        getCombatantInfo(args.code, fight.id),
        ...RAID_BUFFS.map((d) =>
          d.on === "debuff"
            ? getAuraEvents(args.code, fight.id, "Debuffs", d.auraId, window, "Enemies")
            : getAuraEvents(args.code, fight.id, "Buffs", d.auraId, window, "Friendlies"),
        ),
      ]);

      for (const row of table.entries ?? []) {
        const icon = typeof row.icon === "string" ? row.icon : "";
        if (row.id != null && specs[row.id] == null) specs[row.id] = icon.split("-")[1] ?? null;
      }

      const initial: NonNullable<BuffFightInput["initial"]> = [];
      for (const c of combatants) {
        if (c.sourceID == null) continue;
        // The highest of the three is the stat the spec actually uses.
        const best = STATS.map((s) => [s, Number(c[s] ?? 0)] as const).sort((a, b) => b[1] - a[1])[0];
        if (best[1] > 0 && primaryStats[c.sourceID] == null) primaryStats[c.sourceID] = best[0];
        const list = (c.auras as Array<{ source?: number; ability?: number }> | undefined) ?? [];
        for (const a of list) {
          if (a.ability == null || a.source == null) continue;
          if (RAID_BUFFS.some((d) => d.auraId === a.ability)) initial.push({ target: c.sourceID, ability: a.ability, source: a.source });
        }
      }

      progress(`Pull ${++done}/${fights.length}: ${damage.length.toLocaleString()} damage events`);
      return { fightId: fight.id, startTime: fight.startTime, endTime: fight.endTime, damage, auras: auras.flat(), initial };
    }),
  );

  inputs.sort((a, b) => a.startTime - b.startTime);
  const report = computeBuffValue(inputs, actors, master.schools, { specs, primaryStats });
  return {
    ...report,
    report: { code: meta.code, title: meta.title },
    encounter: { id: fights[0].encounterID, name: fights[0].name, difficulty: difficultyName(fights[0].difficulty) },
    pulls: fights.map((f) => ({ fightId: f.id, durationMs: f.endTime - f.startTime, kill: !!f.kill })),
  };
}
