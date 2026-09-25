"use client";

import { useState, type ReactNode } from "react";
import type { AggregatedFinding } from "@/lib/model/aggregate";
import { FindingCard, type LinkContext } from "./FindingCard";

/** Cards shown before the section folds the rest behind a button. */
const VISIBLE = 6;

export function FindingSection({
  title,
  findings,
  medianDps,
  links,
  focusCount,
  lead,
}: {
  title: string;
  findings: AggregatedFinding[];
  medianDps: number;
  links: LinkContext;
  /** How many of this family's findings already sit in the focus block. */
  focusCount: number;
  /** Rendered between the header and the cards — the rotation table, say. */
  lead?: ReactNode;
}) {
  const [showAll, setShowAll] = useState(false);
  if (findings.length === 0 && !lead) return null;

  // Findings in a family overlap, so the section's gain is the largest, not the sum.
  const maxGain = Math.max(0, ...findings.map((f) => f.medianGainPct ?? 0));
  const visible = showAll ? findings : findings.slice(0, VISIBLE);
  const hidden = findings.length - visible.length;

  return (
    <section style={{ marginTop: 28 }}>
      <div className="section-head">
        <h3>{title}</h3>
        <span className="muted" style={{ fontSize: 12 }}>
          {findings.length} finding{findings.length === 1 ? "" : "s"}
          {maxGain >= 0.5 ? ` · up to +${maxGain.toFixed(1)}%` : ""}
          {focusCount > 0 ? ` · ${focusCount} more in "fix these first"` : ""}
        </span>
      </div>

      {lead}

      {visible.map((f) => (
        <FindingCard key={f.id} finding={f} medianDps={medianDps} links={links} />
      ))}

      {hidden > 0 && (
        <button type="button" onClick={() => setShowAll(true)} style={{ marginTop: 4 }}>
          Show {hidden} more
        </button>
      )}
    </section>
  );
}
