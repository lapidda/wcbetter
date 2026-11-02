"use client";

import { useState, type ReactNode } from "react";
import type { PriorityRow, PrioritySummary } from "@/lib/spec/priority";
import { formatDuration } from "@/lib/model/stats";

const rowKey = (r: PriorityRow) => `${r.list ?? ""}#${r.rank}`;

/**
 * A guide's priority list, ranked by which line you break more often than
 * the top parses. Only provable breaks count; the lines the log cannot judge
 * are listed with the reason. Shared by every spec tab.
 */
export function PriorityPanel({
  summary,
  description,
  isCrossed,
  listLabel,
  more,
  link,
}: {
  summary: PrioritySummary;
  /** What list this is and what counts as proof, under the title. */
  description: ReactNode;
  /** A line crossed out in the guide card below, hidden here too. */
  isCrossed: (row: PriorityRow) => boolean;
  /** For specs with several lists in play: the name of a row's list, shown before its number. */
  listLabel?: (list: string) => string;
  /** Shown under the examples when there are more than fit. */
  more?: string;
  link: (fightId: number, ms: number) => string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const inBuild = summary.rows.filter((r) => !isCrossed(r));
  const checked = inBuild.filter((r) => r.checked);
  const unchecked = inBuild
    .filter((r) => !r.checked)
    .sort((a, b) => (a.list ?? "").localeCompare(b.list ?? "") || a.rank - b.rank);
  const hidden = summary.rows.filter((r) => isCrossed(r));
  const maxRate = Math.max(0.1, ...checked.map((r) => Math.max(r.you.perMin, r.topPerMin ?? 0)));
  const label = (r: PriorityRow) => `${r.list && listLabel ? `${listLabel(r.list)} ` : ""}#${r.rank}`;

  return (
    <div className="panel" style={{ marginTop: 24 }}>
      <div style={{ fontWeight: 600 }}>Priority list — which line you break most</div>
      <div className="muted" style={{ fontSize: 12, margin: "2px 0 12px" }}>
        {description} Ranked by how much more often you break a line than the {summary.referenceCount} top parses on
        this boss — on a boss with several targets they break the single-target list too, and the comparison absorbs
        that.
      </div>

      <table className="abilities pr-table">
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>#</th>
            <th style={{ textAlign: "left" }}>Line</th>
            <th>you</th>
            <th style={{ textAlign: "left", minWidth: 150 }}>per minute: you / top</th>
            <th title="your rate minus the top parses' median">over top</th>
          </tr>
        </thead>
        <tbody>
          {checked.map((r) => (
            <PriorityRows
              key={rowKey(r)}
              row={r}
              label={label(r)}
              max={maxRate}
              open={open === rowKey(r)}
              onToggle={() => setOpen(open === rowKey(r) ? null : rowKey(r))}
              more={more}
              link={link}
            />
          ))}
        </tbody>
      </table>

      {hidden.length > 0 && (
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Hidden, crossed out in the priority list below: {hidden.map((r) => `${label(r)} ${r.action}`).join(", ")}.
        </div>
      )}

      <div className="muted" style={{ fontSize: 12, marginTop: 14 }}>
        <b style={{ color: "var(--text)" }}>Not checked</b> — the log cannot prove these were broken:
        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          {unchecked.map((r) => (
            <li key={rowKey(r)}>
              {label(r)} {r.action}
              {r.when ? ` if ${r.when}` : ""} — {r.why}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function PriorityRows({
  row: r,
  label,
  max,
  open,
  onToggle,
  more,
  link,
}: {
  row: PriorityRow;
  label: string;
  max: number;
  open: boolean;
  onToggle: () => void;
  more?: string;
  link: (fightId: number, ms: number) => string;
}) {
  const level = r.you.count === 0 ? "good" : r.excessPerMin > 0.5 ? "bad" : r.excessPerMin > 0.15 ? "warn" : "good";
  return (
    <>
      <tr className={`ww-window-row pr-row ${level}`} onClick={onToggle}>
        <td className="mono muted" style={{ textAlign: "left", whiteSpace: "nowrap" }}>
          {open ? "▾" : "▸"} {label}
        </td>
        <td style={{ textAlign: "left", whiteSpace: "normal" }}>
          <b>{r.action}</b>
          {r.when && <span className="muted"> if {r.when}</span>}
        </td>
        <td className="mono">
          {r.you.count}
          {r.you.wasted > 0 && (
            <span className="muted" style={{ fontSize: 11 }} title="procs that ran out unused">
              {" "}
              ({r.you.wasted} wasted)
            </span>
          )}
        </td>
        <td style={{ textAlign: "left" }}>
          <div className="pr-bars">
            <div className="pr-bar you" style={{ width: `${(r.you.perMin / max) * 100}%` }} />
            <div className="pr-bar top" style={{ width: `${((r.topPerMin ?? 0) / max) * 100}%` }} />
          </div>
          <span className="mono" style={{ fontSize: 11 }}>
            {r.you.perMin.toFixed(2)} / <span className="muted">{r.topPerMin == null ? "—" : r.topPerMin.toFixed(2)}</span>
          </span>
        </td>
        <td className={`mono pr-excess ${level}`}>
          {r.excessPerMin > 0 ? "+" : ""}
          {r.excessPerMin.toFixed(2)}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} style={{ textAlign: "left", whiteSpace: "normal", background: "var(--panel-2)" }}>
            {r.fix && level !== "good" && <div style={{ fontSize: 13, marginBottom: 6 }}>{r.fix}</div>}
            {r.examples.length === 0 ? (
              <div className="muted" style={{ fontSize: 12 }}>
                Never broken on these pulls.
              </div>
            ) : (
              <div style={{ fontSize: 12 }}>
                {r.examples.map((e, i) => (
                  <div key={i}>
                    <a className="mono" href={link(e.fightId, e.t)} target="_blank" rel="noreferrer" title="open in WarcraftLogs">
                      {formatDuration(e.t)}
                    </a>{" "}
                    <span className="muted">{e.label}</span> · {e.note}
                  </div>
                ))}
                {r.you.count > r.examples.length && (
                  <div className="muted">
                    …and {r.you.count - r.examples.length} more.{more ? ` ${more}` : ""}
                  </div>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
