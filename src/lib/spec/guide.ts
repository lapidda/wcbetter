// A class guide's priority lists, as a reference card on a spec tab: the
// shapes every spec's guide data uses, and the one rule that crosses out lines
// a build cannot use. The order of each list is the guide's; the wording is
// ours, kept short, with the guide linked for the full text and its reasoning.

export interface GuideSource {
  name: string;
  url: string;
  patch: string;
  updated: string;
}

export type Need = { cast: string } | { buff: string } | { talent: string };

export interface GuideLine {
  action: string;
  /** When the line applies; empty for an unconditional line. */
  when?: string;
  /** All of these must be in your build for the line to apply. */
  needs?: Need[];
}

export interface GuideList {
  id: string;
  /** Which switch on the card shows it: a hero tree, usually. */
  group: string;
  target: "single" | "aoe";
  /** The line numbering matches this list, which is what a priority check on the tab uses. */
  lines: GuideLine[];
}

export interface GuideSet {
  source: GuideSource;
  groups: Array<{ id: string; label: string }>;
  lists: GuideList[];
  /** Tab label per list id. */
  labels: Record<string, string>;
  /** Lists the tab's priority check judges, so crossing a line out there hides it from the check. */
  checked: string[];
  /** The flowchart's last box, when nothing above applies. */
  idle: string;
  /** Where crossed-out lines are remembered in the browser. */
  storageKey: string;
  /** Button colours for the flowchart: "gen" (builder), "big" (hitter), "cd" (cooldown). */
  colours?: Record<string, "gen" | "big" | "cd">;
  /** One line under the card, if the guide needs it. */
  note?: string;
}

/** What the log shows of your build: buttons pressed, buffs had, talents picked. */
export interface BuildEvidence {
  /** Buttons cast or dealing damage on these pulls. */
  casts: string[];
  buffs: string[];
  /** Null when the log carried no talents; talent lines are then never crossed out. */
  talents: string[] | null;
}

/** Why a line does not fit your build, or null when it does (or the log cannot tell). */
export function missingFromBuild(line: GuideLine, evidence: BuildEvidence): string | null {
  for (const need of line.needs ?? []) {
    if ("cast" in need && !evidence.casts.includes(need.cast)) return `you never used ${need.cast} on these pulls`;
    if ("buff" in need && !evidence.buffs.includes(need.buff)) return `you never had ${need.buff} on these pulls`;
    if ("talent" in need && evidence.talents && !evidence.talents.includes(need.talent)) return `${need.talent} is not in your talents`;
  }
  return null;
}
