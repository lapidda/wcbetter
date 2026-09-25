import assert from "node:assert/strict";
import {
  buildDictionary,
  describeLead,
  friendlyAbilityIds,
  MAX_MECHANIC_CPM,
  mechanicBefore,
  mechanicCasts,
  precedingBossCast,
  withoutFriendlyAbilities,
} from "@/lib/model/encounter";
import type { BossCast, EnemyAbility } from "@/lib/model/types";
import type { WclEvent } from "@/lib/wcl/types";

const ability = (gameID: number, name: string): EnemyAbility => ({ gameID, name, icon: null, casters: ["Boss"], casts: 1 });

// --- buildDictionary --------------------------------------------------------
// The enemy-side Casts table nests abilities under NPC rows; a second id with
// the same name is a separate entry (the real boss had two Stone Breaker ids).
{
  const dict = buildDictionary({
    entries: [
      {
        name: "Ithraz",
        abilities: [
          { guid: 1, name: "Stone Breaker", total: 18, icon: "ability_smash.jpg" },
          { guid: 2, name: "Stone Breaker", total: 18, icon: "ability_smash.jpg" },
        ],
      },
      { name: "Vexhul", abilities: [{ guid: 3, name: "Caustic Deluge", total: 66 }] },
      { name: "Vexhul", abilities: [{ guid: 3, name: "Caustic Deluge", total: 4 }] },
    ] as never,
  });
  assert.equal(Object.keys(dict).length, 3);
  assert.equal(dict[1].name, "Stone Breaker");
  assert.equal(dict[1].icon, "ability_smash.jpg");
  assert.deepEqual(dict[1].casters, ["Ithraz"]);
  assert.equal(dict[3].casts, 70, "the same id across rows accumulates");
  console.log("buildDictionary: ok");
}

// --- withoutFriendlyAbilities ------------------------------------------------
// Anti-Magic Zone is a Death Knight raid cooldown that the enemy-side log
// attributes to the environment. A friendly having cast it is the tell.
{
  const enemy = {
    1: ability(1, "Stone Breaker"),
    2: ability(2, "Caustic Globule"),
    3: ability(3, "Anti-Magic Zone"),
  };
  const friendly = friendlyAbilityIds({
    entries: [
      { name: "Somedk", abilities: [{ guid: 3, name: "Anti-Magic Zone", total: 7 }, { guid: 50, name: "Obliterate", total: 90 }] },
      { name: "Hotforfel", abilities: [{ guid: 60, name: "Void Ray", total: 40 }] },
    ] as never,
  });
  const { abilities, excluded } = withoutFriendlyAbilities(enemy, friendly);
  assert.deepEqual(Object.keys(abilities).map(Number), [1, 2], "Caustic Globule stays: no friendly cast it");
  assert.deepEqual(excluded, ["Anti-Magic Zone"]);
  console.log("withoutFriendlyAbilities: ok");
}

// The Buffs table is shaped differently (`auras`, flat) and must read the same.
{
  const fromBuffs = friendlyAbilityIds({ auras: [{ guid: 145629, name: "Anti-Magic Zone", totalUptime: 5000 }] } as never);
  assert.ok(fromBuffs.has(145629), "beneficial auras on the raid count as raid abilities");
  console.log("friendlyAbilityIds(auras): ok");
}

// --- mechanicCasts ----------------------------------------------------------
const fight = { startTime: 1000, endTime: 61_000 }; // one minute
const dict: Record<number, EnemyAbility> = {
  1: ability(1, "Eternal Venom"),
  2: ability(2, "Stone Breaker"),
  3: ability(3, "Coiling Ichor"),
  4: ability(4, "Caustic Deluge"),
};
const ev = (timestamp: number, abilityGameID: number, type: "cast" | "begincast" = "cast", sourceID = 7): WclEvent => ({
  timestamp,
  type,
  abilityGameID,
  sourceID,
});

{
  const events: WclEvent[] = [
    // 30 casts in a minute: an auto-attack, whatever it is called.
    ...Array.from({ length: 30 }, (_, i) => ev(1000 + i * 2000, 1)),
    // A cast bar at 10s completing at 12s: one mechanic, telegraphed.
    ev(11_000, 2, "begincast"),
    ev(13_000, 2, "cast"),
    // A plain cast at 40s.
    ev(41_000, 3),
    // Unnamed id: dropped, however rare.
    ev(21_000, 99),
    // 8/min mechanic recurring every 7.5s must NOT collapse into itself.
    ...Array.from({ length: 8 }, (_, i) => ev(1000 + i * 7500, 4)),
  ];

  const casts = mechanicCasts(events, fight, dict);
  const byName = (name: string) => casts.filter((c) => dict[c.gameID].name === name);

  assert.equal(byName("Eternal Venom").length, 0, `30/min is above MAX_MECHANIC_CPM (${MAX_MECHANIC_CPM})`);
  assert.equal(byName("Stone Breaker").length, 1, "begincast + cast collapse to one");
  assert.equal(byName("Stone Breaker")[0].atMs, 10_000, "kept at the cast-bar start");
  assert.equal(byName("Stone Breaker")[0].telegraphed, true);
  assert.equal(byName("Coiling Ichor").length, 1);
  assert.equal(byName("Coiling Ichor")[0].telegraphed, false);
  assert.equal(byName("Caustic Deluge").length, 8, "7.5s apart is eight casts, not one");
  assert.ok(!casts.some((c) => c.gameID === 99), "unnamed ids never reach a rule");
  assert.deepEqual(
    casts.map((c) => c.atMs),
    [...casts.map((c) => c.atMs)].sort((a, b) => a - b),
    "sorted by time",
  );
  console.log("mechanicCasts: ok");
}

// Two ids, one name (a real boss did this): they are one mechanic when close together.
{
  const two: Record<number, EnemyAbility> = { 5: ability(5, "Stone Breaker"), 6: ability(6, "Stone Breaker") };
  const casts = mechanicCasts([ev(11_000, 5, "begincast"), ev(12_500, 6, "cast")], fight, two);
  assert.equal(casts.length, 1, "collapsed by name across ids");
  console.log("cross-id collapse: ok");
}

// --- precedingBossCast / mechanicBefore ---------------------------------------
{
  const casts: BossCast[] = [
    { atMs: 9000, gameID: 2, sourceId: 7, telegraphed: true, targetId: null, castMs: null },
    { atMs: 39_000, gameID: 3, sourceId: 7, telegraphed: false, targetId: null, castMs: null },
  ];

  assert.equal(precedingBossCast(casts, 16_000)?.atMs, 9000, "7s after: counts");
  assert.equal(precedingBossCast(casts, 17_600), null, "8.6s after: too far back to be a reaction");
  assert.equal(precedingBossCast(casts, 8700)?.atMs, 9000, "0.3s before the stamp: pre-empting the cast bar still counts");
  assert.equal(precedingBossCast(casts, 8000), null, "a full second before: not caused by it");
  assert.equal(precedingBossCast(casts, 45_000)?.atMs, 39_000, "the nearest of two, not the first");

  const lead = mechanicBefore(casts, dict, 41_000);
  assert.deepEqual(lead, { name: "Coiling Ichor", gameID: 3, leadMs: 2000 });
  assert.equal(describeLead(lead), "2.0s after Coiling Ichor");
  assert.equal(describeLead(null), "no boss cast in the previous 8s");
  console.log("precedingBossCast: ok");
}

console.log("\nall assertions passed");
