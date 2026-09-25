import type { Finding, Severity } from "@/lib/rules";
import { mechanicBefore } from "./encounter";
import { formatDuration, median } from "./stats";
import type { EncounterContext, PlayerProfile, ReferenceProfile } from "./types";

export interface PullSummary {
  fightId: number;
  label: string;
  durationMs: number;
  kill: boolean;
  bossPercentage: number | null;
  dps: number;
  activeTimePct: number;
  deaths: number;
}

export interface AggregatedFinding extends Finding {
  /** Pulls where this finding fired. */
  occurrences: number;
  totalPulls: number;
  /** occurrences / totalPulls. */
  consistency: number;
  /** Median estimated gain across the pulls where it fired. */
  medianGainPct?: number;
  /** Ranking score: impact discounted by how often it actually happens. */
  priority: number;
  /** The pull whose detail/metric/evidence text is shown; anchors are relative to it. */
  representativeFightId: number;
  perPull: Array<{
    fightId: number;
    label: string;
    title: string;
    gainPct?: number;
    /** A window on that pull worth opening in the log. */
    anchor?: { atMs: number; endMs?: number };
  }>;
}

/** Impact stand-in for rules that do not estimate a throughput gain (avoidable damage, deaths). */
const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 6,
  major: 3,
  minor: 1,
  info: 0.2,
};

/**
 * A one-off still counts for something — it might repeat — but an every-pull
 * habit is what actually costs you the tier. 0.4 is the floor so a single
 * catastrophic mistake never sorts below a trivial but constant one.
 */
export function priorityOf(impact: number, consistency: number): number {
  return impact * (0.4 + 0.6 * consistency);
}

/**
 * Rules run per pull; this merges their output by finding id. Keeping the rules
 * single-fight means none of them had to learn about aggregation, and the
 * per-pull breakdown survives intact.
 */
export function aggregateFindings(
  perPull: Array<{ pull: PullSummary; findings: Finding[] }>,
): AggregatedFinding[] {
  const totalPulls = perPull.length;
  const groups = new Map<string, Array<{ pull: PullSummary; finding: Finding }>>();

  for (const { pull, findings } of perPull) {
    for (const finding of findings) {
      const group = groups.get(finding.id);
      if (group) group.push({ pull, finding });
      else groups.set(finding.id, [{ pull, finding }]);
    }
  }

  const aggregated: AggregatedFinding[] = [];

  for (const [id, group] of groups) {
    const gains = group.map((g) => g.finding.estimatedGainPct ?? 0).filter((g) => g > 0);
    const medianGainPct = gains.length ? median(gains) : undefined;

    // The representative is a real pull, not a synthesised average, so the
    // detail text and evidence always describe something that actually happened.
    const representative = pickRepresentative(group, medianGainPct);

    const consistency = group.length / totalPulls;
    const impact = medianGainPct ?? SEVERITY_WEIGHT[representative.finding.severity];

    aggregated.push({
      ...representative.finding,
      id,
      // One pull's title next to an "every pull" badge misreads ("died at 1:37"
      // twelve times); when the rule left structured facts, summarise them.
      title: (group.length > 1 && aggregateTitle(id, group, totalPulls)) || representative.finding.title,
      occurrences: group.length,
      totalPulls,
      consistency,
      medianGainPct,
      representativeFightId: representative.pull.fightId,
      priority: priorityOf(impact, consistency),
      evidence: [
        `Seen on ${group.length} of ${totalPulls} pulls`,
        `Detail below is from ${representative.pull.label}`,
        ...representative.finding.evidence,
      ],
      perPull: group.map((g) => ({
        fightId: g.pull.fightId,
        label: g.pull.label,
        title: g.finding.title,
        gainPct: g.finding.estimatedGainPct,
      })),
    });
  }

  return aggregated.sort((a, b) => b.priority - a.priority);
}

/** A number for prose: "2", not "2.0"; "1.5" when it genuinely is. */
const tidy = (n: number) => String(Number(n.toFixed(1)));

/**
 * A title that describes the whole group of pulls, built from the `facts` each
 * rule leaves behind. Returns undefined when the rule left none, in which case
 * the representative pull's title stands.
 */
function aggregateTitle(
  id: string,
  group: Array<{ pull: PullSummary; finding: Finding }>,
  totalPulls: number,
): string | undefined {
  const facts = group.map((g) => g.finding.facts);
  if (facts.some((f) => !f)) return undefined;
  const rows = facts as Array<NonNullable<Finding["facts"]>>;
  const nums = (key: string) => rows.map((f) => Number(f[key])).filter(Number.isFinite);
  const n = group.length;
  const rule = group[0].finding.rule;

  switch (rule) {
    case "deaths": {
      const counts = new Map<string, number>();
      for (const f of rows) {
        const abilities = Array.isArray(f.killingAbilities) ? f.killingAbilities : [];
        for (const a of abilities) counts.set(String(a), (counts.get(String(a)) ?? 0) + 1);
      }
      const top = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, c]) => `${name} (${c})`)
        .join(", ");
      return `Died on ${n} of ${totalPulls} pulls — ${top}`;
    }
    case "missed-cooldowns":
      return (
        `Missed casts of ${rows[0].ability} on ${n} of ${totalPulls} pulls ` +
        `(median ${tidy(median(nums("missed")))} of ${tidy(median(nums("possible")))} possible)`
      );
    case "active-time":
      if (id === "active-time:overall") {
        return (
          `Uptime ${median(nums("activePct")).toFixed(1)}% (median) vs ` +
          `${median(nums("refActivePct")).toFixed(1)}% for top parses`
        );
      }
      if (id === "active-time:gaps") {
        return (
          `A median of ${tidy(median(nums("gapCount")))} gaps of 3s+ per pull, ` +
          `${formatDuration(median(nums("gapMs")))} lost`
        );
      }
      return undefined;
    case "cast-frequency":
      return rows.every((f) => Number(f.neverCast) === 1)
        ? `You never cast ${rows[0].ability} (${n} of ${totalPulls} pulls)`
        : `${rows[0].ability} cast ${tidy(median(nums("shortfallPct")))}% less than top parses (median across pulls)`;
    case "opener":
      if (id === "opener:latency") {
        return `You start a median ${(median(nums("lateMs")) / 1000).toFixed(1)}s later than the top parses`;
      }
      return undefined;
    default:
      return undefined;
  }
}

/** The pull whose gain is closest to the median — the typical case, not the worst. */
function pickRepresentative(
  group: Array<{ pull: PullSummary; finding: Finding }>,
  medianGainPct: number | undefined,
): { pull: PullSummary; finding: Finding } {
  if (medianGainPct == null) return group[0];

  return group.reduce((best, candidate) => {
    const bestDelta = Math.abs((best.finding.estimatedGainPct ?? 0) - medianGainPct);
    const delta = Math.abs((candidate.finding.estimatedGainPct ?? 0) - medianGainPct);
    return delta < bestDelta ? candidate : best;
  });
}

/** Fight-relative bucket width for recurring-downtime detection. */
const BUCKET_MS = 15_000;
const NOTABLE_GAP_MS = 3000;

/**
 * The analysis that only exists with multiple pulls: downtime landing at the
 * same point in the fight, pull after pull. A gap at 2:30 on one pull is noise;
 * a gap at 2:30 on five of seven pulls is a mechanic you have not solved.
 */
/** A gap counts as "stopping" in a window when it starts inside it and is at least this long. */
function stallsInWindow(gaps: PlayerProfile["gaps"], windowStart: number, windowEnd: number) {
  return gaps.filter(
    (g) => g.durationMs >= NOTABLE_GAP_MS && g.startMs >= windowStart && g.startMs < windowEnd,
  );
}

export function findRecurringDowntime(
  profiles: Array<{ pull: PullSummary; profile: PlayerProfile }>,
  /** When given, the same window is checked in the top parses, so the advice can say whether stopping here is forced. */
  reference?: Pick<ReferenceProfile, "members">,
  /** When given, the window is labelled with the boss cast that precedes it on most affected pulls. */
  context?: EncounterContext,
): AggregatedFinding[] {
  const totalPulls = profiles.length;
  if (totalPulls < 3) return [];

  // bucket -> the pulls that had a notable gap starting in it
  const buckets = new Map<number, Array<{ pull: PullSummary; startMs: number; durationMs: number }>>();

  for (const { pull, profile } of profiles) {
    const seenThisPull = new Set<number>();

    for (const gap of profile.gaps) {
      if (gap.durationMs < NOTABLE_GAP_MS) continue;
      const bucket = Math.floor(gap.startMs / BUCKET_MS);
      // One vote per pull per bucket, so a single long stutter cannot look like a pattern.
      if (seenThisPull.has(bucket)) continue;
      seenThisPull.add(bucket);

      const list = buckets.get(bucket);
      const entry = { pull, startMs: gap.startMs, durationMs: gap.durationMs };
      if (list) list.push(entry);
      else buckets.set(bucket, [entry]);
    }
  }

  // Qualifying buckets, then merged into runs. A player who struggles through a
  // whole phase lights up five consecutive buckets, and reporting that as five
  // findings buries everything else under one behaviour.
  const qualifying = [...buckets.keys()]
    .filter((bucket) => {
      const hits = buckets.get(bucket)!;
      if (hits.length < 2 || hits.length / totalPulls < 0.5) return false;
      // A pull shorter than the bucket could not have had a gap there, so it is
      // not evidence against the pattern and must not dilute the denominator.
      const eligible = profiles.filter((p) => p.profile.durationMs >= bucket * BUCKET_MS).length;
      return eligible > 0 && hits.length / eligible >= 0.5;
    })
    .sort((a, b) => a - b);

  const runs: number[][] = [];
  for (const bucket of qualifying) {
    const last = runs[runs.length - 1];
    if (last && bucket === last[last.length - 1] + 1) last.push(bucket);
    else runs.push([bucket]);
  }

  const findings: AggregatedFinding[] = [];

  for (const run of runs) {
    const hits = run.flatMap((bucket) => buckets.get(bucket)!);

    // Pulls affected, not gaps counted: one pull stalling three buckets in a row
    // is one pull with a problem, not three.
    const affected = new Set(hits.map((h) => h.pull.fightId));
    const eligible = profiles.filter(
      (p) => p.profile.durationMs >= run[run.length - 1] * BUCKET_MS,
    ).length;
    const consistency = eligible > 0 ? affected.size / eligible : 0;

    const windowStart = run[0] * BUCKET_MS;
    const windowEnd = (run[run.length - 1] + 1) * BUCKET_MS;
    const label =
      run.length === 1
        ? `around ${formatDuration(windowStart)}`
        : `between ${formatDuration(windowStart)} and ${formatDuration(windowEnd)}`;

    // Per affected pull, how much time was lost inside this window.
    const perPullLoss = [...affected].map((fightId) =>
      hits.filter((h) => h.pull.fightId === fightId).reduce((sum, h) => sum + h.durationMs, 0),
    );
    const medianLossMs = median(perPullLoss);

    // Do the top parses stop in the same window? Their pulls are different
    // pulls, so phase timings drift a little — which is why this only chooses
    // between two readings of the finding rather than claiming a measurement.
    const members = reference?.members ?? [];
    const refLosses = members.map((m) =>
      stallsInWindow(m.gaps, windowStart, windowEnd).reduce((sum, g) => sum + g.durationMs, 0),
    );
    const refStalls = refLosses.filter((ms) => ms > 0).length;
    const forced = members.length > 0 && refStalls / members.length >= 0.5;
    const refMedianLossMs = refStalls > 0 ? median(refLosses.filter((ms) => ms > 0)) : 0;

    // When the top parses stop here too, the mechanic is stopping them, not a
    // decision the player made — so only the part they lose *beyond* the top
    // parses is theirs to fix. Charging them for the whole window would rank a
    // raid-wide forced break above things they actually control.
    const recoverableMs = forced ? Math.max(0, medianLossMs - refMedianLossMs) : medianLossMs;
    const impact = (recoverableMs / median(profiles.map((p) => p.profile.durationMs))) * 100;

    // Which boss cast precedes the window? One vote per affected pull (its first
    // gap in the run); a mechanic is named only when most pulls agree, and the
    // absence of consensus is stated rather than papered over.
    const leads = context
      ? [...affected].map((fightId) => {
          const first = hits.filter((h) => h.pull.fightId === fightId).sort((a, b) => a.startMs - b.startMs)[0];
          const casts = context.castsByFight[fightId];
          return casts ? mechanicBefore(casts, context.abilities, first.startMs) : null;
        })
      : [];
    const votes = new Map<string, number[]>();
    for (const lead of leads) {
      if (!lead) continue;
      votes.set(lead.name, [...(votes.get(lead.name) ?? []), lead.leadMs]);
    }
    const modal = [...votes.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    const mechanic =
      modal && affected.size > 0 && modal[1].length / affected.size >= 0.5
        ? { name: modal[0], pulls: modal[1].length, medianLeadMs: median(modal[1]) }
        : null;

    findings.push({
      id: `recurring-downtime:${run[0]}-${run[run.length - 1]}`,
      rule: "recurring-downtime",
      // Forced downtime never grades above minor however consistent it is: the
      // player cannot choose not to be moved, only to lose less time to it.
      severity: forced ? "minor" : consistency >= 0.8 ? "major" : "minor",
      title:
        (forced ? `Forced downtime ${label}` : `You stop casting ${label}`) +
        ` on ${affected.size} of ${eligible} pulls` +
        (mechanic ? `, right after ${mechanic.name}` : ""),
      detail:
        `You lose ${(medianLossMs / 1000).toFixed(1)}s (median) in the ` +
        `${formatDuration(windowStart)}–${formatDuration(windowEnd)} window on most of your pulls. ` +
        (forced
          ? `The top parses lose ${(refMedianLossMs / 1000).toFixed(1)}s in the same window, so the ` +
            `estimate below counts only the ${(recoverableMs / 1000).toFixed(1)}s difference.`
          : `Downtime this repeatable is a mechanic, not bad luck.`) +
        (mechanic
          ? ` On ${mechanic.pulls} of ${affected.size} affected pulls the gap starts a median ` +
            `${(Math.max(0, mechanic.medianLeadMs) / 1000).toFixed(1)}s after ${mechanic.name}.`
          : context
            ? ` No single boss cast precedes it consistently.`
            : ""),
      advice: forced
        ? `The top parses stop here as well${mechanic ? ` — ${mechanic.name} forces it` : ""}, so most ` +
          `of this is not yours to fix. They lose ${(refMedianLossMs / 1000).toFixed(1)}s here and you ` +
          `lose ${(medianLossMs / 1000).toFixed(1)}s; only the ${(recoverableMs / 1000).toFixed(1)}s ` +
          `difference is worth chasing — they get back on the boss sooner, not through it.`
        : mechanic
          ? `The top parses keep casting through ${mechanic.name}. Plan for it: pre-position before ` +
            `it lands, save an instant cast, or line up a movement ability.`
          : `The top parses keep casting through this window. Find out what the boss does ${label} ` +
            `and plan for it: pre-position, save an instant cast, or line up a movement ability.`,
      facts: {
        ...(mechanic ? { mechanic: mechanic.name } : {}),
        forced: forced ? 1 : 0,
        recoverableMs,
      },
      metric: {
        label: "Pulls with a 3s+ gap in this window",
        you: `${affected.size}/${eligible}`,
        reference: reference ? `${refStalls}/${members.length} top parses` : "not measured",
      },
      evidence: hits
        .sort((a, b) => a.startMs - b.startMs)
        .map(
          (h) => `${h.pull.label}: ${formatDuration(h.startMs)} (${(h.durationMs / 1000).toFixed(1)}s)`,
        ),
      estimatedGainPct: impact,
      occurrences: affected.size,
      totalPulls: eligible,
      consistency,
      medianGainPct: impact,
      priority: priorityOf(impact, consistency),
      representativeFightId: [...affected][0],
      anchors: [{ atMs: windowStart, endMs: windowEnd, label: `${formatDuration(windowStart)} window` }],
      perPull: [...affected].map((fightId) => {
        const forPull = hits
          .filter((h) => h.pull.fightId === fightId)
          .sort((a, b) => a.startMs - b.startMs);
        const lost = forPull.reduce((sum, h) => sum + h.durationMs, 0);
        return {
          fightId,
          label: forPull[0].pull.label,
          title: `${(lost / 1000).toFixed(1)}s lost across ${forPull.length} gap${forPull.length === 1 ? "" : "s"}`,
          gainPct: undefined,
          anchor: { atMs: forPull[0].startMs, endMs: forPull[0].startMs + forPull[0].durationMs },
        };
      }),
    });
  }

  return findings;
}
