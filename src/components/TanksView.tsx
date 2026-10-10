"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { addToStored, storageKey, type StoredDoc } from "@/lib/model/note-doc";
import type { RaidPayload } from "@/lib/model/raid-payload";
import { formatDuration } from "@/lib/model/stats";
import { tankNoteLines, type TankPull, type TankReport } from "@/lib/model/tanks";

const W = 1000;
const CLASS_COLOUR: Record<string, string> = {
  DeathKnight: "#C41E3A",
  DemonHunter: "#A330C9",
  Druid: "#FF7C0A",
  Monk: "#00FF98",
  Paladin: "#F48CBA",
  Warrior: "#C69B6D",
};
const m = (n: number) => `${(n / 1e6).toFixed(1)}M`;

function defaultPull(t: TankReport): TankPull | undefined {
  return t.pulls.find((p) => p.kill) ?? [...t.pulls].sort((a, b) => b.durationMs - a.durationMs)[0];
}

/**
 * The tanks of one boss: who takes it first, when each taunted and at how
 * many stacks, and what was up when a buster landed — one tank at a time,
 * against the boss's own casts.
 */
export function TanksView({
  payload,
  hrefNotes,
  initialTankId,
  exportable = true,
}: {
  payload: RaidPayload;
  hrefNotes: string;
  /** Open on this tank rather than the first one. */
  initialTankId?: number | null;
  /** The note export only makes sense for your own raid. */
  exportable?: boolean;
}) {
  const t = payload.tanks;
  const [tankId, setTankId] = useState(() => initialTankId ?? t?.order[0] ?? t?.tanks[0]?.id ?? 0);
  const [fightId, setFightId] = useState(() => (t ? defaultPull(t)?.fightId : undefined));

  if (!t || t.tanks.length === 0) {
    return <div className="panel muted">No tanks were found in these pulls.</div>;
  }

  const pull = t.pulls.find((p) => p.fightId === fightId) ?? t.pulls[0];
  const tank = t.tanks.find((x) => x.id === tankId) ?? t.tanks[0];
  const other = t.tanks.find((x) => x.id !== tank.id) ?? null;
  const sum = t.summary.find((s) => s.tankId === tank.id)!;
  const position = (id: number) => t.order.indexOf(id);
  const colour = (id: number) => CLASS_COLOUR[t.tanks.find((x) => x.id === id)?.className ?? ""] ?? "var(--accent)";
  const nameOf = (id: number | null) => t.tanks.find((x) => x.id === id)?.name ?? "—";

  return (
    <div>
      <div className="panel">
        <div className="section-head">
          <h3>
            Tanks · {payload.encounter.difficulty} {payload.encounter.name}
          </h3>
          <span className="muted" style={{ fontSize: 12 }}>
            {t.pulls.length} pull{t.pulls.length === 1 ? "" : "s"}
          </span>
        </div>
        <div style={{ fontSize: 13, margin: "6px 0 12px" }}>
          {t.order.length >= 2 ? (
            <>
              <b style={{ color: colour(t.order[0]) }}>{nameOf(t.order[0])}</b> takes the boss first on{" "}
              {t.summary.find((s) => s.tankId === t.order[0])?.firstOn} of {t.pulls.length} pulls,{" "}
              <b style={{ color: colour(t.order[1]) }}>{nameOf(t.order[1])}</b> second.
            </>
          ) : (
            <>One tank in these pulls.</>
          )}{" "}
          <span className="muted">
            {t.swapDebuff ? (
              <>
                Swap debuff: <b style={{ color: "var(--text)" }}>{t.swapDebuff}</b> — the boss debuff that stacks on tanks only.
              </>
            ) : (
              "No stacking tank debuff on this boss, so there is no swap to read."
            )}{" "}
            {t.busterNames.length > 0 && <>Tank busters: {t.busterNames.join(", ")}.</>}
          </span>
        </div>

        <div className="row" style={{ gap: 8 }}>
          {t.tanks.map((x) => (
            <button
              key={x.id}
              type="button"
              className={`chip${x.id === tank.id ? " on" : ""}`}
              aria-pressed={x.id === tank.id}
              onClick={() => setTankId(x.id)}
            >
              <span className="swatch" style={{ background: colour(x.id) }} />
              {x.name}
              <span className="muted" style={{ fontSize: 11 }}>
                {x.spec ?? x.className}
              </span>
              {position(x.id) >= 0 && <span className="tk-badge">{position(x.id) === 0 ? "1st" : "2nd"}</span>}
            </button>
          ))}
        </div>

        <div className="ww-checks" style={{ marginTop: 14 }}>
          <Stat label="Swap taunts" value={`${sum.swapTaunts}`} sub={sum.tauntAtStacks != null ? `usually at ${sum.tauntAtStacks} stacks` : "no swap taunts"} warn={sum.lateTaunts > 0 ? `${sum.lateTaunts} late` : undefined} />
          <Stat label="Peak stacks" value={sum.peakStacks != null ? `${sum.peakStacks}` : "—"} sub={t.swapDebuff ? `${t.swapDebuff}, median per pull` : "no swap debuff"} />
          <Stat
            label="Busters covered"
            value={sum.busterHits ? `${sum.bustersCovered} of ${sum.busterHits}` : "—"}
            sub="a defensive or external up when it hit"
            warn={sum.busterHits - sum.bustersCovered > 0 ? `${sum.busterHits - sum.bustersCovered} without` : undefined}
          />
          <Stat label="Deaths" value={`${sum.deaths}`} sub={`over ${t.pulls.length} pulls`} warn={sum.deaths > 0 ? " " : undefined} />
        </div>
        {sum.defensives.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 12 }}>
            <span className="muted">Cooldowns per pull: </span>
            {sum.defensives.map((d) => (
              <span key={d.name} className={`rp-chip ${d.kind === "external" ? "assigned" : "targeted"}`}>
                {d.name} {d.perPull.toFixed(1)}
                {d.kind === "external" ? " (external)" : ""}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end", marginBottom: 10 }}>
          <div>
            <div style={{ fontWeight: 600 }}>{tank.name}, pull by pull</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Boss casts on top; stacks, taunts, cooldowns and tank-buster hits below. Hover anything for detail.
            </div>
          </div>
          <label style={{ minWidth: 220 }}>
            <div className="muted" style={{ fontSize: 11, marginBottom: 3 }}>
              PULL
            </div>
            <select value={pull.fightId} onChange={(e) => setFightId(Number(e.target.value))} style={{ padding: "6px 9px", fontSize: 13 }}>
              {t.pulls.map((p) => (
                <option key={p.fightId} value={p.fightId}>
                  {p.label} · {formatDuration(p.durationMs)}
                  {p.firstTankId != null ? ` · ${nameOf(p.firstTankId)} first` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>

        <Timeline pull={pull} tankId={tank.id} otherId={other?.id ?? null} colour={colour} busterNames={new Set(t.busterNames)} swapDebuff={t.swapDebuff} />

        <div className="grid-2" style={{ marginTop: 16, gap: 16 }}>
          <div>
            <div className="ww-sub">Taunts by {tank.name}</div>
            <table className="abilities">
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Time</th>
                  <th title={`${other?.name ?? "the other tank"}'s stacks`}>Their stacks</th>
                  <th title="your own stacks">Own</th>
                  <th style={{ textAlign: "left" }}>Kind</th>
                </tr>
              </thead>
              <tbody>
                {pull.taunts.filter((x) => x.tankId === tank.id).length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted" style={{ textAlign: "left" }}>
                      No taunts on this pull.
                    </td>
                  </tr>
                )}
                {pull.taunts
                  .filter((x) => x.tankId === tank.id)
                  .map((x, i) => (
                    <tr key={i}>
                      <td style={{ textAlign: "left" }} className="mono">
                        {formatDuration(x.atMs)}
                      </td>
                      <td className="mono">{x.otherStacks}</td>
                      <td className="mono muted">{x.ownStacks}</td>
                      <td style={{ textAlign: "left" }}>
                        {x.swap ? (
                          <span className={`rp-read ${x.late ? "warn" : "good"}`}>{x.late ? "swap — late" : "swap"}</span>
                        ) : (
                          <span className="muted">other (pull, add, reposition)</span>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div>
            <div className="ww-sub">Tank busters on {tank.name}</div>
            <table className="abilities">
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Time</th>
                  <th style={{ textAlign: "left" }}>Hit</th>
                  <th>Damage</th>
                  <th style={{ textAlign: "left" }}>Up at the time</th>
                </tr>
              </thead>
              <tbody>
                {pull.busters.filter((b) => b.tankId === tank.id).length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted" style={{ textAlign: "left" }}>
                      No tank-buster hits on {tank.name} this pull.
                    </td>
                  </tr>
                )}
                {pull.busters
                  .filter((b) => b.tankId === tank.id)
                  .map((b, i) => (
                    <tr key={i}>
                      <td style={{ textAlign: "left" }} className="mono">
                        {formatDuration(b.atMs)}
                      </td>
                      <td style={{ textAlign: "left" }}>{b.name}</td>
                      <td className="mono">{m(b.amount)}</td>
                      <td style={{ textAlign: "left", whiteSpace: "normal" }}>
                        {b.covered.length === 0 ? (
                          <span className="rp-read bad">nothing</span>
                        ) : (
                          b.covered.map((c) => (
                            <span key={c.name} className={`rp-chip ${c.kind === "external" ? "assigned" : "targeted"}`}>
                              {c.name}
                            </span>
                          ))
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {exportable && <NoteExport payload={payload} report={t} hrefNotes={hrefNotes} />}
    </div>
  );
}

function Stat({ label, value, sub, warn }: { label: string; value: string; sub: string; warn?: string }) {
  return (
    <div className={`ww-check ${warn ? "warn" : "good"}`}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>{label}</div>
      <div className="mono" style={{ fontSize: 16, marginTop: 2 }}>
        {value}
        {warn && warn.trim() && (
          <span style={{ color: "var(--minor)", fontSize: 12, marginLeft: 8 }}>{warn}</span>
        )}
      </div>
      <div className="muted" style={{ fontSize: 11 }}>
        {sub}
      </div>
    </div>
  );
}

// --- Timeline ---------------------------------------------------------------------

const LANES = { boss: 0, stacks: 22, taunts: 76, cds: 96, busters: 116, deaths: 136 };
const HEIGHT = 150;

function Timeline({
  pull,
  tankId,
  otherId,
  colour,
  busterNames,
  swapDebuff,
}: {
  pull: TankPull;
  tankId: number;
  otherId: number | null;
  colour: (id: number) => string;
  busterNames: Set<string>;
  swapDebuff: string | null;
}) {
  const x = (ms: number) => (ms / Math.max(1, pull.durationMs)) * W;
  const maxStacks = Math.max(1, ...Object.values(pull.stacks).flatMap((s) => s.map((p) => p.stacks)));
  const stackY = (s: number) => LANES.stacks + 48 - (s / maxStacks) * 46;
  const path = (id: number | null) => {
    if (id == null) return "";
    const steps = pull.stacks[id] ?? [];
    let d = `M0 ${stackY(0)}`;
    for (const s of steps) d += ` H${x(s.atMs)} V${stackY(s.stacks)}`;
    return d + ` H${W}`;
  };
  const ticks = useMemo(() => {
    const step = pull.durationMs > 300_000 ? 60_000 : 30_000;
    return Array.from({ length: Math.floor(pull.durationMs / step) + 1 }, (_, i) => i * step);
  }, [pull.durationMs]);

  return (
    <div className="tk-timeline">
      <div className="tk-labels">
        <span style={{ top: LANES.boss }}>boss casts</span>
        <span style={{ top: LANES.stacks + 16 }}>{swapDebuff ? "stacks" : ""}</span>
        <span style={{ top: LANES.taunts }}>taunts</span>
        <span style={{ top: LANES.cds }}>cooldowns</span>
        <span style={{ top: LANES.busters }}>busters</span>
        <span style={{ top: LANES.deaths }}>deaths</span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <svg viewBox={`0 0 ${W} ${HEIGHT}`} preserveAspectRatio="none" style={{ width: "100%", height: HEIGHT, display: "block" }}>
          {ticks.map((t) => (
            <line key={t} x1={x(t)} x2={x(t)} y1={0} y2={HEIGHT} stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          {pull.bossCasts.map((c, i) => {
            const tankish = busterNames.has(c.name) || c.onTank != null;
            return (
              <rect key={i} x={x(c.atMs) - 1} y={LANES.boss} width={2} height={14} fill={tankish ? "var(--critical)" : "#5a6270"}>
                <title>{`${formatDuration(c.atMs)} ${c.name}${c.onTank != null ? " (on a tank)" : ""}`}</title>
              </rect>
            );
          })}
          {swapDebuff && (
            <>
              <path d={path(otherId)} fill="none" stroke={otherId != null ? colour(otherId) : "var(--muted)"} strokeOpacity={0.45} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              <path d={path(tankId)} fill="none" stroke={colour(tankId)} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
            </>
          )}
          {pull.taunts.map((t, i) => (
            <rect
              key={i}
              x={x(t.atMs) - 2}
              y={LANES.taunts}
              width={4}
              height={14}
              fill={t.tankId === tankId ? (t.late ? "var(--minor)" : colour(tankId)) : "var(--muted)"}
              opacity={t.tankId === tankId ? 1 : 0.4}
            >
              <title>{`${formatDuration(t.atMs)} taunt${t.swap ? ` at ${t.otherStacks} stacks${t.late ? " (late)" : ""}` : ""}`}</title>
            </rect>
          ))}
          {pull.windows
            .filter((w) => w.tankId === tankId)
            .map((w, i) => (
              <rect key={i} x={x(w.startMs)} y={LANES.cds} width={Math.max(1, x(w.endMs) - x(w.startMs))} height={14} fill={w.kind === "external" ? "#bb9af7" : "var(--good)"} opacity={0.75}>
                <title>{`${w.name}${w.kind === "external" ? " (external)" : ""} ${formatDuration(w.startMs)}–${formatDuration(w.endMs)}`}</title>
              </rect>
            ))}
          {pull.busters.map((b, i) => (
            <rect
              key={i}
              x={x(b.atMs) - 2}
              y={LANES.busters}
              width={4}
              height={14}
              fill={b.covered.length ? "var(--good)" : "var(--critical)"}
              opacity={b.tankId === tankId ? 1 : 0.25}
            >
              <title>{`${formatDuration(b.atMs)} ${b.name} ${m(b.amount)} — ${b.covered.length ? b.covered.map((c) => c.name).join(", ") : "nothing up"}`}</title>
            </rect>
          ))}
          {pull.deaths.map((d, i) => (
            <rect key={i} x={x(d.atMs) - 2} y={LANES.deaths} width={4} height={12} fill={d.tankId === tankId ? "var(--text)" : "var(--muted)"}>
              <title>{`${formatDuration(d.atMs)} died${d.ability ? ` to ${d.ability}` : ""}`}</title>
            </rect>
          ))}
        </svg>
        <div style={{ position: "relative", height: 14 }}>
          {ticks.map((t) => (
            <span key={t} className="mono muted" style={{ position: "absolute", left: `${(t / pull.durationMs) * 100}%`, fontSize: 10, transform: "translateX(-50%)" }}>
              {formatDuration(t)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// --- Export to the callout note -------------------------------------------------

function NoteExport({ payload, report, hrefNotes }: { payload: RaidPayload; report: TankReport; hrefNotes: string }) {
  const [fightId, setFightId] = useState(() => defaultPull(report)?.fightId ?? report.pulls[0]?.fightId);
  const [order, setOrder] = useState(true);
  const [taunts, setTaunts] = useState(true);
  const [defensives, setDefensives] = useState(true);
  const [done, setDone] = useState<number | null>(null);

  const lines = tankNoteLines(report, fightId, { order, taunts, defensives });

  function add() {
    const key = storageKey(payload.report.code, payload.encounter.id);
    let stored: StoredDoc | null = null;
    try {
      stored = JSON.parse(localStorage.getItem(key) ?? "null");
    } catch {
      stored = null;
    }
    const next = addToStored(
      stored,
      lines.map((l) => ({ id: l.id, timeSec: l.timeSec, tag: l.tag, text: l.text, enabled: true })),
      "tank:",
    );
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setDone(lines.length);
    } catch {
      setDone(-1);
    }
  }

  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="section-head">
        <h3>Add to the callout note</h3>
        <span className="muted" style={{ fontSize: 12 }}>
          timings from one pull — the kill when there is one
        </span>
      </div>
      <div className="row" style={{ gap: 14, margin: "8px 0", fontSize: 13 }}>
        <label>
          <input type="checkbox" checked={order} onChange={(e) => setOrder(e.target.checked)} style={{ width: "auto", marginRight: 5 }} />
          first / second tank
        </label>
        <label>
          <input type="checkbox" checked={taunts} onChange={(e) => setTaunts(e.target.checked)} style={{ width: "auto", marginRight: 5 }} />
          taunt calls
        </label>
        <label>
          <input type="checkbox" checked={defensives} onChange={(e) => setDefensives(e.target.checked)} style={{ width: "auto", marginRight: 5 }} />
          defensive 2s before each buster
        </label>
        <select value={fightId} onChange={(e) => setFightId(Number(e.target.value))} style={{ width: "auto", padding: "4px 8px", fontSize: 12 }}>
          {report.pulls.map((p) => (
            <option key={p.fightId} value={p.fightId}>
              {p.label} · {formatDuration(p.durationMs)}
            </option>
          ))}
        </select>
      </div>
      <pre className="mono tk-preview">
        {lines.length ? lines.map((l) => `time:${l.timeSec};ph:1;tag:${l.tag};text:${l.text};`).join("\n") : "Nothing selected."}
      </pre>
      <div className="row" style={{ gap: 10, marginTop: 8 }}>
        <button type="button" className="primary" disabled={lines.length === 0} onClick={add}>
          Add {lines.length} line{lines.length === 1 ? "" : "s"} to the note
        </button>
        {done != null &&
          (done >= 0 ? (
            <span style={{ fontSize: 13 }}>
              Added — earlier tank lines were replaced. <Link href={hrefNotes}>Open the callout note →</Link>
            </span>
          ) : (
            <span style={{ fontSize: 13, color: "var(--critical)" }}>The browser blocked saving the note.</span>
          ))}
      </div>
    </div>
  );
}
