"use client";

import { useState } from "react";
import { TankLookupPanel } from "@/components/TankLookupPanel";
import { TanksView } from "@/components/TanksView";
import { useWorkspace } from "@/components/Workspace";

export default function Tanks() {
  const { summary, raid, hrefFor, tankLookup } = useWorkspace();
  const { result: payload, busy, progress, error } = raid;
  // Without a report loaded, the top-players lookup is the only thing to show.
  const [mode, setMode] = useState<"yours" | "top">(() => (tankLookup.result || !summary ? "top" : "yours"));

  return (
    <div className="wrap">
      <h1 style={{ fontSize: 26, margin: "0 0 4px" }}>Tanks</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Who takes the boss first, when each tank taunted and at how many stacks, and which cooldown was up
        when a tank buster landed — for your own raid, or for the top players of any tank spec.
      </p>

      <div className="tabs" role="tablist">
        {(
          [
            ["yours", "From your log"],
            ["top", "Top players"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={mode === id} className={mode === id ? "active" : undefined} onClick={() => setMode(id)}>
            {label}
          </button>
        ))}
      </div>

      {mode === "top" && <TankLookupPanel />}

      {mode === "yours" && (
        <>
          {!summary && <p className="muted">Load a report in the sidebar to start, or look at the top players instead.</p>}
          {summary && !payload && !busy && <p className="muted">Pick a boss and its pulls in the sidebar, then press Analyse.</p>}

          {error && (
            <div className="panel" style={{ marginTop: 14, borderColor: "var(--critical)" }}>
              {error}
            </div>
          )}

          {busy && (
            <div className="panel mono" style={{ marginTop: 14 }}>
              {progress.length === 0 && <div className="muted">Starting…</div>}
              {progress.map((line, i) => (
                <div key={i} className={i === progress.length - 1 ? undefined : "muted"}>
                  {line}
                </div>
              ))}
            </div>
          )}

          {payload && !busy && <TanksView payload={payload} hrefNotes={hrefFor("notes")} />}
        </>
      )}
    </div>
  );
}
