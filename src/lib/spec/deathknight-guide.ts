// Wowhead's Unholy and Frost Death Knight priority lists (patch 12.1.5,
// updated 13 October 2026), cross-checked against Icy Veins and Method, as the
// reference card on the Death Knight tab. Order is Wowhead's; wording is ours.
//
// Where the three guides disagree, the card follows Wowhead and the priority
// check does not flag the disputed order (see deathknight.ts):
// - Frost: Method puts Obliterate with Killing Machine above Howling Blast with
//   Rime, and Obliterate above a plain Frost Strike.
// - Unholy: Icy Veins builds Lesser Ghoul with Festering Strike at 3 or fewer
//   stacks, not only at none.

import type { GuideLine, GuideList, GuideSet, Need } from "./guide";

const cast = (name: string): Need => ({ cast: name });

// --- Unholy ---------------------------------------------------------------------

const FS = "Festering Strike";
const SS = "Scourge Strike";
const VS = "Vampiric Strike";
const DC = "Death Coil";
const NC = "Necrotic Coil";
const SR = "Soul Reaper";
const DT = "Dark Transformation";
const ARMY = "Army of the Dead";
const PUTREFY = "Putrefy";
const SCYTHE = "Festering Scythe";
const BLIGHTFALL = "Blightfall";
const OUTBREAK = "Outbreak";
const EPIDEMIC = "Epidemic";
const DND = "Death and Decay";
const GRAVEYARD = "Graveyard";

const BLIGHTFALL_LINE: GuideLine = {
  action: BLIGHTFALL,
  when: "your trinket is about to end, or about 15s into Dark Transformation — whichever is first",
  needs: [cast(BLIGHTFALL)],
};
const OUTBREAK_LINE: GuideLine = { action: OUTBREAK, when: "Virulent Plague is not up" };
const SR_EXECUTE: GuideLine = { action: SR, when: "the target is under 35% health" };
const SR_AFTER_DT: GuideLine = { action: SR, when: "about 7s after Dark Transformation" };
const SCYTHE_LINE: GuideLine = { action: SCYTHE, when: "its buff is about to run out", needs: [cast(SCYTHE)] };
const FS_NO_GHOUL: GuideLine = { action: FS, when: "you have no Lesser Ghoul stacks" };
const SS_GHOUL: GuideLine = { action: SS, when: "you have Lesser Ghoul stacks" };

export const UNHOLY_LISTS: GuideList[] = [
  {
    id: "uh-st-sanlayn",
    group: "sanlayn",
    target: "single",
    lines: [
      { action: FS, when: "Dark Transformation is next and you have 3 or fewer Lesser Ghoul stacks" },
      SR_EXECUTE,
      BLIGHTFALL_LINE,
      { action: ARMY, when: "it is ready" },
      { action: DT, when: "it is ready" },
      SR_AFTER_DT,
      { action: PUTREFY, when: "Dark Transformation is up" },
      SCYTHE_LINE,
      { action: DC, when: "Sudden Doom is up" },
      FS_NO_GHOUL,
      SS_GHOUL,
      { action: DC },
    ],
  },
  {
    id: "uh-st-sanlayn-fk",
    group: "sanlayn",
    target: "single",
    lines: [
      SR_EXECUTE,
      BLIGHTFALL_LINE,
      SR_AFTER_DT,
      { action: PUTREFY, when: "it is ready" },
      SCYTHE_LINE,
      { action: NC, needs: [cast(NC)] },
      FS_NO_GHOUL,
      { action: VS, when: "you have Lesser Ghoul stacks", needs: [cast(VS)] },
    ],
  },
  {
    id: "uh-aoe-sanlayn",
    group: "sanlayn",
    target: "aoe",
    lines: [
      { action: FS, when: "Dark Transformation is next and you have 5 or fewer Lesser Ghoul stacks" },
      BLIGHTFALL_LINE,
      { action: ARMY, when: "it is ready" },
      { action: DT, when: "it is ready" },
      SCYTHE_LINE,
      { action: SR, when: "it is ready" },
      { action: PUTREFY, when: "Dark Transformation is up" },
      { action: DND, when: "the targets will stay in it" },
      { action: EPIDEMIC, when: "Sudden Doom is up" },
      FS_NO_GHOUL,
      SS_GHOUL,
      { action: EPIDEMIC },
    ],
  },
  {
    id: "uh-aoe-sanlayn-fk",
    group: "sanlayn",
    target: "aoe",
    lines: [
      BLIGHTFALL_LINE,
      SCYTHE_LINE,
      { action: PUTREFY, when: "it is ready" },
      { action: DND, when: "the targets will stay in it" },
      { action: SR, when: "it is ready" },
      { action: GRAVEYARD, needs: [cast(GRAVEYARD)] },
      FS_NO_GHOUL,
      SS_GHOUL,
    ],
  },
  {
    id: "uh-st-rider",
    group: "rider",
    target: "single",
    lines: [
      OUTBREAK_LINE,
      SR_EXECUTE,
      { action: ARMY, when: "it is ready" },
      { action: DT, when: "it is ready" },
      SR_AFTER_DT,
      { action: PUTREFY, when: "Dark Transformation is up" },
      SCYTHE_LINE,
      { action: DC, when: "Sudden Doom is up" },
      FS_NO_GHOUL,
      SS_GHOUL,
      { action: DC },
    ],
  },
  {
    id: "uh-st-rider-fk",
    group: "rider",
    target: "single",
    lines: [
      SR_AFTER_DT,
      { action: PUTREFY, when: "it is ready" },
      SCYTHE_LINE,
      { action: NC, needs: [cast(NC)] },
      FS_NO_GHOUL,
      SS_GHOUL,
    ],
  },
  {
    id: "uh-aoe-rider",
    group: "rider",
    target: "aoe",
    lines: [
      OUTBREAK_LINE,
      { action: ARMY, when: "it is ready" },
      { action: DT, when: "it is ready" },
      SCYTHE_LINE,
      { action: SR, when: "it is ready" },
      { action: PUTREFY, when: "Dark Transformation is up" },
      { action: DND, when: "the targets will stay in it" },
      { action: EPIDEMIC, when: "Sudden Doom is up" },
      FS_NO_GHOUL,
      SS_GHOUL,
      { action: EPIDEMIC },
    ],
  },
  {
    id: "uh-aoe-rider-fk",
    group: "rider",
    target: "aoe",
    lines: [
      SCYTHE_LINE,
      { action: PUTREFY, when: "it is ready" },
      { action: DND, when: "the targets will stay in it" },
      { action: SR, when: "it is ready" },
      { action: GRAVEYARD, needs: [cast(GRAVEYARD)] },
      FS_NO_GHOUL,
      SS_GHOUL,
    ],
  },
];

// --- Frost ----------------------------------------------------------------------

const ERW = "Empower Rune Weapon";
const RM = "Reaper's Mark";
const POF = "Pillar of Frost";
const BOS = "Breath of Sindragosa";
const FWF = "Frostwyrm's Fury";
const OBLIT = "Obliterate";
const SCYTHE_F = "Frostscythe";
const HB = "Howling Blast";
const FSTRIKE = "Frost Strike";
const GA = "Glacial Advance";

const frostList = (id: string, group: "deathbringer" | "rider", target: "single" | "aoe"): GuideList => {
  const builder = target === "single" ? OBLIT : SCYTHE_F;
  const spender = target === "single" ? FSTRIKE : GA;
  const db = group === "deathbringer";
  return {
    id,
    group,
    target,
    lines: [
      { action: ERW, when: "it has 2 charges" },
      ...(db ? [{ action: RM, needs: [cast(RM)] }] : []),
      { action: POF },
      { action: BOS, needs: [cast(BOS)] },
      { action: FWF },
      {
        action: builder,
        when: db
          ? target === "single"
            ? "you have 2 Killing Machine stacks, or 1 with Exterminate"
            : "you have 2 Killing Machine stacks, or Exterminate"
          : "you have 2 Killing Machine stacks",
      },
      { action: HB, when: "Rime is up" },
      { action: spender, when: "Runic Power would otherwise overcap" },
      { action: builder, when: "Killing Machine is up" },
      { action: ERW, when: "you need a Killing Machine proc" },
      { action: spender },
      { action: builder, when: "Killing Machine is not up" },
      { action: HB },
    ],
  };
};

export const FROST_LISTS: GuideList[] = [
  frostList("fr-st-deathbringer", "deathbringer", "single"),
  frostList("fr-st-rider", "rider", "single"),
  frostList("fr-aoe-deathbringer", "deathbringer", "aoe"),
  frostList("fr-aoe-rider", "rider", "aoe"),
];

const WOWHEAD = (spec: "unholy" | "frost") => ({
  name: `Wowhead — ${spec === "unholy" ? "Unholy" : "Frost"} Death Knight Rotation Guide`,
  url: `https://www.wowhead.com/guide/classes/death-knight/${spec}/rotation-cooldowns-pve-dps`,
  patch: "12.1.5",
  updated: "2026-10-13",
});

export const UNHOLY_GUIDE: GuideSet = {
  source: WOWHEAD("unholy"),
  groups: [
    { id: "sanlayn", label: "San'layn" },
    { id: "rider", label: "Rider of the Apocalypse" },
  ],
  lists: UNHOLY_LISTS,
  labels: {
    "uh-st-sanlayn": "Single target",
    "uh-st-sanlayn-fk": "Single target · Forbidden Knowledge",
    "uh-aoe-sanlayn": "AoE",
    "uh-aoe-sanlayn-fk": "AoE · Forbidden Knowledge",
    "uh-st-rider": "Single target",
    "uh-st-rider-fk": "Single target · Forbidden Knowledge",
    "uh-aoe-rider": "AoE",
    "uh-aoe-rider-fk": "AoE · Forbidden Knowledge",
  },
  checked: ["uh-st-sanlayn", "uh-st-sanlayn-fk", "uh-st-rider", "uh-st-rider-fk"],
  idle: "Nothing ready — wait for Runes or Runic Power, then start over",
  storageKey: "wcbetter:dk-guide:unholy:v1",
  colours: {
    [FS]: "gen",
    [DC]: "big",
    [NC]: "big",
    [EPIDEMIC]: "big",
    [PUTREFY]: "big",
    [ARMY]: "cd",
    [DT]: "cd",
    [BLIGHTFALL]: "cd",
    [SR]: "cd",
  },
  note: "Wowhead's AoE lists are for packs that live long enough for Death and Decay; Icy Veins swaps Death Coil for Epidemic from 4 targets (6 in Forbidden Knowledge). The priority check above is single-target only.",
};

export const FROST_GUIDE: GuideSet = {
  source: WOWHEAD("frost"),
  groups: [
    { id: "deathbringer", label: "Deathbringer" },
    { id: "rider", label: "Rider of the Apocalypse" },
  ],
  lists: FROST_LISTS,
  labels: {
    "fr-st-deathbringer": "Single target",
    "fr-aoe-deathbringer": "AoE",
    "fr-st-rider": "Single target",
    "fr-aoe-rider": "AoE",
  },
  checked: ["fr-st-deathbringer", "fr-st-rider"],
  idle: "Nothing ready — wait for Runes or Runic Power, then start over",
  storageKey: "wcbetter:dk-guide:frost:v1",
  colours: {
    [OBLIT]: "gen",
    [SCYTHE_F]: "gen",
    [FSTRIKE]: "big",
    [GA]: "big",
    [HB]: "big",
    [ERW]: "cd",
    [RM]: "cd",
    [POF]: "cd",
    [BOS]: "cd",
    [FWF]: "cd",
  },
  note: "Icy Veins switches to Frostscythe and Glacial Advance from 3 targets. The priority check above is single-target only.",
};
