"use client";

import { useState } from "react";
import type { AnalysisReport } from "@/lib/analyze";
import type { BuildOption, TalentBuilds as Builds } from "@/lib/talents/builds";

const k = (n: number) => `${(n / 1000).toFixed(1)}k`;

/** Wowhead reads a game export string directly. */
const wowheadUrl = (s: string) => `https://www.wowhead.com/talent-calc/blizzard/${s}`;

/**
 * Which hero tree the top players pick on this boss, and their builds as
 * in-game strings: the most used one and the best player's, per tree, plus
 * yours and where it differs.
 */
export function TalentBuilds({ report, compact = false }: { report: AnalysisReport; compact?: boolean }) {
  const data = report.talentBuilds;
  if (!data) {
    return (
      <div className="panel muted" style={{ fontSize: 13 }}>
        Talent builds are unavailable for this analysis
        {report.warnings.find((w) => w.startsWith("Talent builds")) ? ` — ${report.warnings.find((w) => w.startsWith("Talent builds"))}` : "."}
      </div>
    );
  }
  const leader = data.heroTrees[0];
  const runnerUp = data.heroTrees[1];
  const gap = runnerUp && leader.top5 > 0 ? ((leader.top5 - runnerUp.top5) / leader.top5) * 100 : null;

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <div style={{ fontWeight: 600 }}>
          Talent builds · {report.encounter.difficulty} {report.encounter.name}
        </div>
        <span className="muted" style={{ fontSize: 12 }}>
          top {data.sample} {report.player.specName} parses
        </span>
      </div>
      <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
        {runnerUp ? (
          <>
            <b style={{ color: "var(--text)" }}>{leader.heroTree}</b> is ahead on this boss
            {gap != null && ` — its five best parses are ${gap.toFixed(1)}% higher than ${runnerUp.heroTree}'s`}.
            {leader.share < 0.5 && ` Most players still pick ${runnerUp.heroTree}.`}
          </>
        ) : (
          <>Every ranked player here runs {leader.heroTree}.</>
        )}{" "}
        Copy a string and paste it into the in-game talent import.
      </p>

      {/* Hero tree split */}
      <div className="tb-trees">
        {data.heroTrees.map((t, i) => (
          <div key={t.heroTree} className="tb-tree">
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
              <span style={{ fontWeight: i === 0 ? 600 : 400 }}>{t.heroTree}</span>
              <span className="mono muted" style={{ fontSize: 12 }}>
                {Math.round(t.share * 100)}%
              </span>
            </div>
            <div className="tb-share">
              <div style={{ width: `${t.share * 100}%`, background: i === 0 ? "var(--accent)" : "var(--muted)" }} />
            </div>
            <div className="muted" style={{ fontSize: 11 }}>
              {t.count} players · best #{t.bestRank} · top-5 median {k(t.top5)}
            </div>
          </div>
        ))}
      </div>

      {/* Builds per tree */}
      {data.builds.map((b) => (
        <div key={b.heroTree} style={{ marginTop: 16 }}>
          <div className="ww-sub">{b.heroTree}</div>
          <div className="grid-2">
            <BuildCard title="Most used" option={b.mostUsed} sample={data.heroTrees.find((t) => t.heroTree === b.heroTree)?.count ?? 0} />
            {b.best.string !== b.mostUsed.string ? (
              <BuildCard title="Best player's" option={b.best} sample={data.heroTrees.find((t) => t.heroTree === b.heroTree)?.count ?? 0} />
            ) : (
              <div className="tb-card muted" style={{ fontSize: 13 }}>
                The best {b.heroTree} player (#{b.best.players[0]?.rank} {b.best.players[0]?.name}) runs the most used build.
              </div>
            )}
          </div>
        </div>
      ))}

      {/* Yours */}
      {data.yours && !compact && (
        <div style={{ marginTop: 20 }}>
          <div className="ww-sub">Your build ({data.yours.heroTree ?? "hero tree unknown"})</div>
          <CopyString value={data.yours.string} />
          {data.yours.comparedTo && (
            <div style={{ marginTop: 8, fontSize: 13 }}>
              {data.yours.diff.length === 0 ? (
                <span style={{ color: "var(--good)" }}>Identical to the most used {data.yours.comparedTo} build.</span>
              ) : (
                <>
                  <div className="muted" style={{ marginBottom: 4 }}>
                    {data.yours.diff.length} node{data.yours.diff.length === 1 ? "" : "s"} differ from the most used{" "}
                    {data.yours.comparedTo} build:
                  </div>
                  <table className="abilities tb-diff">
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left" }}>Tree</th>
                        <th style={{ textAlign: "left" }}>You</th>
                        <th style={{ textAlign: "left" }}>Most used</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.yours.diff.map((d, i) => (
                        <tr key={i}>
                          <td style={{ textAlign: "left" }} className="muted">
                            {d.section}
                          </td>
                          <td style={{ textAlign: "left", color: d.you ? "var(--minor)" : "var(--muted)" }}>{d.you ?? "—"}</td>
                          <td style={{ textAlign: "left", color: d.them ? "var(--good)" : "var(--muted)" }}>{d.them ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {data.unknownTalents > 0 && (
        <div className="muted" style={{ fontSize: 11, marginTop: 10, color: "var(--minor)" }}>
          {data.unknownTalents} talents in the rankings are not in the current tree data — some logs are from an
          older patch.
        </div>
      )}
    </div>
  );
}

function BuildCard({ title, option, sample }: { title: string; option: BuildOption; sample: number }) {
  const lead = option.players[0];
  return (
    <div className="tb-card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{title}</span>
        <span className="muted" style={{ fontSize: 11 }}>
          {option.players.length > 1
            ? `${option.players.length} of ${sample} use exactly this`
            : `#${lead.rank} ${lead.name} · ${k(lead.amount)}`}
          {option.near > 0 && ` · ${option.near} more within 2 talents`}
        </span>
      </div>
      {option.players.length > 1 && (
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
          {option.players
            .slice(0, 4)
            .map((p) => `#${p.rank} ${p.name}`)
            .join(", ")}
          {option.players.length > 4 ? ", …" : ""}
        </div>
      )}
      <CopyString value={option.string} />
    </div>
  );
}

function CopyString({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard blocked: the string is selectable in the box.
    }
  }
  return (
    <div className="tb-copy">
      <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} className="mono" aria-label="talent string" />
      <button type="button" className={copied ? undefined : "primary"} onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
      <a href={wowheadUrl(value)} target="_blank" rel="noreferrer" title="view on Wowhead">
        view
      </a>
    </div>
  );
}
