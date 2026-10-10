"use client";

import { useEffect, useState } from "react";
import type { RaidZone } from "@/lib/tank-lookup";
import { wclUrl } from "@/lib/wcl/links";
import { TanksView } from "./TanksView";
import { useWorkspace } from "./Workspace";

const k = (n: number) => `${(n / 1000).toFixed(0)}k`;

// Mirrors TANK_CHOICES in lib/tank-lookup.ts; kept here so the page does not
// import the server module.
const SPECS = [
  { className: "DeathKnight", specName: "Blood", label: "Blood Death Knight" },
  { className: "DemonHunter", specName: "Vengeance", label: "Vengeance Demon Hunter" },
  { className: "Druid", specName: "Guardian", label: "Guardian Druid" },
  { className: "Monk", specName: "Brewmaster", label: "Brewmaster Monk" },
  { className: "Paladin", specName: "Protection", label: "Protection Paladin" },
  { className: "Warrior", specName: "Protection", label: "Protection Warrior" },
];

/**
 * A top tank's log for any spec, boss and difficulty — no report of your own
 * needed. Shown in the same view as your own tanks, opened on the ranked player.
 */
export function TankLookupPanel() {
  const { tankLookup, lookupTank } = useWorkspace();
  const [zones, setZones] = useState<RaidZone[] | null>(null);
  const [zonesError, setZonesError] = useState<string | null>(null);
  const [spec, setSpec] = useState(() => tankLookup.args ? SPECS.findIndex((s) => s.className === tankLookup.args!.className && s.specName === tankLookup.args!.specName) : 4);
  const [zoneId, setZoneId] = useState<number | null>(null);
  const [encounterID, setEncounterID] = useState<number | null>(tankLookup.args?.encounterID ?? null);
  const [difficulty, setDifficulty] = useState<number>(tankLookup.args?.difficulty ?? 5);

  useEffect(() => {
    fetch("/api/zones")
      .then((r) => r.json())
      .then((j) => {
        if (j.error) throw new Error(j.error);
        const list = j.zones as RaidZone[];
        setZones(list);
        const current = list.find((z) => z.encounters.some((e) => e.id === encounterID)) ?? list[0];
        if (current) {
          setZoneId(current.id);
          setEncounterID((id) => id ?? current.encounters[0]?.id ?? null);
        }
      })
      .catch((e) => setZonesError((e as Error).message));
    // Once, on mount: the zone list does not change while the page is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const zone = zones?.find((z) => z.id === zoneId) ?? null;
  const result = tankLookup.result;
  const chosen = result?.top[result.pick];

  function run(pick = 0) {
    if (encounterID == null) return;
    const s = SPECS[spec];
    lookupTank({ encounterID, difficulty, className: s.className, specName: s.specName, pick });
  }

  return (
    <div>
      <div className="panel">
        <div className="row" style={{ gap: 12, alignItems: "flex-end" }}>
          <label style={{ minWidth: 200 }}>
            <div className="muted" style={{ fontSize: 11, marginBottom: 3 }}>
              TANK SPEC
            </div>
            <select value={spec} onChange={(e) => setSpec(Number(e.target.value))} style={{ padding: "6px 9px", fontSize: 13 }}>
              {SPECS.map((s, i) => (
                <option key={s.label} value={i}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ minWidth: 200 }}>
            <div className="muted" style={{ fontSize: 11, marginBottom: 3 }}>
              RAID
            </div>
            <select
              value={zoneId ?? ""}
              disabled={!zones}
              onChange={(e) => {
                const z = zones?.find((x) => x.id === Number(e.target.value));
                setZoneId(z?.id ?? null);
                setEncounterID(z?.encounters[0]?.id ?? null);
              }}
              style={{ padding: "6px 9px", fontSize: 13 }}
            >
              {!zones && <option>Loading…</option>}
              {zones?.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name} ({z.expansion})
                </option>
              ))}
            </select>
          </label>
          <label style={{ minWidth: 200 }}>
            <div className="muted" style={{ fontSize: 11, marginBottom: 3 }}>
              BOSS
            </div>
            <select value={encounterID ?? ""} disabled={!zone} onChange={(e) => setEncounterID(Number(e.target.value))} style={{ padding: "6px 9px", fontSize: 13 }}>
              {zone?.encounters.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ minWidth: 120 }}>
            <div className="muted" style={{ fontSize: 11, marginBottom: 3 }}>
              DIFFICULTY
            </div>
            <select value={difficulty} onChange={(e) => setDifficulty(Number(e.target.value))} style={{ padding: "6px 9px", fontSize: 13 }}>
              {(zone?.difficulties ?? [{ id: 5, name: "Mythic" }, { id: 4, name: "Heroic" }])
                .filter((d) => d.id >= 3)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
            </select>
          </label>
          <button type="button" className="primary" disabled={encounterID == null || tankLookup.busy} onClick={() => run(0)}>
            {tankLookup.busy ? "Loading…" : "Show the top tank"}
          </button>
        </div>
        {zonesError && <div style={{ color: "var(--critical)", fontSize: 12, marginTop: 8 }}>{zonesError}</div>}
        {tankLookup.busy && tankLookup.progress.length > 0 && (
          <div className="mono muted" style={{ fontSize: 11, marginTop: 8 }}>
            {tankLookup.progress[tankLookup.progress.length - 1]}
          </div>
        )}
        {tankLookup.error && <div style={{ color: "var(--critical)", fontSize: 13, marginTop: 8 }}>{tankLookup.error}</div>}

        {result && chosen && !tankLookup.busy && (
          <div className="row" style={{ gap: 12, marginTop: 12, fontSize: 13 }}>
            <span>
              Showing <b>#{chosen.rank} {chosen.name}</b>
              {chosen.server ? ` (${chosen.server})` : ""} — {k(chosen.amount)} DPS ·{" "}
              <a href={wclUrl(chosen.reportCode, chosen.fightId, { source: result.tankId ?? undefined })} target="_blank" rel="noreferrer">
                open the log ↗
              </a>
            </span>
            <label className="muted" style={{ fontSize: 12 }}>
              another of the top {result.top.length}:{" "}
              <select
                value={result.pick}
                onChange={(e) => run(Number(e.target.value))}
                style={{ width: "auto", display: "inline-block", padding: "3px 6px", fontSize: 12 }}
              >
                {result.top.map((t, i) => (
                  <option key={t.reportCode + t.name} value={i}>
                    #{t.rank} {t.name} · {k(t.amount)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>

      {result && !tankLookup.busy && (
        <div style={{ marginTop: 14 }}>
          {/* Keyed on the log so switching parse reopens on the new ranked tank. */}
          <TanksView key={`${chosen?.reportCode}:${chosen?.fightId}`} payload={result.payload} hrefNotes="/notes" initialTankId={result.tankId} exportable={false} />
        </div>
      )}
    </div>
  );
}
