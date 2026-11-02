"use client";

import { DeathKnightView } from "@/components/DeathKnightView";
import { useWorkspace } from "@/components/Workspace";

export default function DeathKnight() {
  const { summary, player } = useWorkspace();
  const { result: report, busy, progress, error } = player;

  return (
    <div className="wrap">
      {error && (
        <div className="panel" style={{ marginBottom: 16, borderColor: "var(--critical)" }}>
          {error}
        </div>
      )}

      {report && !busy && <DeathKnightView report={report} />}

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
          <h1 style={{ fontSize: 26, margin: "0 0 6px" }}>Death Knight</h1>
          <p className="muted" style={{ marginTop: 0 }}>
            Your Unholy or Frost button presses against Wowhead&apos;s priority list, cross-checked with Icy Veins and
            Method: which line you break more often than the top Death Knights on the same boss, every proc you let run
            out, and the guide&apos;s lists with the lines your build does not use crossed out.
          </p>
          <p className="muted">
            {summary
              ? "Pick your Death Knight and the boss in the sidebar, then press Analyse."
              : "Load a report in the sidebar to start."}{" "}
            It shares the run with the player analysis, so switching between the two costs nothing.
          </p>
        </div>
      )}
    </div>
  );
}
