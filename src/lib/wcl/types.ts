export interface Fight {
  id: number;
  encounterID: number;
  name: string;
  difficulty: number | null;
  kill: boolean | null;
  startTime: number;
  endTime: number;
  bossPercentage: number | null;
  fightPercentage: number | null;
  friendlyPlayers: number[] | null;
}

export interface Actor {
  id: number;
  name: string;
  type: string;
  subType: string;
  server: string | null;
}

export interface ReportMeta {
  code: string;
  title: string;
  startTime: number;
  endTime: number;
  zone: { id: number; name: string } | null;
  fights: Fight[];
  masterData: { actors: Actor[] };
}

/** One row of a WCL `table` response. Shape varies by dataType; fields are best-effort. */
export interface TableEntry {
  name: string;
  id?: number;
  guid?: number;
  type?: string;
  total?: number;
  uses?: number;
  hitCount?: number;
  activeTime?: number;
  activeTimeReduced?: number;
  uptime?: number;
  totalReduced?: number;
  abilities?: TableEntry[];
  gear?: unknown[];
  talents?: unknown[];
  [key: string]: unknown;
}

export interface WclEvent {
  timestamp: number;
  type: string;
  sourceID?: number;
  targetID?: number;
  abilityGameID?: number;
  amount?: number;
  unmitigatedAmount?: number;
  absorbed?: number;
  overkill?: number;
  mitigated?: number;
  killingAbilityGameID?: number;
  classResources?: Array<{ amount: number; max: number; type: number }>;
  [key: string]: unknown;
}

export const DIFFICULTY_NAMES: Record<number, string> = {
  1: "LFR",
  2: "Normal",
  3: "Normal",
  4: "Heroic",
  5: "Mythic",
};

/** WCL rankings use "Raid Finder"/"Normal"/"Heroic"/"Mythic"; the ints above are what fights report. */
export function difficultyName(difficulty: number | null): string {
  if (difficulty == null) return "Unknown";
  return DIFFICULTY_NAMES[difficulty] ?? `Difficulty ${difficulty}`;
}
