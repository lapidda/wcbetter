import assert from "node:assert/strict";
import { buildAbilityRows } from "@/lib/model/abilities";
import type { AggregatedFinding } from "@/lib/model/aggregate";
import type { AbilityStat, PlayerProfile, ReferenceProfile } from "@/lib/model/types";

const stat = (gameID: number, name: string, casts: number, minutes: number, damage: number, gaps: number[] = []): AbilityStat => ({
  gameID,
  name,
  icon: null,
  casts,
  castsPerMinute: casts / minutes,
  damage,
  damagePerCast: casts > 0 ? damage / casts : 0,
  interCastGaps: gaps,
});

const profile = (abilities: Record<number, AbilityStat>, totalDamage: number): PlayerProfile => ({
  key: "p",
  name: "Subject",
  actorId: 20,
  className: "DemonHunter",
  specName: "Devourer",
  reportCode: "x",
  fightId: 1,
  durationMs: 300_000,
  itemLevel: 313,
  burnStartMs: null,
  totalDamage,
  dps: totalDamage / 300,
  activeTimeMs: 290_000,
  activeTimePct: 96.7,
  abilities,
  damageTaken: {},
  buffs: {},
  deaths: [],
  talents: [],
  gaps: [],
  castTimeline: [],
});

// Two pulls: Void Ray at 3 and 5 /min (median 4), a 120s cooldown held 10s then 6s,
// and an unnamed id that must never become a row.
const pulls = [
  profile(
    {
      100: stat(100, "Void Ray", 15, 5, 30_000_000),
      200: stat(200, "Eye Beam", 2, 5, 20_000_000, [130_000]),
      999: stat(999, "", 40, 5, 1_000_000),
    },
    100_000_000,
  ),
  profile(
    {
      100: stat(100, "Void Ray", 25, 5, 50_000_000),
      200: stat(200, "Eye Beam", 3, 5, 30_000_000, [126_000, 121_000]),
    },
    100_000_000,
  ),
];

const reference = {
  medianCpm: { 100: 6.7, 200: 0.6, 300: 4 },
  usageCount: { 100: 4, 200: 4, 300: 4 },
  estimatedCooldownMs: { 200: 120_000 },
  abilityNames: { 100: "Void Ray", 200: "Eye Beam", 300: "Blur" },
} as unknown as ReferenceProfile;

const findings = [
  { id: "cast-frequency:100", medianGainPct: 20 },
  { id: "missed-cooldowns:200", medianGainPct: 4 },
] as AggregatedFinding[];

const rows = buildAbilityRows(pulls, reference, findings, 100_000);
const byId = new Map(rows.map((r) => [r.gameID, r]));

assert.ok(!byId.has(999), "unnamed ids are not rows");
assert.ok(byId.has(300), "an ability only the reference casts still gets a row");

const voidRay = byId.get(100)!;
assert.equal(voidRay.yourCpm, 4, "median of 3 and 5 per minute");
assert.equal(voidRay.yourCasts, 40, "total across pulls");
assert.equal(voidRay.yourDamageShare, 0.4, "median of 30% and 50%");
assert.equal(voidRay.refCpm, 6.7);
assert.equal(voidRay.cooldownMs, null, "filler, not a cooldown");
assert.equal(voidRay.medianHeldMs, null);
assert.equal(voidRay.findingId, "cast-frequency:100");
assert.equal(voidRay.gainDps, 20_000, "20% of 100k");

const eyeBeam = byId.get(200)!;
assert.equal(eyeBeam.cooldownMs, 120_000);
assert.equal(eyeBeam.medianHeldMs, 6000, "gaps of 130s, 126s, 121s past a 120s cooldown: median 6s held");

const blur = byId.get(300)!;
assert.equal(blur.yourCpm, 0);
assert.equal(blur.yourCasts, 0);
assert.equal(blur.refCpm, 4);

assert.deepEqual(
  rows.map((r) => r.gameID),
  [100, 200, 300],
  "flagged rows first by gain, then unflagged by damage share",
);

console.log("buildAbilityRows: ok");
console.log("\nall assertions passed");
