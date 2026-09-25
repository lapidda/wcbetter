"use client";

import type { AbilityRow } from "@/lib/model/abilities";
import { iconUrl, wowheadSpellUrl } from "@/lib/wcl/links";

const k = (n: number) => `${(n / 1000).toFixed(1)}k`;

function AbilityIcon({ file, name }: { file: string | null; name: string }) {
  const src = iconUrl(file);
  if (!src) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      title={name}
      width={18}
      height={18}
      style={{ borderRadius: 3, verticalAlign: "-4px", marginRight: 6 }}
    />
  );
}

/**
 * The rotation as one table instead of a card per ability. Flagged rows are
 * on top; the rest show what you actually spend your GCDs on — including the
 * abilities you cast *more* than the reference, which is the other half of
 * "what are you casting instead".
 */
export function AbilityTable({ rows, totalPulls }: { rows: AbilityRow[]; totalPulls: number }) {
  if (rows.length === 0) return null;

  return (
    <div className="panel" style={{ padding: 0, marginBottom: 10, overflowX: "auto" }}>
      <table className="abilities">
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Ability</th>
            <th>you /min</th>
            <th>top /min</th>
            <th>Δ</th>
            <th title="median delay after it came off cooldown, cooldowns only">held</th>
            <th title="share of your damage">dmg</th>
            <th title={`casts across ${totalPulls} pulls`}>casts</th>
            <th>est. gain</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const delta = r.refCpm != null && r.refCpm > 0 ? ((r.yourCpm - r.refCpm) / r.refCpm) * 100 : null;
            const deltaColour =
              delta == null ? "var(--muted)" : delta <= -25 ? "var(--critical)" : delta >= 25 ? "var(--minor)" : "var(--muted)";
            return (
              <tr key={r.gameID} className={r.findingId ? "flagged" : undefined}>
                <td style={{ textAlign: "left", whiteSpace: "nowrap" }}>
                  <AbilityIcon file={r.icon} name={r.name} />
                  <a href={wowheadSpellUrl(r.gameID)} target="_blank" rel="noreferrer">
                    {r.name}
                  </a>
                  {r.cooldownMs != null && (
                    <span className="muted" style={{ fontSize: 11 }}>
                      {" "}
                      {Math.round(r.cooldownMs / 1000)}s cd
                    </span>
                  )}
                </td>
                <td className="mono">{r.yourCpm.toFixed(1)}</td>
                <td className="mono muted">{r.refCpm != null ? r.refCpm.toFixed(1) : "—"}</td>
                <td className="mono" style={{ color: deltaColour }}>
                  {delta == null ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(0)}%`}
                </td>
                <td className="mono muted">{r.medianHeldMs != null ? `${(r.medianHeldMs / 1000).toFixed(1)}s` : ""}</td>
                <td className="mono muted">{r.yourDamageShare >= 0.005 ? `${(r.yourDamageShare * 100).toFixed(0)}%` : ""}</td>
                <td className="mono muted">{r.yourCasts}</td>
                <td className="mono" style={{ color: r.gainDps ? "var(--major)" : undefined }}>
                  {r.gainDps != null && r.gainDps >= 100 ? `+${k(r.gainDps)}` : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
