"use client";

import type { MechanicWave, NotableMechanic } from "@/lib/model/notable";
import { noteWorthyWaves } from "@/lib/model/notable";
import { formatDuration } from "@/lib/model/stats";

// A different shape from PullTimeline, which is row-per-pull: this is
// row-per-mechanic with one marker per wave, because the note is a list of
// moments in the fight rather than a comparison between attempts. Contorting one
// component into both jobs would serve neither.

const COLUMNS = 1000;
const ROW_H = 18;
const MARK_W = 5;

/** Outcome colours: how badly the raid handled that wave. */
function colourOf(wave: MechanicWave): string {
  if (wave.deaths > 0) return "var(--critical)";
  if (wave.consistency >= 0.8) return "var(--major)";
  if (wave.failedOn > 0) return "var(--minor)";
  return "var(--info)";
}

export interface MechanicTimelineProps {
  notable: NotableMechanic[];
  /** Longest pull, so every wave has somewhere to sit on the axis. */
  scaleMs: number;
  /** Waves already in the note, keyed `mechanic#ordinal`. */
  selected: Set<string>;
  onToggle: (mechanic: NotableMechanic, wave: MechanicWave) => void;
}

export const waveKey = (mechanic: string, ordinal: number) => `${mechanic}#${ordinal}`;

export function MechanicTimeline({ notable, scaleMs, selected, onToggle }: MechanicTimelineProps) {
  const rows = notable.filter((m) => m.waves.length > 0);
  if (rows.length === 0) return null;

  const x = (ms: number) => Math.min(COLUMNS, (ms / scaleMs) * COLUMNS);
  const minutes = Math.floor(scaleMs / 60_000);

  return (
    <div style={{ marginTop: 14 }}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
        <div className="muted" style={{ fontSize: 12 }}>
          Every wave of every mechanic. <span style={{ color: "var(--critical)" }}>killed someone</span>,{" "}
          <span style={{ color: "var(--major)" }}>failed most pulls</span>,{" "}
          <span style={{ color: "var(--minor)" }}>failed sometimes</span>,{" "}
          <span style={{ color: "var(--info)" }}>clean</span>
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          click a wave to add or remove its call
        </div>
      </div>

      {rows.map((mechanic) => {
        const worthy = new Set(noteWorthyWaves(mechanic).map((w) => w.ordinal));
        return (
          <div key={mechanic.name} className="row" style={{ gap: 10, marginBottom: 3, flexWrap: "nowrap" }}>
            <div
              className="muted"
              style={{
                width: 130,
                flexShrink: 0,
                fontSize: 11,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                opacity: mechanic.noteWorthy ? 1 : 0.55,
              }}
              title={`${mechanic.classification} — ${mechanic.reason}`}
            >
              {mechanic.name}
            </div>

            <svg
              viewBox={`0 0 ${COLUMNS} ${ROW_H}`}
              preserveAspectRatio="none"
              style={{
                flex: 1,
                height: ROW_H,
                display: "block",
                background: "var(--panel-2)",
                borderRadius: 3,
              }}
            >
              {mechanic.waves.map((wave) => {
                const key = waveKey(mechanic.name, wave.ordinal);
                const on = selected.has(key);
                const clickable = worthy.has(wave.ordinal) || on;
                return (
                  <g
                    key={wave.ordinal}
                    onClick={() => onToggle(mechanic, wave)}
                    style={{ cursor: "pointer" }}
                  >
                    {/* Selected waves get a full-height backing so the note's
                        contents are readable off the timeline at a glance. */}
                    {on && (
                      <rect
                        x={x(wave.atMs) - MARK_W}
                        y={0}
                        width={MARK_W * 2}
                        height={ROW_H}
                        fill="var(--accent)"
                        opacity={0.25}
                      />
                    )}
                    <rect
                      x={x(wave.atMs) - MARK_W / 2}
                      y={3}
                      width={MARK_W}
                      height={ROW_H - 6}
                      fill={colourOf(wave)}
                      opacity={clickable ? 1 : 0.4}
                    />
                    <title>
                      {`${mechanic.name} #${wave.ordinal} at ${formatDuration(wave.atMs)}` +
                        `${wave.medianCasts > 1 ? ` (x${Math.round(wave.medianCasts)})` : ""}\n` +
                        `hit on ${wave.failedOn} of ${wave.seen} pulls that saw it` +
                        ` (${wave.reached} got this far)\n` +
                        `median ${Math.round(wave.medianHitCount)} players hit` +
                        `${wave.deaths ? `, ${wave.deaths} deaths` : ""}` +
                        `${wave.confident ? "" : `\ntimer drifts ±${(wave.spreadMs / 1000).toFixed(0)}s across pulls`}`}
                    </title>
                  </g>
                );
              })}
            </svg>
          </div>
        );
      })}

      <div className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
        <div style={{ width: 130, flexShrink: 0 }} />
        <div style={{ flex: 1, position: "relative", height: 14 }}>
          {Array.from({ length: minutes + 1 }, (_, m) => (
            <span
              key={m}
              className="mono muted"
              style={{
                position: "absolute",
                left: `${((m * 60_000) / scaleMs) * 100}%`,
                fontSize: 10,
                transform: "translateX(-50%)",
              }}
            >
              {m}:00
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
