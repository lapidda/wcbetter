"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnalysisReport, ReportSummary } from "@/lib/analyze";
import { formatDuration } from "@/lib/model/stats";
import { decodeState, defaultSelection, encodeState } from "@/lib/url-state";
import { ReportView } from "@/components/ReportView";

type Fight = ReportSummary["fights"][number];

/** Remembers the last log and character so a weekly user does not re-pick themselves. */
const LAST_KEY = "wcbetter:last";

const readLast = (): { input?: string; sourceId?: number } => {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}");
  } catch {
    return {};
  }
};

export default function Home() {
  const [input, setInput] = useState("");
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [actorId, setActorId] = useState<number | null>(null);
  const [encounterKey, setEncounterKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [shortPulls, setShortPulls] = useState<Set<number>>(new Set());

  const [progress, setProgress] = useState<string[]>([]);
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /** Pulls from a shared link, applied once the report has loaded. */
  const pendingPulls = useRef<number[] | null>(null);
  const autoRan = useRef(false);

  /** Encounters grouped by boss + difficulty, limited to pulls the player was in. */
  const encounters = useMemo(() => {
    if (!summary || actorId == null) return [];

    const groups = new Map<string, { key: string; label: string; fights: Fight[] }>();

    for (const fight of summary.fights) {
      if (fight.friendlyPlayers.length > 0 && !fight.friendlyPlayers.includes(actorId)) continue;

      const key = `${fight.encounterID}:${fight.difficulty}`;
      const group = groups.get(key);
      if (group) group.fights.push(fight);
      else groups.set(key, { key, label: `${fight.difficulty} ${fight.name}`, fights: [fight] });
    }

    return [...groups.values()];
  }, [summary, actorId]);

  const activeEncounter = encounters.find((e) => e.key === encounterKey) ?? null;

  const chooseEncounter = useCallback(
    (key: string, fights?: Fight[]) => {
      setEncounterKey(key);
      const group = fights ?? encounters.find((e) => e.key === key)?.fights ?? [];
      const { selected: pick, short } = defaultSelection(group);
      setSelected(new Set(pick));
      setShortPulls(new Set(short));
    },
    [encounters],
  );

  const loadReport = useCallback(async (value: string) => {
    setLoading(true);
    setError(null);
    setSummary(null);
    setReport(null);
    setActorId(null);
    setEncounterKey(null);
    setSelected(new Set());
    setShortPulls(new Set());

    try {
      const res = await fetch(`/api/report?input=${encodeURIComponent(value)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setSummary(json);
      try {
        localStorage.setItem(LAST_KEY, JSON.stringify({ ...readLast(), input: value }));
      } catch {
        // Private browsing: remembering is a convenience, not a requirement.
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // --- Arriving with a URL ---------------------------------------------------
  // A shared report link carries `pulls` and runs itself; a pasted WCL link
  // only prefills. With neither, fall back to the last log this browser used.
  useEffect(() => {
    const state = decodeState(window.location.search);
    if (state.report) {
      const url = `https://www.warcraftlogs.com/reports/${state.report}${encodeState({
        fight: state.fight,
        source: state.source,
      }).replace("?", "?")}`;
      pendingPulls.current = state.pulls ?? null;
      setInput(url);
      void loadReport(url);
      return;
    }
    const last = readLast();
    if (last.input) setInput(last.input);
  }, [loadReport]);

  // Prefill the player from the link (WCL's `source` is the actor id).
  useEffect(() => {
    if (!summary) return;
    const { sourceId } = summary.link;
    if (sourceId != null && summary.players.some((p) => p.id === sourceId)) setActorId(sourceId);
  }, [summary]);

  // ...then the boss, once the encounter list exists for that player.
  useEffect(() => {
    if (!summary || encounterKey != null) return;
    const fight = summary.fights.find((f) => f.id === summary.link.fightId);
    if (!fight) return;
    const key = `${fight.encounterID}:${fight.difficulty}`;
    const group = encounters.find((e) => e.key === key);
    if (!group) return;

    chooseEncounter(key, group.fights);

    // A shared link names its exact pulls; honour them over the default.
    const wanted = pendingPulls.current;
    if (wanted) {
      const valid = wanted.filter((id) => group.fights.some((f) => f.id === id));
      if (valid.length > 0) {
        setSelected(new Set(valid));
        setShortPulls(new Set());
      }
      pendingPulls.current = null;
    }
  }, [summary, encounters, encounterKey, chooseEncounter]);

  function togglePull(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const analyze = useCallback(async () => {
    if (!summary || actorId == null || selected.size === 0) return;
    setBusy(true);
    setError(null);
    setReport(null);
    setProgress([]);

    const fightIds = [...selected].sort((a, b) => a - b);

    // The address bar becomes the shareable link the moment analysis starts.
    try {
      const state = encodeState({
        report: summary.code,
        source: actorId,
        fight: fightIds[fightIds.length - 1],
        pulls: fightIds,
      });
      window.history.replaceState(null, "", state || window.location.pathname);
      localStorage.setItem(LAST_KEY, JSON.stringify({ input, sourceId: actorId }));
    } catch {
      // Non-fatal: the analysis matters more than the URL.
    }

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: summary.code, actorId, fightIds }),
      });
      if (!res.body) throw new Error("No response stream");

      // Minimal SSE parser: the payload is small and same-origin, so a reader
      // over the fetch body beats pulling in an EventSource polyfill for POST.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";

        for (const chunk of chunks) {
          const event = chunk.match(/^event: (.+)$/m)?.[1];
          const dataLine = chunk.match(/^data: (.+)$/m)?.[1];
          if (!event || !dataLine) continue;
          const data = JSON.parse(dataLine);

          if (event === "progress") setProgress((p) => [...p, data.message]);
          else if (event === "report") setReport(data as AnalysisReport);
          else if (event === "error") setError(data.message);
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [summary, actorId, selected, input]);

  // A link that named its pulls is a finished report someone shared: run it.
  useEffect(() => {
    if (autoRan.current || busy || report) return;
    if (!summary || actorId == null || selected.size === 0) return;
    if (!decodeState(window.location.search).pulls) return;
    autoRan.current = true;
    void analyze();
  }, [summary, actorId, selected, busy, report, analyze]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy — the link is in the address bar.");
    }
  }

  return (
    <main className="wrap">
      {!report && (
        <>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <h1 style={{ fontSize: 28, margin: "0 0 6px" }}>wcbetter</h1>
            <a className="muted" href="/notes" style={{ fontSize: 13 }}>
              Raid notes →
            </a>
          </div>
          <p className="muted" style={{ marginTop: 0 }}>
            Paste a WarcraftLogs report, pick a boss, and analyse every pull at once. Findings are
            measured against the top parses on your build, and ranked by how consistently you make
            them.
          </p>

          <div className="panel" style={{ marginTop: 24 }}>
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <input
                value={input}
                disabled={loading}
                placeholder="https://www.warcraftlogs.com/reports/aBcD1234..."
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !loading && input && loadReport(input)}
              />
              <button
                className="primary"
                onClick={() => loadReport(input)}
                disabled={loading || !input}
              >
                {loading ? "Loading…" : "Load"}
              </button>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              A link straight from the log — with <code>fight=</code> and <code>source=</code> in it —
              fills in the boss and player for you.
            </div>

            {summary && (
              <div style={{ marginTop: 20 }}>
                <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
                  {summary.title}
                  {summary.zone ? ` — ${summary.zone}` : ""}
                </div>

                <div className="grid-2">
                  <label>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                      Player
                    </div>
                    <select
                      value={actorId ?? ""}
                      onChange={(e) => {
                        setActorId(Number(e.target.value));
                        setEncounterKey(null);
                        setSelected(new Set());
                      }}
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
                  </label>

                  <label>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                      Boss
                    </div>
                    <select
                      value={encounterKey ?? ""}
                      onChange={(e) => chooseEncounter(e.target.value)}
                      disabled={actorId == null}
                    >
                      <option value="">Select a boss…</option>
                      {encounters.map((e) => (
                        <option key={e.key} value={e.key}>
                          {e.label} ({e.fights.length} pull{e.fights.length === 1 ? "" : "s"})
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {activeEncounter && (
                  <div style={{ marginTop: 16 }}>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <div className="muted" style={{ fontSize: 12 }}>
                        Pulls to include ({selected.size} of {activeEncounter.fights.length}
                        {shortPulls.size > 0 ? ` · ${shortPulls.size} short pulls skipped` : ""})
                      </div>
                      <button
                        style={{ padding: "2px 8px", fontSize: 12 }}
                        onClick={() =>
                          setSelected(
                            selected.size === activeEncounter.fights.length
                              ? new Set()
                              : new Set(activeEncounter.fights.map((f) => f.id)),
                          )
                        }
                      >
                        {selected.size === activeEncounter.fights.length ? "None" : "All"}
                      </button>
                    </div>

                    <div style={{ marginTop: 8 }}>
                      {activeEncounter.fights.map((f, i) => (
                        <label
                          key={f.id}
                          className="row mono"
                          style={{ gap: 10, padding: "3px 0", cursor: "pointer", flexWrap: "nowrap" }}
                        >
                          <input
                            type="checkbox"
                            style={{ width: "auto" }}
                            checked={selected.has(f.id)}
                            onChange={() => togglePull(f.id)}
                          />
                          <span style={{ width: 60 }} className="muted">
                            Pull {i + 1}
                          </span>
                          <span style={{ width: 56 }}>{formatDuration(f.durationMs)}</span>
                          <span className="muted">
                            {f.kill ? "kill" : `wipe at ${f.bossPercentage?.toFixed(1) ?? "?"}%`}
                            {shortPulls.has(f.id) ? " · short" : ""}
                          </span>
                        </label>
                      ))}
                    </div>

                    <button
                      className="primary"
                      style={{ marginTop: 16 }}
                      onClick={analyze}
                      disabled={busy || selected.size === 0}
                    >
                      {busy ? "Analyzing…" : `Analyze ${selected.size} pulls`}
                    </button>
                    {!busy && (
                      <span className="muted" style={{ fontSize: 12, marginLeft: 10 }}>
                        first run takes about half a minute; after that it is instant
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {progress.length > 0 && (
            <div className="panel mono" style={{ marginTop: 16 }}>
              {progress.map((line, i) => (
                <div key={i} className={i === progress.length - 1 ? undefined : "muted"}>
                  {line}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {error && (
        <div className="panel" style={{ marginTop: 16, borderColor: "var(--critical)" }}>
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 20 }}>
            <button
              onClick={() => {
                setReport(null);
                autoRan.current = true;
              }}
            >
              ← Analyze another boss
            </button>
            <button onClick={copyLink}>{copied ? "Link copied" : "Copy link to this report"}</button>
          </div>
          <ReportView report={report} />
        </>
      )}
    </main>
  );
}
