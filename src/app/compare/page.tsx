"use client";

import { useEffect, useMemo, useState } from "react";
import { CLASS_COLOUR } from "@/components/RaidPerformanceView";
import { useWorkspace } from "@/components/Workspace";
import {
  bossWinner,
  columnAverage,
  columnKey,
  type CompareColumn,
  type CompareReport,
  type CompareTable,
} from "@/lib/model/spec-compare";
import { formatDuration } from "@/lib/model/stats";
import type { SpecChoice } from "@/lib/talents/talent-data";
import type { RaidZone } from "@/lib/tank-lookup";

const STORAGE_KEY = "wcbetter:compare:v1";
const DEFAULT_COLUMNS: CompareColumn[] = [
  { className: "DeathKnight", specName: "Frost", heroTree: null },
  { className: "DeathKnight", specName: "Unholy", heroTree: null },
  { className: "Monk", specName: "Windwalker", heroTree: "Conduit of the Celestials" },
  { className: "Monk", specName: "Windwalker", heroTree: "Shado-Pan" },
];
const DIFFICULTIES = [
  { id: 5, name: "Mythic" },
  { id: 4, name: "Heroic" },
];

/** "DeathKnight" → "Death Knight". */
const spaced = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2");
const k = (n: number) => `${(n / 1000).toFixed(1)}k`;

interface Saved {
  columns: CompareColumn[];
  zoneId: number | null;
  difficulties: number[];
  days: number | null;
  topN: number;
}

function readSaved(): Partial<Saved> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export default function Compare() {
  const { compare, runCompare } = useWorkspace();
  const [specs, setSpecs] = useState<SpecChoice[]>([]);
  const [zones, setZones] = useState<RaidZone[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [columns, setColumns] = useState<CompareColumn[]>(DEFAULT_COLUMNS);
  const [zoneId, setZoneId] = useState<number | null>(null);
  const [difficulties, setDifficulties] = useState<number[]>([5, 4]);
  const [days, setDays] = useState<number | null>(7);
  const [topN, setTopN] = useState(10);
  const [loaded, setLoaded] = useState(false);

  const [className, setClassName] = useState("");
  const [specName, setSpecName] = useState("");
  const [heroTree, setHeroTree] = useState("");

  useEffect(() => {
    const saved = readSaved();
    if (saved.columns?.length) setColumns(saved.columns);
    if (saved.zoneId) setZoneId(saved.zoneId);
    if (saved.difficulties?.length) setDifficulties(saved.difficulties);
    if (saved.days !== undefined) setDays(saved.days);
    if (saved.topN) setTopN(saved.topN);
    setLoaded(true);

    Promise.all([fetch("/api/specs").then((r) => r.json()), fetch("/api/zones").then((r) => r.json())])
      .then(([s, z]) => {
        if (s.error || z.error) throw new Error(s.error ?? z.error);
        setSpecs(s.specs);
        setZones(z.zones);
      })
      .catch((e) => setLoadError((e as Error).message));
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ columns, zoneId, difficulties, days, topN } satisfies Saved));
    } catch {
      // Private browsing: the settings just are not remembered.
    }
  }, [loaded, columns, zoneId, difficulties, days, topN]);

  const classes = useMemo(() => [...new Set(specs.map((s) => s.className))], [specs]);
  const classSpecs = specs.filter((s) => s.className === className);
  const spec = classSpecs.find((s) => s.specName === specName);
  const zone = zones.find((z) => z.id === zoneId) ?? zones[0];

  const candidate: CompareColumn | null = spec ? { className, specName, heroTree: heroTree || null } : null;
  const duplicate = candidate != null && columns.some((c) => columnKey(c) === columnKey(candidate));

  const canRun = !!zone && columns.length > 0 && difficulties.length > 0 && !compare.busy;

  return (
    <div className="wrap">
      <h1 style={{ fontSize: 26, margin: "0 0 4px" }}>Compare specs</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        The median of each spec&apos;s top parses on every boss, so one outlier does not skew it. Add any spec, for one
        hero tree or for its best parses on either.
      </p>
      {loadError && (
        <div className="panel" style={{ marginBottom: 14, borderColor: "var(--critical)" }}>
          {loadError}
        </div>
      )}

      <div className="panel">
        <div style={{ marginBottom: 8 }}>
          {columns.map((c) => (
            <span key={columnKey(c)} className="cmp-chip">
              <span style={{ color: CLASS_COLOUR[c.className] }}>
                {spaced(c.specName)} {spaced(c.className)}
              </span>
              <span className="muted" style={{ fontSize: 12 }}>
                {c.heroTree ?? "any hero tree"}
              </span>
              <button
                type="button"
                aria-label={`Remove ${c.specName} ${c.className}`}
                onClick={() => setColumns(columns.filter((x) => columnKey(x) !== columnKey(c)))}
              >
                ✕
              </button>
            </span>
          ))}
        </div>

        <div className="cmp-controls">
          <label>
            CLASS
            <select
              value={className}
              onChange={(e) => {
                setClassName(e.target.value);
                setSpecName("");
                setHeroTree("");
              }}
            >
              <option value="">Choose…</option>
              {classes.map((c) => (
                <option key={c} value={c}>
                  {spaced(c)}
                </option>
              ))}
            </select>
          </label>
          <label>
            SPEC
            <select
              value={specName}
              disabled={!className}
              onChange={(e) => {
                setSpecName(e.target.value);
                setHeroTree("");
              }}
            >
              <option value="">Choose…</option>
              {classSpecs.map((s) => (
                <option key={s.specName} value={s.specName}>
                  {spaced(s.specName)}
                </option>
              ))}
            </select>
          </label>
          <label>
            HERO TREE
            <select value={heroTree} disabled={!spec} onChange={(e) => setHeroTree(e.target.value)}>
              <option value="">Any (spec&apos;s best)</option>
              {spec?.heroTrees.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!candidate || duplicate}
            title={duplicate ? "Already a column" : undefined}
            onClick={() => candidate && setColumns([...columns, candidate])}
          >
            Add column
          </button>
        </div>

        <div className="cmp-controls" style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
          <label>
            RAID
            <select value={zone?.id ?? ""} onChange={(e) => setZoneId(Number(e.target.value))}>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            PARSES FROM
            <select value={days ?? ""} onChange={(e) => setDays(e.target.value ? Number(e.target.value) : null)}>
              <option value="7">Last 7 days</option>
              <option value="14">Last 14 days</option>
              <option value="30">Last 30 days</option>
              <option value="">Whole current patch</option>
            </select>
          </label>
          <label>
            TOP PARSES
            <select value={topN} onChange={(e) => setTopN(Number(e.target.value))}>
              {[5, 10, 20, 50].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {DIFFICULTIES.map((d) => (
            <label key={d.id} className="row" style={{ gap: 6, fontSize: 13, color: "var(--text)", paddingBottom: 7 }}>
              <input
                type="checkbox"
                style={{ width: "auto" }}
                checked={difficulties.includes(d.id)}
                onChange={(e) =>
                  setDifficulties(e.target.checked ? [...difficulties, d.id].sort((a, b) => b - a) : difficulties.filter((x) => x !== d.id))
                }
              />
              {d.name}
            </label>
          ))}
          <button
            type="button"
            className="primary"
            disabled={!canRun}
            onClick={() => zone && runCompare({ zoneId: zone.id, difficulties, columns, days, topN })}
          >
            {compare.busy ? "Comparing…" : "Compare"}
          </button>
        </div>
      </div>

      {compare.error && (
        <div className="panel" style={{ marginTop: 14, borderColor: "var(--critical)" }}>
          {compare.error}
        </div>
      )}
      {compare.busy && (
        <div className="panel mono" style={{ marginTop: 14 }}>
          {compare.progress[compare.progress.length - 1] ?? "Starting…"}
        </div>
      )}
      {compare.result && !compare.busy && <CompareTables report={compare.result} />}
    </div>
  );
}

function CompareTables({ report }: { report: CompareReport }) {
  return (
    <>
      <div className="muted" style={{ fontSize: 12, margin: "16px 0 0" }}>
        {report.zone} · median of the top {report.topN} ·{" "}
        {report.days != null ? `parses from the last ${report.days} days` : "whole current patch"} · rankings fetched{" "}
        {new Date(report.fetchedAt).toLocaleString()}, at most a day old. Green is the highest full column on a boss;
        amber has fewer than {report.topN} parses and cannot win. Hover a cell for item level, kill time and the best parse.
      </div>
      {report.tables.map((t) => (
        <CompareTableView key={t.difficulty} table={t} report={report} />
      ))}
    </>
  );
}

function CompareTableView({ table, report }: { table: CompareTable; report: CompareReport }) {
  const { columns, topN } = report;
  const winners = table.bosses.map((b) => bossWinner(b, topN));
  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>{table.difficultyName}</div>
      <div style={{ overflowX: "auto" }}>
        <table className="abilities cmp-table">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Boss</th>
              {columns.map((c) => (
                <th key={columnKey(c)} style={{ color: CLASS_COLOUR[c.className] }}>
                  {spaced(c.specName)} {spaced(c.className)}
                  <span className="cmp-col-sub">{c.heroTree ?? "any hero tree"}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.bosses.map((b, bi) => (
              <tr key={b.id}>
                <td style={{ textAlign: "left" }}>{b.name}</td>
                {b.cells.map((cell, i) => (
                  <td
                    key={columnKey(columns[i])}
                    className={`mono${winners[bi] === i ? " best" : ""}${cell.n > 0 && cell.n < topN ? " thin" : ""}`}
                    title={
                      cell.n === 0
                        ? "No qualifying parses"
                        : `${cell.n} parse${cell.n === 1 ? "" : "s"} · best ${k(cell.best!)} · item level ${cell.itemLevel ?? "?"} · kill ${formatDuration(cell.durationMs!)}`
                    }
                  >
                    {cell.median == null ? "—" : k(cell.median)}
                    {cell.n > 0 && cell.n < topN ? ` (${cell.n})` : ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td style={{ textAlign: "left" }} title="Only for a column with a full cell on every boss">
                Average of bosses
              </td>
              {columns.map((c, i) => {
                const avg = columnAverage(table, i, topN);
                return (
                  <td key={columnKey(c)} className="mono">
                    {avg == null ? "—" : k(avg)}
                  </td>
                );
              })}
            </tr>
            <tr>
              <td style={{ textAlign: "left" }}>Bosses won</td>
              {columns.map((c, i) => (
                <td key={columnKey(c)} className="mono">
                  {winners.filter((w) => w === i).length}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
