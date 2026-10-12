// Peak of Serenity's Windwalker priority lists, as a reference card on the
// Windwalker tab. The order is the guide's; the wording is ours, kept short —
// the guide itself is linked for the full text and its reasoning.
//
// Each line can name what it depends on — a button, a buff or a talent — so a
// line your build cannot use is crossed out from what the log shows: a button
// you never pressed, a buff you never had, a talent you did not pick. The
// guide says to skip such steps; this does it for you, and you can override.

export const GUIDE_SOURCE = {
  name: "Peak of Serenity — Windwalker Monk PvE Guide",
  url: "https://www.peakofserenity.com/tww/windwalker/pve-guide/",
  patch: "12.1",
  updated: "2026-09-23",
} as const;

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
  tree: "conduit" | "shado-pan";
  target: "single" | "aoe";
  variant: "default" | "advanced";
  /** The line numbering matches this list, which is what the priority check on the tab uses. */
  lines: GuideLine[];
}

const WDP = "Whirling Dragon Punch";
const SOTW = "Strike of the Windlord";
const STOMP = "Zenith Stomp";
const FOF = "Fists of Fury";
const TP = "Tiger Palm";
const RSK = "Rising Sun Kick";
const RWK = "Rushing Wind Kick";
const SCK = "Spinning Crane Kick";
const BOK = "Blackout Kick";
const CONDUIT = "Celestial Conduit";
const TOD = "Touch of Death";
const SLICING = "Slicing Winds";

const cast = (name: string): Need => ({ cast: name });
const buff = (name: string): Need => ({ buff: name });
const talent = (name: string): Need => ({ talent: name });
/** Unbroken Rhythm is the Season 2 four-piece bonus. */
const RHYTHM = buff("Unbroken Rhythm");
const DANCE = buff("Dance of Chi-Ji");

const ENERGY_CAP = "Energy is about to cap, outside Zenith and Bloodlust";
const NO_FOF_CHI = "you are short of Chi for Fists of Fury";
const XUEN_AWAY = "Xuen is more than 10s away";

export const GUIDE_LISTS: GuideList[] = [
  {
    id: "st-default-conduit",
    tree: "conduit",
    target: "single",
    variant: "default",
    lines: [
      { action: WDP, when: XUEN_AWAY, needs: [cast(WDP)] },
      { action: CONDUIT, when: "no Heart of the Jade Serpent from Whirling Dragon Punch or Strike of the Windlord is up", needs: [cast(CONDUIT)] },
      { action: STOMP, when: "Chi is low, Zenith is about to end, or during Conduit's channel", needs: [cast(STOMP)] },
      { action: FOF, when: "Heart of the Jade Serpent has under 1s left" },
      { action: TP, when: `${ENERGY_CAP} — or ${NO_FOF_CHI}` },
      { action: FOF },
      { action: RWK, needs: [cast(RWK)] },
      { action: SCK, when: "Unbroken Rhythm (Season 2 four-piece) is up", needs: [RHYTHM] },
      { action: RSK },
      { action: BOK, when: "Combo Breaker is up, or in Zenith with Obsidian Spiral" },
      { action: SCK, when: "in Zenith with more than 4 Chi or Dance of Chi-Ji" },
      { action: TP, when: "under 2 Chi" },
      { action: SCK, when: "Dance of Chi-Ji is up", needs: [DANCE] },
      { action: TP, when: "it does not overcap Chi" },
      { action: BOK },
    ],
  },
  {
    id: "st-advanced-conduit",
    tree: "conduit",
    target: "single",
    variant: "advanced",
    lines: [
      { action: WDP, when: `in its grace period and ${XUEN_AWAY}`, needs: [cast(WDP)] },
      { action: STOMP, when: "Chi is low, Zenith is about to end, or during Conduit's channel", needs: [cast(STOMP)] },
      { action: FOF, when: "Heart of the Jade Serpent has under 1s left" },
      { action: TP, when: ENERGY_CAP },
      { action: FOF },
      { action: WDP, when: XUEN_AWAY, needs: [cast(WDP)] },
      { action: SOTW, when: XUEN_AWAY, needs: [cast(SOTW)] },
      { action: CONDUIT, when: "no Heart of the Jade Serpent from Whirling Dragon Punch or Strike of the Windlord is up", needs: [cast(CONDUIT)] },
      { action: TP, when: NO_FOF_CHI },
      { action: RWK, needs: [cast(RWK)] },
      { action: SCK, when: "Dance of Chi-Ji and Unbroken Rhythm are both up", needs: [DANCE, RHYTHM] },
      { action: RSK, when: "in Bloodlust, without Dance of Chi-Ji" },
      { action: SCK, when: "Unbroken Rhythm (Season 2 four-piece) is up", needs: [RHYTHM] },
      { action: RSK },
      { action: BOK, when: "Combo Breaker has 2 stacks" },
      { action: BOK, when: "in Zenith with Combo Breaker, or with Obsidian Spiral" },
      { action: SCK, when: "in Zenith with more than 4 Chi or Dance of Chi-Ji" },
      { action: TOD },
      { action: TP, when: "under 2 Chi" },
      { action: BOK, when: "Combo Breaker is up" },
      { action: SCK, when: "Dance of Chi-Ji is up", needs: [DANCE] },
      { action: SLICING, needs: [cast(SLICING)] },
      { action: TP, when: "it does not overcap Chi" },
      { action: BOK },
    ],
  },
  {
    id: "aoe-conduit",
    tree: "conduit",
    target: "aoe",
    variant: "default",
    lines: [
      { action: FOF, when: "Heart of the Jade Serpent is about to end" },
      { action: WDP, when: XUEN_AWAY, needs: [cast(WDP)] },
      { action: SOTW, when: XUEN_AWAY, needs: [cast(SOTW)] },
      { action: STOMP, when: "Chi is low or Zenith is about to end", needs: [cast(STOMP)] },
      { action: TP, when: NO_FOF_CHI },
      { action: FOF },
      { action: SCK, when: "Unbroken Rhythm (Season 2 four-piece) is up", needs: [RHYTHM] },
      { action: TP, when: "Energy is about to cap, outside Zenith" },
      { action: RSK, when: "it enables Whirling Dragon Punch", needs: [cast(WDP)] },
      { action: RWK, when: "Unbroken Rhythm is not up", needs: [cast(RWK)] },
      { action: RSK, when: "Heart of the Jade Serpent is up and Unbroken Rhythm is not" },
      { action: SCK, when: "in Zenith with 5 or more targets" },
      { action: RSK, when: "in Bloodlust or Zenith, without Unbroken Rhythm" },
      { action: BOK, when: "in Zenith with Rising Sun Kick on cooldown", needs: [talent("Obsidian Spiral")] },
      { action: SCK },
      { action: SLICING, needs: [cast(SLICING)] },
      { action: BOK, when: "Combo Breaker is up" },
      { action: TP, when: "under 5 Chi, outside Zenith" },
      { action: BOK, needs: [talent("Shadowboxing Treads")] },
      { action: RSK },
      { action: BOK },
    ],
  },
  {
    id: "st-default-sp",
    tree: "shado-pan",
    target: "single",
    variant: "default",
    lines: [
      { action: WDP, needs: [cast(WDP)] },
      { action: STOMP, when: "Chi is low or Zenith is about to end", needs: [cast(STOMP)] },
      { action: TP, when: `${ENERGY_CAP} — or ${NO_FOF_CHI}` },
      { action: FOF },
      { action: RWK, needs: [cast(RWK)] },
      { action: SCK, when: "Dance of Chi-Ji and Unbroken Rhythm are both up", needs: [DANCE, RHYTHM] },
      { action: RSK },
      { action: BOK, when: "Combo Breaker is up, or in Zenith with Obsidian Spiral" },
      { action: SCK, when: "in Zenith with more than 4 Chi or Dance of Chi-Ji" },
      { action: TP, when: "under 2 Chi" },
      { action: SCK, when: "Dance of Chi-Ji is up", needs: [DANCE] },
      { action: TP, when: "it does not overcap Chi" },
      { action: BOK },
    ],
  },
  {
    id: "st-advanced-sp",
    tree: "shado-pan",
    target: "single",
    variant: "advanced",
    lines: [
      { action: WDP, when: "in its grace period", needs: [cast(WDP)] },
      { action: STOMP, when: "Chi is low or Zenith is about to end", needs: [cast(STOMP)] },
      { action: TP, when: ENERGY_CAP },
      { action: FOF },
      { action: WDP, needs: [cast(WDP)] },
      { action: SOTW, needs: [cast(SOTW)] },
      { action: TP, when: NO_FOF_CHI },
      { action: RWK, needs: [cast(RWK)] },
      { action: SCK, when: "Dance of Chi-Ji and Unbroken Rhythm are both up", needs: [DANCE, RHYTHM] },
      { action: RSK },
      { action: BOK, when: "Combo Breaker has 2 stacks" },
      { action: BOK, when: "in Zenith with Combo Breaker, or with Obsidian Spiral" },
      { action: SCK, when: "in Zenith with more than 4 Chi or Dance of Chi-Ji" },
      { action: TOD },
      { action: TP, when: "under 2 Chi" },
      { action: BOK, when: "Combo Breaker is up" },
      { action: SCK, when: "Dance of Chi-Ji is up", needs: [DANCE] },
      { action: SLICING, needs: [cast(SLICING)] },
      { action: TP, when: "it does not overcap Chi" },
      { action: BOK },
    ],
  },
  {
    id: "aoe-sp",
    tree: "shado-pan",
    target: "aoe",
    variant: "default",
    lines: [
      { action: WDP, needs: [cast(WDP)] },
      { action: SOTW, needs: [cast(SOTW)] },
      { action: STOMP, when: "Chi is low or Zenith is about to end", needs: [cast(STOMP)] },
      { action: TP, when: NO_FOF_CHI },
      { action: FOF },
      { action: SCK, when: "Unbroken Rhythm (Season 2 four-piece) is up", needs: [RHYTHM] },
      { action: TP, when: "Energy is about to cap, outside Zenith" },
      { action: RSK, when: "it enables Whirling Dragon Punch", needs: [cast(WDP)] },
      { action: RWK, when: "Unbroken Rhythm is not up", needs: [cast(RWK)] },
      { action: SCK, when: "in Zenith with 5 or more targets" },
      { action: RSK, when: "in Bloodlust or Zenith, without Unbroken Rhythm" },
      { action: BOK, when: "in Zenith with Rising Sun Kick on cooldown", needs: [talent("Obsidian Spiral")] },
      { action: SCK },
      { action: SLICING, needs: [cast(SLICING)] },
      { action: BOK, when: "Combo Breaker is up" },
      { action: TP, when: "under 5 Chi, outside Zenith" },
      { action: BOK, needs: [talent("Shadowboxing Treads")] },
      { action: RSK },
      { action: BOK },
    ],
  },
];

export const LIST_LABEL: Record<string, string> = {
  "st-default-conduit": "Single target",
  "st-advanced-conduit": "Single target · advanced",
  "aoe-conduit": "AoE (2+ targets)",
  "st-default-sp": "Single target",
  "st-advanced-sp": "Single target · advanced",
  "aoe-sp": "AoE (2+ targets)",
};

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
