"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReportSummary } from "@/lib/analyze";
import type { MechanicWave, NotableMechanic } from "@/lib/model/notable";
import {
  addLine,
  applyStored,
  fromGenerated,
  mergeDocInto,
  mergeGenerated,
  removeLine,
  renderDoc,
  setCaller,
  setText,
  setTime,
  storageKey,
  toStored,
  toggleEnabled,
  type DocLine,
  type StoredDoc,
} from "@/lib/model/note-doc";
import { formatDuration } from "@/lib/model/stats";
import { buildHeader, generateLines, mergeCloseLines } from "@/lib/nsrt/generate";
import { emitNote, parseNote } from "@/lib/nsrt/note-syntax";
import type { RaidPayload } from "@/lib/model/raid-payload";
import { rosterFromPayload } from "@/lib/model/raid-payload";
import { decodeState, defaultSelection, encodeState } from "@/lib/url-state";
import { MechanicTimeline, waveKey } from "@/components/MechanicTimeline";
import { NoteEditor } from "@/components/NoteEditor";

type Fight = ReportSummary["fights"][number];

const LAST_KEY = "wcbetter:last";

const readLast = (): { input?: string } => {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}");
  } catch {
    return {};
  }
};

export default function Notes() {
  const [input, setInput] = useState("");
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [encounterKey, setEncounterKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const [payload, setPayload] = useState<RaidPayload | null>(null);
  const [progress, setProgress] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [caller, setCallerName] = useState("");
  const [includeNames, setIncludeNames] = useState(false);
  const [lines, setLines] = useState<DocLine[]>([]);
  const [copied, setCopied] = useState(false);
  const [existing, setExisting] = useState("");
  const [mergeMsg, setMergeMsg] = useState<string | null>(null);

  const pendingPulls = useRef<number[] | null>(null);
  const autoRan = useRef(false);

  const encounters = useMemo(() => {
    if (!summary) return [];
    const groups = new Map<string, { key: string; label: string; fights: Fight[] }>();
    for (const fight of summary.fights) {
      if (fight.encounterID <= 0) continue;
      const key = `${fight.encounterID}:${fight.difficulty}`;
      const group = groups.get(key);
      if (group) group.fights.push(fight);
      else groups.set(key, { key, label: `${fight.difficulty} ${fight.name}`, fights: [fight] });
    }
    return [...groups.values()];
  }, [summary]);

  const activeEncounter = encounters.find((e) => e.key === encounterKey) ?? null;

  const chooseEncounter = useCallback(
    (key: string, fights?: Fight[]) => {
      setEncounterKey(key);
      const group = fights ?? encounters.find((e) => e.key === key)?.fights ?? [];
      setSelected(new Set(defaultSelection(group).selected));
    },
    [encounters],
  );

  const loadReport = useCallback(async (value: string) => {
    setLoading(true);
    setError(null);
    setSummary(null);
    setPayload(null);
    setLines([]);
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

  useEffect(() => {
    const state = decodeState(window.location.search);
    if (state.report) {
      pendingPulls.current = state.pulls ?? null;
      const url = `https://www.warcraftlogs.com/reports/${state.report}${encodeState({
        fight: state.fight,
      })}`;
      setInput(url);
      void loadReport(url);
      return;
    }
    const last = readLast();
    if (last.input) setInput(last.input);
  }, [loadReport]);

  // Pick the encounter once the report lands: the linked fight, else the boss
  // with the most pulls, which is what the night was actually about.
  useEffect(() => {
    if (!summary || encounters.length === 0 || encounterKey) return;
    const linked = summary.link.fightId
      ? encounters.find((e) => e.fights.some((f) => f.id === summary.link.fightId))
      : null;
    const biggest = [...encounters].sort((a, b) => b.fights.length - a.fights.length)[0];
    const pick = linked ?? biggest;
    if (!pick) return;

    if (pendingPulls.current) {
      const wanted = new Set(pendingPulls.current);
      setEncounterKey(pick.key);
      setSelected(new Set(pick.fights.filter((f) => wanted.has(f.id)).map((f) => f.id)));
      pendingPulls.current = null;
    } else {
      chooseEncounter(pick.key, pick.fights);
    }
  }, [summary, encounters, encounterKey, chooseEncounter]);

  const analyse = useCallback(async () => {
    if (!summary || selected.size === 0) return;
    setBusy(true);
    setError(null);
    setPayload(null);
    setProgress([]);

    const fightIds = [...selected].sort((a, b) => a - b);
    try {
      window.history.replaceState(
        null,
        "",
        encodeState({ report: summary.code, fight: fightIds[fightIds.length - 1], pulls: fightIds }) ||
          window.location.pathname,
      );
    } catch {
      // Non-fatal: the analysis matters more than the URL.
    }

    try {
      const res = await fetch("/api/raid", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: summary.code, fightIds }),
      });
      if (!res.body) throw new Error("No response stream");

      // Same minimal SSE reader as /api/analyze: POST rules out EventSource.
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
          else if (event === "report") setPayload(data as RaidPayload);
          else if (event === "error") setError(data.message);
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [summary, selected]);

  useEffect(() => {
    if (autoRan.current || busy || payload) return;
    if (!summary || selected.size === 0) return;
    if (!decodeState(window.location.search).pulls) return;
    autoRan.current = true;
    void analyse();
  }, [summary, selected, busy, payload, analyse]);

  const roster = useMemo(() => (payload ? rosterFromPayload(payload) : null), [payload]);

  const generated = useMemo(() => {
    if (!payload || !roster) return [];
    return mergeCloseLines(
      generateLines(payload.notable, roster, {
        tag: caller || undefined,
        includeNames,
      }),
    );
  }, [payload, roster, caller, includeNames]);

  // Last session's decisions, loaded once per analysis.
  const storedRef = useRef<StoredDoc | null>(null);
  const appliedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!payload) return;
    let stored: StoredDoc | null = null;
    try {
      const raw = localStorage.getItem(storageKey(payload.report.code, payload.encounter.id));
      stored = raw ? (JSON.parse(raw) as StoredDoc) : null;
    } catch {
      stored = null;
    }
    storedRef.current = stored;
    appliedFor.current = null;
    if (stored) {
      setCallerName(stored.caller);
      setIncludeNames(stored.includeNames);
    }
  }, [payload]);

  // Rebuild the document whenever the generation changes, carrying every edit
  // across. Stored edits are folded in once per analysis.
  //
  // The updater below must stay pure. It used to set a ref and call setState
  // from inside itself, and React's StrictMode double-invokes updaters in
  // development: the second pass saw the guard already flipped and returned the
  // un-restored lines, so a saved "Move to Soak" silently reverted on reload.
  useEffect(() => {
    if (!payload) return;
    const key = storageKey(payload.report.code, payload.encounter.id);
    const restore = appliedFor.current !== key;
    const stored = storedRef.current;
    setLines((previous) => {
      const merged = mergeGenerated(previous, generated);
      return restore ? applyStored(merged, stored) : merged;
    });
    if (restore) appliedFor.current = key;
  }, [payload, generated]);

  // Persist the decisions — never the evidence, which is re-derived every run.
  useEffect(() => {
    if (!payload || lines.length === 0) return;
    try {
      localStorage.setItem(
        storageKey(payload.report.code, payload.encounter.id),
        JSON.stringify(toStored({ caller, includeNames, placeholder: true, lines })),
      );
    } catch {
      // Private browsing: the note is still on screen and still copyable.
    }
  }, [payload, lines, caller, includeNames]);

  const header = useMemo(
    () => (payload ? buildHeader(payload.encounter) : null),
    [payload],
  );
  const note = useMemo(
    () => (header ? renderDoc(header, lines) : ""),
    [header, lines],
  );

  const scaleMs = useMemo(
    () => Math.max(1, ...(payload?.pulls.map((p) => p.durationMs) ?? [1])),
    [payload],
  );

  const inNote = useMemo(
    () =>
      new Set(
        lines.filter((l) => l.source).map((l) => waveKey(l.source!.mechanic, l.source!.ordinal)),
      ),
    [lines],
  );

  const toggleWave = useCallback(
    (mechanic: NotableMechanic, wave: MechanicWave) => {
      const key = waveKey(mechanic.name, wave.ordinal);
      setLines((previous) => {
        const found = previous.find(
          (l) => l.source && waveKey(l.source.mechanic, l.source.ordinal) === key,
        );
        if (found) return removeLine(previous, found.id);

        // Adding a wave the generator left out: build the same line it would have.
        if (!roster) return previous;
        const candidate = generateLines([{ ...mechanic, noteWorthy: true, waves: [wave] }], roster, {
          tag: caller || undefined,
          includeNames,
        })[0];
        if (!candidate) return previous;
        return [...previous, fromGenerated(candidate)].sort((a, b) => a.timeSec - b.timeSec);
      });
    },
    [roster, caller, includeNames],
  );

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(note);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Could not reach the clipboard — select the note text and copy it by hand.");
    }
  }, [note]);

  const mergeExisting = useCallback(() => {
    if (!existing.trim()) return;
    try {
      const parsed = parseNote(existing);
      const merged = mergeDocInto(parsed, lines);
      const before = parsed.lines.filter((l) => l.kind === "cooldown").length;
      const after = merged.lines.filter((l) => l.kind === "cooldown").length;
      setExisting(emitNote(merged));
      setMergeMsg(`Merged. ${after} of ${before} cooldown assignments preserved.`);
    } catch (e) {
      setMergeMsg(`Could not read that note: ${(e as Error).message}`);
    }
  }, [existing, lines]);

  const unwritten = lines.filter((l) => l.enabled && l.generated.includes("<call>") && !l.custom);

  return (
    <main className="wrap">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ margin: 0 }}>Raid notes</h1>
        <a className="muted" href="/" style={{ fontSize: 13 }}>
          ← DPS analysis
        </a>
      </div>
      <p className="muted" style={{ marginTop: 4 }}>
        What the raid keeps failing, as a callout sheet for whoever is running it.
      </p>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
          <input
            type="text"
            value={input}
            placeholder="https://www.warcraftlogs.com/reports/…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void loadReport(input)}
          />
          <button onClick={() => void loadReport(input)} disabled={loading || !input.trim()}>
            {loading ? "Loading…" : "Load"}
          </button>
        </div>

        {summary && (
          <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "nowrap" }}>
            <select
              value={encounterKey ?? ""}
              onChange={(e) => chooseEncounter(e.target.value)}
              style={{ flex: 1 }}
            >
              {encounters.map((e) => (
                <option key={e.key} value={e.key}>
                  {e.label} ({e.fights.length} pulls)
                </option>
              ))}
            </select>
            <button className="primary" onClick={() => void analyse()} disabled={busy || selected.size === 0}>
              {busy ? "Analysing…" : `Analyse ${selected.size} pulls`}
            </button>
          </div>
        )}

        {activeEncounter && !busy && (
          <div className="row" style={{ gap: 6, marginTop: 8, fontSize: 11 }}>
            {activeEncounter.fights.map((f) => (
              <label key={f.id} className="muted" style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={selected.has(f.id)}
                  onChange={() =>
                    setSelected((s) => {
                      const next = new Set(s);
                      if (next.has(f.id)) next.delete(f.id);
                      else next.add(f.id);
                      return next;
                    })
                  }
                  style={{ width: 13, marginRight: 3 }}
                />
                {formatDuration(f.durationMs)}
              </label>
            ))}
          </div>
        )}

        {busy && progress.length > 0 && (
          <div className="mono muted" style={{ marginTop: 10, fontSize: 11 }}>
            {progress[progress.length - 1]}
          </div>
        )}
        {error && (
          <p style={{ color: "var(--critical)", marginTop: 10, marginBottom: 0 }}>{error}</p>
        )}
      </div>

      {payload && (
        <>
          <div className="panel" style={{ marginTop: 14 }}>
            <div className="section-head">
              <h3>
                {payload.encounter.difficulty} {payload.encounter.name}
              </h3>
              <span className="muted" style={{ fontSize: 12 }}>
                {payload.pulls.length} pulls ·{" "}
                {payload.notable.filter((m) => m.noteWorthy).length} mechanics worth calling
              </span>
            </div>

            {payload.notable.some((m) => m.thinEvidence) && (
              <div className="muted" style={{ fontSize: 11, color: "var(--minor)", marginTop: 6 }}>
                Only {payload.pulls.length} pull{payload.pulls.length === 1 ? "" : "s"}: within each
                pull the raid still acts as its own control group, so &quot;most people dodged this&quot;
                holds — but nothing here is a trend yet. Re-run after a few more pulls.
              </div>
            )}

            <MechanicTimeline
              notable={payload.notable}
              scaleMs={scaleMs}
              selected={inNote}
              onToggle={toggleWave}
            />

            {payload.notable.some((m) => !m.noteWorthy) && (
              <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>
                Left out:{" "}
                {payload.notable
                  .filter((m) => !m.noteWorthy)
                  .map((m) => `${m.name} (${m.reason})`)
                  .join(" · ")}
              </div>
            )}
          </div>

          <div className="panel" style={{ marginTop: 14 }}>
            <div className="section-head">
              <h3>The note</h3>
              <span className="muted" style={{ fontSize: 12 }}>
                {lines.filter((l) => l.enabled).length} calls
              </span>
            </div>

            <div className="row" style={{ gap: 10, marginTop: 8, flexWrap: "wrap" }}>
              <label className="muted" style={{ fontSize: 12 }}>
                Calling:{" "}
                <input
                  type="text"
                  list="roster-names"
                  value={caller}
                  placeholder="everyone"
                  onChange={(e) => {
                    setCallerName(e.target.value);
                    setLines((l) => setCaller(l, e.target.value));
                  }}
                  style={{ width: 170, display: "inline-block", padding: "5px 8px" }}
                />
              </label>
              <datalist id="roster-names">
                {Object.values(payload.roster.actors).map((a) => (
                  <option key={a.id} value={a.name} />
                ))}
              </datalist>

              <label className="muted" style={{ fontSize: 12, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={includeNames}
                  onChange={(e) => setIncludeNames(e.target.checked)}
                  style={{ width: 13, marginRight: 4 }}
                />
                name who keeps missing it
              </label>

              <button
                onClick={() => setLines((l) => addLine(l, { timeSec: 0, tag: caller || "everyone" }))}
                style={{ padding: "4px 10px" }}
              >
                + call
              </button>
            </div>

            {caller && !Object.values(payload.roster.actors).some((a) => a.name === caller) && (
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                {caller} is not in this report — using the name as typed.
              </div>
            )}

            <NoteEditor
              lines={lines}
              mechanics={Object.fromEntries(
                payload.notable.map((m) => [
                  m.name,
                  { description: m.description, spellId: m.spellId },
                ]),
              )}
              onToggle={(id) => setLines((l) => toggleEnabled(l, id))}
              onText={(id, text) => setLines((l) => setText(l, id, text))}
              onTime={(id, t) => setLines((l) => setTime(l, id, t))}
              onRemove={(id) => setLines((l) => removeLine(l, id))}
            />

            {unwritten.length > 0 && (
              <div className="muted" style={{ fontSize: 11, marginTop: 10, color: "var(--minor)" }}>
                {unwritten.length} call{unwritten.length === 1 ? "" : "s"} still say{" "}
                <span className="mono">&lt;call&gt;</span> — the log can tell you when a mechanic lands
                and who it hits, but not whether to soak it, spread for it or move out. Write those in.
              </div>
            )}
          </div>

          <div className="panel" style={{ marginTop: 14 }}>
            <div className="section-head">
              <h3>Export</h3>
              <button className="primary" onClick={() => void copy()} disabled={!note.trim()}>
                {copied ? "Copied" : "Copy note"}
              </button>
            </div>
            <pre
              className="mono"
              style={{
                marginTop: 8,
                padding: 10,
                background: "var(--panel-2)",
                borderRadius: 6,
                fontSize: 11,
                maxHeight: 260,
                overflow: "auto",
                whiteSpace: "pre",
              }}
            >
              {note}
            </pre>

            <details style={{ marginTop: 10 }}>
              <summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>
                Already have a note? Paste it to splice these calls in without losing it
              </summary>
              <textarea
                value={existing}
                onChange={(e) => {
                  setExisting(e.target.value);
                  setMergeMsg(null);
                }}
                placeholder="EncounterID:…;Difficulty:…;Name:…"
                spellCheck={false}
                style={{
                  width: "100%",
                  minHeight: 120,
                  marginTop: 8,
                  padding: 8,
                  fontFamily: "var(--mono, monospace)",
                  fontSize: 11,
                  background: "var(--panel-2)",
                  color: "var(--text)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                }}
              />
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <button onClick={mergeExisting} disabled={!existing.trim()}>
                  Merge into this note
                </button>
                {mergeMsg && (
                  <span className="muted" style={{ fontSize: 11 }}>
                    {mergeMsg}
                  </span>
                )}
              </div>
            </details>
          </div>
        </>
      )}
    </main>
  );
}
