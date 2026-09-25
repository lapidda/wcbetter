"use client";

import { ReportView } from "@/components/ReportView";
import { useWorkspace } from "@/components/Workspace";

export default function Home() {
  const { summary, actorId, player } = useWorkspace();
  const { result: report, busy, progress, error } = player;

  return (
    <div className="wrap">
      {error && (
        <div className="panel" style={{ marginBottom: 16, borderColor: "var(--critical)" }}>
          {error}
        </div>
      )}

      {report && !busy && <ReportView report={report} />}

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
          <h1 style={{ fontSize: 26, margin: "0 0 6px" }}>Player analysis</h1>
          <p className="muted" style={{ marginTop: 0 }}>
            Analyse every pull of a boss at once. Findings are measured against the top parses on your
            build, and ranked by how consistently you make them.
          </p>
          <ol className="muted" style={{ paddingLeft: 20, lineHeight: 1.9 }}>
            <li style={{ color: summary ? "var(--good)" : undefined }}>
              Paste a WarcraftLogs report link in the sidebar and press Load. A link straight from the
              log — with <code>fight=</code> and <code>source=</code> in it — fills in the rest.
            </li>
            <li style={{ color: actorId != null ? "var(--good)" : undefined }}>
              Pick the player and the boss.
            </li>
            <li>
              Tick the pulls to include and press Analyse, or press ▸ next to a pull to look at just
              that one. The first run takes about half a minute; after that it is instant.
            </li>
          </ol>
        </div>
      )}
    </div>
  );
}
