"use client";

import Link from "next/link";
import { useState } from "react";
import { formatDuration } from "@/lib/model/stats";
import { usesPlayerRun, useWorkspace, type View } from "./Workspace";

const k = (n: number) => `${(n / 1000).toFixed(1)}k`;

const VIEWS: Array<{ view: View; label: string; hint: string }> = [
  { view: "player", label: "Player analysis", hint: "one DPS vs the top parses" },
  { view: "monk", label: "Windwalker", hint: "button presses and burst windows" },
  { view: "notes", label: "Raid notes", hint: "what the raid keeps failing" },
];

/**
 * The loaded report, always in reach. Everything that used to sit above the
 * results — the link, the player, the boss, the pulls — lives here, so trying
 * a different pull is one click in the sidebar rather than a trip back to a
 * form that replaced the report you were reading.
 */
export function Sidebar() {
  const ws = useWorkspace();
  const {
    view,
    summary,
    activeEncounter,
    selected,
    shortPulls,
    player,
    raid,
  } = ws;
  const run = usesPlayerRun(view) ? player : raid;
  const [copied, setCopied] = useState(false);

  // DPS per pull, once the player analysis has seen it: makes "which pull was
  // my good one" answerable from the list itself.
  const dpsByFight = new Map((player.result?.pulls ?? []).map((p) => [p.fightId, p.dps]));
  const onScreen = new Set(run.result ? run.fightIds : []);

  const needsPlayer = usesPlayerRun(view) && ws.actorId == null;
  const canRun = !!activeEncounter && selected.size > 0 && !needsPlayer && !run.busy;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // The link is in the address bar either way.
    }
  }

  return (
    <aside className="sidebar">
      <div className="side-brand">
        <Link href={ws.hrefFor("player")}>wcbetter</Link>
      </div>

      <nav className="side-nav" aria-label="Views">
        {VIEWS.map((v) => (
          <Link
            key={v.view}
            href={ws.hrefFor(v.view)}
            className={v.view === view ? "active" : undefined}
            aria-current={v.view === view ? "page" : undefined}
          >
            <span>{v.label}</span>
            <span className="side-hint">{v.hint}</span>
          </Link>
        ))}
      </nav>

      <section className="side-section">
        <div className="side-label">Report</div>
        <form
          className="row"
          style={{ gap: 6, flexWrap: "nowrap" }}
          onSubmit={(e) => {
            e.preventDefault();
            if (ws.input.trim() && !ws.loading) void ws.loadReport(ws.input.trim());
          }}
        >
          <input
            value={ws.input}
            disabled={ws.loading}
            placeholder="WarcraftLogs report link"
            onChange={(e) => ws.setInput(e.target.value)}
            style={{ padding: "7px 9px", fontSize: 13 }}
          />
          <button type="submit" disabled={ws.loading || !ws.input.trim()} style={{ padding: "7px 10px" }}>
            {ws.loading ? "…" : "Load"}
          </button>
        </form>
        {ws.loadError && <div className="side-error">{ws.loadError}</div>}
        {summary && (
          <div className="muted" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.4 }}>
            {summary.title}
            {summary.zone ? ` · ${summary.zone}` : ""}
          </div>
        )}
      </section>

      {summary && usesPlayerRun(view) && (
        <section className="side-section">
          <div className="side-label">Player</div>
          <select
            value={ws.actorId ?? ""}
            onChange={(e) => ws.setActorId(e.target.value ? Number(e.target.value) : null)}
            style={{ padding: "7px 9px", fontSize: 13 }}
          >
            <option value="">Select a player…</option>
            {summary.players.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {p.specName ? `${p.specName} ` : ""}
                {p.className}
                {p.damage > 0 ? ` — ${(p.damage / 1_000_000).toFixed(1)}M` : ""}
              </option>
            ))}
          </select>
        </section>
      )}

      {summary && (
        <section className="side-section">
          <div className="side-label">Boss</div>
          {ws.encounters.length === 0 && (
            <div className="muted" style={{ fontSize: 12 }}>
              {usesPlayerRun(view) && ws.actorId != null
                ? "This player was in no boss pulls."
                : "No boss pulls in this report."}
            </div>
          )}
          <div className="side-list">
            {ws.encounters.map((e) => (
              <button
                key={e.key}
                type="button"
                className={`side-item${e.key === activeEncounter?.key ? " active" : ""}`}
                onClick={() => ws.chooseEncounter(e.key)}
              >
                <span>{e.label}</span>
                <span className="muted mono" style={{ fontSize: 11 }}>
                  {e.fights.length}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {activeEncounter && (
        <section className="side-section side-pulls">
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
            <div className="side-label" style={{ margin: 0 }}>
              Pulls · {selected.size} of {activeEncounter.fights.length}
            </div>
            <button
              type="button"
              className="side-mini"
              onClick={() =>
                ws.setSelected(
                  selected.size === activeEncounter.fights.length
                    ? new Set()
                    : new Set(activeEncounter.fights.map((f) => f.id)),
                )
              }
            >
              {selected.size === activeEncounter.fights.length ? "none" : "all"}
            </button>
          </div>

          <div className="side-list">
            {activeEncounter.fights.map((f, i) => {
              const dps = dpsByFight.get(f.id);
              return (
                <div
                  key={f.id}
                  className={`side-pull${onScreen.has(f.id) ? " shown" : ""}`}
                  title={onScreen.has(f.id) ? "in the analysis on screen" : undefined}
                >
                  <label>
                    <input type="checkbox" checked={selected.has(f.id)} onChange={() => ws.togglePull(f.id)} />
                    <span className="mono muted" style={{ width: 22 }}>
                      {i + 1}
                    </span>
                    <span className="mono" style={{ width: 38 }}>
                      {formatDuration(f.durationMs)}
                    </span>
                    <span className="mono muted" style={{ flex: 1, fontSize: 11 }}>
                      {f.kill ? <span style={{ color: "var(--good)" }}>kill</span> : `${f.bossPercentage?.toFixed(0) ?? "?"}%`}
                      {shortPulls.has(f.id) ? " · short" : ""}
                    </span>
                    {dps != null && usesPlayerRun(view) && (
                      <span className="mono" style={{ fontSize: 11 }}>
                        {k(dps)}
                      </span>
                    )}
                  </label>
                  <button
                    type="button"
                    className="side-mini"
                    disabled={run.busy || needsPlayer}
                    onClick={() => ws.analyze([f.id])}
                    title="analyse only this pull"
                  >
                    ▸
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {summary && (
        <div className="side-footer">
          <button type="button" className="primary" style={{ width: "100%" }} disabled={!canRun} onClick={() => ws.analyze()}>
            {run.busy
              ? "Analysing…"
              : needsPlayer
                ? "Pick a player"
                : `Analyse ${selected.size} pull${selected.size === 1 ? "" : "s"}`}
          </button>
          {run.busy && run.progress.length > 0 && (
            <div className="mono muted" style={{ fontSize: 11, marginTop: 6 }}>
              {run.progress[run.progress.length - 1]}
            </div>
          )}
          {run.result && !run.busy && (
            <button type="button" style={{ width: "100%", marginTop: 6, fontSize: 13, padding: "6px 10px" }} onClick={copyLink}>
              {copied ? "Link copied" : "Copy link to this analysis"}
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
