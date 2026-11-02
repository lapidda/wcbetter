"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { missingFromBuild, type BuildEvidence, type GuideList, type GuideSet } from "@/lib/spec/guide";

/** Your overrides per list and line: true crosses a line out, false keeps one the log would cross out. */
type Overrides = Record<string, Record<number, boolean>>;

function readOverrides(key: string): Overrides {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}");
  } catch {
    return {};
  }
}

function writeOverrides(key: string, value: Overrides) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing: the crossing-out still works, it just is not remembered.
  }
}

export interface GuideState {
  /** Line index (0-based) → why it is crossed out; absent means it is in. */
  crossed: (list: GuideList) => Map<number, string>;
  toggle: (list: GuideList, line: number) => void;
  reset: (list: GuideList) => void;
}

/**
 * Crossed-out lines: the log's verdict (a button never pressed, a buff never
 * had, a talent not picked), with your overrides on top, remembered in this
 * browser. Shared by the reference card and the priority check.
 */
export function useGuideState(build: BuildEvidence, storageKey: string): GuideState {
  const [overrides, setOverrides] = useState<Overrides>({});
  // Read after mount: the server render has no localStorage.
  useEffect(() => setOverrides(readOverrides(storageKey)), [storageKey]);

  const crossed = useCallback(
    (list: GuideList) => {
      const out = new Map<number, string>();
      list.lines.forEach((line, i) => {
        const auto = missingFromBuild(line, build);
        const mine = overrides[list.id]?.[i];
        if (mine === true) out.set(i, "crossed out by you");
        else if (mine !== false && auto) out.set(i, auto);
      });
      return out;
    },
    [build, overrides],
  );

  const toggle = useCallback(
    (list: GuideList, line: number) => {
      setOverrides((prev) => {
        const isOut = crossed(list).has(line);
        const auto = missingFromBuild(list.lines[line], build) != null;
        const forList = { ...(prev[list.id] ?? {}) };
        // Back to the log's verdict when that is what the click asks for.
        if (isOut === auto) forList[line] = !isOut;
        else delete forList[line];
        const next = { ...prev, [list.id]: forList };
        writeOverrides(storageKey, next);
        return next;
      });
    },
    [build, crossed, storageKey],
  );

  const reset = useCallback((list: GuideList) => {
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[list.id];
      writeOverrides(storageKey, next);
      return next;
    });
  }, [storageKey]);

  return { crossed, toggle, reset };
}

/**
 * A guide's priority lists for your hero tree, with the lines your build
 * cannot use crossed out. Click a line to cross it out or bring it back.
 */
export function PriorityGuide({ guide, group, state }: { guide: GuideSet; group: string | null; state: GuideState }) {
  const [shownGroup, setShownGroup] = useState(() =>
    guide.groups.some((g) => g.id === group) ? group! : guide.groups[0].id,
  );
  const lists = useMemo(() => guide.lists.filter((l) => l.group === shownGroup), [guide, shownGroup]);
  const [listId, setListId] = useState(lists[0].id);
  const [hideCrossed, setHideCrossed] = useState(false);
  const [view, setView] = useState<"list" | "flow">("list");
  const list = lists.find((l) => l.id === listId) ?? lists[0];
  const crossed = state.crossed(list);

  let n = 0;
  return (
    <div className="panel" style={{ marginTop: 24 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontWeight: 600 }}>Priority lists</div>
        <div className="row" style={{ gap: 6 }}>
          {guide.groups.map((g) => (
            <button
              key={g.id}
              type="button"
              className={`side-mini${shownGroup === g.id ? " active" : ""}`}
              aria-pressed={shownGroup === g.id}
              onClick={() => {
                setShownGroup(g.id);
                setListId(guide.lists.find((l) => l.group === g.id)!.id);
              }}
            >
              {g.label}
              {group === g.id ? " · yours" : ""}
            </button>
          ))}
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12, margin: "2px 0 10px" }}>
        From{" "}
        <a href={guide.source.url} target="_blank" rel="noreferrer">
          {guide.source.name}
        </a>{" "}
        (patch {guide.source.patch}, updated {guide.source.updated}), in short. Press the highest line that applies.
        Lines your build cannot use are crossed out from what your log shows; click any line to cross it out or bring
        it back. Your choices are remembered in this browser
        {guide.checked.includes(list.id) ? ", and the priority check above hides the lines you cross out here" : ""}.
      </div>

      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div className="tabs" role="tablist" style={{ marginBottom: 8 }}>
          {lists.map((l) => (
            <button
              key={l.id}
              type="button"
              role="tab"
              aria-selected={l.id === list.id}
              className={l.id === list.id ? "active" : undefined}
              onClick={() => setListId(l.id)}
            >
              {guide.labels[l.id] ?? l.id}
            </button>
          ))}
        </div>
        <div className="row" style={{ gap: 6, marginBottom: 8 }}>
          {(["list", "flow"] as const).map((v) => (
            <button
              key={v}
              type="button"
              className={`side-mini${view === v ? " active" : ""}`}
              aria-pressed={view === v}
              onClick={() => setView(v)}
            >
              {v === "list" ? "List" : "Flowchart"}
            </button>
          ))}
        </div>
      </div>

      {view === "flow" ? (
        <GuideFlow
          list={list}
          crossed={crossed}
          colours={guide.colours ?? {}}
          idle={guide.idle}
          onToggle={(i) => state.toggle(list, i)}
        />
      ) : (
        <ol className="wg-list">
          {list.lines.map((line, i) => {
            const why = crossed.get(i);
            if (why && hideCrossed) return null;
            const num = why ? null : ++n;
            return (
              <li key={i} className={why ? "out" : undefined}>
                <button type="button" className="wg-line" onClick={() => state.toggle(list, i)} title={why ? `Crossed out: ${why}. Click to bring it back.` : "Click to cross this line out"}>
                  <span className="wg-num mono">{num ?? "—"}</span>
                  <span style={{ flex: 1 }}>
                    <span className="wg-text">
                      <b>{line.action}</b>
                      {line.when && <span className="muted"> if {line.when}</span>}
                    </span>
                    {why && <span className="wg-why"> · {why}</span>}
                  </span>
                  <span className="wg-x" aria-hidden>
                    {why ? "↺" : "✕"}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      <div className="row" style={{ gap: 12, marginTop: 8, fontSize: 12 }}>
        {view === "list" && (
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={hideCrossed} onChange={(e) => setHideCrossed(e.target.checked)} style={{ width: "auto" }} />
            hide crossed-out lines ({crossed.size})
          </label>
        )}
        <button type="button" className="side-mini" onClick={() => state.reset(list)}>
          reset to what the log shows
        </button>
      </div>
      {list.target === "aoe" && guide.note && (
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          {guide.note}
        </div>
      )}
    </div>
  );
}

/**
 * The list as a decision chain: from the top after every press, each line
 * asks "is this button ready and does its condition hold?" — yes presses it,
 * no falls through to the next. Crossed-out lines are left out of the chain.
 */
function GuideFlow({
  list,
  crossed,
  colours,
  idle,
  onToggle,
}: {
  list: GuideList;
  crossed: Map<number, string>;
  /** Button colours for the "yes" boxes, so the same press reads the same everywhere. */
  colours: Record<string, string>;
  idle: string;
  onToggle: (line: number) => void;
}) {
  const steps = list.lines.map((line, i) => ({ line, i })).filter(({ i }) => !crossed.has(i));
  const out = list.lines.map((line, i) => ({ line, i, why: crossed.get(i) })).filter((x) => x.why);

  return (
    <div className="wf">
      <div className="wf-start">After every press, start here</div>
      {steps.map(({ line, i }, k) => (
        <div key={i} className="wf-step">
          <div className="wf-link" aria-hidden>
            {k === 0 ? "" : "no"}
          </div>
          <div className="wf-row">
            <div className="wf-q">
              <span className="wf-num mono">{k + 1}</span>
              <span>
                <b>{line.action}</b> ready?
                {line.when && <span className="wf-cond">only if {line.when}</span>}
              </span>
              <button type="button" className="wf-x" title="Cross this line out" onClick={() => onToggle(i)}>
                ✕
              </button>
            </div>
            <div className="wf-yes" aria-hidden>
              yes →
            </div>
            <div className={`wf-a ${colours[line.action] ?? ""}`}>{line.action}</div>
          </div>
        </div>
      ))}
      <div className="wf-step">
        <div className="wf-link" aria-hidden>
          no
        </div>
        <div className="wf-end">{idle}</div>
      </div>

      {out.length > 0 && (
        <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>
          Left out (crossed out):{" "}
          {out.map(({ line, i, why }, k) => (
            <span key={i}>
              {k > 0 ? ", " : ""}
              <button type="button" className="wf-back" title={`${why}. Click to bring it back.`} onClick={() => onToggle(i)}>
                {line.action}
                {line.when ? ` if ${line.when}` : ""} ↺
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
