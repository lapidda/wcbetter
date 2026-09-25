"use client";

import type { AnalysisReport } from "@/lib/analyze";
import { formatDuration } from "@/lib/model/stats";
import { wclUrl } from "@/lib/wcl/links";

const k = (n: number) => `${(n / 1000).toFixed(1)}k`;

/** Horizontal resolution of a row. Casts are bucketed into this many columns. */
const COLUMNS = 1000;
const BAR_H = 14;
const LANE_H = 6;
const ROW_H = BAR_H + LANE_H + 2;

/**
 * One row per pull on a shared time axis, so the same second lines up
 * vertically across the night and recurring downtime shows as a band. Casts
 * are density, gaps are red, deaths are marked, and the boss's mechanic casts
 * sit in a lane above the bar so a gap can be read against what caused it.
 * Everything clickable opens the WarcraftLogs replay at that moment.
 */
export function PullTimeline({ report }: { report: AnalysisReport }) {
  const { timelines, enemyAbilities } = report;
  if (timelines.length === 0) return null;

  const scaleMs = Math.max(...timelines.map((t) => t.durationMs));
  const x = (ms: number) => (ms / scaleMs) * COLUMNS;

  // Colour the eight most frequent mechanics; the rest share grey. Hues are
  // spread around the wheel so neighbours in the legend stay distinguishable.
  const bossCounts = new Map<number, number>();
  for (const t of timelines) for (const c of t.bossCasts) bossCounts.set(c.id, (bossCounts.get(c.id) ?? 0) + 1);
  const legend = [...bossCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const hue = new Map(legend.map(([id], i) => [id, `hsl(${(i * 47) % 360} 65% 62%)`]));
  const colourOf = (id: number) => hue.get(id) ?? "#5a6270";

  const minutes = Math.floor(scaleMs / 60_000);
  const pullByFight = new Map(report.pulls.map((p) => [p.fightId, p]));

  return (
    <div style={{ marginTop: 20 }}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
        <div className="muted" style={{ fontSize: 12 }}>
          Per pull — casts, <span style={{ color: "var(--critical)" }}>gaps</span>,{" "}
          <span style={{ color: "var(--text)" }}>✝ deaths</span>, boss casts above,{" "}
          <span style={{ color: "var(--minor)" }}>burn phase</span> shaded
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          click a gap to open it in the log
        </div>
      </div>

      {timelines.map((t) => {
        const pull = pullByFight.get(t.fightId);
        const density = new Uint16Array(COLUMNS);
        for (const at of t.casts) {
          const col = Math.min(COLUMNS - 1, Math.floor((at / scaleMs) * COLUMNS));
          density[col] += 1;
        }
        const columns: Array<{ col: number; n: number }> = [];
        for (let c = 0; c < COLUMNS; c++) if (density[c] > 0) columns.push({ col: c, n: density[c] });

        return (
          <div key={t.fightId} className="row" style={{ gap: 10, marginBottom: 3, flexWrap: "nowrap" }}>
            <a
              className="mono muted"
              style={{ width: 52, flexShrink: 0, textDecoration: "none" }}
              href={wclUrl(report.report.code, t.fightId, { source: report.player.actorId })}
              target="_blank"
              rel="noreferrer"
              title="open this pull in WarcraftLogs"
            >
              {formatDuration(t.durationMs)}
            </a>

            <svg
              viewBox={`0 0 ${COLUMNS} ${ROW_H}`}
              preserveAspectRatio="none"
              style={{ flex: 1, height: ROW_H, display: "block", background: "var(--panel-2)", borderRadius: 3 }}
            >
              {/* Boss mechanic lane */}
              {t.bossCasts.map((c, i) => (
                <rect key={`b${i}`} x={x(c.at)} y={0} width={2} height={LANE_H} fill={colourOf(c.id)}>
                  <title>{`${formatDuration(c.at)} ${enemyAbilities[c.id]?.name ?? c.id}`}</title>
                </rect>
              ))}

              {/* Beyond this pull's end: nothing happened, draw it darker */}
              <rect x={x(t.durationMs)} y={LANE_H + 2} width={COLUMNS - x(t.durationMs)} height={BAR_H} fill="var(--bg)" opacity={0.6} />

              {/* Burn phase: everything after the boss dropped into execute range */}
              {t.burnStartMs != null && (
                <rect
                  x={x(t.burnStartMs)}
                  y={0}
                  width={Math.max(1, x(t.durationMs) - x(t.burnStartMs))}
                  height={ROW_H}
                  fill="var(--minor)"
                  opacity={0.1}
                >
                  <title>{`burn phase from ${formatDuration(t.burnStartMs)}`}</title>
                </rect>
              )}

              {/* Cast density */}
              {columns.map(({ col, n }) => (
                <rect
                  key={col}
                  x={col}
                  y={LANE_H + 2}
                  width={1}
                  height={BAR_H}
                  fill={pull?.kill ? "var(--accent)" : "#6b7a93"}
                  opacity={Math.min(1, n / 2)}
                />
              ))}

              {/* Gaps, clickable */}
              {t.gaps
                .filter((g) => g.e - g.s >= 3000)
                .map((g, i) => (
                  <a
                    key={`g${i}`}
                    href={wclUrl(report.report.code, t.fightId, {
                      source: report.player.actorId,
                      window: { startTime: t.startTime, startMs: g.s, endMs: g.e },
                    })}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <rect x={x(g.s)} y={LANE_H + 2} width={Math.max(1.5, x(g.e) - x(g.s))} height={BAR_H} fill="var(--critical)" opacity={0.75}>
                      <title>
                        {`${formatDuration(g.s)}–${formatDuration(g.e)} (${((g.e - g.s) / 1000).toFixed(1)}s)` +
                          (g.mechanic != null
                            ? ` · after ${enemyAbilities[g.mechanic]?.name ?? g.mechanic}`
                            : " · no boss cast in the previous 8s")}
                      </title>
                    </rect>
                  </a>
                ))}

              {/* Deaths */}
              {t.deaths.map((d, i) => (
                <rect key={`d${i}`} x={x(d.at) - 1.5} y={LANE_H} width={3} height={BAR_H + 2} fill="var(--text)">
                  <title>{`died ${formatDuration(d.at)}${d.ability ? ` to ${d.ability}` : ""}`}</title>
                </rect>
              ))}
            </svg>

            <div className="mono" style={{ width: 58, flexShrink: 0, textAlign: "right" }}>
              {pull ? k(pull.dps) : ""}
            </div>
            <div className="mono muted" style={{ width: 74, flexShrink: 0 }}>
              {pull?.kill ? "kill" : `${pull?.bossPercentage?.toFixed(1) ?? "?"}%`}
              {pull && pull.deaths > 0 ? ` ✝${pull.deaths}` : ""}
            </div>
          </div>
        );
      })}

      {/* Time axis */}
      <div className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
        <div style={{ width: 52, flexShrink: 0 }} />
        <div style={{ flex: 1, position: "relative", height: 14 }}>
          {Array.from({ length: minutes + 1 }, (_, m) => (
            <span
              key={m}
              className="mono muted"
              style={{ position: "absolute", left: `${((m * 60_000) / scaleMs) * 100}%`, fontSize: 10, transform: "translateX(-50%)" }}
            >
              {m}:00
            </span>
          ))}
        </div>
        <div style={{ width: 58 + 10 + 74, flexShrink: 0 }} />
      </div>

      {legend.length > 0 && (
        <div className="row" style={{ gap: 12, marginTop: 8, fontSize: 11 }}>
          {legend.map(([id, n]) => (
            <span key={id} className="muted">
              <span style={{ display: "inline-block", width: 8, height: 8, background: colourOf(id), marginRight: 5, borderRadius: 1 }} />
              {enemyAbilities[id]?.name ?? id} ({n})
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
