"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { buildHeader, generateLines, mergeCloseLines } from "@/lib/nsrt/generate";
import { emitNote, parseNote } from "@/lib/nsrt/note-syntax";
import { rosterFromPayload } from "@/lib/model/raid-payload";
import { MechanicTimeline, waveKey } from "@/components/MechanicTimeline";
import { NoteEditor } from "@/components/NoteEditor";
import { useWorkspace } from "@/components/Workspace";

export default function Notes() {
  const { summary, raid } = useWorkspace();
  const { result: payload, busy, progress } = raid;
  const [error, setError] = useState<string | null>(null);

  const [caller, setCallerName] = useState("");
  const [includeNames, setIncludeNames] = useState(false);
  const [lines, setLines] = useState<DocLine[]>([]);
  const [copied, setCopied] = useState(false);
  const [existing, setExisting] = useState("");
  const [mergeMsg, setMergeMsg] = useState<string | null>(null);

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
    <div className="wrap">
      <h1 style={{ fontSize: 26, margin: "0 0 4px" }}>Raid notes</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        What the raid keeps failing, as a callout sheet for whoever is running it.
        {!summary && " Load a report in the sidebar to start."}
        {summary && !payload && !busy && " Pick a boss and its pulls in the sidebar, then press Analyse."}
      </p>

      {(raid.error || error) && (
        <div className="panel" style={{ marginTop: 14, borderColor: "var(--critical)" }}>
          {raid.error ?? error}
        </div>
      )}

      {busy && (
        <div className="panel mono" style={{ marginTop: 14 }}>
          {progress.length === 0 && <div className="muted">Starting…</div>}
          {progress.map((line, i) => (
            <div key={i} className={i === progress.length - 1 ? undefined : "muted"}>
              {line}
            </div>
          ))}
        </div>
      )}

      {payload && !busy && (
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
    </div>
  );
}
