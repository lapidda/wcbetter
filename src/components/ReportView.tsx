"use client";

import { useState } from "react";
import type { AnalysisReport } from "@/lib/analyze";
import { BURN_THRESHOLD_PCT } from "@/lib/model/burn";
import { FAMILY_LABEL, FAMILY_ORDER } from "@/lib/model/focus";
import { WEAK_BUILD_MATCH } from "@/lib/rules/types";
import { wclUrl } from "@/lib/wcl/links";
import { AbilityTable } from "./AbilityTable";
import { CastComparison } from "./CastComparison";
import { FindingCard, type LinkContext } from "./FindingCard";
import { FindingSection } from "./FindingSection";
import { FocusBlock } from "./FocusBlock";
import { OpenerPanel } from "./OpenerPanel";
import { SequencePanel } from "./SequencePanel";
import { TalentBuilds } from "./TalentBuilds";
import { PullTimeline } from "./PullTimeline";

const k = (n: number) => `${(n / 1000).toFixed(1)}k`;

type Tab = "findings" | "timeline" | "talents";

export function ReportView({ report }: { report: AnalysisReport }) {
  const [tab, setTab] = useState<Tab>("findings");
  const [narrative, setNarrative] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byId = new Map(report.findings.map((f) => [f.id, f]));
  const kills = report.pulls.filter((p) => p.kill).length;
  const { gap } = report;
  const behind = gap.deltaPct > 0;

  const links: LinkContext = {
    code: report.report.code,
    actorId: report.player.actorId,
    startTimeByFight: Object.fromEntries(report.timelines.map((t) => [t.fightId, t.startTime])),
  };

  const burnPulls = report.timelines.filter((t) => t.burnStartMs != null).length;

  // Gear context for the gap. Gains below are already scaled to the player's
  // own output (see valuePerCast), but the raw DPS delta is not, so say it.
  const ilvlDelta =
    report.player.itemLevel != null && report.reference.medianItemLevel != null
      ? Math.round(report.reference.medianItemLevel - report.player.itemLevel)
      : null;

  // How much of the distance to the reference the focus items would close.
  const gapShare =
    gap.deltaDps > 0 && report.focusGainDps > 0
      ? Math.min(100, (report.focusGainDps / gap.deltaDps) * 100)
      : null;

  async function coach() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/narrative", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(report),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Narrative failed");
      setNarrative(json.narrative);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const killText = kills === 0 ? "no kill" : `${kills} kill${kills === 1 ? "" : "s"}`;

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <div style={{ fontSize: 20, fontWeight: 600 }}>
          {report.player.name}{" "}
          <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>
            {report.player.specName} {report.player.className}
            {report.player.itemLevel != null && ` · ilvl ${report.player.itemLevel}`} · {report.encounter.difficulty}{" "}
            {report.encounter.name} · {report.pulls.length} pull{report.pulls.length === 1 ? "" : "s"} · {killText}
          </span>
        </div>
      </div>

      <div className="tabs" role="tablist">
        {(
          [
            ["findings", "Findings"],
            ["timeline", "Cast timeline"],
            ["talents", "Talents"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "active" : undefined}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "timeline" && <CastComparison report={report} />}

      {tab === "talents" && <TalentBuilds report={report} />}

      {tab === "findings" && (
        <>
          <div className="panel" style={{ marginBottom: 20 }}>
            <div className="grid-2" style={{ gap: 20 }}>
              <Metric
                label="Median DPS"
                value={k(gap.playerMedianDps)}
                sub={
                  `${behind ? "−" : "+"}${Math.abs(gap.deltaPct).toFixed(0)}% vs top-parse median ` +
                  `${k(gap.referenceMedianDps)} · best ${k(report.totals.bestDps)}` +
                  (ilvlDelta != null ? ` · they average ${ilvlDelta} ilvl higher` : "")
                }
              />
              <Metric
                label={`Fix these ${report.focus.length || ""}`.trim()}
                value={report.focusGainDps > 0 ? `+${k(report.focusGainDps)} DPS` : "—"}
                sub={
                  report.focusGainDps > 0
                    ? `about +${report.focusGainPct.toFixed(0)}%${
                        gapShare != null ? `, closes ~${gapShare.toFixed(0)}% of the gap` : ""
                      }`
                    : "nothing measurable to fix"
                }
              />
            </div>

            <PullTimeline report={report} />

            <div className="muted" style={{ fontSize: 12, marginTop: 16 }}>
              {report.reference.buildMatch.matched ? (
                <>
                  Matched to your talent build (
                  {(report.reference.buildMatch.similarity * 100).toFixed(0)}% overlap
                  {report.reference.buildMatch.similarity < WEAK_BUILD_MATCH && (
                    <span style={{ color: "var(--minor)" }}>
                      {" "}
                      — a weak match, so treat rotational findings with care
                    </span>
                  )}
                  ).{" "}
                </>
              ) : (
                <>No talent data in this log, so the comparison is by spec only. </>
              )}
              Compared against {report.reference.members.length} top parses:{" "}
              {report.reference.members.map((m, i) => (
                <span key={m.name}>
                  {i > 0 && ", "}
                  <a href={wclUrl(m.reportCode, m.fightId, { source: m.actorId })} target="_blank" rel="noreferrer">
                    {m.name}
                  </a>{" "}
                  ({(m.dps / 1000).toFixed(0)}k{m.itemLevel != null ? `, ilvl ${m.itemLevel}` : ""})
                </span>
              ))}
              {burnPulls > 0 && (
                <>
                  {" "}
                  &middot; {burnPulls} of {report.pulls.length} pulls got the boss below{" "}
                  {BURN_THRESHOLD_PCT}%, so the burn phase is analysed on those.
                </>
              )}
              {report.bossContext == null && (
                <> &middot; boss-ability context unavailable for this log, so gaps are unlabelled.</>
              )}
            </div>
          </div>

          <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
            <h2 style={{ fontSize: 17, margin: 0 }}>Fix these first</h2>
            {!narrative && (
              <button type="button" onClick={coach} disabled={loading}>
                {loading ? "Writing..." : "Write coach summary"}
              </button>
            )}
          </div>

          {error && (
            <div className="panel muted" style={{ marginBottom: 12, borderColor: "var(--critical)" }}>
              {error}
            </div>
          )}

          {narrative && (
            <div className="panel" style={{ marginBottom: 20, whiteSpace: "pre-wrap" }}>
              {narrative}
            </div>
          )}

          <FocusBlock report={report} links={links} />

          {FAMILY_ORDER.map((family) => {
            const items = report.sections[family].map((id) => byId.get(id)).filter((f) => f != null);
            const focusCount = report.focus.filter((f) => f.family === family).length;

            // The opener leads with its side-by-side, which is always shown: it
            // is the most practisable thing in the report even on a clean pull.
            if (family === "opener") {
              return (
                <section key={family} style={{ marginTop: 28 }}>
                  <OpenerPanel report={report} />
                  <FindingSection
                    title={FAMILY_LABEL[family]}
                    findings={items}
                    medianDps={report.totals.medianDps}
                    links={links}
                    focusCount={focusCount}
                  />
                </section>
              );
            }

            // The burn leads with its own side-by-side sequence, when one was written.
            if (family === "burn") {
              const sequence = items.find((f) => f.id === "burn:sequence");
              const rest = items.filter((f) => f.id !== "burn:sequence");
              if (!sequence && rest.length === 0) return null;
              return (
                <section key={family} style={{ marginTop: 28 }}>
                  {sequence && (
                    <SequencePanel
                      finding={sequence}
                      title={`Your burn phase vs the top parses (boss below ${BURN_THRESHOLD_PCT}%)`}
                    />
                  )}
                  <FindingSection
                    title={FAMILY_LABEL[family]}
                    findings={rest}
                    medianDps={report.totals.medianDps}
                    links={links}
                    focusCount={focusCount}
                  />
                </section>
              );
            }

            if (family === "rotation") {
              // The table carries every cast-frequency finding as a row, so those
              // cards are redundant here; cooldown and opener findings stay as cards.
              const cards = items.filter((f) => f.rule !== "cast-frequency");
              return (
                <FindingSection
                  key={family}
                  title={FAMILY_LABEL.rotation}
                  findings={cards}
                  medianDps={report.totals.medianDps}
                  links={links}
                  focusCount={focusCount}
                  lead={<AbilityTable rows={report.abilities} totalPulls={report.pulls.length} />}
                />
              );
            }

            return (
              <FindingSection
                key={family}
                title={FAMILY_LABEL[family]}
                findings={items}
                medianDps={report.totals.medianDps}
                links={links}
                focusCount={focusCount}
              />
            );
          })}

          {report.oneOffs.length > 0 && (
            <details style={{ marginTop: 28 }}>
              <summary className="muted" style={{ cursor: "pointer" }}>
                One-offs ({report.oneOffs.length}) — happened on a single pull
              </summary>
              <div style={{ marginTop: 10 }}>
                {report.oneOffs.map((id) => {
                  const f = byId.get(id);
                  return f ? <FindingCard key={id} finding={f} medianDps={report.totals.medianDps} links={links} /> : null;
                })}
              </div>
            </details>
          )}

          {report.warnings.length > 0 && (
            <div className="panel muted" style={{ marginTop: 28, fontSize: 13 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Analysis warnings</div>
              {report.warnings.map((w, i) => (
                <div key={i} className="mono">
                  {w}
                </div>
              ))}
            </div>
          )}

          <p className="muted" style={{ fontSize: 12, marginTop: 24 }}>
            Findings are ranked by estimated impact discounted for how often they actually happen, so a
            smaller mistake you make every pull outranks a larger one you made once. Gains are rough,
            derived from your own average damage per cast and the reference medians, and they overlap
            with each other — treat them as a ranking, not a total.
          </p>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 12 }}>
        {label}
      </div>
      <div style={{ fontSize: 30, fontWeight: 600, lineHeight: 1.2 }}>{value}</div>
      <div className="muted" style={{ fontSize: 12 }}>
        {sub}
      </div>
    </div>
  );
}
