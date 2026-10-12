import type { PlayerProfile } from "./model/types";
import type { PriorityInput } from "./spec/windwalker-priority";
import { getActorsAndAbilities, getCastsWithResources, getEvents, getReportMeta } from "./wcl/fetchers";

/**
 * What the priority check needs for one profiled pull, yours or a top parse's:
 * casts with Energy and Chi, the player's own buff events, and the report's
 * ability names to read them by. Two small event queries per pull (one page
 * each) plus the report's ability list, cached like everything else.
 */
export async function loadPriorityInput(profile: PlayerProfile): Promise<PriorityInput | null> {
  const meta = await getReportMeta(profile.reportCode);
  const fight = meta.fights.find((f) => f.id === profile.fightId);
  if (!fight) return null;
  const window = { start: fight.startTime, end: fight.endTime };

  const [casts, buffs, master] = await Promise.all([
    getCastsWithResources(profile.reportCode, profile.fightId, profile.actorId, window),
    getEvents(profile.reportCode, profile.fightId, "Buffs", window, { targetID: profile.actorId }),
    getActorsAndAbilities(profile.reportCode),
  ]);
  const name = (id: number | undefined) => (id == null ? "" : (master.names[id] ?? ""));

  return {
    durationMs: fight.endTime - fight.startTime,
    casts: casts
      .filter((e) => e.type === "cast" && e.abilityGameID != null)
      .map((e) => {
        const res = (e.classResources ?? []) as Array<{ amount: number; max: number; type: number; cost?: number }>;
        // WCL resource types: 3 is Energy, 12 is Chi.
        const energy = res.find((r) => r.type === 3);
        const chi = res.find((r) => r.type === 12);
        return {
          t: e.timestamp - fight.startTime,
          name: name(e.abilityGameID),
          energy: energy?.amount ?? null,
          energyMax: energy?.max ?? null,
          chi: chi?.amount ?? null,
          chiCost: chi?.cost ?? null,
          chiMax: chi?.max ?? null,
        };
      })
      .sort((a, b) => a.t - b.t),
    auras: buffs
      .filter((e) => e.abilityGameID != null && e.targetID === profile.actorId)
      .map((e) => ({ t: e.timestamp - fight.startTime, type: e.type, id: e.abilityGameID!, name: name(e.abilityGameID) }))
      .sort((a, b) => a.t - b.t),
    deathsMs: profile.deaths.map((d) => d.atMs),
  };
}
