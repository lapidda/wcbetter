import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMechanicProfile,
  describeMechanic,
  emptyProfile,
  wowheadUrl,
  type ProfileInput,
} from "@/lib/model/mechanic-profile";
import { mechanicCasts } from "@/lib/model/encounter";
import type { WclEvent } from "@/lib/wcl/types";

const PLAYERS = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i + 1, {}]));

function cast(atMs: number, targetId: number | null, castMs: number | null = null) {
  return { atMs, gameID: 1, sourceId: 90, telegraphed: castMs != null, targetId, castMs };
}

function hit(amount: number, unmitigated = amount, aoe = true): WclEvent {
  return { timestamp: 0, type: "damage", abilityGameID: 1, targetID: 5, amount, unmitigatedAmount: unmitigated, isAoE: aoe };
}

function input(over: Partial<ProfileInput> = {}): ProfileInput {
  return {
    casts: [cast(1000, 5), cast(2000, 6)],
    hits: [hit(1000), hit(1000)],
    players: PLAYERS,
    hitsPerCast: [1, 1],
    splashPerCast: [],
    ...over,
  };
}

test("a cast bar is measured, and a short one reads as instant", () => {
  const slow = buildMechanicProfile(input({ casts: [cast(0, 5, 2400), cast(9000, 6, 2600)] }));
  assert.equal(slow.castMs, 2500);
  assert.match(describeMechanic(slow), /^2\.5s cast/);

  const twitchy = buildMechanicProfile(input({ casts: [cast(0, 5, 100), cast(9000, 6, 200)] }));
  assert.equal(twitchy.castMs, null, "too short to react to is not a cast bar");
  assert.match(describeMechanic(twitchy), /^instant/);
});

test("a mechanic that names a player is targeted; one that names nobody is not", () => {
  assert.equal(buildMechanicProfile(input()).targeted, true);
  assert.equal(
    buildMechanicProfile(input({ casts: [cast(1000, null), cast(2000, null)] })).targeted,
    false,
  );
});

test("an NPC target does not make a mechanic player-targeted", () => {
  const atBoss = buildMechanicProfile(input({ casts: [cast(1000, 90), cast(2000, 90)] }));
  assert.equal(atBoss.targeted, false, "90 is not in the player index");
});

test("splash is the named target plus somebody else", () => {
  // The signal that separates "you take this" from "you and everyone near you".
  const spread = buildMechanicProfile(
    input({ splashPerCast: [true, true, true, false], hitsPerCast: [4, 4, 4, 1] }),
  );
  assert.equal(spread.splashes, true);
  assert.match(describeMechanic(spread), /aimed at one player, and 3 others nearby take it too/);

  const clean = buildMechanicProfile(input({ splashPerCast: [false, false, false] }));
  assert.equal(clean.splashes, false);
  assert.match(describeMechanic(clean), /aimed at one player, and only they take it/);
});

test("damage is reported unmitigated, because that is the size of the mechanic", () => {
  const profile = buildMechanicProfile(
    input({ hits: [hit(100, 1000), hit(100, 1000), hit(100, 1000)] }),
  );
  assert.equal(profile.medianHit, 1000);
  assert.ok(Math.abs(profile.soakedShare - 0.9) < 1e-9);
  assert.match(describeMechanic(profile), /90% of it absorbed or mitigated away/);
});

test("millions read as millions", () => {
  const big = buildMechanicProfile(input({ hits: [hit(2_163_000), hit(2_163_000)] }));
  assert.match(describeMechanic(big), /2\.2M a hit/);
});

test("several people hit with no AoE flag is described as separate hits", () => {
  const dot = buildMechanicProfile(
    input({ hits: [hit(500, 500, false)], hitsPerCast: [17, 17], casts: [cast(0, null), cast(9000, null)] }),
  );
  assert.match(describeMechanic(dot), /hits 17 separately/);

  const blast = buildMechanicProfile(
    input({ hits: [hit(500, 500, true)], hitsPerCast: [17, 17], casts: [cast(0, null), cast(9000, null)] }),
  );
  assert.match(describeMechanic(blast), /hits 17 at once/);
});

test("a tank-facing mechanic says so, since that changes the call entirely", () => {
  const profile = buildMechanicProfile(input({ hitsPerCast: [1, 1], casts: [cast(0, null), cast(9000, null)] }));
  assert.doesNotMatch(describeMechanic(profile), /tanks/);
  assert.match(describeMechanic(profile, { tankFocus: 6.3 }), /almost always the tanks/);
});

test("the description never tells anyone what to do", () => {
  // Same rule the note text follows: soak, spread and move out are
  // indistinguishable in a damage log, so the description states facts only.
  for (const profile of [
    buildMechanicProfile(input({ splashPerCast: [true, true] })),
    buildMechanicProfile(input({ casts: [cast(0, null, 3000), cast(9000, null, 3000)] })),
    buildMechanicProfile(input({ hitsPerCast: [19, 19] })),
  ]) {
    const text = describeMechanic(profile, { tankFocus: 6 });
    assert.doesNotMatch(text, /\b(soak|spread|dodge|move|stack|avoid|swap)\b/i, text);
  }
});

test("cast events carry their target and cast bar into the model", () => {
  // The two fields the whole profile rests on, read off a real event shape.
  const events: WclEvent[] = [
    { timestamp: 10_000, type: "begincast", sourceID: 90, targetID: 7, abilityGameID: 200 },
    { timestamp: 12_500, type: "cast", sourceID: 90, targetID: 7, abilityGameID: 200 },
  ];
  const [only] = mechanicCasts(events, { startTime: 0, endTime: 300_000 }, {
    200: { gameID: 200, name: "Stone Breaker", icon: null, casters: [], casts: 1 },
  });
  assert.equal(only.telegraphed, true);
  assert.equal(only.castMs, 2500, "begincast to cast is the cast bar");
  assert.equal(only.targetId, 7);
});

test("an empty profile describes nothing rather than inventing something", () => {
  const profile = emptyProfile();
  assert.equal(profile.castMs, null);
  assert.equal(profile.targeted, false);
  assert.equal(profile.medianHit, 0);
  assert.equal(describeMechanic(profile), "instant, no cast bar · hits one player");
});

test("the wowhead link is built from the spell id", () => {
  assert.equal(wowheadUrl(1289201), "https://www.wowhead.com/spell=1289201");
});
