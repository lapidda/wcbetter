import type { AggregatedFinding } from "./aggregate";

/**
 * Rule families. Findings inside a family largely measure the same seconds —
 * uptime, the gap list and recurring downtime are one problem seen three ways —
 * so "the three things to fix" is chosen one family at a time.
 */
export type FindingFamily = "opener" | "burn" | "downtime" | "rotation" | "survival" | "preparation";

/**
 * Display order. The opener and the burn lead because they are the two windows
 * of the pull that are scripted, and so the most practisable things here.
 */
export const FAMILY_ORDER: FindingFamily[] = [
  "opener",
  "burn",
  "downtime",
  "rotation",
  "survival",
  "preparation",
];

export const FAMILY_LABEL: Record<FindingFamily, string> = {
  opener: "Opener",
  burn: "Burn phase",
  downtime: "Downtime",
  rotation: "Rotation",
  survival: "Survival",
  preparation: "Preparation",
};

export function familyOf(f: Pick<AggregatedFinding, "rule" | "id">): FindingFamily {
  if (f.rule === "active-time" || f.rule === "recurring-downtime" || f.id === "opener:latency") {
    return "downtime";
  }
  if (f.id === "opener:sequence") return "opener";
  // The whole burn analysis is one window, so it caps at one focus item too.
  if (f.rule === "burn") return "burn";
  if (f.rule === "opener" || f.rule === "cast-frequency" || f.rule === "missed-cooldowns") {
    return "rotation";
  }
  if (f.rule === "deaths" || f.rule === "avoidable-damage") return "survival";
  return "preparation";
}

export interface FocusItem {
  findingId: string;
  family: FindingFamily;
  rank: 1 | 2 | 3;
  /** Median gain when it fires, as % of the player's own damage. */
  gainPct?: number;
  /** The same gain at the player's median DPS. */
  gainDps?: number;
  /** Share of the DPS gap to the reference this alone would close, 0-1. */
  gapShare?: number;
}

/** Families where a second focus item is never allowed, because the findings overlap almost entirely. */
const SINGLE_ITEM_FAMILIES = new Set<FindingFamily>(["downtime", "burn"]);

function eligible(f: AggregatedFinding): boolean {
  // Sequence cards are reference material, not a finding to act on.
  const isSequence = f.id === "opener:sequence" || f.id === "burn:sequence";
  return f.severity !== "info" && !isSequence && !f.id.startsWith("error:");
}

/**
 * The bounded action list at the top of the report. Findings arrive in
 * priority order; pass one takes the best of each family, pass two fills any
 * remaining slots with second picks — except in families that measure the same
 * seconds, where a second item would be the first one restated.
 */
export function selectFocus(
  findings: AggregatedFinding[],
  medianDps: number,
  deltaDps: number,
  n = 3,
): FocusItem[] {
  const candidates = findings.filter(eligible);
  const chosen: AggregatedFinding[] = [];
  const perFamily = new Map<FindingFamily, number>();

  for (const pass of [1, 2]) {
    for (const f of candidates) {
      if (chosen.length >= n) break;
      if (chosen.includes(f)) continue;
      const family = familyOf(f);
      const have = perFamily.get(family) ?? 0;
      const cap = pass === 1 || SINGLE_ITEM_FAMILIES.has(family) ? 1 : 2;
      if (have >= cap) continue;
      chosen.push(f);
      perFamily.set(family, have + 1);
    }
  }

  return chosen.map((f, i) => {
    const gainPct = f.medianGainPct;
    const gainDps = gainPct != null ? (gainPct / 100) * medianDps : undefined;
    return {
      findingId: f.id,
      family: familyOf(f),
      rank: (i + 1) as 1 | 2 | 3,
      gainPct,
      gainDps,
      gapShare: gainDps != null && deltaDps > 0 ? Math.min(1, gainDps / deltaDps) : undefined,
    };
  });
}

/**
 * Combined gain of the focus items. Diminishing weights, because even across
 * families the seconds overlap: a missed cooldown often sits inside a downtime
 * gap. Three items is few enough for this to be defensible as a total.
 */
export function focusGain(focus: FocusItem[], medianDps: number): { pct: number; dps: number } {
  const pct = focus
    .map((f) => f.gainPct ?? 0)
    .filter((g) => g > 0)
    .sort((a, b) => b - a)
    .reduce((total, gain, i) => total + gain / (i + 1), 0);
  return { pct, dps: (pct / 100) * medianDps };
}

/** A finding that fired on exactly one of several pulls is a bad pull, not a habit. */
export function isOneOff(f: Pick<AggregatedFinding, "occurrences" | "totalPulls">): boolean {
  return f.occurrences === 1 && f.totalPulls > 2;
}

/**
 * Everything not in the focus block, grouped by family, plus the one-offs
 * pulled out so a night of wipes does not read as forty separate problems.
 */
export function sectionize(
  findings: AggregatedFinding[],
  focusIds: Set<string>,
): { sections: Record<FindingFamily, string[]>; oneOffs: string[] } {
  const sections: Record<FindingFamily, string[]> = {
    opener: [],
    burn: [],
    downtime: [],
    rotation: [],
    survival: [],
    preparation: [],
  };
  const oneOffs: string[] = [];

  for (const f of findings) {
    if (focusIds.has(f.id) || f.id.startsWith("error:")) continue;
    if (isOneOff(f)) {
      oneOffs.push(f.id);
      continue;
    }
    sections[familyOf(f)].push(f.id);
  }

  return { sections, oneOffs };
}
