"use client";

import { BuffValueView } from "@/components/BuffValueView";
import { useWorkspace } from "@/components/Workspace";

export default function Buffs() {
  const { summary, buffs } = useWorkspace();
  const { result: payload, busy, progress, error } = buffs;

  return (
    <div className="wrap">
      <h1 style={{ fontSize: 26, margin: "0 0 4px" }}>Raid buffs</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        What each raid buff and debuff was actually worth to this raid, from its own damage split by spell
        school and checked against the auras that were up on every hit, and how much DPS a swap-in would
        need to make up for losing them.
      </p>

      {!summary && <p className="muted">Load a report in the sidebar to start.</p>}
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

      {payload && !busy && <BuffValueView payload={payload} />}
    </div>
  );
}
