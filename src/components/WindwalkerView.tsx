"use client";

import { useMemo, useState } from "react";
import type { AnalysisReport } from "@/lib/analyze";
import { formatDuration } from "@/lib/model/stats";
import { WW, type BurstWindow, type Check, type Press, type PullAnalysis, type Tree } from "@/lib/spec/windwalker";
import { iconUrl, wclUrl } from "@/lib/wcl/links";
import { TalentBuilds } from "./TalentBuilds";

const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

const TREE_LABEL: Record<Tree, string> = {
  conduit: "Conduit of the Celestials",
  "shado-pan": "Shado-Pan",
  unknown: "hero tree not detected",
};

const SHORT: Record<string, string> = {
  [WW.TP]: "TP",
  [WW.BOK]: "BoK",
  [WW.RSK]: "RSK",
  [WW.RWK]: "RWK",
  [WW.FOF]: "FoF",
  [WW.SCK]: "SCK",
  [WW.WDP]: "WDP",
  [WW.SOTW]: "SotW",
  [WW.ZENITH]: "Zenith",
  [WW.STOMP]: "Stomp",
  [WW.XUEN]: "Xuen",
  [WW.CONDUIT]: "Conduit",
  [WW.UNITY]: "Unity",
  [WW.TOD]: "ToD",
};
const shortName = (name: string) => SHORT[name] ?? (name.length > 14 ? `${name.slice(0, 13)}…` : name);

const STATUS_ICON = { good: "✓", warn: "!", bad: "✗" } as const;

function defaultPull(pulls: PullAnalysis[]): PullAnalysis | undefined {
  const kills = pulls.filter((p) => p.kill);
  const pool = kills.length ? kills : pulls;
  return pool.reduce<PullAnalysis | undefined>((best, p) => (!best || p.dps > best.dps ? p : best), undefined);
}

/**
 * The Windwalker lens on the player analysis: a scorecard against the top
 * parses, then every burst window and every wrong press of one pull, marked
 * where it happened.
 */
export function WindwalkerView({ report }: { report: AnalysisReport }) {
  const ww = report.windwalker;
  const [fightId, setFightId] = useState(() => (ww ? defaultPull(ww.pulls)?.fightId : undefined));
  const [openWindow, setOpenWindow] = useState<number | null>(0);
  const [showAll, setShowAll] = useState(false);

  const pull = ww?.pulls.find((p) => p.fightId === fightId) ?? ww?.pulls[0];
  const flagged = useMemo(() => (pull ? pull.presses.filter((p) => p.marks.length > 0) : []), [pull]);

  if (!ww) {
    return (
      <div className="panel">
        <b>Not a Windwalker Monk.</b>{" "}
        <span className="muted">
          This view analyses Windwalker button presses. {report.player.name} is{" "}
          {report.player.specName ?? "an unknown spec"} {report.player.className ?? ""} — pick a Windwalker in
          the sidebar.
        </span>
      </div>
    );
  }
  if (!pull) return null;

  const link = (ms: number) =>
    wclUrl(report.report.code, pull.fightId, {
      source: report.player.actorId,
      window: pull.startTime != null ? { startTime: pull.startTime, startMs: ms } : undefined,
    });
  const counts = { bad: 0, warn: 0 };
  for (const p of flagged) for (const m of p.marks) counts[m.level] += 1;

  return (
    <div>
      {/* --- Header ------------------------------------------------------- */}
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <div style={{ fontSize: 20, fontWeight: 600 }}>
          {report.player.name}{" "}
          <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>
            Windwalker · {TREE_LABEL[ww.tree]} · {report.encounter.difficulty} {report.encounter.name} ·{" "}
            {report.pulls.length} pull{report.pulls.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 16 }}>
        Hero tree read from the log ({ww.treeEvidence}). Every target below is what the {ww.reference.length}{" "}
        build-matched top parses did on this boss, measured the same way.
        {ww.referenceTree !== ww.tree && ww.referenceTree !== "unknown" && (
          <span style={{ color: "var(--minor)" }}>
            {" "}
            The top parses play {TREE_LABEL[ww.referenceTree]}, so tree-specific targets compare against a
            different playstyle.
          </span>
        )}
        {ww.tree === "shado-pan" && (
          <span> The burst-window checks are Conduit-only; Shado-Pan gets the universal ones.</span>
        )}
      </div>

      {/* --- Scorecard ---------------------------------------------------- */}
      <div className="ww-checks">
        {ww.checks.map((c) => (
          <CheckCard key={c.id} check={c} />
        ))}
      </div>

      {/* --- One pull in detail ------------------------------------------ */}
      <div className="panel" style={{ marginTop: 24 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end", marginBottom: 12 }}>
          <div>
            <div style={{ fontWeight: 600 }}>Button presses, pull by pull</div>
            <div className="muted" style={{ fontSize: 12 }}>
              <span className="ww-dot bad" /> {counts.bad} wrong press{counts.bad === 1 ? "" : "es"} ·{" "}
              <span className="ww-dot warn" /> {counts.warn} to look at · hover a press for the reason
            </div>
          </div>
          <label style={{ minWidth: 240 }}>
            <div className="muted" style={{ fontSize: 11, marginBottom: 3 }}>
              PULL
            </div>
            <select
              value={pull.fightId}
              onChange={(e) => {
                setFightId(Number(e.target.value));
                setOpenWindow(0);
              }}
              style={{ padding: "6px 9px", fontSize: 13 }}
            >
              {ww.pulls.map((p) => {
                const bad = p.presses.reduce((n, x) => n + x.marks.filter((m) => m.level === "bad").length, 0);
                return (
                  <option key={p.fightId} value={p.fightId}>
                    {p.label} · {k(p.dps)} · {bad} wrong
                  </option>
                );
              })}
            </select>
          </label>
        </div>

        {pull.windows.length > 0 && (
          <>
            <div className="ww-sub">Burst windows — Xuen → Zenith → … → Celestial Conduit</div>
            <WindowTable pull={pull} open={openWindow} onToggle={(i) => setOpenWindow(openWindow === i ? null : i)} link={link} />
          </>
        )}

        <div className="ww-sub" style={{ marginTop: 20 }}>
          Flagged presses ({flagged.length})
        </div>
        {flagged.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>
            Nothing flagged on this pull.
          </div>
        ) : (
          <div className="ww-flags">
            {flagged.map((p, i) => (
              <div key={i} className={`ww-flag ${p.marks.some((m) => m.level === "bad") ? "bad" : "warn"}`}>
                <a className="mono" href={link(p.t)} target="_blank" rel="noreferrer" title="open in WarcraftLogs">
                  {formatDuration(p.t)}
                </a>
                <PressChip press={p} icons={report.icons} />
                <div>
                  {p.marks.map((m) => (
                    <div key={m.code}>{m.note}</div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="ww-sub" style={{ marginTop: 20 }}>
          <button type="button" className="side-mini" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "hide" : "show"} every press of this pull
          </button>
        </div>
        {showAll && <AllPresses presses={pull.presses} icons={report.icons} />}
      </div>

      {/* --- Hero tree and builds for this boss ---------------------------- */}
      <div style={{ marginTop: 24 }}>
        <TalentBuilds report={report} />
      </div>

      {/* --- Habits and rates --------------------------------------------- */}
      <div className="grid-2" style={{ marginTop: 24, gap: 16 }}>
        <div className="panel">
          <div style={{ fontWeight: 600, marginBottom: 4 }}>What you press next</div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
            The filler habit after the two big presses, across all pulls.
          </div>
          <Habit title={`After ${WW.FOF}`} you={ww.habits.afterFof.you} top={ww.habits.afterFof.top} />
          <Habit title={`After ${WW.WDP}`} you={ww.habits.afterWdp.you} top={ww.habits.afterWdp.top} />
        </div>
        <div className="panel">
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Presses per minute</div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Your median across pulls against the top parses'.
          </div>
          <table className="abilities">
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Button</th>
                <th>you</th>
                <th>top</th>
                <th>Δ</th>
              </tr>
            </thead>
            <tbody>
              {ww.rates
                .filter((r) => r.you > 0 || r.top > 0)
                .map((r) => {
                  const delta = r.you - r.top;
                  const rel = r.top > 0 ? delta / r.top : 0;
                  const colour = rel <= -0.2 ? "var(--critical)" : rel >= 0.2 ? "var(--minor)" : "var(--muted)";
                  return (
                    <tr key={r.name}>
                      <td style={{ textAlign: "left" }}>{r.name}</td>
                      <td className="mono">{r.you.toFixed(1)}</td>
                      <td className="mono muted">{r.top.toFixed(1)}</td>
                      <td className="mono" style={{ color: colour }}>
                        {delta >= 0 ? "+" : ""}
                        {delta.toFixed(1)}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function CheckCard({ check }: { check: Check }) {
  return (
    <div className={`ww-check ${check.status}`}>
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap", gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{check.label}</span>
        <span className={`ww-status ${check.status}`}>{STATUS_ICON[check.status]}</span>
      </div>
      <div className="mono" style={{ fontSize: 15, marginTop: 4 }}>
        {check.you}
      </div>
      <div className="muted" style={{ fontSize: 11 }}>
        top parses: {check.top}
      </div>
      {check.status !== "good" && <div style={{ fontSize: 12, marginTop: 6 }}>{check.advice}</div>}
    </div>
  );
}

function Cell({ ok, children, title }: { ok: boolean | null; children: React.ReactNode; title?: string }) {
  return (
    <td className={`mono ww-cell ${ok == null ? "" : ok ? "good" : "bad"}`} title={title}>
      {children}
    </td>
  );
}

function WindowTable({
  pull,
  open,
  onToggle,
  link,
}: {
  pull: PullAnalysis;
  open: number | null;
  onToggle: (i: number) => void;
  link: (ms: number) => string;
}) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="abilities ww-windows">
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Window</th>
            <th title="Zenith pressed within 2s of Xuen">Zenith</th>
            <th title="Trinket, potion or racial within 2s of Xuen">Items</th>
            <th title="Fists of Fury between Xuen and Conduit — 2 or more">FoF</th>
            <th title="Whirling Dragon Punch inside the window — 1">WDP</th>
            <th title="Tiger Palm between Xuen and Conduit — 0">TP</th>
            <th title="Conduit 8-16s after Xuen">Conduit</th>
            <th title="Conduit at least 5s after Whirling Dragon Punch">after WDP</th>
            <th title="Fists of Fury right after Conduit (with Unity Within). Not scored: the top parses do it about half the time.">FoF next</th>
          </tr>
        </thead>
        <tbody>
          {pull.windows.map((w) => (
            <WindowRows key={w.index} pull={pull} w={w} open={open === w.index} onToggle={() => onToggle(w.index)} link={link} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WindowRows({
  pull,
  w,
  open,
  onToggle,
  link,
}: {
  pull: PullAnalysis;
  w: BurstWindow;
  open: boolean;
  onToggle: () => void;
  link: (ms: number) => string;
}) {
  const conduitOk = w.conduitMs != null && w.conduitMs >= 8_000 && w.conduitMs <= 16_000;
  return (
    <>
      <tr className="ww-window-row" onClick={onToggle}>
        <td style={{ textAlign: "left" }}>
          <span className="muted">{open ? "▾" : "▸"}</span> {w.index === 0 && w.atMs < 15_000 ? "Opener" : `#${w.index + 1}`}{" "}
          <a className="mono muted" href={link(w.atMs)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
            {formatDuration(w.atMs)}
          </a>
        </td>
        <Cell ok={w.zenith}>{w.zenith ? "✓" : "✗"}</Cell>
        <Cell ok={w.items}>{w.items == null ? "—" : w.items ? "✓" : "✗"}</Cell>
        <Cell ok={w.fof >= 2}>{w.fof}</Cell>
        <Cell ok={w.wdp >= 1}>{w.wdp}</Cell>
        <Cell ok={w.tigerPalms === 0}>{w.tigerPalms}</Cell>
        <Cell ok={w.conduitMs == null ? false : conduitOk}>{w.conduitMs == null ? "none" : `+${secs(w.conduitMs)}`}</Cell>
        <Cell ok={w.sinceWdpMs == null ? null : w.sinceWdpMs >= 5_000}>{w.sinceWdpMs == null ? "—" : secs(w.sinceWdpMs)}</Cell>
        <td className="mono ww-cell muted">{w.fofAfterConduit == null ? "—" : w.fofAfterConduit ? "yes" : "no"}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={9} style={{ textAlign: "left", whiteSpace: "normal", background: "var(--panel-2)" }}>
            <div className="ww-strip">
              {pull.presses.slice(w.from, w.to).map((p, i) => (
                <PressChip key={i} press={p} offsetMs={p.t - w.atMs} />
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function PressChip({ press, icons, offsetMs }: { press: Press; icons?: Record<number, string>; offsetMs?: number }) {
  const level = press.marks.some((m) => m.level === "bad") ? "bad" : press.marks.length ? "warn" : "";
  const src = icons ? iconUrl(icons[press.gameID]) : null;
  const title = [
    `${press.name} at ${formatDuration(press.t)}`,
    ...press.marks.map((m) => `${m.level === "bad" ? "✗" : "!"} ${m.note}`),
  ].join("\n");
  return (
    <span className={`ww-chip ${press.kind} ${level}`} title={title}>
      {src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" width={14} height={14} />
      )}
      {shortName(press.name)}
      {offsetMs != null && <span className="ww-chip-t">{offsetMs >= 0 ? "+" : ""}{(offsetMs / 1000).toFixed(1)}</span>}
    </span>
  );
}

/** Every press of the pull in 20-second rows, so the wrong ones stand out in context. */
function AllPresses({ presses, icons }: { presses: Press[]; icons: Record<number, string> }) {
  const rows = new Map<number, Press[]>();
  for (const p of presses) {
    if (p.kind === "other") continue;
    const row = Math.floor(p.t / 20_000);
    (rows.get(row) ?? rows.set(row, []).get(row)!).push(p);
  }
  return (
    <div className="ww-all">
      {[...rows.entries()].map(([row, ps]) => (
        <div key={row} className="ww-all-row">
          <span className="mono muted">{formatDuration(row * 20_000)}</span>
          <div className="ww-strip">
            {ps.map((p, i) => (
              <PressChip key={i} press={p} icons={icons} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Habit({ title, you, top }: { title: string; you: Record<string, number>; top: Record<string, number> }) {
  const names = [...new Set([...Object.keys(top), ...Object.keys(you)])]
    .sort((a, b) => (top[b] ?? 0) + (you[b] ?? 0) - (top[a] ?? 0) - (you[a] ?? 0))
    .slice(0, 4);
  if (names.length === 0) return null;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 13, marginBottom: 4 }}>{title}</div>
      {names.map((n) => (
        <div key={n} className="ww-habit">
          <span className="ww-habit-name">{n}</span>
          <div className="ww-habit-bars">
            <div className="ww-bar you" style={{ width: `${(you[n] ?? 0) * 100}%` }} />
            <div className="ww-bar top" style={{ width: `${(top[n] ?? 0) * 100}%` }} />
          </div>
          <span className="mono" style={{ fontSize: 11, width: 74, textAlign: "right" }}>
            {Math.round((you[n] ?? 0) * 100)}% / <span className="muted">{Math.round((top[n] ?? 0) * 100)}%</span>
          </span>
        </div>
      ))}
    </div>
  );
}
