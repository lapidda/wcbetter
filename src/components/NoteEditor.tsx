"use client";

import { CALL_PLACEHOLDER } from "@/lib/nsrt/generate";
import { wowheadUrl } from "@/lib/model/mechanic-profile";
import { isUnwritten, textOf, type DocLine } from "@/lib/model/note-doc";

const mmss = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(Math.max(0, Math.round(sec)) % 60).padStart(2, "0")}`;

export interface NoteEditorProps {
  lines: DocLine[];
  /** Mechanic name -> what it does and its spell id, for writing the call. */
  mechanics: Record<string, { description: string; spellId: number }>;
  onToggle: (id: string) => void;
  onText: (id: string, text: string) => void;
  onTime: (id: string, timeSec: number) => void;
  onRemove: (id: string) => void;
}

/**
 * One row per call. The evidence sits beside each line rather than inside the
 * note text, because the caller needs it while deciding what to write and the
 * raid does not need it on screen mid-pull.
 */
export function NoteEditor({
  lines,
  mechanics,
  onToggle,
  onText,
  onTime,
  onRemove,
}: NoteEditorProps) {
  if (lines.length === 0) {
    return (
      <p className="muted" style={{ marginTop: 12 }}>
        No calls yet. Click a wave on the timeline above to add one.
      </p>
    );
  }

  return (
    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
      {lines.map((line) => {
        const unwritten = isUnwritten(line);
        const about = mechanics[line.mechanic];
        return (
          <div key={line.id}>
          <div
            className="row"
            style={{
              gap: 8,
              flexWrap: "nowrap",
              alignItems: "center",
              padding: "6px 8px",
              borderRadius: 6,
              background: "var(--panel-2)",
              opacity: line.enabled ? 1 : 0.45,
              borderLeft: `3px solid ${
                line.deaths > 0 ? "var(--critical)" : unwritten ? "var(--minor)" : "transparent"
              }`,
            }}
          >
            <input
              type="checkbox"
              checked={line.enabled}
              onChange={() => onToggle(line.id)}
              style={{ width: 16, flexShrink: 0 }}
              title={line.enabled ? "in the note" : "left out of the note"}
            />

            <input
              className="mono"
              type="text"
              value={mmss(line.timeSec)}
              onChange={(e) => {
                const [m, s] = e.target.value.split(":");
                const secs = Number(m) * 60 + Number(s ?? 0);
                if (Number.isFinite(secs)) onTime(line.id, secs);
              }}
              style={{ width: 62, flexShrink: 0, padding: "5px 6px", textAlign: "center" }}
              title={
                line.confident
                  ? "when this fires"
                  : `the boss timer drifts ±${(line.spreadMs / 1000).toFixed(0)}s across pulls, so this is approximate`
              }
            />

            <input
              type="text"
              value={textOf(line)}
              onChange={(e) => onText(line.id, e.target.value)}
              placeholder={CALL_PLACEHOLDER}
              spellCheck={false}
              style={{
                flex: 1,
                padding: "5px 8px",
                color: unwritten ? "var(--minor)" : "var(--text)",
              }}
            />

            <span
              className="mono muted"
              style={{ width: 150, flexShrink: 0, fontSize: 11, textAlign: "right" }}
              title={
                line.source
                  ? `${line.mechanic} wave ${line.source.ordinal}: hit on ${line.failedOn} of ${line.seen} pulls that saw it, ${line.reached} got this far`
                  : "added by hand"
              }
            >
              {line.source
                ? `${Math.round(line.medianHitCount)} hit · ${line.failedOn}/${line.seen}` +
                  (line.deaths ? ` · ✝${line.deaths}` : "")
                : "manual"}
              {line.confident ? "" : " ·~"}
            </span>

            <button
              onClick={() => onRemove(line.id)}
              style={{ padding: "3px 8px", flexShrink: 0 }}
              title="remove this call"
            >
              ×
            </button>
          </div>

          {about && (
            <div
              className="muted"
              style={{ fontSize: 11, padding: "2px 0 4px 30px", opacity: line.enabled ? 0.8 : 0.4 }}
            >
              {about.description}
              {" · "}
              <a
                href={wowheadUrl(about.spellId)}
                target="_blank"
                rel="noreferrer"
                className="muted"
                title="the spell on Wowhead — opens only if you click it"
              >
                tooltip
              </a>
            </div>
          )}
          </div>
        );
      })}
    </div>
  );
}
