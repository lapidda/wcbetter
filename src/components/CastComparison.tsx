"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { AnalysisReport } from "@/lib/analyze";
import { defaultComparePull, laneCpm, type CastLane, type CompareAbility } from "@/lib/model/cast-compare";
import { formatDuration } from "@/lib/model/stats";
import { iconUrl, wclUrl, wowheadSpellUrl } from "@/lib/wcl/links";

const k = (n: number) => `${(n / 1000).toFixed(1)}k`;

/** You are always the accent; reference parses keep one colour each whichever are shown. */
const YOU_COLOUR = "var(--accent)";
const REF_COLOURS = ["#e0af68", "#73daca", "#bb9af7", "#ff9e64", "#c0caf5", "#9ece6a"];

const LABEL_W = 210;
const AXIS_H = 20;
const BOSS_H = 14;
const LANE_H = 10;
const LANE_GAP = 2;
/** Tall enough for the two-line label even with a single lane. */
const MIN_GROUP_H = 32;
const NO_BOSS_CASTS: AnalysisReport["timelines"][number]["bossCasts"] = [];
const ZOOMS = [1, 2, 4, 8, 16];
/** Rows shown before "show all": cooldowns come first, so this always covers them. */
const DEFAULT_ROWS = 16;

/** A cpm this far from the reference is worth a colour on the label. */
const DIFF_RATIO = 0.25;

/**
 * Hidden rows are remembered per spec: the utility buttons worth hiding —
 * Roll, Dash, a movement charge — are the same every week for that spec, so
 * hiding them once should stick.
 */
const hiddenKey = (report: AnalysisReport) =>
  `wcbetter:hidden-rows:${report.player.className ?? "?"}:${report.player.specName ?? "?"}`;

function readHidden(key: string): Set<number> {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((n) => typeof n === "number") : []);
  } catch {
    return new Set();
  }
}

type Mode = "time" | "pct";

interface ShownLane {
  lane: CastLane;
  colour: string;
  /** Every pressed cast in this lane, sorted: the "all casts" row. */
  all: number[];
}

interface Row {
  key: string;
  ability: CompareAbility | null;
  y: number;
  h: number;
}

/**
 * Your cast timeline against the top parses' over the whole fight, one row
 * per ability and one lane per player inside it. The opener and burn panels
 * compare the scripted windows; this is for everything in between — which
 * cooldowns drift, which fillers they use while moving, where their casts
 * bunch and yours thin out.
 */
export function CastComparison({ report }: { report: AnalysisReport }) {
  const { castComparison: data } = report;

  const [pullKey, setPullKey] = useState(() => defaultComparePull(data.yours)?.key ?? "");
  const [refIdx, setRefIdx] = useState<number[]>(() => (data.reference.length > 0 ? [0] : []));
  const [mode, setMode] = useState<Mode>("time");
  const [zoom, setZoom] = useState(1);
  const [showAll, setShowAll] = useState(false);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [dragging, setDragging] = useState(false);

  // Read after mount: localStorage does not exist during the server render.
  const storageKey = hiddenKey(report);
  useEffect(() => setHidden(readHidden(storageKey)), [storageKey]);

  const updateHidden = (change: (prev: Set<number>) => Set<number>) =>
    setHidden((prev) => {
      const next = change(prev);
      try {
        localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        // Private browsing: the rows stay hidden for this session only.
      }
      return next;
    });
  const hideRow = (gameID: number) => updateHidden((prev) => new Set(prev).add(gameID));
  const showRow = (gameID: number) =>
    updateHidden((prev) => {
      const next = new Set(prev);
      next.delete(gameID);
      return next;
    });

  const scroller = useRef<HTMLDivElement>(null);
  const [fitWidth, setFitWidth] = useState(800);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setFitWidth(Math.max(300, el.clientWidth)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const you = data.yours.find((l) => l.key === pullKey) ?? data.yours[0];

  const lanes: ShownLane[] = useMemo(() => {
    if (!you) return [];
    const shown = [
      { lane: you, colour: YOU_COLOUR },
      ...refIdx
        .filter((i) => data.reference[i])
        .map((i) => ({ lane: data.reference[i], colour: REF_COLOURS[i % REF_COLOURS.length] })),
    ];
    return shown.map((s) => ({ ...s, all: Object.values(s.lane.casts).flat().sort((a, b) => a - b) }));
  }, [you, refIdx, data.reference]);

  const maxMs = Math.max(1, ...lanes.map((l) => l.lane.durationMs));
  const width = Math.round(fitWidth * zoom);

  // Keep the middle of the view where it was when zooming, instead of snapping to the start.
  const centre = useRef(0);
  const rememberCentre = () => {
    const el = scroller.current;
    if (el && el.scrollWidth > 0) centre.current = (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth;
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, centre.current * width - el.clientWidth / 2);
  }, [width]);

  // Drag to pan. Touch already scrolls natively, so this is for mouse and pen;
  // pointer capture keeps the drag alive when the cursor leaves the chart.
  const drag = useRef<{ x: number; scrollLeft: number } | null>(null);
  const pannable = zoom > 1;
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pannable || e.pointerType === "touch" || e.button !== 0) return;
    drag.current = { x: e.clientX, scrollLeft: e.currentTarget.scrollLeft };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    setHoverX(null);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    e.currentTarget.scrollLeft = drag.current.scrollLeft - (e.clientX - drag.current.x);
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
  };

  const xOf = (lane: CastLane, ms: number) =>
    mode === "time" ? (ms / maxMs) * width : (ms / Math.max(1, lane.durationMs)) * width;

  // --- Rows ---------------------------------------------------------------
  const cpmFor = (ability: CompareAbility) => lanes.map((l) => laneCpm(l.lane, ability.gameID));

  const cast = data.abilities.filter((a) => lanes.some((l) => (l.lane.casts[a.gameID]?.length ?? 0) > 0));
  const hiddenRows = cast.filter((a) => hidden.has(a.gameID));
  const abilities = cast.filter((a) => !hidden.has(a.gameID));
  const visible = showAll ? abilities : abilities.slice(0, DEFAULT_ROWS);

  const lanesH = lanes.length * LANE_H + Math.max(0, lanes.length - 1) * LANE_GAP;
  const groupH = Math.max(MIN_GROUP_H, lanesH + 10);
  const pad = (groupH - lanesH) / 2;
  const top = AXIS_H + BOSS_H + 4;
  const rows: Row[] = [{ key: "all", ability: null }, ...visible.map((a) => ({ key: String(a.gameID), ability: a }))].map(
    (r, i) => ({ ...r, y: top + i * groupH, h: groupH }),
  );
  const height = top + rows.length * groupH;

  // --- Boss lane: your pull's mechanics, coloured by frequency like the pull strip.
  const bossCasts = report.timelines.find((t) => t.fightId === you?.fightId)?.bossCasts ?? NO_BOSS_CASTS;
  const bossHue = useMemo(() => {
    const counts = new Map<number, number>();
    for (const c of bossCasts) counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    return new Map(ranked.map(([id], i) => [id, `hsl(${(i * 47) % 360} 65% 62%)`]));
  }, [bossCasts]);

  // --- Axis -----------------------------------------------------------------
  const ticks: Array<{ x: number; label: string }> = [];
  if (mode === "time") {
    const pxPerSec = width / (maxMs / 1000);
    const step = [5, 10, 15, 30, 60, 120, 300].find((s) => s * pxPerSec >= 70) ?? 600;
    for (let s = 0; s * 1000 <= maxMs; s += step) ticks.push({ x: (s * 1000 * width) / maxMs, label: formatDuration(s * 1000) });
  } else {
    const step = [5, 10, 20, 25, 50].find((p) => (p / 100) * width >= 70) ?? 100;
    for (let p = 0; p <= 100; p += step) ticks.push({ x: (p / 100) * width, label: `${p}%` });
  }

  // The chart body is thousands of rects; build it once per layout so the hover
  // cursor re-renders only itself.
  const body = useMemo(() => {
    const out: ReactElement[] = [];

    for (const t of ticks) {
      out.push(<line key={`t${t.x}`} x1={t.x} x2={t.x} y1={AXIS_H - 4} y2={height} stroke="var(--border)" strokeWidth={1} />);
      out.push(
        <text key={`tl${t.x}`} x={t.x + 3} y={AXIS_H - 7} fontSize={10} fill="var(--muted)" className="mono">
          {t.label}
        </text>,
      );
    }

    if (you) {
      for (const [i, c] of bossCasts.entries()) {
        out.push(
          <rect key={`b${i}`} x={xOf(you, c.at) - 1} y={AXIS_H} width={2} height={BOSS_H - 2} fill={bossHue.get(c.id) ?? "#5a6270"}>
            <title>{`${formatDuration(c.at)} ${report.enemyAbilities[c.id]?.name ?? c.id}`}</title>
          </rect>,
        );
      }
    }

    for (const [ri, row] of rows.entries()) {
      if (ri % 2 === 1) {
        out.push(<rect key={`z${row.key}`} x={0} y={row.y} width={width} height={row.h} fill="var(--panel-2)" opacity={0.35} />);
      }

      for (const [li, { lane, colour, all }] of lanes.entries()) {
        const y = row.y + pad + li * (LANE_H + LANE_GAP);
        const end = xOf(lane, lane.durationMs);
        const kp = `${row.key}:${lane.key}`;

        out.push(<rect key={`bg${kp}`} x={0} y={y} width={end} height={LANE_H} fill="var(--panel-2)" />);
        if (lane.burnStartMs != null) {
          const bx = xOf(lane, lane.burnStartMs);
          out.push(<rect key={`burn${kp}`} x={bx} y={y} width={Math.max(1, end - bx)} height={LANE_H} fill="var(--minor)" opacity={0.14} />);
        }

        if (row.ability == null) {
          // Every cast: the density of this row is where you were pressing buttons at all.
          for (const [i, t] of all.entries()) {
            out.push(<rect key={`a${kp}:${i}`} x={xOf(lane, t)} y={y} width={1} height={LANE_H} fill={colour} opacity={0.75} />);
          }
          for (const [i, d] of lane.deaths.entries()) {
            out.push(
              <rect key={`d${kp}:${i}`} x={xOf(lane, d) - 1} y={y - 1} width={3} height={LANE_H + 2} fill="var(--text)">
                <title>{`${lane.label} died at ${formatDuration(d)}`}</title>
              </rect>,
            );
          }
          continue;
        }

        const { gameID, name, cooldownMs } = row.ability;
        const times = lane.casts[gameID] ?? [];

        // A cooldown shows how long it was unavailable after each press; the
        // empty stretch after a bar is time it sat ready and unused.
        if (cooldownMs != null) {
          for (const [i, t] of times.entries()) {
            const until = Math.min(t + cooldownMs, times[i + 1] ?? Infinity, lane.durationMs);
            out.push(
              <rect key={`cd${kp}:${i}`} x={xOf(lane, t)} y={y} width={Math.max(1, xOf(lane, until) - xOf(lane, t))} height={LANE_H} fill={colour} opacity={0.22} />,
            );
          }
        }
        for (const [i, t] of times.entries()) {
          out.push(
            <rect key={`c${kp}:${i}`} x={xOf(lane, t) - 1} y={y} width={2} height={LANE_H} fill={colour}>
              <title>{`${lane.label}: ${name} at ${formatDuration(t)}`}</title>
            </rect>,
          );
        }
      }
    }
    return out;
    // xOf/ticks/rows are derived from exactly these inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lanes, width, mode, maxMs, showAll, bossCasts, bossHue, height, data.abilities, hidden]);

  if (!you || data.yours.length === 0) return null;

  const hoverLabel =
    hoverX == null
      ? null
      : mode === "time"
        ? formatDuration((hoverX / width) * maxMs)
        : `${((hoverX / width) * 100).toFixed(0)}% · you ${formatDuration((hoverX / width) * you.durationMs)}`;

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <div style={{ fontWeight: 600 }}>Cast timeline vs the top parses</div>
        <span className="muted" style={{ fontSize: 12 }}>
          {abilities.length} abilities · hover a mark for the exact cast
          {pannable ? " · drag to pan" : ""}
        </span>
      </div>
      <p className="muted" style={{ margin: "0 0 14px", fontSize: 13 }}>
        Every button pressed over the whole fight, one row per ability. Cooldowns come first, with a
        faint bar for the time each one was unavailable — a gap after a bar is time it sat ready and
        unused. Top parses are usually faster kills, so switch to <em>% of fight</em> to line up
        phases rather than seconds.
      </p>

      <div className="row" style={{ gap: 18, marginBottom: 12, alignItems: "flex-end" }}>
        <label style={{ minWidth: 220 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 3 }}>
            YOUR PULL
          </div>
          <select value={you.key} onChange={(e) => setPullKey(e.target.value)} style={{ padding: "6px 9px", fontSize: 13 }}>
            {data.yours.map((l) => (
              <option key={l.key} value={l.key}>
                {l.label} · {k(l.dps)}
              </option>
            ))}
          </select>
        </label>

        <div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 3 }}>
            COMPARE WITH
          </div>
          <div className="row" style={{ gap: 6 }}>
            {data.reference.map((r, i) => {
              const on = refIdx.includes(i);
              return (
                <button
                  key={r.key}
                  type="button"
                  className={`chip${on ? " on" : ""}`}
                  aria-pressed={on}
                  onClick={() => setRefIdx((prev) => (on ? prev.filter((x) => x !== i) : [...prev, i].sort((a, b) => a - b)))}
                  title={`${r.label} · ${formatDuration(r.durationMs)} kill · ${k(r.dps)} DPS`}
                >
                  <span className="swatch" style={{ background: REF_COLOURS[i % REF_COLOURS.length] }} />
                  {r.label}
                  <span className="muted mono" style={{ fontSize: 11 }}>
                    {k(r.dps)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 3 }}>
            TIME
          </div>
          <div className="seg">
            <button type="button" className={mode === "time" ? "on" : undefined} onClick={() => setMode("time")}>
              fight time
            </button>
            <button type="button" className={mode === "pct" ? "on" : undefined} onClick={() => setMode("pct")}>
              % of fight
            </button>
          </div>
        </div>

        <div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 3 }}>
            ZOOM
          </div>
          <div className="seg">
            {ZOOMS.map((z) => (
              <button
                key={z}
                type="button"
                className={zoom === z ? "on" : undefined}
                onClick={() => {
                  rememberCentre();
                  setZoom(z);
                }}
              >
                {z}×
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
        {/* Labels: fixed while the chart scrolls sideways. */}
        <div style={{ width: LABEL_W, flexShrink: 0, position: "relative", height, borderRight: "1px solid var(--border)" }}>
          <div className="muted" style={{ position: "absolute", top: AXIS_H, left: 8, fontSize: 10, lineHeight: `${BOSS_H}px` }}>
            boss casts (your pull)
          </div>
          {rows.map((row, ri) => (
            <RowLabel
              key={row.key}
              row={row}
              lanes={lanes}
              striped={ri % 2 === 1}
              cpm={row.ability ? cpmFor(row.ability) : null}
              onHide={row.ability ? () => hideRow(row.ability!.gameID) : undefined}
            />
          ))}
        </div>

        <div
          ref={scroller}
          style={{
            flex: 1,
            minWidth: 0,
            overflowX: pannable ? "auto" : "hidden",
            cursor: pannable ? (dragging ? "grabbing" : "grab") : undefined,
            userSelect: dragging ? "none" : undefined,
          }}
          onMouseLeave={() => setHoverX(null)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <svg
            width={width}
            height={height}
            style={{ display: "block" }}
            onMouseMove={(e) => {
              if (!drag.current) setHoverX(e.clientX - e.currentTarget.getBoundingClientRect().left);
            }}
          >
            {body}
            {hoverX != null && (
              <g pointerEvents="none">
                <line x1={hoverX} x2={hoverX} y1={0} y2={height} stroke="var(--text)" strokeOpacity={0.5} strokeWidth={1} />
                <rect
                  x={Math.min(hoverX + 4, width - 150)}
                  y={2}
                  width={hoverLabel!.length * 6.4 + 10}
                  height={15}
                  rx={3}
                  fill="var(--bg)"
                  stroke="var(--border)"
                />
                <text x={Math.min(hoverX + 4, width - 150) + 5} y={13} fontSize={11} fill="var(--text)" className="mono">
                  {hoverLabel}
                </text>
              </g>
            )}
          </svg>
        </div>
      </div>

      <div className="row" style={{ justifyContent: "space-between", marginTop: 10, fontSize: 12 }}>
        <div className="row muted" style={{ gap: 14 }}>
          {lanes.map((l) => (
            <span key={l.lane.key}>
              <span className="swatch" style={{ background: l.colour }} />
              {l.lane.key.startsWith("you") ? `you — ${l.lane.label}` : l.lane.label}{" "}
              <a
                href={
                  l.lane.source
                    ? wclUrl(l.lane.source.reportCode, l.lane.source.fightId, { source: l.lane.source.actorId })
                    : wclUrl(report.report.code, l.lane.fightId!, { source: report.player.actorId })
                }
                target="_blank"
                rel="noreferrer"
                title="open in WarcraftLogs"
              >
                ↗
              </a>
            </span>
          ))}
          <span>
            <span className="swatch" style={{ background: "var(--minor)", opacity: 0.5 }} />
            burn phase
          </span>
          <span>
            <span className="swatch" style={{ background: "var(--text)", width: 3 }} />
            death
          </span>
        </div>
        {abilities.length > DEFAULT_ROWS && (
          <button type="button" className="side-mini" onClick={() => setShowAll((v) => !v)}>
            {showAll ? `show top ${DEFAULT_ROWS}` : `show all ${abilities.length} abilities`}
          </button>
        )}
      </div>

      {hiddenRows.length > 0 && (
        <div className="row muted" style={{ gap: 6, marginTop: 8, fontSize: 12 }}>
          <span>Hidden for {report.player.specName ?? "this spec"}:</span>
          {hiddenRows.map((a) => (
            <button
              key={a.gameID}
              type="button"
              className="chip on"
              style={{ padding: "1px 9px", fontSize: 12 }}
              onClick={() => showRow(a.gameID)}
              title={`show ${a.name} again`}
            >
              {a.name} <span aria-hidden>↺</span>
            </button>
          ))}
          {hiddenRows.length > 1 && (
            <button type="button" className="side-mini" onClick={() => updateHidden(() => new Set())}>
              show all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RowLabel({
  row,
  lanes,
  striped,
  cpm,
  onHide,
}: {
  row: Row;
  lanes: ShownLane[];
  striped: boolean;
  cpm: number[] | null;
  onHide?: () => void;
}) {
  const base: React.CSSProperties = {
    position: "absolute",
    top: row.y,
    left: 0,
    right: 0,
    height: row.h,
    padding: "0 8px",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    background: striped ? "rgba(29, 33, 42, 0.35)" : undefined,
    overflow: "hidden",
  };

  if (!row.ability || !cpm) {
    const apm = lanes.map((l) => (l.lane.durationMs > 0 ? l.all.length / (l.lane.durationMs / 60_000) : 0));
    return (
      <div style={base} title="every button pressed, per minute">
        <div style={{ fontSize: 12, fontWeight: 600 }}>All casts</div>
        <CpmLine values={apm} lanes={lanes} />
      </div>
    );
  }

  const { gameID, name, icon, cooldownMs } = row.ability;
  const [yours, ...theirs] = cpm;
  const refMedian = theirs.length > 0 ? [...theirs].sort((a, b) => a - b)[Math.floor(theirs.length / 2)] : null;

  // The same thresholds the rotation table colours its delta by.
  let flag: { colour: string; why: string } | null = null;
  if (refMedian != null) {
    if (yours === 0 && refMedian > 0) flag = { colour: "var(--critical)", why: "you never cast this" };
    else if (refMedian === 0 && yours > 0) flag = { colour: "var(--minor)", why: "they never cast this" };
    else if (refMedian > 0 && yours < refMedian * (1 - DIFF_RATIO)) flag = { colour: "var(--critical)", why: "you cast this less often" };
    else if (refMedian > 0 && yours > refMedian * (1 + DIFF_RATIO)) flag = { colour: "var(--minor)", why: "you cast this more often" };
  }

  const src = iconUrl(icon);
  return (
    <div
      className="row-label"
      style={{ ...base, borderLeft: `2px solid ${flag?.colour ?? "transparent"}` }}
      title={flag ? `${name}: ${flag.why}` : name}
    >
      {onHide && (
        <button type="button" className="row-hide" onClick={onHide} title={`hide ${name}`} aria-label={`hide ${name}`}>
          ×
        </button>
      )}
      <div style={{ fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: 1.3 }}>
        {src && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="" width={14} height={14} style={{ borderRadius: 2, verticalAlign: "-2px", marginRight: 5 }} />
        )}
        <a href={wowheadSpellUrl(gameID)} target="_blank" rel="noreferrer" style={{ color: "var(--text)", textDecoration: "none" }}>
          {name}
        </a>
        {cooldownMs != null && (
          <span className="muted" style={{ fontSize: 10 }}>
            {" "}
            {Math.round(cooldownMs / 1000)}s
          </span>
        )}
      </div>
      <CpmLine values={cpm} lanes={lanes} />
    </div>
  );
}

function CpmLine({ values, lanes }: { values: number[]; lanes: ShownLane[] }) {
  return (
    <div className="mono" style={{ fontSize: 10, lineHeight: 1.3, whiteSpace: "nowrap" }}>
      {values.map((v, i) => (
        <span key={lanes[i].lane.key} style={{ color: lanes[i].colour, marginRight: 7 }}>
          {v.toFixed(1)}
        </span>
      ))}
      <span className="muted">/min</span>
    </div>
  );
}
