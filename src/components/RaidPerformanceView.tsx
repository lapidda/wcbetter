"use client";

import type { DutyKind, PlayerPerformance, Role } from "@/lib/model/performance";
import type { RaidPayload } from "@/lib/model/raid-payload";

const k = (n: number) => `${(n / 1000).toFixed(0)}k`;

/** The game's class colours, for reading the table at a glance. Display only. */
export const CLASS_COLOUR: Record<string, string> = {
  DeathKnight: "#C41E3A",
  DemonHunter: "#A330C9",
  Druid: "#FF7C0A",
  Evoker: "#33937F",
  Hunter: "#AAD372",
  Mage: "#3FC7EB",
  Monk: "#00FF98",
  Paladin: "#F48CBA",
  Priest: "#FFFFFF",
  Rogue: "#FFF468",
  Shaman: "#0070DD",
  Warlock: "#8788EE",
  Warrior: "#C69B6D",
};

const KIND_LABEL: Record<DutyKind, string> = {
  assigned: "assigned",
  targeted: "targeted",
  tank: "tank",
  avoidable: "avoidable",
  "raid-wide": "raid-wide",
};

const ROLE_TITLE: Record<Role, string> = { dps: "Damage", tank: "Tanks", healer: "Healers" };

/**
 * Damage done next to the mechanics each player carried — the overview a
 * damage meter cannot give: was someone low because the boss kept picking them?
 */
export function RaidPerformanceView({ payload }: { payload: RaidPayload }) {
  const perf = payload.performance;
  if (!perf || perf.players.length === 0) {
    return <div className="panel muted">No player data for these pulls.</div>;
  }

  const byRole = (role: Role) => perf.players.filter((p) => p.role === role);
  const maxDps = Math.max(1, ...byRole("dps").map((p) => p.dps), ...byRole("tank").map((p) => p.dps));
  const maxHps = Math.max(1, ...byRole("healer").map((p) => p.hps));
  const maxDuty = Math.max(1, ...perf.players.map((p) => p.dutySecondsPerPull));
  const nameOf = (id: number) => payload.roster.actors[id]?.name ?? `#${id}`;
  const shown = perf.duties.filter((d) => d.kind !== "raid-wide");

  return (
    <div>
      <div className="panel">
        <div className="section-head">
          <h3>
            Raid performance · {payload.encounter.difficulty} {payload.encounter.name}
          </h3>
          <span className="muted" style={{ fontSize: 12 }}>
            {payload.pulls.length} pull{payload.pulls.length === 1 ? "" : "s"} · median per pull
          </span>
        </div>
        <p className="muted" style={{ margin: "6px 0 12px", fontSize: 13 }}>
          Damage done next to the boss mechanics each player carried. A chip is a mechanic someone had
          more of than the rest of the raid: <span className="rp-chip assigned">assigned</span> they were
          one of its few carriers, <span className="rp-chip targeted">targeted</span> the boss picked them
          clearly more often than most. <b style={{ color: "var(--text)" }}>Under mechanics</b> is the time
          spent with a boss debuff that needed handling.
        </p>

        <div style={{ overflowX: "auto" }}>
          <table className="abilities rp-table">
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Player</th>
                <th style={{ textAlign: "left", minWidth: 180 }}>Output</th>
                <th title="share of the pull spent casting">Active</th>
                <th style={{ textAlign: "left" }}>Mechanics carried (per pull)</th>
                <th title="seconds per pull under an assigned or targeted debuff">Under mechanics</th>
                <th>Deaths</th>
                <th title="hits per pull from mechanics most of the raid dodged">Avoidable</th>
                <th style={{ textAlign: "left" }}>Reading</th>
              </tr>
            </thead>
            <tbody>
              {(["dps", "tank", "healer"] as const).map((role) =>
                byRole(role).length === 0 ? null : (
                  <RoleGroup
                    key={role}
                    role={role}
                    players={byRole(role)}
                    max={role === "healer" ? maxHps : maxDps}
                    maxDuty={maxDuty}
                    pulls={payload.pulls.length}
                  />
                ),
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="section-head">
          <h3>Mechanics on players</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            classified by who gets them — no boss is hardcoded
          </span>
        </div>
        <table className="abilities rp-duties">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Mechanic</th>
              <th style={{ textAlign: "left" }}>Kind</th>
              <th>Applied</th>
              <th>Players</th>
              <th style={{ textAlign: "left" }}>Most often on</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((d) => (
              <tr key={d.name}>
                <td style={{ textAlign: "left" }}>{d.name}</td>
                <td style={{ textAlign: "left" }}>
                  <span className={`rp-chip ${d.kind}`}>{KIND_LABEL[d.kind]}</span>
                </td>
                <td className="mono">{d.applications}</td>
                <td className="mono">{d.players}</td>
                <td style={{ textAlign: "left", whiteSpace: "normal" }} className="muted">
                  {d.top
                    .slice(0, 4)
                    .map((t) => `${nameOf(t.id)} ${t.count}`)
                    .join(", ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {perf.duties.some((d) => d.kind === "raid-wide") && (
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            Left out as raid-wide (everyone gets it at once):{" "}
            {perf.duties
              .filter((d) => d.kind === "raid-wide")
              .map((d) => d.name)
              .join(", ")}
            .
          </div>
        )}
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          A targeted debuff can also come from standing in something; the log cannot tell a debuff you
          were given from one you walked into, unless the raid notes found it avoidable.
        </div>
      </div>
    </div>
  );
}

function RoleGroup({
  role,
  players,
  max,
  maxDuty,
  pulls,
}: {
  role: Role;
  players: PlayerPerformance[];
  max: number;
  maxDuty: number;
  pulls: number;
}) {
  return (
    <>
      <tr className="rp-group">
        <td colSpan={8}>
          {ROLE_TITLE[role]} <span className="muted">({players.length})</span>
        </td>
      </tr>
      {players.map((p) => {
        const value = role === "healer" ? p.hps : p.dps;
        return (
          <tr key={p.id}>
            <td style={{ textAlign: "left" }}>
              <span style={{ color: CLASS_COLOUR[p.className] ?? "var(--text)", fontWeight: 600 }}>{p.name}</span>{" "}
              <span className="muted" style={{ fontSize: 11 }}>
                {p.spec ?? p.className}
                {p.pulls < pulls ? ` · ${p.pulls}/${pulls} pulls` : ""}
              </span>
            </td>
            <td style={{ textAlign: "left" }}>
              <div className="rp-bar">
                <div style={{ width: `${(value / max) * 100}%`, background: CLASS_COLOUR[p.className] ?? "var(--accent)" }} />
                <span className="mono">
                  {k(value)} {role === "healer" ? "HPS" : "DPS"}
                </span>
              </div>
            </td>
            <td className="mono muted">{p.activePct.toFixed(0)}%</td>
            <td style={{ textAlign: "left", whiteSpace: "normal" }}>
              {p.duties.length === 0 ? (
                <span className="muted">—</span>
              ) : (
                p.duties.map((d) => (
                  <span
                    key={d.name}
                    className={`rp-chip ${d.kind}`}
                    title={
                      d.kind === "assigned"
                        ? `${Math.round(d.share * 100)}% of all ${d.name}`
                        : d.vsMedian != null
                          ? `${d.vsMedian.toFixed(1)}× the raid's median`
                          : undefined
                    }
                  >
                    {d.name} {d.perPull.toFixed(1)}
                  </span>
                ))
              )}
            </td>
            <td>
              <div className="rp-duty">
                <div style={{ width: `${(p.dutySecondsPerPull / maxDuty) * 100}%` }} />
                <span className="mono">{p.dutySecondsPerPull.toFixed(0)}s</span>
              </div>
            </td>
            <td className="mono" style={{ color: p.deaths > 0 ? "var(--critical)" : "var(--muted)" }}>
              {p.deaths}
            </td>
            <td className="mono" style={{ color: p.avoidableHitsPerPull >= 3 ? "var(--minor)" : "var(--muted)" }}>
              {p.avoidableHitsPerPull.toFixed(1)}
            </td>
            <td style={{ textAlign: "left", whiteSpace: "normal" }}>
              {p.read && <span className={`rp-read ${p.read.tone}`}>{p.read.text}</span>}
            </td>
          </tr>
        );
      })}
    </>
  );
}
