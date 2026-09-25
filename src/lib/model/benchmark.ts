import { getCharacterRankings, getReportMeta, type RankingRow } from "@/lib/wcl/fetchers";
import { buildPlayerProfile } from "./profile";
import { median, percentile } from "./stats";
import type { PlayerProfile, ReferenceProfile } from "./types";

export interface BuildReferenceArgs {
  encounterID: number;
  encounterName: string;
  difficulty: number | null;
  className: string | null;
  specName: string | null;
  metric?: "dps" | "hps";
  /** How many top parses to profile. Each one costs ~6 API queries on a cold cache. */
  size?: number;
  /** The character being analysed. Excluded from their own reference set. */
  excludeCharacter?: string | null;
  /** The player's talent ids, so the reference set can be matched to their build. */
  playerTalents?: number[];
  onProgress?: (message: string) => void;
}

/**
 * Overlap between two talent selections, 0-1.
 *
 * Hero talent trees are disjoint sets of roughly a dozen nodes, so two players
 * on different trees differ by ~22 of ~76 selections and score far apart, while
 * two on the same tree with different filler choices stay close. That means a
 * plain set overlap separates builds without needing to know which tree is
 * which, or any spell database at all.
 */
export function talentSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const left = new Set(a);
  const right = new Set(b);
  let shared = 0;
  for (const id of left) if (right.has(id)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * How far below the best available match we will still accept.
 *
 * Picking purely by similarity would hand back rank-90 parses that happen to
 * share a build. Taking everything within a small band of the best match and
 * then preferring the higher-ranked parses gives the best players *who play the
 * build being analysed*.
 */
const SIMILARITY_BAND = 0.08;

/**
 * The reference profile is the whole point of the tool: instead of hardcoding a
 * rotation per spec, we measure what the best players actually did on this exact
 * boss, difficulty and spec, and treat the median of that as the target.
 */
export async function buildReferenceProfile(args: BuildReferenceArgs): Promise<ReferenceProfile> {
  const { encounterID, difficulty, className, specName, metric = "dps", size = 5 } = args;
  const progress = args.onProgress ?? (() => {});

  progress(`Fetching top ${metric.toUpperCase()} rankings for ${specName ?? "spec"} ${args.encounterName}...`);

  const rankings = await getCharacterRankings(encounterID, {
    className: className ?? undefined,
    specName: specName ?? undefined,
    difficulty: difficulty ?? undefined,
    metric,
  });

  // One entry per character: the same player appearing three times is one data
  // point, not three, and would otherwise dominate the median.
  const seen = new Set<string>();
  const candidates: RankingRow[] = [];
  for (const row of rankings) {
    if (!row.report?.code || !row.name) continue;
    if (seen.has(row.name)) continue;
    // A strong player can be their own top parse. Benchmarking someone against
    // themselves makes every gap vanish, so drop them from their own reference.
    if (args.excludeCharacter && row.name === args.excludeCharacter) {
      progress(`  excluding ${row.name} from the reference set (that is you)`);
      continue;
    }
    seen.add(row.name);
    candidates.push(row);
  }

  const { picks, similarity, matched } = selectByBuild(candidates, args.playerTalents ?? [], size);

  if (matched) {
    progress(
      `  matched to your build: ${(similarity * 100).toFixed(0)}% talent overlap ` +
        `(${picks.map((p) => p.name).join(", ")})`,
    );
  } else {
    progress(`  no talent data available; comparing against the top ${size} parses by rank`);
  }

  const members: PlayerProfile[] = [];
  for (const [i, row] of picks.entries()) {
    progress(`Profiling reference parse ${i + 1}/${picks.length} (${row.name})...`);
    try {
      members.push(await profileRanking(row));
    } catch (error) {
      // A single private or deleted reference log must not sink the analysis.
      progress(`  skipped ${row.name}: ${(error as Error).message}`);
    }
  }

  if (members.length === 0) {
    throw new Error(
      `No usable reference parses found for ${specName ?? "this spec"} on ${args.encounterName}. ` +
        `The rankings may be empty for this difficulty, or the top logs may be private.`,
    );
  }

  return aggregate(members, args, { matched, similarity });
}

/**
 * Choose the reference parses. When talent data is available on both sides this
 * matches the player's build — the point being that a Rider of the Apocalypse
 * Death Knight and a Deathbringer one press genuinely different buttons, and
 * comparing across the two manufactures findings that are talent differences
 * rather than mistakes.
 */
function selectByBuild(
  candidates: RankingRow[],
  playerTalents: number[],
  size: number,
): { picks: RankingRow[]; similarity: number; matched: boolean } {
  const usable = candidates.filter((c) => (c.talents?.length ?? 0) > 0);

  // Older logs carry no combatant info. Fall back to rank order rather than
  // pretending to a match we cannot make.
  if (playerTalents.length === 0 || usable.length === 0) {
    return { picks: candidates.slice(0, size), similarity: 0, matched: false };
  }

  const scored = usable.map((row) => ({
    row,
    score: talentSimilarity(
      playerTalents,
      (row.talents ?? []).map((t) => t.talentID),
    ),
  }));

  const best = Math.max(...scored.map((s) => s.score));
  const withinBand = scored.filter((s) => s.score >= best - SIMILARITY_BAND);

  // `candidates` is already in rank order, and filtering preserves it, so this
  // takes the strongest parses inside the matched-build band.
  const picks = withinBand.slice(0, size);

  return {
    picks: picks.map((p) => p.row),
    similarity: picks.length > 0 ? picks.reduce((sum, p) => sum + p.score, 0) / picks.length : 0,
    matched: true,
  };
}

async function profileRanking(row: RankingRow): Promise<PlayerProfile> {
  const code = row.report.code;
  const meta = await getReportMeta(code);

  const fight = meta.fights.find((f) => f.id === row.report.fightID);
  if (!fight) throw new Error(`fight ${row.report.fightID} missing from report ${code}`);

  const actor = meta.masterData.actors.find((a) => a.name === row.name);
  if (!actor) throw new Error(`${row.name} not found in report ${code}`);

  return buildPlayerProfile({
    key: `ref:${row.name}`,
    reportCode: code,
    fight,
    actor,
    className: row.class ?? null,
    specName: row.spec ?? null,
    withTimeline: true,
    // Already returned inline by the rankings query — no need to fetch it again.
    talents: (row.talents ?? []).map((t) => t.talentID),
  });
}

function aggregate(
  members: PlayerProfile[],
  args: BuildReferenceArgs,
  buildMatch: { matched: boolean; similarity: number },
): ReferenceProfile {
  const abilityIds = new Set<number>();
  const damageTakenIds = new Set<number>();
  const buffIds = new Set<number>();
  for (const m of members) {
    for (const id of Object.keys(m.abilities)) abilityIds.add(Number(id));
    for (const id of Object.keys(m.damageTaken)) damageTakenIds.add(Number(id));
    for (const id of Object.keys(m.buffs)) buffIds.add(Number(id));
  }

  const medianCpm: Record<number, number> = {};
  const usageCount: Record<number, number> = {};
  const medianDamagePerCast: Record<number, number> = {};
  const abilityNames: Record<number, string> = {};
  const estimatedCooldownMs: Record<number, number> = {};

  for (const gameID of abilityIds) {
    const users = members.filter((m) => (m.abilities[gameID]?.casts ?? 0) > 0);
    usageCount[gameID] = users.length;
    abilityNames[gameID] =
      members.find((m) => m.abilities[gameID])?.abilities[gameID]?.name ?? String(gameID);

    if (users.length === 0) continue;

    // Median across *users only*. A member who never pressed the button is
    // evidence about talent choice, captured by usageCount, not about the rate.
    medianCpm[gameID] = median(users.map((m) => m.abilities[gameID].castsPerMinute));
    medianDamagePerCast[gameID] = median(users.map((m) => m.abilities[gameID].damagePerCast));

    // Empirical cooldown: the shortest gaps anyone in the reference set achieved.
    // The 10th percentile rather than the true minimum, so one haste-fluked or
    // reset-driven double-cast cannot define the floor.
    const gaps = users.flatMap((m) => m.abilities[gameID].interCastGaps);
    if (gaps.length >= 3) estimatedCooldownMs[gameID] = percentile(gaps, 0.1);
  }

  const medianDamageTakenDpm: Record<number, number> = {};
  const damageTakenNames: Record<number, string> = {};
  for (const gameID of damageTakenIds) {
    damageTakenNames[gameID] =
      members.find((m) => m.damageTaken[gameID])?.damageTaken[gameID]?.name ?? String(gameID);
    // Zero-filled: a member who took none of it is the strongest possible evidence
    // that the ability is avoidable, so they must count toward the median.
    medianDamageTakenDpm[gameID] = median(members.map((m) => m.damageTaken[gameID]?.damagePerMinute ?? 0));
  }

  const medianBuffUptime: Record<number, number> = {};
  const buffNames: Record<number, string> = {};
  for (const gameID of buffIds) {
    buffNames[gameID] = members.find((m) => m.buffs[gameID])?.buffs[gameID]?.name ?? String(gameID);
    medianBuffUptime[gameID] = median(members.map((m) => m.buffs[gameID]?.uptimePct ?? 0));
  }

  return {
    encounterID: args.encounterID,
    encounterName: args.encounterName,
    difficulty: args.difficulty,
    className: args.className,
    specName: args.specName,
    members,
    medianDps: median(members.map((m) => m.dps)),
    medianActiveTimePct: median(members.map((m) => m.activeTimePct)),
    medianItemLevel: (() => {
      const levels = members.map((m) => m.itemLevel).filter((l): l is number => l != null && l > 0);
      return levels.length > 0 ? median(levels) : null;
    })(),
    medianCpm,
    usageCount,
    medianDamagePerCast,
    abilityNames,
    medianDamageTakenDpm,
    damageTakenNames,
    estimatedCooldownMs,
    medianBuffUptime,
    buffNames,
    buildMatch,
  };
}
