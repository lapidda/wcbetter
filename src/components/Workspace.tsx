"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AnalysisReport, ReportSummary } from "@/lib/analyze";
import type { RaidPayload } from "@/lib/model/raid-payload";
import { decodeState, defaultSelection, encodeState } from "@/lib/url-state";

// One workspace behind both views. The report, the pickers and both analyses
// live here, in the root layout, so they survive switching between the player
// analysis and the raid notes: load a log once, flip between views, re-run a
// different pull from the sidebar without starting over.

export type Fight = ReportSummary["fights"][number];
export type View = "player" | "notes";

export interface Encounter {
  key: string;
  label: string;
  fights: Fight[];
}

interface Run<T> {
  result: T | null;
  progress: string[];
  busy: boolean;
  error: string | null;
  /** The pulls this result covers, so the sidebar can say which ones are on screen. */
  fightIds: number[];
}

const idle = <T,>(): Run<T> => ({ result: null, progress: [], busy: false, error: null, fightIds: [] });

interface WorkspaceValue {
  view: View;
  input: string;
  setInput: (value: string) => void;
  summary: ReportSummary | null;
  loading: boolean;
  loadError: string | null;
  loadReport: (value: string) => Promise<void>;

  actorId: number | null;
  setActorId: (id: number | null) => void;
  /** Every boss in the report; in the player view, only those the player was in. */
  encounters: Encounter[];
  activeEncounter: Encounter | null;
  chooseEncounter: (key: string) => void;
  selected: Set<number>;
  setSelected: (next: Set<number>) => void;
  togglePull: (id: number) => void;
  shortPulls: Set<number>;

  player: Run<AnalysisReport>;
  raid: Run<RaidPayload>;
  /** Run the current view's analysis, on the given pulls or the ticked ones. */
  analyze: (fightIds?: number[]) => void;
  /** Link to a view carrying the current report and selection. */
  hrefFor: (view: View) => string;
}

const Ctx = createContext<WorkspaceValue | null>(null);

export function useWorkspace(): WorkspaceValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useWorkspace outside <WorkspaceProvider>");
  return value;
}

/** Remembers the last log and character so a weekly user does not re-pick themselves. */
const LAST_KEY = "wcbetter:last";

const readLast = (): { input?: string; sourceId?: number } => {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}");
  } catch {
    return {};
  }
};

const writeLast = (patch: { input?: string; sourceId?: number }) => {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ ...readLast(), ...patch }));
  } catch {
    // Private browsing: remembering is a convenience, not a requirement.
  }
};

const pathFor = (view: View) => (view === "notes" ? "/notes" : "/");

/** A pull the player sat out has no profile; an empty roster means the log did not say. */
const playerWasIn = (fight: Fight, actorId: number | null) =>
  actorId == null || fight.friendlyPlayers.length === 0 || fight.friendlyPlayers.includes(actorId);

/**
 * Both analyses stream progress as server-sent events over a POST, which rules
 * out EventSource. The payloads are small and same-origin, so a reader over the
 * fetch body is all it takes.
 */
async function streamSse(
  url: string,
  body: unknown,
  on: { progress: (m: string) => void; result: (data: unknown) => void; error: (m: string) => void },
) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.body) throw new Error("No response stream");

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
      if (event === "progress") on.progress(data.message);
      else if (event === "report") on.result(data);
      else if (event === "error") on.error(data.message);
    }
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const view: View = pathname?.startsWith("/notes") ? "notes" : "player";

  const [input, setInput] = useState("");
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [actorId, setActorIdState] = useState<number | null>(null);
  const [encounterKey, setEncounterKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [shortPulls, setShortPulls] = useState<Set<number>>(new Set());

  const [player, setPlayer] = useState<Run<AnalysisReport>>(idle);
  const [raid, setRaid] = useState<Run<RaidPayload>>(idle);

  /** From a shared link: the pulls to select, and whether to run straight away. */
  const pending = useRef<{ pulls: number[] | null; run: View | null }>({ pulls: null, run: null });

  const allEncounters = useMemo(() => {
    if (!summary) return [];
    const groups = new Map<string, Encounter>();
    for (const fight of summary.fights) {
      // Trash has no encounter, no rankings and no mechanics worth a note.
      if (fight.encounterID <= 0) continue;
      const key = `${fight.encounterID}:${fight.difficulty}`;
      const group = groups.get(key);
      if (group) group.fights.push(fight);
      else groups.set(key, { key, label: `${fight.difficulty} ${fight.name}`, fights: [fight] });
    }
    return [...groups.values()];
  }, [summary]);

  const encounters = useMemo(() => {
    if (view !== "player" || actorId == null) return allEncounters;
    return allEncounters
      .map((e) => ({ ...e, fights: e.fights.filter((f) => playerWasIn(f, actorId)) }))
      .filter((e) => e.fights.length > 0);
  }, [allEncounters, view, actorId]);

  const activeEncounter = encounters.find((e) => e.key === encounterKey) ?? null;

  const selectEncounter = useCallback((group: Encounter, pulls?: number[] | null) => {
    setEncounterKey(group.key);
    const wanted = pulls?.filter((id) => group.fights.some((f) => f.id === id)) ?? [];
    if (wanted.length > 0) {
      setSelected(new Set(wanted));
      setShortPulls(new Set());
      return;
    }
    const { selected: pick, short } = defaultSelection(group.fights);
    setSelected(new Set(pick));
    setShortPulls(new Set(short));
  }, []);

  const chooseEncounter = useCallback(
    (key: string) => {
      const group = encounters.find((e) => e.key === key);
      if (group) selectEncounter(group);
    },
    [encounters, selectEncounter],
  );

  const setActorId = useCallback((id: number | null) => {
    setActorIdState(id);
    if (id != null) writeLast({ sourceId: id });
  }, []);

  const loadReport = useCallback(async (value: string) => {
    setLoading(true);
    setLoadError(null);
    setSummary(null);
    setActorIdState(null);
    setEncounterKey(null);
    setSelected(new Set());
    setShortPulls(new Set());
    setPlayer(idle());
    setRaid(idle());

    try {
      const res = await fetch(`/api/report?input=${encodeURIComponent(value)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setSummary(json);
      writeLast({ input: value });
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // --- Arriving with a URL ---------------------------------------------------
  // A shared report link carries `pulls` and runs itself; a pasted WCL link
  // only prefills. With neither, fall back to the last log this browser used.
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current) return;
    arrived.current = true;

    const state = decodeState(window.location.search);
    if (state.report) {
      const url = `https://www.warcraftlogs.com/reports/${state.report}${encodeState({
        fight: state.fight,
        source: state.source,
      })}`;
      pending.current = { pulls: state.pulls ?? null, run: state.pulls ? view : null };
      setInput(url);
      void loadReport(url);
      return;
    }
    const last = readLast();
    if (last.input) setInput(last.input);
  }, [loadReport, view]);

  // Once a report lands: the player from the link (WCL's `source` is the actor
  // id), else the one this browser last analysed, if they are in this log.
  useEffect(() => {
    if (!summary) return;
    const inLog = (id: number | null | undefined) => id != null && summary.players.some((p) => p.id === id);
    const fromLink = summary.link.sourceId;
    const remembered = readLast().sourceId;
    if (inLog(fromLink)) setActorIdState(fromLink);
    else if (inLog(remembered)) setActorIdState(remembered!);
  }, [summary]);

  // ...then the boss: the linked fight's, else the one with the most pulls,
  // which is what the night was actually about.
  useEffect(() => {
    if (!summary || encounterKey != null || encounters.length === 0) return;
    const linked = summary.link.fightId
      ? encounters.find((e) => e.fights.some((f) => f.id === summary.link.fightId))
      : null;
    const biggest = [...encounters].sort((a, b) => b.fights.length - a.fights.length)[0];
    const pick = linked ?? biggest;
    if (!pick) return;
    selectEncounter(pick, pending.current.pulls);
    pending.current.pulls = null;
  }, [summary, encounters, encounterKey, selectEncounter]);

  // The player filter can drop the active boss (a player who sat it out); fall
  // back to picking again rather than leaving a selection that cannot run.
  useEffect(() => {
    if (encounterKey != null && summary && !encounters.some((e) => e.key === encounterKey)) {
      setEncounterKey(null);
    }
  }, [encounters, encounterKey, summary]);

  const togglePull = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const hrefFor = useCallback(
    (target: View) => {
      if (!summary) return pathFor(target);
      // A view with a finished analysis links to exactly that analysis, so the
      // address bar stays a shareable link after switching back to it. Only the
      // first page load reads `pulls` and auto-runs; in-app navigation never does.
      const done = target === "player" ? player : raid;
      const ids = done.result ? done.fightIds : [...selected].sort((a, b) => a - b);
      return (
        pathFor(target) +
        encodeState({
          report: summary.code,
          source: actorId ?? undefined,
          fight: ids[ids.length - 1] ?? summary.link.fightId ?? undefined,
          pulls: done.result ? ids : undefined,
        })
      );
    },
    [summary, selected, actorId, player, raid],
  );

  const analyze = useCallback(
    (only?: number[]) => {
      if (!summary || !activeEncounter) return;
      const pool = only ?? [...selected];
      const fightIds = pool
        .filter((id) => activeEncounter.fights.some((f) => f.id === id))
        .sort((a, b) => a - b);
      if (fightIds.length === 0) return;
      if (only) setSelected(new Set(only));

      // The address bar becomes the shareable link the moment analysis starts.
      try {
        const query = encodeState({
          report: summary.code,
          source: view === "player" ? actorId ?? undefined : undefined,
          fight: fightIds[fightIds.length - 1],
          pulls: fightIds,
        });
        window.history.replaceState(null, "", pathFor(view) + query);
        if (view === "player" && actorId != null) writeLast({ input, sourceId: actorId });
      } catch {
        // Non-fatal: the analysis matters more than the URL.
      }

      if (view === "player") {
        if (actorId == null) return;
        setPlayer({ ...idle(), busy: true, fightIds });
        streamSse(
          "/api/analyze",
          { code: summary.code, actorId, fightIds },
          {
            progress: (m) => setPlayer((r) => ({ ...r, progress: [...r.progress, m] })),
            result: (data) => setPlayer((r) => ({ ...r, result: data as AnalysisReport })),
            error: (m) => setPlayer((r) => ({ ...r, error: m })),
          },
        )
          .catch((e) => setPlayer((r) => ({ ...r, error: (e as Error).message })))
          .finally(() => setPlayer((r) => ({ ...r, busy: false })));
      } else {
        setRaid({ ...idle(), busy: true, fightIds });
        streamSse(
          "/api/raid",
          { code: summary.code, fightIds },
          {
            progress: (m) => setRaid((r) => ({ ...r, progress: [...r.progress, m] })),
            result: (data) => setRaid((r) => ({ ...r, result: data as RaidPayload })),
            error: (m) => setRaid((r) => ({ ...r, error: m })),
          },
        )
          .catch((e) => setRaid((r) => ({ ...r, error: (e as Error).message })))
          .finally(() => setRaid((r) => ({ ...r, busy: false })));
      }
    },
    [summary, activeEncounter, selected, view, actorId, input],
  );

  // A link that named its pulls is a finished analysis someone shared: run it,
  // once, as soon as the pickers it needs have filled in.
  useEffect(() => {
    const want = pending.current.run;
    if (!want || want !== view || !summary || !activeEncounter || selected.size === 0) return;
    if (view === "player" && actorId == null) return;
    pending.current.run = null;
    analyze();
  }, [view, summary, activeEncounter, selected, actorId, analyze]);

  const value: WorkspaceValue = {
    view,
    input,
    setInput,
    summary,
    loading,
    loadError,
    loadReport,
    actorId,
    setActorId,
    encounters,
    activeEncounter,
    chooseEncounter,
    selected,
    setSelected,
    togglePull,
    shortPulls,
    player,
    raid,
    analyze,
    hrefFor,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
