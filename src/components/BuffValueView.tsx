"use client";

import type { BuffValue, BuffValuePayload } from "@/lib/model/buff-value";
import { formatDuration } from "@/lib/model/stats";
import { CLASS_COLOUR } from "./RaidPerformanceView";

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${(n / 1000).toFixed(1)}k`);
const pct = (n: number, digits = 1) => `${(n * 100).toFixed(digits)}%`;

/**
 * What each raid buff and debuff was worth on these pulls, and what a player
 * replacing its only provider would have to do to make up for losing it.
 */
export function BuffValueView({ payload }: { payload: BuffValuePayload }) {
  const dpsPlayers = payload.players.filter((p) => p.dps > 0);
  const nameOf = (id: number) => payload.players.find((p) => p.id === id)?.name ?? `#${id}`;
  const auraName = (id: number) => payload.buffs.find((b) => b.def.auraId === id)?.def.name ?? `#${id}`;
  const debuffs = payload.buffs.filter((b) => b.def.on === "debuff");
  const buffs = payload.buffs.filter((b) => b.def.on === "buff");
  const valued = payload.buffs.filter((b) => b.def.value > 0);
  const multiPull = payload.pulls.length > 1;

  return (
    <div>
      <div className="panel">
        <div className="section-head">
          <h3>
            Raid buff value · {payload.encounter.difficulty} {payload.encounter.name}
          </h3>
          <span className="muted" style={{ fontSize: 12 }}>
            {payload.pulls.length} pull{payload.pulls.length === 1 ? "" : "s"} · {formatDuration(payload.durationMs)} ·{" "}
            {k(payload.raidDps)} raid DPS
          </span>
        </div>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>
          Every damage hit is sorted by its spell school and checked against the auras that were actually up
          when it landed: debuffs on that target, buffs on the player who dealt it. The raid did{" "}
          <b style={{ color: "var(--text)" }}>{pct(payload.physicalShare)}</b> physical,{" "}
          <b style={{ color: "var(--text)" }}>{pct(payload.mixedShare)}</b> mixed-school and{" "}
          <b style={{ color: "var(--text)" }}>{pct(payload.magicShare)}</b> magic damage.
        </p>
      </div>

      {payload.buffs.length === 0 && (
        <div className="panel muted" style={{ marginTop: 14 }}>
          Nobody brought a tracked raid buff on these pulls.
        </div>
      )}

      {payload.soleProviders.length > 0 && (
        <div className="panel" style={{ marginTop: 14 }}>
          <div className="section-head">
            <h3>Swapping a player out</h3>
            <span className="muted" style={{ fontSize: 12 }}>
              only players who are the sole source of something
            </span>
          </div>
          <table className="abilities rp-table">
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Player</th>
                <th style={{ textAlign: "left" }}>Takes with them</th>
                <th>Own DPS</th>
                <th title="what their buffs gave the rest of the raid">+ buffs to others</th>
                <th title="what a replacement without these buffs must do">Swap-in break-even</th>
              </tr>
            </thead>
            <tbody>
              {payload.soleProviders.map((s) => (
                <tr key={s.id}>
                  <td style={{ textAlign: "left" }}>
                    <span style={{ color: CLASS_COLOUR[s.className] ?? "var(--text)", fontWeight: 600 }}>{s.name}</span>
                  </td>
                  <td style={{ textAlign: "left" }}>{s.auraIds.map(auraName).join(", ")}</td>
                  <td className="mono">{k(s.dps)}</td>
                  <td className="mono">{k(s.othersDps)}</td>
                  <td className="mono">
                    <b>{k(s.breakEvenDps)}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            Assumes the swap-in brings none of these buffs. Battle Shout, Arcane Intellect and Mark of the Wild
            are upper-bound estimates, see their cards.
          </div>
        </div>
      )}

      {debuffs.length > 0 && (
        <>
          <h3 style={{ margin: "20px 0 8px" }}>
            On the enemy <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>measured</span>
          </h3>
          <div className="bv-cards">
            {debuffs.map((b) => (
              <BuffCard key={b.def.auraId} buff={b} nameOf={nameOf} multiPull={multiPull} />
            ))}
          </div>
        </>
      )}

      {buffs.length > 0 && (
        <>
          <h3 style={{ margin: "20px 0 8px" }}>
            On players <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>estimated</span>
          </h3>
          <div className="bv-cards">
            {buffs.map((b) => (
              <BuffCard key={b.def.auraId} buff={b} nameOf={nameOf} multiPull={multiPull} />
            ))}
          </div>
        </>
      )}

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="section-head">
          <h3>Per player</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            <span className="bv-key" style={{ background: "#c69b6d" }} />
            physical
            <span className="bv-key" style={{ background: "#bb9af7" }} />
            mixed
            <span className="bv-key" style={{ background: "var(--info)" }} />
            magic
          </span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="abilities rp-table">
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Player</th>
                <th>DPS</th>
                <th style={{ textAlign: "left", minWidth: 140 }}>School split</th>
                <th>Phys</th>
                {valued.map((b) => (
                  <th key={b.def.auraId} title={`DPS this player loses without ${b.def.name}`}>
                    − {b.def.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dpsPlayers.map((p) => (
                <tr key={p.id}>
                  <td style={{ textAlign: "left" }}>
                    <span style={{ color: CLASS_COLOUR[p.className] ?? "var(--text)", fontWeight: 600 }}>{p.name}</span>{" "}
                    <span className="muted" style={{ fontSize: 11 }}>
                      {p.specName ?? p.className}
                    </span>
                  </td>
                  <td className="mono">{k(p.dps)}</td>
                  <td style={{ textAlign: "left" }}>
                    <div className="bv-split" title={`${pct(p.physicalShare)} physical · ${pct(p.mixedShare)} mixed · ${pct(p.magicShare)} magic`}>
                      <div className="phys" style={{ width: pct(p.physicalShare, 3) }} />
                      <div className="mixed" style={{ width: pct(p.mixedShare, 3) }} />
                      <div className="magic" style={{ width: pct(p.magicShare, 3) }} />
                    </div>
                  </td>
                  <td className="mono muted">{pct(p.physicalShare, 0)}</td>
                  {valued.map((b) => {
                    const loss = p.lossDps[b.def.auraId] ?? 0;
                    return (
                      <td key={b.def.auraId} className="mono" style={{ color: loss < 50 ? "var(--muted)" : undefined }}>
                        {loss < 50 ? "—" : k(loss)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          Pets count toward their owner, using the owner&apos;s buffs. Absorbed damage counts, since it still came
          off the enemy. A logged hit already includes the aura, so removing a 5% aura takes 5/105 of it, not 5%.
        </div>
      </div>
    </div>
  );
}

function BuffCard({ buff: b, nameOf, multiPull }: { buff: BuffValue; nameOf: (id: number) => string; multiPull: boolean }) {
  const sole = b.providers.length === 1 ? b.providers[0] : null;
  const unvalued = b.def.value === 0;
  return (
    <div className="panel">
      <div className="section-head">
        <h3>{b.def.name}</h3>
        <span className="muted" style={{ fontSize: 12 }}>
          {b.def.effect}
        </span>
      </div>
      {unvalued ? (
        <div className="muted" style={{ fontSize: 13 }}>
          {b.def.estimate}
        </div>
      ) : (
        <>
          <div className="bv-big">
            {b.def.estimate ? "≤ " : ""}
            {k(b.lossDps)} DPS
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            {pct(b.lossShare, 2)} of raid damage
          </div>
        </>
      )}

      <div className="bv-facts">
        <span>Brought by</span>
        <span>{b.providers.map((p) => nameOf(p.id)).join(", ")}</span>
        <span>Eligible damage</span>
        <span>{pct(b.eligibleShare)} of the raid&apos;s</span>
        <span>Uptime</span>
        <span style={{ color: b.coverage < 0.9 ? "var(--minor)" : undefined }}>{pct(b.coverage)} of eligible damage</span>
        {!unvalued && (
          <>
            <span>To everyone else</span>
            <span>{k(b.lossDpsOthers)} DPS</span>
            <span>Swap-in break-even</span>
            {sole ? (
              <span>
                <b>{k(b.breakEvenDps ?? 0)} DPS</b>{" "}
                <span className="muted">
                  ({nameOf(sole.id)} {k(sole.dps)} + {k(b.lossDpsOthers)})
                </span>
              </span>
            ) : (
              <span className="muted">{b.providers.length} providers: one can go without losing it</span>
            )}
          </>
        )}
      </div>

      {b.def.estimate && !unvalued && (
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          Upper bound: {b.def.estimate}.
        </div>
      )}

      {multiPull && !unvalued && (
        <div className="muted mono" style={{ fontSize: 11, marginTop: 10 }}>
          per pull:{" "}
          {b.pulls.map((p) => (
            <span key={p.fightId} style={{ marginRight: 8, color: p.coverage < 0.9 ? "var(--minor)" : undefined }}>
              {pct(p.lossShare, 1)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
