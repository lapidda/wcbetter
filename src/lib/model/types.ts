export interface AbilityStat {
  gameID: number;
  name: string;
  /** Icon file name from the WCL table row, when it carried one. */
  icon: string | null;
  casts: number;
  castsPerMinute: number;
  damage: number;
  damagePerCast: number;
  /** Sorted gaps in ms between consecutive casts of this ability. Empty if no timeline was fetched. */
  interCastGaps: number[];
}

export interface DamageTakenStat {
  gameID: number;
  name: string;
  total: number;
  /**
   * Per-minute so fights of different lengths compare fairly. WCL's damage-taken
   * tables carry no hit counts, only totals, so this is damage rather than hits.
   */
  damagePerMinute: number;
  /** This ability's share of all damage the player took, 0-1. Scale-free significance. */
  shareOfDamageTaken: number;
}

export interface BuffStat {
  gameID: number;
  name: string;
  uptimeMs: number;
  uptimePct: number;
}

export interface DeathInfo {
  timestampMs: number;
  /** Fight-relative, ms. */
  atMs: number;
  killingAbility: string | null;
  /**
   * How long this death actually cost, in ms: until the first cast after it (a
   * battle rez), or the end of the pull. Measuring the rez is what makes the
   * DPS estimate honest — "rest of the fight" would overstate most deaths.
   */
  deadMs: number;
  /** Whether a cast followed the death, i.e. the player was brought back. */
  rezzed: boolean;
  /** Damage taken in the 10s before death, most recent last. */
  rewind: Array<{ atMs: number; ability: string; amount: number }>;
}

export interface CastGap {
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface PlayerProfile {
  /** "player" for the subject, "ref:<name>" for a reference parse. */
  key: string;
  name: string;
  /** Report-local actor id: what a WCL link wants in source=. */
  actorId: number;
  className: string | null;
  specName: string | null;
  reportCode: string;
  fightId: number;

  durationMs: number;
  /** From the fight-wide damage table's actor row; null on logs without it. */
  itemLevel: number | null;
  /**
   * When the boss dropped into execute range on this pull, fight-relative.
   * Null when the pull never got it that low — most of a progression night.
   */
  burnStartMs: number | null;
  totalDamage: number;
  dps: number;
  activeTimeMs: number;
  activeTimePct: number;

  abilities: Record<number, AbilityStat>;
  damageTaken: Record<number, DamageTakenStat>;
  buffs: Record<number, BuffStat>;

  deaths: DeathInfo[];
  /** Talent ids, hero talents included. Empty for logs without combatant info. */
  talents: number[];
  /** Only populated for the subject player (expensive to fetch for everyone). */
  gaps: CastGap[];
  castTimeline: Array<{ atMs: number; gameID: number }>;
}

/** An enemy ability, named by the log's own enemy-side cast table — never by code. */
export interface EnemyAbility {
  gameID: number;
  name: string;
  icon: string | null;
  /** NPC names that cast it, e.g. which of two bosses. */
  casters: string[];
  casts: number;
}

/** One boss cast, fight-relative. `telegraphed` means it had a cast bar (a begincast event). */
export interface BossCast {
  atMs: number;
  gameID: number;
  sourceId: number;
  telegraphed: boolean;
  /**
   * Who the cast named, when it named anyone. The log carries this on enemy cast
   * events, and it is the difference between "lands on a player" and "goes off
   * at the room" — which is most of what separates a spread from raid damage.
   */
  targetId: number | null;
  /**
   * Cast bar length, from begincast to cast. Null when the ability is instant or
   * only the completed cast was logged.
   */
  castMs: number | null;
}

export interface EncounterContext {
  abilities: Record<number, EnemyAbility>;
  /** fightId -> mechanic casts, sorted by time, auto-attacks and unnamed ids removed. */
  castsByFight: Record<number, BossCast[]>;
}

export interface ReferenceProfile {
  encounterID: number;
  encounterName: string;
  difficulty: number | null;
  className: string | null;
  specName: string | null;
  members: PlayerProfile[];
  /** Median dps across the reference set. */
  medianDps: number;
  medianActiveTimePct: number;
  /** gameID -> median casts/minute across members that used it at all. */
  medianCpm: Record<number, number>;
  /** gameID -> how many members cast it at least once. */
  usageCount: Record<number, number>;
  /** gameID -> median damage per cast. */
  medianDamagePerCast: Record<number, number>;
  /** gameID -> ability name, merged across members. */
  abilityNames: Record<number, string>;
  /** gameID -> median damage/minute taken. Zero means nobody took it. */
  medianDamageTakenDpm: Record<number, number>;
  damageTakenNames: Record<number, string>;
  /** gameID -> estimated cooldown in ms, from the shortest observed gap in the reference set. */
  estimatedCooldownMs: Record<number, number>;
  /** gameID -> median uptime %. */
  medianBuffUptime: Record<number, number>;
  buffNames: Record<number, string>;
  /** How well the reference set matches the player's talent build. */
  buildMatch: { matched: boolean; similarity: number };
  /** Median item level across the reference parses; null when unknown. */
  medianItemLevel: number | null;
}
