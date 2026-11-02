"use client";

import { useMemo, useState } from "react";
import type { AnalysisReport } from "@/lib/analyze";
import { DK_TREE_LABEL, DK_LIST_LABEL, type DkPull } from "@/lib/spec/deathknight";
import { FROST_GUIDE, UNHOLY_GUIDE } from "@/lib/spec/deathknight-guide";
import type { BuildEvidence } from "@/lib/spec/guide";
import { formatDuration } from "@/lib/model/stats";
import { wclUrl } from "@/lib/wcl/links";
import { PriorityGuide, useGuideState } from "./PriorityGuide";
import { PriorityPanel } from "./PriorityPanel";
import { TalentBuilds } from "./TalentBuilds";

const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
const NO_BUILD: BuildEvidence = { casts: [], buffs: [], talents: null };

function defaultPull(pulls: DkPull[]): DkPull | undefined {
  const kills = pulls.filter((p) => p.kill);
  const pool = kills.length ? kills : pulls;
  return pool.reduce<DkPull | undefined>((best, p) => (!best || p.dps > best.dps ? p : best), undefined);
}

/**
 * The Death Knight lens on the player analysis: Wowhead's Unholy or Frost
 * priority, which line you break more often than the top parses, every break
 * where it happened, and the guide's lists to check against.
 */
export function DeathKnightView({ report }: { report: AnalysisReport }) {
  const dk = report.deathknight;
  const guideSet = dk?.spec === "frost" ? FROST_GUIDE : UNHOLY_GUIDE;
  const guide = useGuideState(dk?.build ?? NO_BUILD, guideSet.storageKey);
  const [fightId, setFightId] = useState(() => (dk ? defaultPull(dk.pulls)?.fightId : undefined));
  const [everyBreak, setEveryBreak] = useState(false);
  const pull = dk?.pulls.find((p) => p.fightId === fightId) ?? dk?.pulls[0];
  const lists = useMemo(() => new Map(guideSet.lists.map((l) => [l.id, l])), [guideSet]);

  if (!dk) {
    return (
      <div className="panel">
        <b>Not an Unholy or Frost Death Knight.</b>{" "}
        <span className="muted">
          This view checks Death Knight button presses. {report.player.name} is {report.player.specName ?? "an unknown spec"}{" "}
          {report.player.className ?? ""} — pick an Unholy or Frost Death Knight in the sidebar.
        </span>
      </div>
    );
  }

  const link = (id: number, ms: number) => {
    const p = dk.pulls.find((x) => x.fightId === id);
    return wclUrl(report.report.code, id, {
      source: report.player.actorId,
      window: p?.startTime != null ? { startTime: p.startTime, startMs: ms } : undefined,
    });
  };
  const specLabel = dk.spec === "unholy" ? "Unholy" : "Frost";
  const ruleOf = (list: string | undefined, rank: number) =>
    dk.priority?.rows.find((r) => (r.list ?? undefined) === list && r.rank === rank);
  // The lines worth fixing: broken more often than the top parses break them
  // (the same bar the priority table colours by). The rest is shown on request.
  const worthFixing = (list: string | undefined, rank: number) => {
    const r = ruleOf(list, rank);
    return r != null && r.you.count > 0 && r.excessPerMin > 0.15;
  };
  const shown = pull
    ? pull.violations.filter((v) => {
        const l = v.list ? lists.get(v.list) : undefined;
        if (l && guide.crossed(l).has(v.rank - 1)) return false;
        return everyBreak || worthFixing(v.list, v.rank);
      })
    : [];

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <div style={{ fontSize: 20, fontWeight: 600 }}>
          {report.player.name}{" "}
          <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>
            {specLabel} Death Knight · {dk.tree ? DK_TREE_LABEL[dk.tree] : "hero tree not detected"} · {report.encounter.difficulty}{" "}
            {report.encounter.name} · {report.pulls.length} pull{report.pulls.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 16 }}>
        Hero tree read from the log ({dk.treeEvidence}). Every rate is compared with the {report.reference.members.length}{" "}
        build-matched top parses on this boss, judged the same way.
        {dk.referenceTree && dk.tree && dk.referenceTree !== dk.tree && (
          <span style={{ color: "var(--minor)" }}>
            {" "}
            The top parses play {DK_TREE_LABEL[dk.referenceTree]}, so they are judged against your tree&apos;s list.
          </span>
        )}
      </div>

      {dk.priority ? (
        <PriorityPanel
          summary={dk.priority}
          description={
            <>
              Wowhead&apos;s {specLabel} single-target priority (patch 12.1.5), checked on every press
              {dk.spec === "unholy" ? ", in and out of Forbidden Knowledge" : ""}. A press only counts when the log proves a
              higher line applied:{" "}
              {dk.spec === "unholy"
                ? "Sudden Doom was up, you had Lesser Ghoul stacks (or none), or you had the Runes or Runic Power for the better button."
                : "Killing Machine or Rime was up, Runic Power was full, or you had the Runes for Obliterate."}{" "}
              Where Wowhead, Icy Veins and Method disagree on an order, it is not marked.
            </>
          }
          isCrossed={(r) => {
            const list = r.list ? lists.get(r.list) : undefined;
            return list ? guide.crossed(list).has(r.rank - 1) : false;
          }}
          listLabel={(id) => DK_LIST_LABEL[id] ?? ""}
          more="Every one is listed by pull below."
          link={link}
        />
      ) : (
        <div className="panel muted">The cast and buff events for the priority check could not be read for these pulls.</div>
      )}

      <PriorityGuide guide={guideSet} group={dk.tree} state={guide} />

      {pull && (
        <div className="panel" style={{ marginTop: 24 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end", marginBottom: 12 }}>
            <div>
              <div style={{ fontWeight: 600 }}>Priority breaks, pull by pull</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {everyBreak
                  ? "Every skipped line and every proc that ran out"
                  : "The lines you break more often than the top parses"}
                , each linked into the WarcraftLogs replay.{" "}
                <button type="button" className="side-mini" onClick={() => setEveryBreak((v) => !v)}>
                  {everyBreak ? "only the ones to fix" : `show all ${pull.violations.length}`}
                </button>
              </div>
            </div>
            <label style={{ minWidth: 240 }}>
              <div className="muted" style={{ fontSize: 11, marginBottom: 3 }}>
                PULL
              </div>
              <select value={pull.fightId} onChange={(e) => setFightId(Number(e.target.value))} style={{ padding: "6px 9px", fontSize: 13 }}>
                {dk.pulls.map((p) => (
                  <option key={p.fightId} value={p.fightId}>
                    {p.label} · {k(p.dps)} · {p.violations.length} break{p.violations.length === 1 ? "" : "s"}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {shown.length === 0 ? (
            <div className="muted" style={{ fontSize: 13 }}>
              {pull.violations.length === 0
                ? "Nothing the log can prove on this pull."
                : "Nothing you break more often than the top parses on this pull."}
            </div>
          ) : (
            <div className="ww-flags">
              {shown.map((v, i) => {
                const rule = ruleOf(v.list, v.rank);
                return (
                  <div key={i} className={`ww-flag ${v.kind === "wasted" ? "bad" : "warn"}`}>
                    <a className="mono" href={link(pull.fightId, v.t)} target="_blank" rel="noreferrer" title="open in WarcraftLogs">
                      {formatDuration(v.t)}
                    </a>
                    <span className="mono muted" style={{ fontSize: 11 }}>
                      {v.list && DK_LIST_LABEL[v.list] ? `${DK_LIST_LABEL[v.list]} ` : ""}#{v.rank}
                    </span>
                    <div>
                      <div>{v.note}.</div>
                      {rule?.fix && (
                        <div className="muted" style={{ fontSize: 12 }}>
                          {rule.fix}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        <TalentBuilds report={report} />
      </div>
    </div>
  );
}
