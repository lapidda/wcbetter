import type { WclEvent } from "../wcl/types";

// What each raid buff and debuff is worth, measured from the log rather than guessed.
//
// A "5% physical damage taken" debuff is worth 5% of exactly the damage that
// was physical *and* landed on a target while the debuff was on it. Both halves
// are in the log: every damage event names its ability, every ability carries a
// school mask, and the debuff's apply/remove events give its windows per target.
// Guessing "warriors are mostly physical" gets the first half wrong for hybrid
// specs, and assuming 100% uptime gets the second half wrong on add fights and
// on bosses that spawn mid-pull.
//
// Stat buffs (Arcane Intellect, Battle Shout, Mark of the Wild) work the same
// way from the attacker's side: a hit counts if the attacker had the buff and
// uses that stat. What the log cannot say is how much of a hit the stat made,
// so those are valued as if damage scaled 1:1 with it — an upper bound, and
// marked as an estimate wherever it is shown.
//
// Pure: the fetching lives in lib/buff-value.ts, so the browser can import
// these types without pulling in the WCL client.

/** WCL ability `type` is the spell school bitmask. */
export const SCHOOL = {
  physical: 1,
  holy: 2,
  fire: 4,
  nature: 8,
  frost: 16,
  shadow: 32,
  arcane: 64,
} as const;
const ALL_SCHOOLS = 127;

export type PrimaryStat = "strength" | "agility" | "intellect";

export interface RaidBuffDef {
  auraId: number;
  name: string;
  /** Class that brings it; matches WCL's actor `subType`. */
  className: string;
  /** "debuff": on the enemy being hit. "buff": on the player doing the hitting. */
  on: "debuff" | "buff";
  /** Damage increase it is worth, 0.05 for 5%. Zero for a buff that is tracked but not valued. */
  value: number;
  /** One line for the card: what the aura does. */
  effect: string;
  /** Debuffs: schools it amplifies; a hit counts when its school mask overlaps. */
  schoolMask?: number;
  /** Buffs: only attackers with one of these primary stats benefit. Absent means everyone. */
  stats?: PrimaryStat[];
  /**
   * Why the value is not exact. A debuff on the target multiplies the hit
   * directly and needs none; a stat buff's damage share has to be assumed.
   */
  estimate?: string;
}

/**
 * Values from the spell data (Wowhead, patch 12.x). Add a row to value
 * another aura. Fortitude and Blessing of the Bronze are left out: no damage.
 */
export const RAID_BUFFS: RaidBuffDef[] = [
  {
    auraId: 113746,
    name: "Mystic Touch",
    className: "Monk",
    on: "debuff",
    value: 0.05,
    effect: "+5% physical damage taken",
    schoolMask: SCHOOL.physical,
  },
  {
    auraId: 1490,
    name: "Chaos Brand",
    className: "DemonHunter",
    on: "debuff",
    value: 0.03,
    effect: "+3% damage taken",
    schoolMask: ALL_SCHOOLS,
  },
  {
    auraId: 257284,
    name: "Hunter's Mark",
    className: "Hunter",
    on: "debuff",
    value: 0.03,
    effect: "+3% damage taken",
    schoolMask: ALL_SCHOOLS,
  },
  {
    auraId: 1459,
    name: "Arcane Intellect",
    className: "Mage",
    on: "buff",
    value: 0.03,
    effect: "+3% Intellect",
    stats: ["intellect"],
    estimate: "assumes an Intellect user's damage scales 1:1 with Intellect",
  },
  {
    auraId: 6673,
    name: "Battle Shout",
    className: "Warrior",
    on: "buff",
    value: 0.05,
    effect: "+5% attack power",
    stats: ["strength", "agility"],
    estimate: "assumes a Strength or Agility user's damage scales 1:1 with attack power",
  },
  {
    auraId: 1126,
    name: "Mark of the Wild",
    className: "Druid",
    on: "buff",
    value: 0.03,
    effect: "+3% Versatility",
    estimate: "ignores the player's own Versatility, so slightly high",
  },
  {
    auraId: 462854,
    name: "Skyfury",
    className: "Shaman",
    on: "buff",
    value: 0,
    effect: "+2% Mastery",
    estimate: "not valued: what 2% Mastery is worth differs for every spec",
  },
];

export interface BuffActor {
  id: number;
  name: string;
  /** "Player", "Pet", "NPC", ... */
  type: string;
  /** Class for players. */
  subType: string;
  petOwner?: number | null;
}

export interface BuffFightInput {
  fightId: number;
  startTime: number;
  endTime: number;
  /** DamageDone events, friendly sources. Pets are folded into their owner. */
  damage: WclEvent[];
  /** Apply/remove events of the auras in RAID_BUFFS: debuffs on enemies, buffs on friendlies. */
  auras: WclEvent[];
  /** Auras on each player when the pull began (CombatantInfo), with who cast them. */
  initial?: Array<{ target: number; ability: number; source: number }>;
}

export interface BuffPlayerRow {
  id: number;
  name: string;
  className: string;
  specName: string | null;
  primaryStat: PrimaryStat | null;
  dps: number;
  /** Share of this player's damage whose school is exactly physical. */
  physicalShare: number;
  /** Share with a school mask mixing physical and magic (Chaos, Shadowstrike...). */
  mixedShare: number;
  /** Share that is pure magic. */
  magicShare: number;
  /** DPS this player would lose without each aura, by auraId. */
  lossDps: Record<number, number>;
}

export interface BuffValue {
  def: RaidBuffDef;
  /** Players who cast it, most applications first. */
  providers: Array<{ id: number; name: string; dps: number; applications: number }>;
  /** Share of eligible damage that the aura was actually up for. */
  coverage: number;
  /** Share of raid damage it could have amplified. */
  eligibleShare: number;
  /** Raid DPS the aura adds, the providers' own hits included. */
  lossDps: number;
  lossShare: number;
  /** The same, excluding the providers' own damage — what everyone else gets. */
  lossDpsOthers: number;
  /**
   * DPS a swap-in replacing the sole provider must do to break even on this
   * aura alone: the provider's own DPS plus what it gave everyone else. Null
   * when a second provider would keep it up anyway.
   */
  breakEvenDps: number | null;
  /** Per pull, for spotting a pull where it fell off. */
  pulls: Array<{ fightId: number; coverage: number; lossShare: number }>;
}

/** One player who is the only source of at least one aura: what removing them costs. */
export interface SoleProvider {
  id: number;
  name: string;
  className: string;
  dps: number;
  auraIds: number[];
  /** What their auras gave everyone else, summed. */
  othersDps: number;
  /** Own DPS plus othersDps: a swap-in must match this. */
  breakEvenDps: number;
}

export interface BuffValueReport {
  durationMs: number;
  raidDps: number;
  /** Raid damage by school class, for the "how physical is this raid" headline. */
  physicalShare: number;
  mixedShare: number;
  magicShare: number;
  players: BuffPlayerRow[];
  buffs: BuffValue[];
  soleProviders: SoleProvider[];
}

/** What crosses the wire; types only, so the browser can import it. */
export interface BuffValuePayload extends BuffValueReport {
  report: { code: string; title: string };
  encounter: { id: number; name: string; difficulty: string };
  pulls: Array<{ fightId: number; durationMs: number; kill: boolean }>;
}

type Windows = Map<string, Array<[number, number]>>;

const instanceKey = (id: number | undefined, instance: unknown) => `${id}:${(instance as number | undefined) ?? 0}`;
const targetKey = (e: WclEvent) => instanceKey(e.targetID, e.targetInstance);

const APPLY = new Set(["applydebuff", "applybuff"]);
const REMOVE = new Set(["removedebuff", "removebuff"]);

/**
 * Apply/remove pairs per target instance. An unmatched apply runs to the end
 * of the pull; a remove with no apply, or a target in `initiallyOn`, means the
 * aura was already up when the pull began.
 */
export function auraWindows(
  events: WclEvent[],
  auraId: number,
  start: number,
  end: number,
  initiallyOn: Iterable<string> = [],
): Windows {
  const windows: Windows = new Map();
  const open = new Map<string, number>();
  for (const key of initiallyOn) open.set(key, start);
  const push = (key: string, from: number, to: number) => {
    const list = windows.get(key) ?? [];
    list.push([from, to]);
    windows.set(key, list);
  };
  for (const e of events) {
    if (e.abilityGameID !== auraId) continue;
    const key = targetKey(e);
    if (APPLY.has(e.type)) {
      if (!open.has(key)) open.set(key, e.timestamp);
    } else if (REMOVE.has(e.type)) {
      push(key, open.get(key) ?? start, e.timestamp);
      open.delete(key);
    }
  }
  for (const [key, from] of open) push(key, from, end);
  return windows;
}

const covered = (windows: Windows, key: string, t: number) =>
  (windows.get(key) ?? []).some(([a, b]) => t >= a && t <= b);

export function computeBuffValue(
  fights: BuffFightInput[],
  actors: Record<number, BuffActor>,
  /** Ability id → school mask. */
  schools: Record<number, number>,
  opts: {
    specs?: Record<number, string | null>;
    primaryStats?: Record<number, PrimaryStat | null>;
    defs?: RaidBuffDef[];
  } = {},
): BuffValueReport {
  const defs = opts.defs ?? RAID_BUFFS;
  const specs = opts.specs ?? {};
  const primaryStats = opts.primaryStats ?? {};
  const durationMs = fights.reduce((sum, f) => sum + (f.endTime - f.startTime), 0);
  const seconds = Math.max(durationMs / 1000, 1e-9);

  interface Acc {
    total: number;
    physical: number;
    mixed: number;
    magic: number;
    loss: Record<number, number>;
  }
  const byPlayer = new Map<number, Acc>();
  const perBuff = defs.map(() => ({
    eligible: 0,
    covered: 0,
    loss: 0,
    providerSelf: 0,
    applications: new Map<number, number>(),
    pulls: [] as BuffValue["pulls"],
  }));
  let raidTotal = 0;

  const ownerOf = (id: number | undefined): number | null => {
    if (id == null) return null;
    const actor = actors[id];
    if (!actor) return null;
    if (actor.type === "Player") return id;
    if (actor.type === "Pet" && actor.petOwner != null && actors[actor.petOwner]?.type === "Player") return actor.petOwner;
    return null;
  };
  const isEnemy = (id: number | undefined) => {
    const actor = id == null ? undefined : actors[id];
    return !!actor && actor.type !== "Player" && actor.type !== "Pet";
  };
  const credit = (i: number, source: number | undefined) => {
    const owner = ownerOf(source);
    if (owner == null) return;
    perBuff[i].applications.set(owner, (perBuff[i].applications.get(owner) ?? 0) + 1);
  };

  // Providers first, across all pulls: the "own damage" split needs them.
  for (const fight of fights) {
    for (const e of fight.auras) {
      if (!APPLY.has(e.type)) continue;
      const i = defs.findIndex((d) => d.auraId === e.abilityGameID);
      if (i >= 0) credit(i, e.sourceID);
    }
    for (const a of fight.initial ?? []) {
      const i = defs.findIndex((d) => d.auraId === a.ability);
      if (i >= 0) credit(i, a.source);
    }
  }

  for (const fight of fights) {
    const windows = defs.map((d) => {
      const initiallyOn = (fight.initial ?? []).filter((a) => a.ability === d.auraId).map((a) => instanceKey(a.target, 0));
      return auraWindows(fight.auras, d.auraId, fight.startTime, fight.endTime, initiallyOn);
    });
    const pull = defs.map(() => ({ eligible: 0, covered: 0, loss: 0 }));
    let pullTotal = 0;

    for (const e of fight.damage) {
      if (e.type !== "damage" || !isEnemy(e.targetID)) continue;
      const owner = ownerOf(e.sourceID);
      if (owner == null) continue;
      // Absorbed damage still came off the enemy's effective health.
      const amount = (e.amount ?? 0) + (e.absorbed ?? 0);
      if (amount <= 0) continue;
      const school = schools[e.abilityGameID ?? -1] ?? 0;

      const acc = byPlayer.get(owner) ?? { total: 0, physical: 0, mixed: 0, magic: 0, loss: {} };
      byPlayer.set(owner, acc);
      acc.total += amount;
      raidTotal += amount;
      pullTotal += amount;
      if (school === SCHOOL.physical) acc.physical += amount;
      else if (school & SCHOOL.physical) acc.mixed += amount;
      else acc.magic += amount;

      const tKey = targetKey(e);
      // A pet's stats come from its owner, so the owner's buffs are what count.
      const sKey = instanceKey(owner, 0);
      const stat = primaryStats[owner] ?? null;

      defs.forEach((def, i) => {
        if (def.on === "debuff") {
          if (!(school & (def.schoolMask ?? ALL_SCHOOLS))) return;
        } else if (def.stats && (stat == null || !def.stats.includes(stat))) {
          return;
        }
        pull[i].eligible += amount;
        perBuff[i].eligible += amount;
        const up = def.on === "debuff" ? covered(windows[i], tKey, e.timestamp) : covered(windows[i], sKey, e.timestamp);
        if (!up) return;
        // The logged hit already includes the bonus: remove v/(1+v) of it.
        const loss = (amount * def.value) / (1 + def.value);
        pull[i].covered += amount;
        pull[i].loss += loss;
        perBuff[i].covered += amount;
        perBuff[i].loss += loss;
        if (loss > 0) acc.loss[def.auraId] = (acc.loss[def.auraId] ?? 0) + loss;
        if (perBuff[i].applications.has(owner)) perBuff[i].providerSelf += loss;
      });
    }

    defs.forEach((_, i) =>
      perBuff[i].pulls.push({
        fightId: fight.fightId,
        coverage: pull[i].eligible > 0 ? pull[i].covered / pull[i].eligible : 0,
        lossShare: pullTotal > 0 ? pull[i].loss / pullTotal : 0,
      }),
    );
  }

  const players: BuffPlayerRow[] = [...byPlayer]
    .map(([id, acc]) => ({
      id,
      name: actors[id]?.name ?? `#${id}`,
      className: actors[id]?.subType ?? "",
      specName: specs[id] ?? null,
      primaryStat: primaryStats[id] ?? null,
      dps: acc.total / seconds,
      physicalShare: acc.total > 0 ? acc.physical / acc.total : 0,
      mixedShare: acc.total > 0 ? acc.mixed / acc.total : 0,
      magicShare: acc.total > 0 ? acc.magic / acc.total : 0,
      lossDps: Object.fromEntries(Object.entries(acc.loss).map(([aura, loss]) => [aura, loss / seconds])),
    }))
    .sort((a, b) => b.dps - a.dps);
  const dpsOf = (id: number) => players.find((p) => p.id === id)?.dps ?? 0;

  const buffs: BuffValue[] = defs
    .map((def, i) => {
      const b = perBuff[i];
      const providers = [...b.applications]
        .map(([id, applications]) => ({ id, name: actors[id]?.name ?? `#${id}`, dps: dpsOf(id), applications }))
        .sort((x, y) => y.applications - x.applications);
      const lossDpsOthers = (b.loss - b.providerSelf) / seconds;
      return {
        def,
        providers,
        coverage: b.eligible > 0 ? b.covered / b.eligible : 0,
        eligibleShare: raidTotal > 0 ? b.eligible / raidTotal : 0,
        lossDps: b.loss / seconds,
        lossShare: raidTotal > 0 ? b.loss / raidTotal : 0,
        lossDpsOthers,
        breakEvenDps: providers.length === 1 ? providers[0].dps + lossDpsOthers : null,
        pulls: b.pulls,
      };
    })
    .filter((b) => b.providers.length > 0);

  // A player who is the only source of several auras takes all of them along.
  const sole = new Map<number, SoleProvider>();
  for (const b of buffs) {
    if (b.providers.length !== 1 || b.def.value === 0) continue;
    const p = b.providers[0];
    const row = sole.get(p.id) ?? {
      id: p.id,
      name: p.name,
      className: actors[p.id]?.subType ?? "",
      dps: p.dps,
      auraIds: [],
      othersDps: 0,
      breakEvenDps: p.dps,
    };
    row.auraIds.push(b.def.auraId);
    row.othersDps += b.lossDpsOthers;
    row.breakEvenDps = row.dps + row.othersDps;
    sole.set(p.id, row);
  }

  const sum = (pick: (p: Acc) => number) => [...byPlayer.values()].reduce((s, a) => s + pick(a), 0);
  return {
    durationMs,
    raidDps: raidTotal / seconds,
    physicalShare: raidTotal > 0 ? sum((a) => a.physical) / raidTotal : 0,
    mixedShare: raidTotal > 0 ? sum((a) => a.mixed) / raidTotal : 0,
    magicShare: raidTotal > 0 ? sum((a) => a.magic) / raidTotal : 0,
    players,
    buffs,
    soleProviders: [...sole.values()].sort((a, b) => b.othersDps - a.othersDps),
  };
}
