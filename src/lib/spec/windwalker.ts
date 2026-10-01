// Windwalker Monk: spec knowledge the generic rules deliberately do not have.
//
// The rest of the project avoids hardcoding rotations, and this module keeps
// to the spirit of that: it hardcodes *roles* and *rules* — which button is
// the burst, which presses break Combo Strikes, what the Conduit window has to
// contain — but every target number it shows comes from the build-matched top
// parses of the same boss, measured the same way. Where a rule needs a
// threshold, the threshold is the one the top parses were measured to keep:
//
//   15 Conduit top parses, 67 Xuen windows, Heroic Ula'tek and Mythic
//   Nek'zali / Entombed Sentinels (patch 12.1): Zenith pressed with Xuen in
//   51/52 windows, no Tiger Palm between Xuen and Conduit, Conduit a median
//   11.5s after Xuen and 6-8s after Whirling Dragon Punch, Whirling Dragon
//   Punch never pressed inside the 10s before Xuen (2 of 150 casts).
//
// Two rules that look obvious were measured and dropped or narrowed:
// - Combo Strikes. Across 30 top parses (~5,000 presses) the same button came
//   twice with *nothing* between only 11 times, but 63 more times with Zenith,
//   Zenith Stomp, Xuen or a movement button between them. So a break is the
//   same damaging button twice back to back, nothing else.
// - "Fists of Fury right after Celestial Conduit" (the guide's Unity Within
//   macro). The top parses do it about half the time, 0-100% by player, so it
//   is shown per window but never marked as a mistake.
//
// Abilities are recognised by name, the way they appear in the log.

import { DOUBLE_LOG_MS, extraKind } from "@/lib/model/opener";
import { median } from "@/lib/model/stats";
import type { PlayerProfile, ReferenceProfile } from "@/lib/model/types";

export const WW = {
  TP: "Tiger Palm",
  BOK: "Blackout Kick",
  RSK: "Rising Sun Kick",
  RWK: "Rushing Wind Kick",
  FOF: "Fists of Fury",
  SCK: "Spinning Crane Kick",
  WDP: "Whirling Dragon Punch",
  SOTW: "Strike of the Windlord",
  ZENITH: "Zenith",
  STOMP: "Zenith Stomp",
  XUEN: "Invoke Xuen, the White Tiger",
  CONDUIT: "Celestial Conduit",
  UNITY: "Unity Within",
  TOD: "Touch of Death",
  SLICING: "Slicing Winds",
  CJL: "Crackling Jade Lightning",
} as const;

/** Presses that trigger Mastery: Combo Strikes, so repeating one breaks it. */
const COMBO = new Set<string>([
  WW.TP, WW.BOK, WW.RSK, WW.RWK, WW.FOF, WW.SCK, WW.WDP, WW.SOTW, WW.TOD, WW.SLICING, WW.CJL,
]);
const COOLDOWNS = new Set<string>([WW.ZENITH, WW.XUEN, WW.CONDUIT, WW.UNITY, WW.STOMP]);

/** Thresholds, each one what the top parses were measured to keep (see the header). */
export const WW_RULES = {
  /** Whirling Dragon Punch inside this long before Xuen should have been held. */
  holdWdpBeforeXuenMs: 10_000,
  /** Zenith, items and racials count as "with Xuen" inside this distance. */
  pairedMs: 2_000,
  /** Conduit this long after Xuen is on plan (top median 11.5s, almost all 8-16s). */
  conduitAfterXuenMs: [8_000, 16_000] as const,
  /** Conduit sooner than this after Whirling Dragon Punch overlaps their Heart of the Jade Serpent. */
  conduitAfterWdpMinMs: 5_000,
  /** How long a Xuen window lasts when there is no Conduit to end it. */
  windowWithoutConduitMs: 20_000,
  /** Tiger Palm only counts against the burst this soon after Xuen. */
  burstCoreMs: 12_000,
  /** Fallback Xuen cooldown when the reference set cannot estimate one (measured: ~91s). */
  xuenCooldownMs: 90_000,
};

export type Tree = "conduit" | "shado-pan" | "unknown";
export type PressKind = "combo" | "cooldown" | "item" | "other";
export type MarkLevel = "bad" | "warn";

export interface Mark {
  level: MarkLevel;
  code:
    | "combo-break"
    | "tp-in-burst"
    | "wdp-before-xuen"
    | "conduit-overlap"
    | "conduit-timing"
    | "no-zenith-with-xuen";
  note: string;
}

export interface Press {
  t: number;
  gameID: number;
  name: string;
  kind: PressKind;
  marks: Mark[];
}

export interface BurstWindow {
  index: number;
  atMs: number;
  endMs: number;
  /** Index range into the pull's presses, for the per-window strip. */
  from: number;
  to: number;
  zenith: boolean;
  /** Null when the pull used no on-use item or racial at all, so there was nothing to pair. */
  items: boolean | null;
  fof: number;
  wdp: number;
  tigerPalms: number;
  conduitMs: number | null;
  sinceWdpMs: number | null;
  /**
   * Null unless Unity Within is in use. Shown, never marked: the top parses
   * follow Conduit with Fists of Fury only about half the time.
   */
  fofAfterConduit: boolean | null;
}

export interface PullAnalysis {
  fightId: number;
  label: string;
  kill: boolean;
  dps: number;
  durationMs: number;
  startTime?: number;
  presses: Press[];
  windows: BurstWindow[];
  metrics: PullMetrics;
}

export interface PullMetrics {
  comboBreaksPerMin: number;
  comboPressesPerMin: number;
  windows: number;
  /** How many Xuen windows the pull had room for, at the measured cooldown. */
  possibleWindows: number;
  tigerPalmsPerWindow: number | null;
  fofPerWindow: number | null;
  wdpBeforeXuen: number;
  conduitMs: number | null;
  sinceWdpMs: number | null;
  zenithPairedPct: number | null;
  fofAfterConduitPct: number | null;
  zenithPerMin: number;
  /** Share of each next press after Fists of Fury and Whirling Dragon Punch. */
  afterFof: Record<string, number>;
  afterWdp: Record<string, number>;
  cpm: Record<string, number>;
}

export interface Check {
  id: string;
  label: string;
  you: string;
  top: string;
  status: "good" | "warn" | "bad";
  advice: string;
}

export interface WindwalkerReport {
  tree: Tree;
  treeEvidence: string;
  referenceTree: Tree;
  pulls: PullAnalysis[];
  reference: Array<{ name: string; dps: number; metrics: PullMetrics }>;
  checks: Check[];
  /** Key buttons, presses per minute: your median against the top parses'. */
  rates: Array<{ name: string; you: number; top: number }>;
  habits: {
    afterFof: { you: Record<string, number>; top: Record<string, number> };
    afterWdp: { you: Record<string, number>; top: Record<string, number> };
  };
}

// --- Detection ------------------------------------------------------------------

export function isWindwalker(profile: Pick<PlayerProfile, "className" | "specName">): boolean {
  return /monk/i.test(profile.className ?? "") && /windwalker/i.test(profile.specName ?? "");
}

/** Hero tree, from what the log shows the player doing — no talent ids needed. */
export function detectTree(profile: PlayerProfile): { tree: Tree; evidence: string } {
  const named = Object.values(profile.abilities);
  const conduit = named.find((a) => a.name === WW.CONDUIT && a.casts > 0);
  const xuen = named.find((a) => a.name === WW.XUEN && a.casts > 0);
  if (conduit || xuen) return { tree: "conduit", evidence: `casts ${conduit ? WW.CONDUIT : WW.XUEN}` };
  const flurry = named.find((a) => a.name === "Flurry Strikes" && a.damage > 0);
  if (flurry) return { tree: "shado-pan", evidence: "deals Flurry Strikes damage" };
  return { tree: "unknown", evidence: "neither Celestial Conduit nor Flurry Strikes in the log" };
}

// --- Presses ----------------------------------------------------------------------

export function pressesOf(profile: PlayerProfile): Press[] {
  const out: Press[] = [];
  for (const cast of profile.castTimeline) {
    const stat = profile.abilities[cast.gameID];
    if (!stat) continue;
    const last = out[out.length - 1];
    // One press logged under two ids at once is one press (see DOUBLE_LOG_MS).
    if (last && last.name === stat.name && cast.atMs - last.t < DOUBLE_LOG_MS) continue;
    const kind: PressKind = COMBO.has(stat.name)
      ? "combo"
      : COOLDOWNS.has(stat.name)
        ? "cooldown"
        : extraKind(stat.name, stat.icon)
          ? "item"
          : "other";
    out.push({ t: Math.round(cast.atMs), gameID: cast.gameID, name: stat.name, kind, marks: [] });
  }
  return out;
}

const mark = (press: Press, m: Mark) => {
  if (!press.marks.some((x) => x.code === m.code)) press.marks.push(m);
};

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

// --- Per pull ---------------------------------------------------------------------

export function analyzePull(
  profile: PlayerProfile,
  tree: Tree,
  meta: { label: string; kill: boolean; startTime?: number; xuenCooldownMs?: number },
): PullAnalysis {
  const presses = pressesOf(profile);
  const minutes = profile.durationMs / 60_000;
  const combo = presses.filter((p) => p.kind === "combo");

  // Combo Strikes: the same damaging button twice, back to back. Anything
  // pressed between them — Zenith, Zenith Stomp, Xuen, a Roll — is how the top
  // parses repeat a button, so it does not count (see the header).
  let breaks = 0;
  for (let i = 1; i < presses.length; i++) {
    if (presses[i].kind === "combo" && presses[i].name === presses[i - 1].name) {
      breaks += 1;
      mark(presses[i], {
        level: "bad",
        code: "combo-break",
        note: `${presses[i].name} twice in a row breaks Combo Strikes — put any other button between them.`,
      });
    }
  }

  const windows = tree === "conduit" ? conduitWindows(presses) : [];

  // Whirling Dragon Punch pressed when Xuen was less than 10s away.
  const xuens = presses.filter((p) => p.name === WW.XUEN);
  let wdpBeforeXuen = 0;
  if (tree === "conduit") {
    for (const p of presses) {
      if (p.name !== WW.WDP) continue;
      const next = xuens.find((x) => x.t > p.t);
      if (next && next.t - p.t <= WW_RULES.holdWdpBeforeXuenMs) {
        wdpBeforeXuen += 1;
        mark(p, {
          level: "bad",
          code: "wdp-before-xuen",
          note: `Pressed ${secs(next.t - p.t)} before Xuen — hold Whirling Dragon Punch when Xuen is under 10s away, so it lands inside the window.`,
        });
      }
    }
  }

  const cooldown = meta.xuenCooldownMs ?? WW_RULES.xuenCooldownMs;
  const possibleWindows = Math.max(1, Math.floor(Math.max(0, profile.durationMs - 5_000) / cooldown) + 1);

  const withConduit = windows.filter((w) => w.conduitMs != null);
  const unityUsed = windows.filter((w) => w.fofAfterConduit != null);

  const metrics: PullMetrics = {
    comboBreaksPerMin: minutes > 0 ? breaks / minutes : 0,
    comboPressesPerMin: minutes > 0 ? combo.length / minutes : 0,
    windows: windows.length,
    possibleWindows,
    tigerPalmsPerWindow: windows.length ? windows.reduce((s, w) => s + w.tigerPalms, 0) / windows.length : null,
    fofPerWindow: windows.length ? median(windows.map((w) => w.fof)) : null,
    wdpBeforeXuen,
    conduitMs: withConduit.length ? median(withConduit.map((w) => w.conduitMs!)) : null,
    sinceWdpMs: withConduit.some((w) => w.sinceWdpMs != null)
      ? median(withConduit.filter((w) => w.sinceWdpMs != null).map((w) => w.sinceWdpMs!))
      : null,
    zenithPairedPct: windows.length ? (windows.filter((w) => w.zenith).length / windows.length) * 100 : null,
    fofAfterConduitPct: unityUsed.length
      ? (unityUsed.filter((w) => w.fofAfterConduit).length / unityUsed.length) * 100
      : null,
    zenithPerMin: minutes > 0 ? presses.filter((p) => p.name === WW.ZENITH).length / minutes : 0,
    afterFof: nextShare(combo, WW.FOF),
    afterWdp: nextShare(combo, WW.WDP),
    cpm: Object.fromEntries(
      [WW.TP, WW.BOK, WW.RSK, WW.RWK, WW.FOF, WW.SCK, WW.WDP, WW.ZENITH, WW.TOD].map((n) => [
        n,
        minutes > 0 ? presses.filter((p) => p.name === n).length / minutes : 0,
      ]),
    ),
  };

  return {
    fightId: profile.fightId,
    label: meta.label,
    kill: meta.kill,
    dps: profile.dps,
    durationMs: profile.durationMs,
    startTime: meta.startTime,
    presses,
    windows,
    metrics,
  };
}

/** Share of each button pressed right after `name` — the filler habit after a big press. */
function nextShare(combo: Press[], name: string): Record<string, number> {
  const counts: Record<string, number> = {};
  let total = 0;
  for (let i = 0; i + 1 < combo.length; i++) {
    if (combo[i].name !== name) continue;
    const next = combo[i + 1].name;
    counts[next] = (counts[next] ?? 0) + 1;
    total += 1;
  }
  return Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, n / total]));
}

/**
 * One window per Invoke Xuen, ending at the Celestial Conduit that follows it.
 * Everything the measured top parses keep is checked, and the presses that
 * break it are marked where they happened.
 */
export function conduitWindows(presses: Press[]): BurstWindow[] {
  const xuens = presses.map((p, i) => ({ p, i })).filter(({ p }) => p.name === WW.XUEN);
  const usesItems = presses.some((p) => p.kind === "item");
  const usesUnity = presses.some((p) => p.name === WW.UNITY);
  const windows: BurstWindow[] = [];

  for (const [wi, { p: xuen, i: xi }] of xuens.entries()) {
    const nextXuen = xuens[wi + 1]?.p.t ?? Infinity;
    const conduitIdx = presses.findIndex(
      (p) => p.name === WW.CONDUIT && p.t >= xuen.t - 1_000 && p.t < Math.min(nextXuen, xuen.t + 40_000),
    );
    const conduit = conduitIdx >= 0 ? presses[conduitIdx] : null;
    const endMs = conduit ? conduit.t : Math.min(nextXuen, xuen.t + WW_RULES.windowWithoutConduitMs);

    const near = presses.filter((p) => Math.abs(p.t - xuen.t) <= WW_RULES.pairedMs);
    const zenith = near.some((p) => p.name === WW.ZENITH);
    const items = usesItems ? near.some((p) => p.kind === "item") : null;

    // The burst cluster — Xuen, Zenith, items, racials — ends at its last press;
    // the window's rotation starts after it.
    const clusterEnd = Math.max(xuen.t, ...near.filter((p) => p.t >= xuen.t - WW_RULES.pairedMs && (p.kind !== "combo")).map((p) => p.t));
    const inside = presses.filter((p) => p.t > clusterEnd && p.t < endMs);

    if (!zenith) {
      mark(xuen, {
        level: "warn",
        code: "no-zenith-with-xuen",
        note: "No Zenith with this Xuen — the top parses press Zenith together with Xuen in almost every window. Keep a charge for it.",
      });
    }

    // Tiger Palm is only counted in the core of the window. When Conduit is
    // held for a mechanic the window stretches to 20-30s, and the top parses
    // do Tiger Palm in that tail — measured: up to 9 a fight that way.
    let tigerPalms = 0;
    for (const p of inside) {
      if (p.name !== WW.TP || p.t - xuen.t > WW_RULES.burstCoreMs) continue;
      tigerPalms += 1;
      mark(p, {
        level: "warn",
        code: "tp-in-burst",
        note: "Tiger Palm in the first seconds of the burst — Zenith supplies the Chi, and the top parses rarely press it before Conduit.",
      });
    }

    let sinceWdpMs: number | null = null;
    let fofAfterConduit: boolean | null = null;
    if (conduit) {
      const delay = conduit.t - xuen.t;
      const [lo, hi] = WW_RULES.conduitAfterXuenMs;
      if (delay < lo || delay > hi) {
        mark(conduit, {
          level: "warn",
          code: "conduit-timing",
          note: `Conduit ${secs(delay)} after Xuen — the top parses cast it ${lo / 1000}-${hi / 1000}s after (median 11.5s), once Fists of Fury and Whirling Dragon Punch are out.`,
        });
      }
      const lastWdp = [...presses.slice(0, conduitIdx)].reverse().find((p) => p.name === WW.WDP);
      if (lastWdp) {
        sinceWdpMs = conduit.t - lastWdp.t;
        if (sinceWdpMs < WW_RULES.conduitAfterWdpMinMs) {
          mark(conduit, {
            level: "warn",
            code: "conduit-overlap",
            note: `Conduit only ${secs(sinceWdpMs)} after Whirling Dragon Punch — their Heart of the Jade Serpent buffs do not stack; the top parses wait 6-8s.`,
          });
        }
      }
      if (usesUnity) {
        const next = presses.slice(conduitIdx + 1).find((p) => p.name !== WW.UNITY && p.kind !== "item");
        fofAfterConduit = next?.name === WW.FOF;
      }
    }

    const from = Math.max(0, xi - 2);
    const toIdx = conduit ? Math.min(presses.length, conduitIdx + 4) : presses.findIndex((p) => p.t >= endMs);
    windows.push({
      index: wi,
      atMs: xuen.t,
      endMs,
      from,
      to: toIdx < 0 ? presses.length : toIdx,
      zenith,
      items,
      fof: inside.filter((p) => p.name === WW.FOF).length,
      wdp: inside.filter((p) => p.name === WW.WDP).length,
      tigerPalms,
      conduitMs: conduit ? conduit.t - xuen.t : null,
      sinceWdpMs,
      fofAfterConduit,
    });
  }
  return windows;
}

// --- The whole report -------------------------------------------------------------

export function buildWindwalkerReport(
  yours: Array<{ profile: PlayerProfile; label: string; kill: boolean; startTime?: number }>,
  reference: ReferenceProfile,
): WindwalkerReport | null {
  if (yours.length === 0 || !isWindwalker(yours[0].profile)) return null;

  const detected = yours.map((y) => detectTree(y.profile));
  const tree = majority(detected.map((d) => d.tree));
  const referenceTree = majority(reference.members.map((m) => detectTree(m).tree));

  const xuenId = Object.entries(reference.abilityNames).find(([, n]) => n === WW.XUEN)?.[0];
  const estimated = xuenId ? reference.estimatedCooldownMs[Number(xuenId)] : undefined;
  // Only trust the estimate if it looks like a Xuen cooldown at all.
  const xuenCooldownMs = estimated && estimated > 60_000 && estimated < 150_000 ? estimated : WW_RULES.xuenCooldownMs;

  const pulls = yours.map((y) =>
    analyzePull(y.profile, tree, { label: y.label, kill: y.kill, startTime: y.startTime, xuenCooldownMs }),
  );
  const refs = reference.members.map((m) => ({
    name: m.name,
    dps: m.dps,
    metrics: analyzePull(m, detectTree(m).tree, { label: m.name, kill: true, xuenCooldownMs }).metrics,
  }));

  const you = pulls.map((p) => p.metrics);
  const top = refs.map((r) => r.metrics);

  return {
    tree,
    treeEvidence: detected.find((d) => d.tree === tree)?.evidence ?? "",
    referenceTree,
    pulls,
    reference: refs,
    checks: buildChecks(tree, you, top),
    rates: [WW.TP, WW.BOK, WW.RSK, WW.RWK, WW.FOF, WW.SCK, WW.WDP, WW.ZENITH, WW.TOD].map((name) => ({
      name,
      you: median(you.map((m) => m.cpm[name] ?? 0)),
      top: median(top.map((m) => m.cpm[name] ?? 0)),
    })),
    habits: {
      afterFof: { you: mergeShares(you.map((m) => m.afterFof)), top: mergeShares(top.map((m) => m.afterFof)) },
      afterWdp: { you: mergeShares(you.map((m) => m.afterWdp)), top: mergeShares(top.map((m) => m.afterWdp)) },
    },
  };
}

function majority(trees: Tree[]): Tree {
  const counts = new Map<Tree, number>();
  for (const t of trees) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
}

/** Average of per-pull shares, so one long pull does not outweigh the rest. */
function mergeShares(shares: Array<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  const usable = shares.filter((s) => Object.keys(s).length > 0);
  for (const s of usable) for (const [k, v] of Object.entries(s)) out[k] = (out[k] ?? 0) + v / usable.length;
  return out;
}

const medianOf = (values: Array<number | null>) => {
  const v = values.filter((x): x is number => x != null);
  return v.length ? median(v) : null;
};
const fmt = (n: number | null, digits = 1, unit = "") => (n == null ? "—" : `${n.toFixed(digits)}${unit}`);

/**
 * The scorecard. Each check names what was measured on you, what the top
 * parses did on the same boss, and — when it is not good — what to change.
 */
export function buildChecks(tree: Tree, you: PullMetrics[], top: PullMetrics[]): Check[] {
  const checks: Check[] = [];
  const m = (pick: (x: PullMetrics) => number | null, from: PullMetrics[]) => medianOf(from.map(pick));

  const breaks = m((x) => x.comboBreaksPerMin, you)!;
  checks.push({
    id: "combo-breaks",
    label: "Combo Strikes breaks",
    you: `${fmt(breaks, 1)}/min`,
    top: `${fmt(m((x) => x.comboBreaksPerMin, top), 1)}/min`,
    status: breaks <= 0.3 ? "good" : breaks <= 1 ? "warn" : "bad",
    advice: "Never press the same damaging button twice in a row. Each one is marked in the press list below.",
  });

  if (tree === "conduit") {
    // Against what the top parses managed, not the theoretical maximum: a
    // fight can force a delay (on Heroic Ula'tek the top parses fit 26 of 34).
    const used = (from: PullMetrics[]) => {
      const possible = from.reduce((s, x) => s + x.possibleWindows, 0);
      return possible > 0 ? from.reduce((s, x) => s + x.windows, 0) / possible : 0;
    };
    const windows = you.reduce((s, x) => s + x.windows, 0);
    const possible = you.reduce((s, x) => s + x.possibleWindows, 0);
    const yourUse = used(you);
    const topUse = used(top);
    checks.push({
      id: "xuen-windows",
      label: "Xuen windows used",
      you: `${windows} of ${possible} possible`,
      top: `${Math.round(topUse * 100)}% of possible`,
      status: yourUse >= topUse - 0.1 ? "good" : yourUse >= topUse - 0.25 ? "warn" : "bad",
      advice: "Press Xuen on cooldown (~90s). A window delayed past the next one is a whole burst lost — only hold it for a known damage phase.",
    });

    const tp = m((x) => x.tigerPalmsPerWindow, you);
    const topTp = m((x) => x.tigerPalmsPerWindow, top) ?? 0;
    checks.push({
      id: "tp-in-burst",
      label: "Tiger Palm inside the burst",
      you: `${fmt(tp, 1)} per window`,
      top: `${fmt(topTp, 1)} per window`,
      status: tp == null || tp <= topTp + 0.3 ? "good" : tp <= topTp + 1 ? "warn" : "bad",
      advice: "Between Xuen and Conduit, Zenith supplies the Chi. Use Fists of Fury, Rising Sun Kick, Whirling Dragon Punch, Crane Kick and Blackout Kick instead.",
    });

    const zen = m((x) => x.zenithPairedPct, you);
    checks.push({
      id: "zenith-with-xuen",
      label: "Zenith pressed with Xuen",
      you: `${fmt(zen, 0, "%")} of windows`,
      top: `${fmt(m((x) => x.zenithPairedPct, top), 0, "%")}`,
      status: zen == null || zen >= 80 ? "good" : zen >= 50 ? "warn" : "bad",
      advice: "Keep one Zenith charge for every Xuen, and press it in the same second — the burst macro does Xuen-check, trinket, potion and Zenith in one press.",
    });

    const fof = m((x) => x.fofPerWindow, you);
    checks.push({
      id: "fof-in-window",
      label: "Fists of Fury before Conduit",
      you: `${fmt(fof, 0)} per window`,
      top: `${fmt(m((x) => x.fofPerWindow, top), 0)} per window`,
      status: fof == null || fof >= 2 ? "good" : fof >= 1 ? "warn" : "bad",
      advice: "Open the window with Fists of Fury right after Zenith, and get a second one out before Conduit.",
    });

    const wdp = medianOf(you.map((x) => x.wdpBeforeXuen))!;
    checks.push({
      id: "wdp-before-xuen",
      label: "Whirling Dragon Punch held for Xuen",
      you: `${you.reduce((s, x) => s + x.wdpBeforeXuen, 0)} pressed <10s before Xuen`,
      top: `${top.reduce((s, x) => s + x.wdpBeforeXuen, 0)}`,
      status: wdp === 0 ? "good" : wdp <= 1 ? "warn" : "bad",
      advice: "When Xuen is under 10s away, hold Whirling Dragon Punch so it lands inside the window (about 4s after Xuen).",
    });

    const conduit = m((x) => x.conduitMs, you);
    const [lo, hi] = WW_RULES.conduitAfterXuenMs;
    checks.push({
      id: "conduit-timing",
      label: "Celestial Conduit after Xuen",
      you: conduit == null ? "never cast" : `+${fmt(conduit / 1000, 1)}s`,
      top: `+${fmt((m((x) => x.conduitMs, top) ?? 0) / 1000, 1)}s`,
      status: conduit == null ? "bad" : conduit >= lo && conduit <= hi ? "good" : "warn",
      advice: "Cast Conduit 8-16s after Xuen, once two Fists of Fury and Whirling Dragon Punch are out — usually right after a Rising Sun Kick.",
    });

    const since = m((x) => x.sinceWdpMs, you);
    checks.push({
      id: "conduit-overlap",
      label: "Conduit after Whirling Dragon Punch",
      you: since == null ? "—" : `${fmt(since / 1000, 1)}s later`,
      top: `${fmt((m((x) => x.sinceWdpMs, top) ?? 0) / 1000, 1)}s later`,
      status: since == null || since >= 6_000 ? "good" : since >= WW_RULES.conduitAfterWdpMinMs ? "warn" : "bad",
      advice: "Their Heart of the Jade Serpent buffs do not stack: leave 6-8s between Whirling Dragon Punch and Conduit.",
    });

  }

  // Filler habit after Fists of Fury: what the top parses of the same tree reach for.
  const habit = (from: PullMetrics[], name: string) => medianOf(from.map((x) => x.afterFof[name] ?? 0));
  const preferred = tree === "conduit" ? WW.SCK : WW.TP;
  const yourShare = habit(you, preferred) ?? 0;
  const topShare = habit(top, preferred) ?? 0;
  checks.push({
    id: "after-fof",
    label: `${preferred} after Fists of Fury`,
    you: `${fmt(yourShare * 100, 0, "%")}`,
    top: `${fmt(topShare * 100, 0, "%")}`,
    status: yourShare >= topShare - 0.15 ? "good" : yourShare >= topShare - 0.3 ? "warn" : "bad",
    advice:
      tree === "conduit"
        ? "On Conduit, Spinning Crane Kick is the press after Fists of Fury and Whirling Dragon Punch — it is a quarter to a third of the damage."
        : "On Shado-Pan, Tiger Palm is the usual press after Fists of Fury.",
  });

  const pace = m((x) => x.comboPressesPerMin, you)!;
  const topPace = m((x) => x.comboPressesPerMin, top) ?? 0;
  checks.push({
    id: "pace",
    label: "Rotational presses",
    you: `${fmt(pace, 0)}/min`,
    top: `${fmt(topPace, 0)}/min`,
    status: pace >= topPace * 0.92 ? "good" : pace >= topPace * 0.85 ? "warn" : "bad",
    advice: "Fewer presses than the top parses means idle GCDs. Player analysis → Cast timeline shows where the gaps are.",
  });

  return checks;
}
