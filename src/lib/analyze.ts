import { aggregateFindings, findRecurringDowntime } from "./model/aggregate";
import type { AggregatedFinding, PullSummary } from "./model/aggregate";
import { buildReferenceProfile } from "./model/benchmark";
import { buildAbilityRows, type AbilityRow } from "./model/abilities";
import { mechanicBefore } from "./model/encounter";
import { focusGain, sectionize, selectFocus, type FindingFamily, type FocusItem } from "./model/focus";
import { buildPlayerProfile } from "./model/profile";
import { formatDuration, median } from "./model/stats";
import type { PlayerProfile, ReferenceProfile } from "./model/types";
import { buildEncounterContext } from "./raid-context";
import { runRules } from "./rules";
import { getReportMeta, getTable } from "./wcl/fetchers";
import { difficultyName, type Fight, type ReportMeta } from "./wcl/types";

export interface AnalysisReport {
  report: { code: string; title: string };
  encounter: { id: number; name: string; difficulty: string };
  player: {
    actorId: number;
    name: string;
    className: string | null;
    specName: string | null;
    itemLevel: number | null;
  };
  pulls: PullSummary[];
  totals: {
    medianDps: number;
    bestDps: number;
    medianActiveTimePct: number;
    deaths: number;
  };
  reference: {
    encounterName: string;
    specName: string | null;
    className: string | null;
    medianDps: number;
    medianActiveTimePct: number;
    members: Array<{
      name: string;
      dps: number;
      reportCode: string;
      fightId: number;
      actorId: number;
      itemLevel: number | null;
    }>;
    /** Median item level of the reference parses — the gear context for the DPS gap. */
    medianItemLevel: number | null;
    /** How closely the reference set matches the player's talent build. */
    buildMatch: { matched: boolean; similarity: number };
  };
  findings: AggregatedFinding[];
  /** Estimated recoverable throughput across all findings, discounted for overlap. */
  estimatedTotalGainPct: number;

  /** The distance to the reference, which every gain below is a share of. */
  gap: {
    playerMedianDps: number;
    referenceMedianDps: number;
    /** Reference minus player; negative when the player is ahead. */
    deltaDps: number;
    /** How far below the reference the player sits, as % of the reference. */
    deltaPct: number;
  };
  /** The bounded "fix these first" list, one family at a time. */
  focus: FocusItem[];
  focusGainPct: number;
  focusGainDps: number;
  /** Remaining finding ids by family, in priority order. */
  sections: Record<FindingFamily, string[]>;
  /** Findings that fired on a single pull of several: shown collapsed. */
  oneOffs: string[];
  /** Rule failures. Kept out of the plan so an internal error never reads as coaching. */
  warnings: string[];

  /** Boss abilities seen across the selected pulls, named by the log. Empty if unavailable. */
  enemyAbilities: Record<number, { name: string; icon: string | null }>;
  /** Null when the enemy-side log could not be fetched; the rules then run unlabelled. */
  bossContext: {
    abilities: number;
    castsPerPull: number[];
    /** Player abilities the enemy-side log misattributed to the environment, dropped by name. */
    friendlyExcluded: string[];
  } | null;

  /** Compact per-pull view for the timeline strip; full profiles never leave the server. */
  timelines: PullTimeline[];
  /** The rotation as a table: every ability you or the reference cast, side by side. */
  abilities: AbilityRow[];
  /** gameID -> icon file, merged across your abilities and the boss's. */
  icons: Record<number, string>;
}

export interface PullTimeline {
  fightId: number;
  /** Report-relative ms: the base every WCL start=/end= link is built on. */
  startTime: number;
  durationMs: number;
  /** Cast times in ms, sorted. */
  casts: number[];
  gaps: Array<{ s: number; e: number; mechanic?: number }>;
  deaths: Array<{ at: number; ability: string | null }>;
  bossCasts: Array<{ at: number; id: number }>;
  /** When the boss entered execute range, or null if this pull never got there. */
  burnStartMs: number | null;
}

export interface AnalyzeArgs {
  code: string;
  actorId: number;
  /** Every pull to include. All must be the same encounter and difficulty. */
  fightIds: number[];
  referenceSize?: number;
  onProgress?: (message: string) => void;
}

export async function analyzeEncounter(args: AnalyzeArgs): Promise<AnalysisReport> {
  const progress = args.onProgress ?? (() => {});

  if (args.fightIds.length === 0) throw new Error("Select at least one pull to analyse.");

  progress("Loading report...");
  const meta = await getReportMeta(args.code);

  const actor = meta.masterData.actors.find((a) => a.id === args.actorId);
  if (!actor) throw new Error(`Player ${args.actorId} is not in report ${args.code}.`);

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

  // --- Profile every pull ----------------------------------------------------
  const profiled: Array<{ pull: PullSummary; profile: PlayerProfile }> = [];

  // Talents are only needed once — to pick the reference set — so the first pull
  // fetches them and the rest reuse them. Fetching per pull would cost one
  // CombatantInfo query per pull for a value we use a single time.
  let talents: number[] | undefined;

  for (const [i, fight] of fights.entries()) {
    progress(`Profiling pull ${i + 1}/${fights.length} (${formatDuration(fight.endTime - fight.startTime)})...`);

    const profile = await buildPlayerProfile({
      key: `player:${fight.id}`,
      reportCode: args.code,
      fight,
      actor,
      withTimeline: true,
      talents,
    });

    talents ??= profile.talents.length > 0 ? profile.talents : undefined;
    profiled.push({ pull: summarizePull(fight, profile, i), profile });
  }

  // Spec comes off the damage table, so it is only known once a pull is profiled.
  const withSpec = profiled.find((p) => p.profile.specName) ?? profiled[0];
  const { className, specName } = withSpec.profile;

  // --- One reference set for the whole session -------------------------------
  const reference: ReferenceProfile = await buildReferenceProfile({
    encounterID,
    encounterName: fights[0].name,
    difficulty,
    className,
    specName,
    metric: "dps",
    size: args.referenceSize ?? 5,
    excludeCharacter: actor.name,
    // Hero talents change which buttons a spec presses, so the reference set is
    // matched to the player's actual build rather than to the spec name alone.
    playerTalents: withSpec.profile.talents,
    onProgress: progress,
  });

  // --- Boss-ability context --------------------------------------------------
  // The enemy-side log names what the boss was doing when a gap or death
  // happened. Shared with the raid-wide note analysis, which needs the same
  // timeline and none of the reference-parse machinery around it.
  const encounter = await buildEncounterContext(args.code, fights, progress);
  const context = encounter.context;
  const friendlyExcluded = encounter.friendlyExcluded;
  const contextWarnings = encounter.warnings;

  // --- Rules per pull, then aggregate ---------------------------------------
  progress(`Running analysis across ${fights.length} pulls...`);

  const perPull = profiled.map(({ pull, profile }, i) => ({
    pull,
    findings: runRules({
      player: profile,
      reference,
      fight: fights[i],
      bossCasts: context?.castsByFight[fights[i].id],
      enemyAbilities: context?.abilities,
    }),
  }));

  const ranked = [
    ...aggregateFindings(perPull),
    ...findRecurringDowntime(profiled, reference, context ?? undefined),
  ].sort((a, b) => b.priority - a.priority);

  // A rule that threw is a bug report, not a finding.
  const warnings = [
    ...contextWarnings,
    ...ranked.filter((f) => f.id.startsWith("error:")).map((f) => `${f.title}: ${f.detail}`),
  ];
  const findings = ranked.filter((f) => !f.id.startsWith("error:"));

  const pulls = profiled.map((p) => p.pull);
  const playerMedianDps = median(pulls.map((p) => p.dps));
  const gap = {
    playerMedianDps,
    referenceMedianDps: reference.medianDps,
    deltaDps: reference.medianDps - playerMedianDps,
    deltaPct:
      reference.medianDps > 0
        ? ((reference.medianDps - playerMedianDps) / reference.medianDps) * 100
        : 0,
  };

  const focus = selectFocus(findings, playerMedianDps, gap.deltaDps);
  const focusTotal = focusGain(focus, playerMedianDps);
  const { sections, oneOffs } = sectionize(findings, new Set(focus.map((f) => f.findingId)));

  const timelines: PullTimeline[] = profiled.map(({ profile }, i) => {
    const fight = fights[i];
    const casts = context?.castsByFight[fight.id] ?? [];
    return {
      fightId: fight.id,
      startTime: fight.startTime,
      durationMs: profile.durationMs,
      casts: profile.castTimeline.map((c) => Math.round(c.atMs)),
      gaps: profile.gaps.map((g) => ({
        s: Math.round(g.startMs),
        e: Math.round(g.endMs),
        ...(context ? { mechanic: mechanicBefore(casts, context.abilities, g.startMs)?.gameID } : {}),
      })),
      deaths: profile.deaths.map((d) => ({ at: Math.round(d.atMs), ability: d.killingAbility })),
      bossCasts: casts.map((c) => ({ at: Math.round(c.atMs), id: c.gameID })),
      burnStartMs: profile.burnStartMs,
    };
  });

  const abilities = buildAbilityRows(
    profiled.map((p) => p.profile),
    reference,
    findings,
    playerMedianDps,
  );

  return {
    report: { code: meta.code, title: meta.title },
    encounter: {
      id: encounterID,
      name: fights[0].name,
      difficulty: difficultyName(difficulty),
    },
    player: {
      actorId: actor.id,
      name: actor.name,
      className,
      specName,
      itemLevel: median(profiled.map((p) => p.profile.itemLevel ?? 0)) || null,
    },
    pulls,
    totals: {
      medianDps: playerMedianDps,
      bestDps: Math.max(...pulls.map((p) => p.dps)),
      medianActiveTimePct: median(pulls.map((p) => p.activeTimePct)),
      deaths: pulls.reduce((sum, p) => sum + p.deaths, 0),
    },
    reference: {
      encounterName: reference.encounterName,
      specName: reference.specName,
      className: reference.className,
      medianDps: reference.medianDps,
      medianActiveTimePct: reference.medianActiveTimePct,
      members: reference.members.map((m) => ({
        name: m.name,
        dps: m.dps,
        reportCode: m.reportCode,
        fightId: m.fightId,
        actorId: m.actorId,
        itemLevel: m.itemLevel,
      })),
      medianItemLevel: reference.medianItemLevel,
      buildMatch: reference.buildMatch,
    },
    findings,
    estimatedTotalGainPct: estimateTotalGain(findings),
    gap,
    focus,
    focusGainPct: focusTotal.pct,
    focusGainDps: focusTotal.dps,
    sections,
    oneOffs,
    warnings,
    enemyAbilities: Object.fromEntries(
      Object.values(context?.abilities ?? {}).map((a) => [a.gameID, { name: a.name, icon: a.icon }]),
    ),
    bossContext: context
      ? {
          abilities: Object.keys(context.abilities).length,
          castsPerPull: fights.map((f) => context!.castsByFight[f.id]?.length ?? 0),
          friendlyExcluded,
        }
      : null,
    timelines,
    abilities,
    icons: Object.fromEntries([
      ...abilities.filter((a) => a.icon).map((a) => [a.gameID, a.icon as string]),
      ...Object.values(context?.abilities ?? {})
        .filter((a) => a.icon)
        .map((a) => [a.gameID, a.icon as string]),
    ]),
  };
}

function summarizePull(fight: Fight, profile: PlayerProfile, index: number): PullSummary {
  const durationMs = fight.endTime - fight.startTime;
  return {
    fightId: fight.id,
    label: `Pull ${index + 1} · ${formatDuration(durationMs)} · ${
      fight.kill ? "kill" : `${fight.bossPercentage?.toFixed(1) ?? "?"}%`
    }`,
    durationMs,
    kill: fight.kill ?? false,
    bossPercentage: fight.bossPercentage,
    dps: profile.dps,
    activeTimePct: profile.activeTimePct,
    deaths: profile.deaths.length,
  };
}

/**
 * Findings overlap heavily — a missed cooldown is usually also part of a
 * downtime gap — so summing them overstates the ceiling badly. Take the largest
 * at full weight and add diminishing fractions of the rest. Only findings with a
 * real measured gain contribute; severity-only findings have no throughput
 * number to add.
 */
function estimateTotalGain(findings: AggregatedFinding[]): number {
  return findings
    .map((f) => (f.medianGainPct ?? 0) * f.consistency)
    .filter((g) => g > 0)
    .sort((a, b) => b - a)
    .reduce((total, gain, i) => total + gain / (i + 1), 0);
}

/** Everything the pickers need, without running an analysis. */
export interface ReportSummary {
  code: string;
  title: string;
  zone: string | null;
  fights: Array<{
    id: number;
    encounterID: number;
    name: string;
    difficulty: string;
    kill: boolean;
    durationMs: number;
    bossPercentage: number | null;
    /** Actor ids present in this pull, so the UI can hide pulls the player sat out. */
    friendlyPlayers: number[];
  }>;
  players: Array<{
    id: number;
    name: string;
    className: string;
    /** From the damage table's "Class-Spec" icon, when that fight was fetched. */
    specName: string | null;
    /** Damage on the sampled fight: sorts the raid so DPS come first. */
    damage: number;
  }>;
  /** What the pasted URL pointed at, resolved against this report, for prefilling the pickers. */
  link: { fightId: number | null; sourceId: number | null };
}

export async function summarizeReport(
  code: string,
  link: { fightId?: number | "last"; sourceId?: number } = {},
): Promise<ReportSummary> {
  const meta: ReportMeta = await getReportMeta(code);

  // Only echo a link back if it actually resolves in this report; a stale
  // `fight=` from a different log must not select anything.
  const lastFightId = meta.fights.reduce((max, f) => Math.max(max, f.id), 0);
  const wantedFight = link.fightId === "last" ? lastFightId : link.fightId;
  const fightId = meta.fights.some((f) => f.id === wantedFight) ? (wantedFight as number) : null;
  const sourceId = meta.masterData.actors.some((a) => a.id === link.sourceId && a.type === "Player")
    ? (link.sourceId as number)
    : null;

  // Spec and damage for the picker, from one fight-wide damage table — the
  // linked fight when there is one, else the longest, since that is the pull
  // most of the raid was actually present for. Profiling reuses this from the
  // cache, so it is free. Without it the picker is 20 names in alphabetical
  // order with no way to tell your healer from your DPS.
  const sampleFight =
    meta.fights.find((f) => f.id === fightId) ??
    [...meta.fights].sort((a, b) => b.endTime - b.startTime - (a.endTime - a.startTime))[0];

  let damageByActor: Record<number, { damage: number; specName: string | null }> = {};
  if (sampleFight) {
    try {
      const table = await getTable(code, sampleFight.id, "DamageDone");
      damageByActor = Object.fromEntries(
        (table.entries ?? []).map((row) => {
          const icon = typeof row.icon === "string" ? row.icon : "";
          return [
            Number(row.id),
            { damage: Number(row.total ?? 0), specName: icon.split("-")[1] ?? null },
          ];
        }),
      );
    } catch {
      // A picker without specs still works; nothing here is worth failing on.
    }
  }

  return {
    code: meta.code,
    title: meta.title,
    zone: meta.zone?.name ?? null,
    link: { fightId, sourceId },
    fights: meta.fights.map((f: Fight) => ({
      id: f.id,
      encounterID: f.encounterID,
      name: f.name,
      difficulty: difficultyName(f.difficulty),
      kill: f.kill ?? false,
      durationMs: f.endTime - f.startTime,
      bossPercentage: f.bossPercentage,
      friendlyPlayers: f.friendlyPlayers ?? [],
    })),
    players: meta.masterData.actors
      .filter((a) => a.type === "Player")
      .map((a) => ({
        id: a.id,
        name: a.name,
        className: a.subType,
        specName: damageByActor[a.id]?.specName ?? null,
        damage: damageByActor[a.id]?.damage ?? 0,
      }))
      // Damage first: the DPS this tool is for float to the top and the healers
      // and tanks sink, without a hardcoded list of which specs are which.
      .sort((a, b) => b.damage - a.damage || a.name.localeCompare(b.name)),
  };
}
