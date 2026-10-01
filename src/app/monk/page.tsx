"use client";

import { WindwalkerView } from "@/components/WindwalkerView";
import { useWorkspace } from "@/components/Workspace";

export default function Monk() {
  const { summary, player } = useWorkspace();
  const { result: report, busy, progress, error } = player;

  return (
    <div className="wrap">
      {error && (
        <div className="panel" style={{ marginBottom: 16, borderColor: "var(--critical)" }}>
          {error}
        </div>
      )}

      {report && !busy && <WindwalkerView report={report} />}

      {busy && (
        <div className="panel mono">
          {progress.length === 0 && <div className="muted">Starting…</div>}
          {progress.map((line, i) => (
            <div key={i} className={i === progress.length - 1 ? undefined : "muted"}>
              {line}
            </div>
          ))}
        </div>
      )}

      {!report && !busy && (
        <div style={{ maxWidth: 640 }}>
          <h1 style={{ fontSize: 26, margin: "0 0 6px" }}>Windwalker</h1>
          <p className="muted" style={{ marginTop: 0 }}>
            Your button presses against the top Windwalkers on the same boss: every Combo Strikes break,
            every burst window checked step by step, and the wrong presses marked where they happened.
          </p>
          <p className="muted">
            {summary
              ? "Pick your Windwalker and the boss in the sidebar, then press Analyse."
              : "Load a report in the sidebar to start."}{" "}
            It shares the run with the player analysis, so switching between the two costs nothing.
          </p>
        </div>
      )}
    </div>
  );
}
