import {
  buildDictionary,
  friendlyAbilityIds,
  mechanicCasts,
  withoutFriendlyAbilities,
} from "./model/encounter";
import type { EncounterContext } from "./model/types";
import { getEvents, getTableForFights } from "./wcl/fetchers";
import type { Fight } from "./wcl/types";

/**
 * The boss's mechanic timeline for a set of pulls, named entirely by the log.
 *
 * Extracted from `analyzeEncounter` so the raid-wide note analysis can build the
 * same context without dragging in reference parses, rankings or a subject
 * player — none of which it needs.
 *
 * Additive by design: every caller treats a failure here as a warning and keeps
 * going unlabelled, because a missing boss timeline degrades the output rather
 * than invalidating it.
 */
export interface EncounterContextResult {
  context: EncounterContext | null;
  /** Player effects the enemy-side log filed under the environment, dropped by name. */
  friendlyExcluded: string[];
  warnings: string[];
}

export async function buildEncounterContext(
  code: string,
  fights: Fight[],
  onProgress: (message: string) => void = () => {},
): Promise<EncounterContextResult> {
  const warnings: string[] = [];

  try {
    onProgress(`Fetching boss casts for ${fights.length} pulls...`);
    const fightIds = fights.map((f) => f.id);

    const [enemyTable, friendlyCasts, friendlyBuffs] = await Promise.all([
      getTableForFights(code, fightIds, "Casts", "Enemies"),
      // The enemy-side log attributes some player effects to the environment.
      // Anything a friendly cast, or that sits on friendlies as a beneficial
      // aura, is struck from the boss dictionary.
      getTableForFights(code, fightIds, "Casts", "Friendlies"),
      getTableForFights(code, fightIds, "Buffs", "Friendlies"),
    ]);

    const raidAbilities = new Set([
      ...friendlyAbilityIds(friendlyCasts),
      ...friendlyAbilityIds(friendlyBuffs),
    ]);
    const filtered = withoutFriendlyAbilities(buildDictionary(enemyTable), raidAbilities);

    const perFight = await Promise.all(
      fights.map(async (fight) => {
        const events = await getEvents(
          code,
          fight.id,
          "Casts",
          { start: fight.startTime, end: fight.endTime },
          { hostilityType: "Enemies" },
        );
        return [fight.id, mechanicCasts(events, fight, filtered.abilities)] as const;
      }),
    );

    return {
      context: { abilities: filtered.abilities, castsByFight: Object.fromEntries(perFight) },
      friendlyExcluded: filtered.excluded,
      warnings,
    };
  } catch (error) {
    warnings.push(`Boss-ability context unavailable: ${(error as Error).message}`);
    return { context: null, friendlyExcluded: [], warnings };
  }
}
