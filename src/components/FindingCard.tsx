"use client";

import { useState } from "react";
import type { AggregatedFinding } from "@/lib/model/aggregate";
import { formatDuration } from "@/lib/model/stats";
import type { Severity } from "@/lib/rules";
import { wclUrl, wowheadSpellUrl } from "@/lib/wcl/links";

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "var(--critical)",
  major: "var(--major)",
  minor: "var(--minor)",
  info: "var(--info)",
};

const k = (n: number) => `${(n / 1000).toFixed(1)}k`;

/** What a card needs to deep-link into the player's own log. */
export interface LinkContext {
  code: string;
  actorId: number;
  /** fightId -> report-relative start, for WCL start=/end=. */
  startTimeByFight: Record<number, number>;
}

export interface FindingCardProps {
  finding: AggregatedFinding;
  /** The player's median DPS, so a gain can be shown in absolute terms as well as a share. */
  medianDps: number;
  links?: LinkContext;
  defaultOpen?: boolean;
  /** 1-3 when the card sits in the "fix these first" block. */
  rank?: number;
  /** Lead with the action rather than the observation. */
  adviceFirst?: boolean;
}

export function FindingCard({ finding, medianDps, links, defaultOpen = false, rank, adviceFirst = false }: FindingCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const color = SEVERITY_COLOR[finding.severity];

  // Habit vs one-off is the single most useful thing multi-pull analysis adds,
  // so it gets equal billing with severity rather than hiding in the detail.
  const everyPull = finding.occurrences === finding.totalPulls;
  const oneOff = finding.occurrences === 1 && finding.totalPulls > 2;

  const gainPct = finding.medianGainPct;
  const showGain = gainPct != null && gainPct >= 0.1;

  const replay = (fightId: number, atMs: number, endMs?: number) =>
    links
      ? wclUrl(links.code, fightId, {
          source: links.actorId,
          window: { startTime: links.startTimeByFight[fightId] ?? 0, startMs: atMs, endMs },
        })
      : null;

  const advice = <p style={{ margin: "10px 0", color: "var(--accent)" }}>{finding.advice}</p>;
  const detail = <p style={{ margin: "0 0 10px" }}>{finding.detail}</p>;

  return (
    <div
      className="panel"
      style={{ borderLeft: `3px solid ${color}`, padding: "14px 18px", marginBottom: 10 }}
    >
      <button
        type="button"
        className="cardhead"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 10, fontSize: 11, letterSpacing: 0.6 }}>
            {rank != null && <span className="rank">#{rank}</span>}
            <span style={{ color, textTransform: "uppercase" }}>{finding.severity}</span>
            <Consistency finding={finding} everyPull={everyPull} oneOff={oneOff} />
          </div>
          <div style={{ fontWeight: 600 }}>{finding.title}</div>
        </div>

        <div className="row" style={{ gap: 14, flexShrink: 0 }}>
          {showGain && (
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 11 }} className="muted">
                gain when it happens
              </div>
              <div style={{ fontWeight: 600, color }}>
                ≈ +{k((gainPct / 100) * medianDps)} DPS
                <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
                  {" "}
                  (+{gainPct.toFixed(1)}%)
                </span>
              </div>
            </div>
          )}
          <span className="muted" aria-hidden="true">
            {open ? "−" : "+"}
          </span>
        </div>
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          {adviceFirst ? advice : detail}
          {adviceFirst ? detail : null}

          {finding.metric && (
            <div className="row" style={{ gap: 24, margin: "12px 0" }}>
              <Stat label={`${finding.metric.label} (you)`} value={finding.metric.you} />
              <Stat label="top parses" value={finding.metric.reference} muted />
            </div>
          )}

          {adviceFirst ? null : advice}

          {(finding.abilityId != null || (links && finding.anchors?.length)) && (
            <div className="row" style={{ gap: 12, fontSize: 12, margin: "6px 0" }}>
              {finding.abilityId != null && (
                <a href={wowheadSpellUrl(finding.abilityId)} target="_blank" rel="noreferrer">
                  ↗ wowhead
                </a>
              )}
              {links &&
                finding.anchors?.slice(0, 6).map((a, i) => (
                  <a
                    key={i}
                    href={replay(finding.representativeFightId, a.atMs, a.endMs) ?? "#"}
                    target="_blank"
                    rel="noreferrer"
                    title={`open the ${a.label} in WarcraftLogs`}
                  >
                    ↗ {a.label}
                  </a>
                ))}
              {links && (finding.anchors?.length ?? 0) > 6 && (
                <span className="muted">+{finding.anchors!.length - 6} more in the evidence</span>
              )}
            </div>
          )}

          {finding.perPull.length > 1 && (
            <details style={{ marginTop: 10 }}>
              <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>
                Per pull ({finding.perPull.length})
              </summary>
              <ul className="mono muted" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                {finding.perPull.map((p) => (
                  <li key={p.fightId}>
                    {p.label} — {p.title}
                    {p.gainPct != null && p.gainPct >= 0.1 ? ` (+${p.gainPct.toFixed(1)}%)` : ""}
                    {links && p.anchor && (
                      <>
                        {" "}
                        <a href={replay(p.fightId, p.anchor.atMs, p.anchor.endMs) ?? "#"} target="_blank" rel="noreferrer">
                          ↗ {formatDuration(p.anchor.atMs)}
                        </a>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {finding.evidence.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>
                Evidence
              </summary>
              <ul className="mono muted" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                {finding.evidence.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function Consistency({
  finding,
  everyPull,
  oneOff,
}: {
  finding: AggregatedFinding;
  everyPull: boolean;
  oneOff: boolean;
}) {
  const label = everyPull
    ? `EVERY PULL (${finding.totalPulls})`
    : `${finding.occurrences} OF ${finding.totalPulls} PULLS`;

  return (
    <span
      className="muted"
      style={{
        color: everyPull ? "var(--text)" : undefined,
        opacity: oneOff ? 0.6 : 1,
      }}
    >
      {label}
      {oneOff ? " · likely a one-off" : ""}
    </span>
  );
}

function Stat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 11 }}>
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 600, color: muted ? "var(--muted)" : undefined }}>
        {value}
      </div>
    </div>
  );
}
