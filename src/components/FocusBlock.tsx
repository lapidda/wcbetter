"use client";

import type { AnalysisReport } from "@/lib/analyze";
import { FindingCard, type LinkContext } from "./FindingCard";

/**
 * The report's answer to "what do I fix first": at most three items, never two
 * from the same family, advice before evidence, and each gain in DPS.
 */
export function FocusBlock({ report, links }: { report: AnalysisReport; links: LinkContext }) {
  const byId = new Map(report.findings.map((f) => [f.id, f]));
  const items = report.focus.map((f) => byId.get(f.findingId)).filter((f) => f != null);

  if (items.length === 0) {
    return (
      <div className="panel muted">
        Nothing stood out across these pulls. Either they were very clean, or the reference parses
        were too different from your build to compare against.
      </div>
    );
  }

  return (
    <div>
      {items.map((finding, i) => (
        <FindingCard
          key={finding.id}
          finding={finding}
          medianDps={report.totals.medianDps}
          links={links}
          rank={i + 1}
          defaultOpen
          adviceFirst
        />
      ))}
    </div>
  );
}
