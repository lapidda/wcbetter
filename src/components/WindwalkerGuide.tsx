"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  GUIDE_LISTS,
  GUIDE_SOURCE,
  LIST_LABEL,
  missingFromBuild,
  type BuildEvidence,
  type GuideList,
} from "@/lib/spec/windwalker-guide";
import type { Tree } from "@/lib/spec/windwalker";

/** Your overrides per list and line: true crosses a line out, false keeps one the log would cross out. */
type Overrides = Record<string, Record<number, boolean>>;

const STORAGE_KEY = "wcbetter:ww-guide:v1";

function readOverrides(): Overrides {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function writeOverrides(value: Overrides) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
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
export function useGuideState(build: BuildEvidence): GuideState {
  const [overrides, setOverrides] = useState<Overrides>({});
  // Read after mount: the server render has no localStorage.
  useEffect(() => setOverrides(readOverrides()), []);

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
        writeOverrides(next);
        return next;
      });
    },
    [build, crossed],
  );

  const reset = useCallback((list: GuideList) => {
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[list.id];
      writeOverrides(next);
      return next;
    });
  }, []);

  return { crossed, toggle, reset };
}

/**
 * Peak of Serenity's priority lists for your hero tree, with the lines your
 * build cannot use crossed out. Click a line to cross it out or bring it back.
 */
export function WindwalkerGuide({ tree, state }: { tree: Tree; state: GuideState }) {
  const [shownTree, setShownTree] = useState<"conduit" | "shado-pan">(tree === "shado-pan" ? "shado-pan" : "conduit");
  const lists = useMemo(() => GUIDE_LISTS.filter((l) => l.tree === shownTree), [shownTree]);
  const [listId, setListId] = useState(lists[0].id);
  const [hideCrossed, setHideCrossed] = useState(false);
  const list = lists.find((l) => l.id === listId) ?? lists[0];
  const crossed = state.crossed(list);

  let n = 0;
  return (
    <div className="panel" style={{ marginTop: 24 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontWeight: 600 }}>Priority lists</div>
        <div className="row" style={{ gap: 6 }}>
          {(["conduit", "shado-pan"] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`side-mini${shownTree === t ? " active" : ""}`}
              aria-pressed={shownTree === t}
              onClick={() => {
                setShownTree(t);
                setListId(GUIDE_LISTS.find((l) => l.tree === t)!.id);
              }}
            >
              {t === "conduit" ? "Conduit" : "Shado-Pan"}
              {tree === t ? " · yours" : ""}
            </button>
          ))}
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12, margin: "2px 0 10px" }}>
        From{" "}
        <a href={GUIDE_SOURCE.url} target="_blank" rel="noreferrer">
          {GUIDE_SOURCE.name}
        </a>{" "}
        (patch {GUIDE_SOURCE.patch}, updated {GUIDE_SOURCE.updated}), in short. Press the highest line that applies.
        Lines your build cannot use are crossed out from what your log shows; click any line to cross it out or bring
        it back. Your choices are remembered in this browser
        {list.id === "st-default-conduit" ? ", and the priority check above hides the lines you cross out here" : ""}.
      </div>

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
            {LIST_LABEL[l.id]}
          </button>
        ))}
      </div>

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

      <div className="row" style={{ gap: 12, marginTop: 8, fontSize: 12 }}>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={hideCrossed} onChange={(e) => setHideCrossed(e.target.checked)} style={{ width: "auto" }} />
          hide crossed-out lines ({crossed.size})
        </label>
        <button type="button" className="side-mini" onClick={() => state.reset(list)}>
          reset to what the log shows
        </button>
      </div>
      {list.target === "aoe" && (
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          The guide uses the AoE list from 2 targets. The priority check above is single-target only.
        </div>
      )}
    </div>
  );
}
