"use client";

import { useMemo, useState } from "react";
import type { AnalysisReport } from "@/lib/analyze";
import { alignOpeners, type AlignedRow, type OpenerLane, type OpenerStep, type StepStatus } from "@/lib/model/opener";
import { iconUrl, wclUrl, wowheadSpellUrl } from "@/lib/wcl/links";

const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

const STATUS_TEXT: Record<StepStatus, string> = {
  same: "same order",
  order: "out of order",
  missing: "missing",
  extra: "extra",
};

const STATUS_HINT: Record<StepStatus, string> = {
  same: "in both openers, in the same order",
  order: "in both openers, at a different point",
  missing: "they press this in their opener; you do not",
  extra: "you press this where they never do",
};

/** Your best kill is the pull most like a ranked parse; without one, your best pull. */
function defaultPull(lanes: OpenerLane[]): OpenerLane | undefined {
  const kills = lanes.filter((l) => l.kill);
  const pool = kills.length > 0 ? kills : lanes;
  return pool.reduce<OpenerLane | undefined>((best, l) => (!best || l.dps > best.dps ? l : best), undefined);
}

/**
 * Your first twelve casts against one top parse's, lined up like a diff:
 * shared casts sit on one row, and everything else is coloured by what kind
 * of difference it is. Trinkets, potions and racials are listed where they
 * happened but take no slot, so an on-use trinket or a racial never shifts
 * the comparison.
 */
export function OpenerPanel({ report }: { report: AnalysisReport }) {
  const { opener } = report;
  const [pullKey, setPullKey] = useState(() => defaultPull(opener.yours)?.key ?? "");
  const [refIdx, setRefIdx] = useState(0);

  const you = opener.yours.find((l) => l.key === pullKey) ?? opener.yours[0];
  const them = opener.reference[refIdx] ?? opener.reference[0];

  const rows = useMemo(() => (you && them ? alignOpeners(you.steps, them.steps) : []), [you, them]);

  if (!you || !them || you.steps.length === 0) return null;

  // Counted from your side — a moved cast is marked on both sides but is one
  // difference — except "missing", which by definition only exists on theirs.
  const counts: Record<StepStatus, number> = { same: 0, order: 0, missing: 0, extra: 0 };
  for (const r of rows) {
    if (r.yours?.status) counts[r.yours.status] += 1;
    if (r.theirs?.status === "missing") counts.missing += 1;
  }
  const firstCore = (steps: OpenerStep[]) => steps.find((s) => !s.extra)?.atMs;
  const yourFirst = firstCore(you.steps);
  const theirFirst = firstCore(them.steps);

  return (
    <div className="panel" style={{ marginBottom: 10 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <div style={{ fontWeight: 600 }}>Your opener vs the top parses</div>
        <span className="muted" style={{ fontSize: 12 }}>
          first {opener.length} casts · trinkets, potions and racials shown but not counted
        </span>
      </div>
      <p className="muted" style={{ margin: "0 0 14px", fontSize: 13 }}>
        The opener is the most comparable part of the pull — it is scripted, and everyone starts with
        full resources and every cooldown up. Casts both of you make in the same order share a row;
        everything else is coloured by how it differs.
      </p>

      <div className="row" style={{ gap: 18, marginBottom: 14, alignItems: "flex-end" }}>
        <label style={{ minWidth: 220 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 3 }}>
            YOUR PULL
          </div>
          <select value={you.key} onChange={(e) => setPullKey(e.target.value)} style={{ padding: "6px 9px", fontSize: 13 }}>
            {opener.yours.map((l) => (
              <option key={l.key} value={l.key}>
                {l.label} · {k(l.dps)}
              </option>
            ))}
          </select>
        </label>
        <div role="radiogroup" aria-label="Top parse to compare with">
          <div className="muted" style={{ fontSize: 11, marginBottom: 3 }}>
            COMPARE WITH
          </div>
          <div className="row" style={{ gap: 6 }}>
            {opener.reference.map((r, i) => (
              <button
                key={r.key}
                type="button"
                role="radio"
                aria-checked={i === refIdx}
                className={`chip${i === refIdx ? " on" : ""}`}
                onClick={() => setRefIdx(i)}
              >
                <span className="muted mono" style={{ fontSize: 11 }}>
                  #{i + 1}
                </span>
                {r.label}
                <span className="muted mono" style={{ fontSize: 11 }}>
                  {k(r.dps)}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="row" style={{ gap: 14, fontSize: 12, marginBottom: 10 }}>
        {(["same", "order", "missing", "extra"] as const).map((s) => (
          <span key={s} className={`op-key op-${s}`} title={STATUS_HINT[s]}>
            <b className="mono">{counts[s]}</b> {STATUS_TEXT[s]}
          </span>
        ))}
        {yourFirst != null && theirFirst != null && (
          <span className="muted">
            first cast {secs(yourFirst)} vs {secs(theirFirst)}
          </span>
        )}
      </div>

      <div className="op-grid">
        <div className="op-head" style={{ color: "var(--accent)" }}>
          YOU — {you.label}{" "}
          <a href={wclUrl(report.report.code, you.fightId!, { source: report.player.actorId })} target="_blank" rel="noreferrer" title="open in WarcraftLogs">
            ↗
          </a>
        </div>
        <div className="op-head muted">
          {them.label.toUpperCase()}{" "}
          {them.source && (
            <a
              href={wclUrl(them.source.reportCode, them.source.fightId, { source: them.source.actorId })}
              target="_blank"
              rel="noreferrer"
              title="open in WarcraftLogs"
            >
              ↗
            </a>
          )}
        </div>
        {rows.map((row, i) => (
          <Row key={i} row={row} abilities={opener.abilities} />
        ))}
      </div>

      <p style={{ margin: "12px 0 0", color: "var(--accent)", fontSize: 14 }}>
        Write the reference order down and drill it on a target dummy until it is automatic. Nothing
        in the opener reacts to the fight, so what you practise is exactly what you will do on the pull.
      </p>
    </div>
  );
}

function Row({ row, abilities }: { row: AlignedRow; abilities: AnalysisReport["opener"]["abilities"] }) {
  return (
    <>
      <Cell side={row.yours} other={row.theirs} abilities={abilities} />
      <Cell side={row.theirs} other={row.yours} abilities={abilities} />
    </>
  );
}

function Cell({
  side,
  other,
  abilities,
}: {
  side: AlignedRow["yours"];
  other: AlignedRow["yours"];
  abilities: AnalysisReport["opener"]["abilities"];
}) {
  if (!side) {
    // A rotational cast on the other side has no partner here: leave a visible gap.
    return <div className={`op-cell op-empty${other && !other.step.extra ? " op-gap" : ""}`} />;
  }
  const { step, index, status } = side;
  const info = abilities[step.gameID];
  const src = iconUrl(info?.icon);

  return (
    <div
      className={`op-cell${step.extra ? " op-extra-cast" : ""}${status && status !== "same" ? ` op-${status}` : ""}`}
      title={status ? `${info?.name}: ${STATUS_HINT[status]}` : `${info?.name}: ${step.extra}, not counted`}
    >
      <span className="op-index mono">{step.extra ? "" : index}</span>
      {src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" width={16} height={16} style={{ borderRadius: 2, flexShrink: 0 }} />
      )}
      <a href={wowheadSpellUrl(step.gameID)} target="_blank" rel="noreferrer" className="op-name">
        {info?.name ?? step.gameID}
      </a>
      {step.extra && <span className="op-tag">{step.extra}</span>}
      <span className="op-time mono">{secs(step.atMs)}</span>
    </div>
  );
}
