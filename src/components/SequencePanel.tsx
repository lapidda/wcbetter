"use client";

import type { AggregatedFinding } from "@/lib/model/aggregate";

interface Column {
  name: string;
  steps: string[];
}

/**
 * The opener and burn rules write their side-by-side as evidence lines: a
 * header ending in a colon, then numbered casts. Turn that back into columns.
 */
function parseColumns(lines: string[]): Column[] {
  const columns: Column[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.endsWith(":") && !raw.startsWith(" ")) {
      columns.push({ name: line.slice(0, -1), steps: [] });
      continue;
    }
    // Lines before the first header are aggregation notes, not casts.
    if (columns.length === 0) continue;
    columns[columns.length - 1].steps.push(line.replace(/^\d+\.\s*/, ""));
  }
  return columns;
}

/**
 * A scripted window shown side by side against the top parses. These are the
 * most practisable artefacts in the report — nothing in them reacts to the
 * fight — so they are always visible rather than folded into a disclosure.
 */
export function SequencePanel({ finding, title }: { finding: AggregatedFinding; title: string }) {
  const columns = parseColumns(finding.evidence);
  if (columns.length === 0) return null;

  return (
    <div className="panel" style={{ marginBottom: 10 }}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <span className="muted" style={{ fontSize: 11, letterSpacing: 0.6 }}>
          {finding.occurrences === finding.totalPulls
            ? `EVERY PULL (${finding.totalPulls})`
            : `${finding.occurrences} OF ${finding.totalPulls} PULLS`}
        </span>
      </div>
      <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
        {finding.detail}
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`,
          gap: 16,
          overflowX: "auto",
        }}
      >
        {columns.map((col) => (
          <div key={col.name}>
            <div
              style={{
                fontSize: 11,
                letterSpacing: 0.6,
                marginBottom: 6,
                color: col.name === "YOURS" ? "var(--accent)" : "var(--muted)",
              }}
            >
              {col.name === "YOURS" ? "YOU" : col.name}
            </div>
            <ol className="mono" style={{ margin: 0, paddingLeft: 22, fontSize: 12 }}>
              {col.steps.map((step, i) => (
                <li key={i} style={{ whiteSpace: "nowrap" }}>
                  {step}
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>

      <p style={{ margin: "12px 0 0", color: "var(--accent)", fontSize: 14 }}>{finding.advice}</p>
    </div>
  );
}
