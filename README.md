# wcbetter

Turns a WarcraftLogs report into a prioritised improvement plan for one DPS player on one boss,
across every pull of that boss in the log.

Two premises:

1. **Don't hardcode rotations.** Every baseline is measured from the top parses for that exact boss,
   difficulty and spec, so the tool works for any class without a per-spec APL to maintain, and it
   re-calibrates itself every patch on its own.
2. **Consistency is the signal.** A mistake on 6 of 7 pulls is a habit worth drilling. The same
   mistake on 1 of 7 is a bad pull. Findings are ranked by impact *discounted by how often they
   actually happen*, so a smaller mistake you make every pull outranks a larger one you made once.

## Using it

Everything is driven from the sidebar on the left, which stays put while results scroll: the report
link, the player, the boss list and every pull of the selected boss. Paste a WarcraftLogs URL straight
from the address bar. If it carries `fight=` and `source=` — which every link from a log page does —
the boss and the player fill themselves in, every pull of that boss is ticked (short accidental pulls
excluded, with a reason), and you press one button. `▸` next to a pull analyses just that pull, so
trying a different pull never means going back to a form.

The sidebar switches between the views — **Player analysis**, **Windwalker** ([Windwalker](#windwalker),
a Monk-specific lens on the same run) and **Raid notes** ([Raid notes](#raid-notes)) — and they share
the loaded report, the selection and each other's finished results, so flipping between them
re-fetches nothing. Once the player analysis has run, each pull in
the list shows its DPS.

Clicking Analyse rewrites the address bar into a shareable link
(`/?report=…&source=…&fight=…&pulls=…`, or `/notes?…` for the raid notes). Opening that link replays
the whole analysis with no clicks, which is what makes this usable between a player and a raid lead.
The browser also remembers your last log and character, so a weekly user does not re-pick themselves.

The player picker is sorted by damage on a sample fight and shows each spec, so the DPS this tool is
built for come first and the healers sink — without a hardcoded list of which specs are which.

From the command line, both analyses print what the UI shows plus what it cost:

```bash
npm run analyze -- "<report url>" [character]            # one DPS player
npm run raid    -- "<report url>" --note --as <caller>   # the callout sheet
npm run raid    -- "<report url>" --for <player>         # one player's private note
```

`--names` adds the repeat offenders to each call, `--matrix` prints the per-occurrence breakdown, and
`--json` dumps the whole report.

## Setup

```bash
npm install
cp .env.example .env.local
```

Create a WarcraftLogs v2 API client at <https://www.warcraftlogs.com/api/clients/> and put the id and
secret in `.env.local`. The redirect URL is unused — this uses the client-credentials flow — so any
value works there.

`ANTHROPIC_API_KEY` is optional. Without it everything works except the "Write coach summary" button.

```bash
npm run dev
```

Paste a report in the sidebar, pick a player and a boss, and every pull of that boss is selected by
default.

## How it works

```
src/lib/wcl/       OAuth, GraphQL client, disk cache
src/lib/model/     raw JSON -> typed profiles; reference profile from rankings; cross-pull aggregation;
                   cast-timeline lanes for the comparison view
src/lib/rules/     one analyzer per file, each emits Findings for a single pull
src/lib/analyze.ts orchestration
src/app/api/       report metadata, SSE-streamed analysis, coach narrative
src/components/    Workspace (shared state for both views, in the root layout), Sidebar, the report views
```

Rules stay **single-fight**. Multi-pull support is an aggregation layer
([aggregate.ts](src/lib/model/aggregate.ts)) that merges findings by id across pulls — so no rule had
to learn about aggregation, consistency data comes out for free, and each finding keeps a per-pull
breakdown. The representative detail text shown for a finding comes from the pull whose impact was
closest to the median, so it always describes something that actually happened rather than a
synthesised average.

Raw WCL responses are cached forever under `.cache/`. Uploaded logs are immutable, so a cache hit is
always valid — and it means iterating on the analyzers costs zero API points. Delete the directory to
force a refetch.

The cache key includes a hash of the GraphQL document, not just the variables. Without that, adding a
field to a query keeps serving responses fetched by the old one and the new field reads as absent
forever — which is exactly what happened when `includeCombatantInfo` was introduced.

### Query cost

Measured, not estimated — twelve Heroic pulls against four reference parses, cold cache:

```
upstream requests:  149          API points:  ~150-200 of 3600/hour
  table          99              wall clock:  20-40s
  events         28              ~18-24 cold runs per hour
  graph          16
  meta            4              re-run, warm: 0 requests, 0.3s
  combatantinfo   1
  rankings        1
```

Eight queries per profiled player-fight — six tables, the cast-event stream, and the damage graph the
burn window is derived from — times sixteen profiles (twelve pulls plus four reference parses). Then
the boss-ability context: one enemy cast-event stream per pull plus three fight-spanning tables
(enemy casts, friendly casts, friendly buffs). The request count is exact; the point cost is a range
because WarcraftLogs prices by query complexity and the same request set has measured 25% apart on
two runs. Call it 4-6% of the hourly budget for a full raid night.

Re-running the same analysis costs nothing at all — 0 requests, 0.3s — which is what makes iterating
on the analyzers practical.

`npm run cache:stats` prints what is currently stored, by kind and size.

Two things keep it there:

- **Talents are fetched once, not per profile.** Reference parses get theirs inline with the rankings
  query; the subject's are read from the first pull and reused. That removed 15 of the original 133
  requests.
- **Requests are capped at four in flight rather than serialised.** The binding constraint is the
  burst limiter, not the hourly budget, and each profile issues seven independent table queries — so
  a small pool cut wall clock by roughly 5x without changing the request or point cost.

One optimisation was tried and rejected: the fight-wide damage table has a nested `abilities` array
that looks like it could replace the per-source query. It cannot — it holds only 5 of 15 rows and 47M
of 98M damage, silently dropping pet summons and several abilities the rules reason about.

## Tests

```bash
npm test
```

Covers the pure logic that has no WarcraftLogs dependency: gap detection, the rule layer against a
synthetic reference set (including the guard that stops talent differences being reported as
mistakes), and cross-pull aggregation — the median-representative pick, the priority formula, the
short-pull denominator exclusion, and the three-pull floor below which no pattern is claimed.

The raid-note half is covered the same way: mechanic classification, wave clustering (including the
varying-burst-size case that broke per-pull ordinals), the NSRT grammar round-tripped byte for byte
against a real 378-line export, and the editor's reducer. Several of those tests exist because the
behaviour was wrong the first time and only running it against a real log or a real browser showed
it — each one names the case in its comment.

There is no test-runner dependency. Node strips the types itself; `test/ts-resolve.mjs` is a small
resolver hook that teaches it the extensionless imports and the `@/` alias the bundler normally
handles.

The API layer itself is not covered by tests, but the whole pipeline has been run end-to-end against
a live Mythic report — see the note on table shapes at the bottom, which is what that run taught us.

## Build matching (hero talents)

Hero talent trees change which buttons a spec presses. A Rider of the Apocalypse Death Knight and a
Deathbringer one share a spec name and very little else, so comparing across them manufactures
findings that are build differences rather than mistakes.

`characterRankings(includeCombatantInfo: true)` returns every ranked player's full talent selection
inline — all 100 rows, one query, no extra cost. The player's own selection comes from the
`CombatantInfo` events. The ids match, so the two are directly comparable.

Selection then works in two stages: score every candidate by talent overlap with the player, keep
everything within a small band of the best match, and take the highest-*ranked* parses from that
band. Picking purely by similarity would return rank-90 parses that happen to share a build; this
returns the best players *who play the build being analysed*.

No hero tree is ever named, and there is no spell database. Hero trees are disjoint sets of about a
dozen nodes out of ~76, so a plain set overlap separates them on its own — measured at 0.95 within a
tree versus 0.73 across, in `test/aggregate.test.ts`.

Logs without combatant info fall back to rank order, and the report says so rather than implying a
match it couldn't make. The match percentage is shown in the UI, with a warning below 75%.

## The analyzers

| Rule | What it catches |
|---|---|
| `missed-cooldowns` | Long-cooldown abilities cast fewer times than the fight length allowed. Cooldowns are estimated empirically from the shortest gaps observed across the reference set, so no spell database is needed. On-use trinkets and stat buffs deal no direct damage, so their value can't be measured — they rank on severity with the gain left blank rather than reported as zero. |
| `opener` | Your first 12 rotational casts: how late you start, and which abilities the top parses always open with that you don't. Trinkets, potions and racials don't count toward the 12 and never produce a finding (see [The opener](#the-opener)). The opener is the most comparable part of any pull — it's scripted, everyone starts with full resources and every cooldown up — so a difference is a real sequencing mistake rather than a reaction to a mechanic, which makes it the most practisable thing in the report. |
| `cast-frequency` | Abilities the top parses press far more often than you, and abilities they all press that you never cast. Catches priority-order mistakes without knowing the spec. |
| `active-time` | Uptime vs the reference median, plus the timestamped list of every gap over 3s — each labelled with the boss cast that preceded it (`2.3s after Corrosive Spit`) or, explicitly, `no boss cast in the previous 8s`. |
| `recurring-downtime` | **Multi-pull only.** Downtime landing in the same 15s window of the fight, pull after pull, named after the boss cast most affected pulls share (`…on 8 of 12 pulls, right after Corrosive Spit`). Checked against the top parses in the *same window*: if they stop there too, the mechanic is stopping everyone, so it is labelled **forced downtime**, capped at `minor`, and costed only on the difference — `They lose 3.9s here and you lose 11.0s; only the 7.1s difference is worth chasing`. |
| `burn` | The opener's mirror: everything after the boss drops below 20% health — where the game's execute abilities switch on, so it is genuinely a different rotation rather than just the end of the fight. Boss health is reconstructed from the raid's damage graph scaled by the health the pull actually removed, so it needs no boss hit points — and pulls that never got there are skipped entirely rather than guessed at. Compares casts/min in the window (rates, not counts, so a faster kill is not punished) and shows the burn sequence side by side. |
| `avoidable-damage` | Damage from abilities the top parses were rarely or never hit by. Avoidability is decided statistically rather than from a curated per-boss list, so it doesn't rot each tier. |
| `deaths` | One finding per pull with the causes broken out, the damage that led in, and what the time dead cost: the player's own alive-rate applied to the seconds they were actually dead — measured to the battle rez when there was one, detected from the first cast afterwards. |
| `consumables` | Flasks, food, runes and oils the reference set keeps up and you don't. |

Adding an analyzer is one file in `src/lib/rules/` plus one line in `src/lib/rules/index.ts`.
Aggregation across pulls then applies to it automatically.

## Estimated gains

Findings carry an estimated throughput gain used to rank them. For cast-based findings that is
`missed casts × your own average damage per cast`; for downtime it is the share of the fight spent
not casting. Rules that don't produce a throughput number (avoidable damage, deaths) fall back to a
severity weight for ranking purposes only.

**Gains are scaled to your own output.** When you never cast an ability at all, the only figure
available is the reference median damage per cast — and that comes from players on far better gear.
Used raw it tells a Heroic progression player a missed cast is worth 37% of their total damage. It is
therefore multiplied by your share of the reference's DPS (never above 1). See `valuePerCast` in
`src/lib/rules/types.ts`.

**Deaths are costed from time actually dead.** The naive number — the fraction of the pull after the
death — reads as "+71% DPS available" and is untrue, because a battle rez usually follows. So the
clock stops at the rez, detected from the first cast after the death, and the rate applied is the
player's own damage over the time they were *alive*. That answers a question the log can settle:
what would those seconds have been worth at the rate you were already going? A death still never
grades below `major` regardless of the number, because it is a wipe risk as well as a DPS loss.

The ranking score is `impact × (0.4 + 0.6 × consistency)` — a one-off keeps 40% of its weight,
because it might repeat, while an every-pull habit keeps all of it.

Gains overlap heavily — a missed cooldown is usually also part of a downtime gap — so nothing in the
report sums them. Treat every figure as a ranking, not a promise.

## Reading the report

The page answers "what do I fix first" before it shows anything else:

- **Fix these first** — at most three findings, chosen one *family* at a time (opener, downtime,
  rotation, survival, preparation). Uptime, the gap list and recurring downtime all measure the same
  seconds, so only one of them can lead. Each item shows its gain in absolute DPS at your median
  (`≈ +17.6k DPS (+20.2%)`), with the advice before the evidence. The header tile is the diminishing
  sum of those three and says what share of the gap to the reference they would close.
- **Your opener vs the top parses** — always visible, lined up like a diff (see [The
  opener](#the-opener)). It is the most practisable thing in the report, so it is never hidden
  behind a disclosure.
- **Sections by family**, each carrying its own budget (`Downtime · 5 findings · up to +13.5%`), all
  cards collapsed, six shown before a `Show N more`.
- **One-offs** — anything that fired on a single pull of several, folded away. A bad pull is not a
  habit.
- **Analysis warnings** — a rule that threw is reported as a bug, never as coaching.

Above the findings sits a **per-pull timeline**: one row per pull on a shared time axis, so the same
second lines up vertically across the night and recurring downtime shows as a band. Casts are
density, gaps are red and clickable, deaths are marked, and the boss's mechanic casts run in a lane
above each bar — so a gap can be read against what caused it. The **Rotation** section is a table
rather than a card per ability, with your casts/min against the reference, the **time held** past
cooldown (the number that says where a missing cast actually went), and your damage share. It shows
what you cast *too much* as well as too little, which is the other half of "what am I casting
instead". Every timestamp deep-links into the WarcraftLogs replay at that moment with you selected;
every ability links to Wowhead.

### The opener

The opener is the first **12 rotational casts**, a count rather than a time window: a window
punishes nothing but haste, because a player on worse gear fits fewer casts into 60s and "misses" the
tail of an opener they played correctly.

**Trinkets, potions and racials are shown but not counted.** Whether a top parse owns an on-use
trinket or plays a Troll says nothing about the player's sequencing, and counting them would shift
every later cast by a slot. They are listed where they happened, tagged, and never become a finding.
Trinkets and potions are recognised by icon — every measured trinket used an icon with `trinket` in
its file name, every potion one with `potion`, and other on-use items an alchemy or flask icon;
effect names alone ("Nullsight") would miss them. Racials come from a short list of names, the one
hardcoded piece here: the log marks nothing as racial, and icons cannot be trusted for it — Bear
Form's is `ability_racial_bearform`.

The panel compares one of your pulls (your best kill by default) with **one top parse you pick**.
The two sequences are aligned like a diff: casts you both make in the same order share a row, and the
rest is coloured — **out of order** (in both, at a different point), **missing** (they press it, you
do not) and **extra** (you press it, they never do). A plain position-by-position comparison would
mark every cast after the first difference as wrong. Openers repeat buttons, so several alignments
often tie; among those it prefers the one pairing casts at neighbouring positions, which is the one
a reader would draw. One press logged under two ids at the same instant (measured on Voidblade) is
counted once.

### Cast timeline

The second tab of the player analysis is the whole fight laid out cast by cast: one row per ability,
and inside each row one lane for you and one for each top parse you toggle on. The opener and burn
panels compare the scripted windows; this is for everything in between — which cooldowns drift later
every minute, which filler they press while moving, where their casts bunch up and yours thin out.

- **Cooldowns come first**, drawn with a faint bar for the time each press kept it unavailable. The
  empty stretch after a bar is time it sat ready and unused — "time held", read off the picture.
- **Fight time or % of fight.** Top parses are usually faster kills, so seconds line up the opener and
  percentages line up the phases. Zoom goes to 16× and keeps the centre of the view where it was;
  drag the chart to pan.
- **Rows can be hidden** (the × on a row's label) to condense the view — utility buttons like Roll or
  Dash. Hidden rows are remembered per spec in the browser and listed under the chart to restore.
- **Labels carry casts/min per lane** and are edged red where you cast it far less than the top
  parses (or never) and amber where you cast it far more — the same ±25% the rotation table uses.
- It opens on your best kill, or your longest pull on a night without one, against the top-ranked
  parse. Your pull's boss casts run across the top, and the burn phase and deaths are marked per lane.

It costs no extra queries: every profile, yours and the reference's, is already built from its full
cast event stream for the rules. Only buttons that appear in someone's Casts table become rows — the
event stream also carries auto attacks and channel ticks — and ids that share a name are one row, so a
talent-modified version of a spell does not read as a second button.

Item level is shown for you and the reference (`ilvl 313`, `they average 3 ilvl higher`) so the raw
DPS delta is read in context — the per-finding gains are already scaled to your own output.

Titles describe the group of pulls, not one of them: `Died on 12 of 12 pulls — Ravenous Feast (5),
Stone Breaker (2)` rather than one pull's `Died at 1:37` next to an every-pull badge. Each rule leaves
structured `facts` behind for this; the metric block and detail text still come from the pull whose
impact was closest to the median, and the evidence says which.

Advice is measured, not opined. Missed cooldowns say where the cast went — a late first press, or a
median delay after it came off cooldown — and a cooldown pressed promptly every time on a pull that
simply ended early is graded `info`, not a mistake. Whether to hold a cooldown for a window is a
rotational opinion this project does not hardcode. Deaths read the damage rewind themselves ("one hit
did it" vs "you were already low"). The "check your talents" hedge only appears when build matching
could not vouch for the reference set.

## Talent builds

The **Talents** tab (also shown in the Windwalker view) answers two questions for the analysed boss and
difficulty: which hero tree do the top players pick, and what exactly do they run — as in-game strings
to copy. It is built from the rankings page the reference set was already chosen from (top 100,
talents inline), so it costs no extra queries.

- **Hero tree split**: share of the top 100, best rank and top-5 median per tree. On Sszorak this is
  where Shado-Pan shows up as the near-equal it is there (42-68% of the top 100), while it is 0-3% on
  every other Venomous Abyss boss.
- **Most used** build per tree — the exact build the most top players share, with who runs it and how
  many more are within two talents — and the **best player's** build when it differs.
- **Your build** as a string, and every node where it differs from the most used build of your tree.

WarcraftLogs gives talents as entry ids with points, never as a string, so the string is written here
(`src/lib/talents/loadout.ts`): the game's export format — version, spec, a zero tree hash, then a few
bits per node in a fixed node order — over the tree layout from Raidbots' public talent data
(`talent-data.ts`, cached per week since it changes with every patch). It is verified by round-tripping
nine strings exported from the game byte for byte, each decoding to exactly the 34/34/13 point budget
(`test/loadout.test.ts`), and Wowhead opens the generated strings as the right spec and hero tree. One
trap worth knowing: an apex node such as Tigereye Brew is *tiered* — one node whose ranks the log lists
across several entries — and its rank is their sum, not the last entry's.

## Windwalker

`/monk` is a third view on the same player analysis — no extra queries — for Windwalker Monks. It is
the one place the project knows a spec: which button is the burst, which presses break Combo Strikes,
what a Conduit burst window has to contain. It still hardcodes no *numbers*: every target it shows is
what the build-matched top parses did on the same boss, measured the same way, and its thresholds are
what 15 Conduit top parses (67 Xuen windows across Heroic Ula'tek and Mythic Nek'zali and Entombed
Sentinels, patch 12.1) were measured to keep. The code is `src/lib/spec/windwalker.ts`.

- **Hero tree from the log**: Celestial Conduit or Xuen casts mean Conduit of the Celestials, Flurry
  Strikes damage means Shado-Pan. When the top parses play the other tree — likely for Shado-Pan, which
  was 2-4% of the measured rankings — the page says so.
- **A scorecard** of the checks, each with your value, the top parses', and what to change.
- **Every burst window** (Conduit): Zenith and items with Xuen, two Fists of Fury and one Whirling
  Dragon Punch before Conduit, no Tiger Palm in the first 12s, Conduit 8-16s after Xuen and at least
  5s after Whirling Dragon Punch. Click a window for its presses.
- **Every wrong press marked where it happened** — red for a mistake, yellow for something to look at —
  each linked into the WarcraftLogs replay.
- **Filler habits** after Fists of Fury and Whirling Dragon Punch, and presses per minute, against the
  top parses.

Three rules that look obvious were measured against the top parses and changed:

- **Combo Strikes.** The same button twice with *nothing* between happened 11 times in ~5,000 top-parse
  presses; with Zenith, Zenith Stomp, Xuen or a movement button between, 63 times. Only the first is a
  break.
- **Fists of Fury right after Celestial Conduit** (the guide's Unity Within macro) is done about half
  the time, 0-100% by player. It is shown per window and never marked.
- **Tiger Palm in the burst** only counts in the first 12s: when Conduit is held for a mechanic, the
  top parses press Tiger Palm in the tail of the window.

Shado-Pan gets the universal checks only; the burst-window rules are Conduit's.

## Raid notes

A second, different analysis at `/notes` (`npm run raid` on the command line): **raid-wide**, no
subject player, aimed at whoever is calling. It finds the mechanics people actually fail and drafts
an NSRT callout sheet — editable in the browser, exported as plain text.

The governing idea is that **the raid is its own control group**. If a mechanic hit 4 of 19 players
who were alive for it, the other 15 proved on that pull that it is dodgeable. That needs no reference
parses, no boss knowledge and nothing extra to fetch, and it is stronger evidence than the DPS
analysis's cross-report comparison.

Mechanics are classified from the *distribution* of who got hit, never from the ability itself:

| class | signature | in the note |
|---|---|---|
| `avoidable` | a varying minority hit | **yes** |
| `raid-wide` | hits nearly everyone, nearly always | no — a healing problem, nobody failed |
| `tank-only` | every target is a tank | no |
| `assigned` | hit *count* near-constant across pulls | demoted — it looks like a soak rota |
| `unclear` | too few occurrences, or never hit anyone | no |

On a real Heroic night this left three mechanics in the note and correctly excluded Ravenous Feast
(100% of the raid), Corrosive Spit (80%), Coiling Ichor (88%) and Clotted Bolt (tanks only).

**One mechanic is one call.** Nine people missing the same Caustic Globule produces a single line at
that moment, not nine warnings — the call is made once, out loud, by one person. `--names` folds the
repeat offenders onto that same line so the caller knows who to watch.

**Every call carries what the mechanic does**, measured from the log, because that is what makes
the verb obvious to a human:

```
Caustic Globule  instant, no cast bar - aimed at one player, and 3 others nearby take it too - 402k a hit
Stone Breaker    1.5s cast - hits one player - almost always the tanks - 1.3M a hit - 72% absorbed
Ravenous Feast   4.3s cast - hits 19 at once - 201k a hit, up to 3.4M - 70% absorbed
```

WarcraftLogs has no spell descriptions — `GameAbility` exposes id, icon and name and nothing else —
so this is derived rather than fetched, and for writing a callout the behaviour is the more useful
half anyway. The cast bar comes from begincast-to-cast, *targeted* from the cast naming a player, and
*splash* from someone other than that named target taking the damage; the last of those is what
separates "you take this" from "you and everyone near you". Each line also links the spell on
Wowhead, which is a link the reader may follow, not a request the tool makes.

**The verb is never invented.** Soak, spread, move out and face away are indistinguishable in a
damage log, so a line reads `Caustic Globule x3 <call>` and the editor is where you write the
instruction once. An edited call survives regeneration, so next week's log updates the timings and
death counts underneath your wording without touching it.

Two further outputs: `--for <player>` writes a private note for one person (what *they* keep eating
while others dodge, plus anything that killed them twice — including raid-wide mechanics the shared
note stays silent on), and pasting an existing note into the editor splices the calls in, preserving
every cooldown assignment.

### Waves, not ordinals

Grouping occurrences by their per-pull index looks obvious and is wrong. Measured on a real fight,
Caustic Globule arrives in waves of 2-4 casts whose *size* varies between pulls, so one extra cast
shifts every later ordinal by a whole wave: 13 of 15 ordinals came out with ±99s of drift, which is
exactly the wave period. The absolute times were tight throughout — 13-15s, 81-82s, 183-186s, still
within 3s of each other seven minutes in.

So waves are cross-pull time clusters, timed by when each wave *starts* on each pull rather than by
every cast inside it. A strictly periodic mechanic gives the same answer either way; a bursty one
stops being wrong. That took 34 unusable candidate lines to 18, every one with a confident timer.

### Short reports

The three-pull floor the DPS analysis uses is an *ideal* here, not a gate. It exists so cross-pull
consistency is not read off two data points, but the within-pull control group needs no repetition at
all. Demanding three pulls of a two-pull report returned an empty note for exactly the case a raid
leader most wants one — the first night on a boss. The effective floor is `min(3, pulls)`, and a
short report is marked as thin evidence rather than silently producing nothing.

The soak test keeps the full three-observation requirement regardless, because one or two occurrences
have a coefficient of variation of zero for free, and relaxing it would file every mechanic in a short
log as somebody's assignment.

### The NSRT format

Read from a real export rather than guessed, then confirmed by importing a generated note in game.

```
EncounterID:3420;Difficulty:Heroic;Name:Sszorak      <- header, no trailing ;
time:0;ph:1;tag:Niome;spellid:1276452;               <- a cooldown assignment
time:133;ph:1;tag:everyone;text:Move to Soak;        <- a reminder, to the raid
time:228;ph:1;tag:Ennuvathar;text:Watch the adds;    <- or to one player
```

It is **plain text** — no serialisation, no compression, no encoding — so `src/lib/nsrt/` has no
dependencies and the note renders in the browser.

`time` is whole seconds from the pull start, **truncated**. Of 357 lines in the sample whose
(player, spell) pair existed in the log, 352 landed within 2s of their claimed time and every offset
was positive, +0.1s to +0.9s. `Math.round` would put half the timers a second late.

`sanitizeText` strips `;` from both text and tags: it is the field separator, no escape for it was
visible in the sample, and one in a hand-typed name would swallow the rest of the line. The parser
preserves any line it does not recognise verbatim, so splicing into someone's existing note cannot
destroy their assignments — `test/note-syntax.test.ts` round-trips a real 378-line note byte for byte.

Still unverified, and *not* settled by the import working: whether `text` can escape a `;`, whether it
renders `|cffRRGGBB|r` markup, and whether the timers fire early enough on a live pull. The first two
are things we never emit; the third is a claim about `TIMER_QUANTILE`, not about the format.

### Raid query cost

Measured on the same twelve Heroic pulls:

```
on a warm DPS cache:  21 requests   (damage-taken events only; 1-3 pages per pull)
standalone, cold:     ~45 requests  (about a third of the DPS analysis)
wire payload:         45 KB         (336 KB before trimming — 87% smaller)
re-run, warm:          0 requests, 0.4s
```

Everything except the damage-taken events is already on disk: the fight-wide `DamageTaken` and
`Deaths` tables are fetched without a `sourceID` filter by `buildPlayerProfile`, so they already hold
the whole raid, and the boss-ability timeline is shared with the DPS analysis via
`buildEncounterContext`.

Those events are the one thing this genuinely needs, and they are large — 161,831 events across
twelve pulls, 13.5k median per pull and 38.9 MB on disk. **They never leave the server.** The route
sends per-wave summaries only; `series`, which carries every occurrence with its per-player hit lists,
is dropped from the payload.

## Known limitations

- **DPS only.** The rules are damage-shaped. Healers and tanks will produce output, but the findings
  won't mean much and the reference set is fetched on the `dps` metric.
- **Off-meta builds still generate noise.** Build matching (above) removes most of it, and the rules
  additionally require most of the reference set to use an ability before flagging it. But if nobody
  in the top 100 plays your build, the closest match may still be some distance away — watch the
  match percentage.
- **One report at a time.** Comparing across raid nights (did the habit actually improve?) would need
  a persisted store, which this doesn't have.
- **Raid buffs are deliberately not analysed.** The Buffs table returns every aura on the player with
  no marker for who applied it, so "Windwalking missing" means the raid had no Windwalker Monk, not
  that the player erred. `consumables` is restricted to a small name pattern for exactly this reason
  — see the comment in `src/lib/rules/consumables.ts`. It is the one piece of hardcoded game
  knowledge in the project, and it buys precision at the cost of never flagging a personal buff you
  let slip.
- **Defensive and utility abilities rank low.** Their value is measured in damage per cast, which is
  zero for something like Dark Pact, so they land at `info`. That is the right ranking for a DPS
  analysis but it does undersell survivability.
- **Raid notes cannot tell you what to say.** Soak, spread, move out and face away produce identical
  damage logs, so a generated line names the mechanic and leaves `<call>` for the instruction. This is
  the one place the tool is deliberately incomplete rather than guessing.
- **Tank detection is derived, and can be fooled.** Tanks are whoever eats a high-rate ability that
  lands on a small share of the raid — no spec-to-role table. It needs the boss to actually melee
  someone; a fight where nothing does would detect no tanks, and the `tank-only` and tank-fairness
  rules would then go quiet rather than misfire.
- **A mechanic whose damage cannot be tied to a cast is dropped.** Name match first, then a timing
  fallback; anything matching neither is left out rather than guessed at. On the measured fight that
  was 2 of 9 mechanics, with a 78% name-match rate.

## A note on the WCL table shapes

`table` returns an untyped JSON scalar and the layout varies by `dataType` in ways worth knowing if
you extend this:

- `DamageDone` **filtered by `sourceID` returns ability rows, with no actor row at all.** Totals,
  `activeTime` and the spec (`icon: "Warlock-Demonology"`) only exist on the *fight-wide* table,
  where each entry is an actor. Reading active time from the filtered table silently yields 100%
  uptime for everyone.
- `Buffs` returns **`auras`**, not `entries`.
- `DamageTaken` ability rows carry totals but **no hit counts**, which is why avoidable damage is
  measured as a share of your total damage taken rather than as a hit count.
- `Deaths` puts the killing ability on **`killingBlow`**, and its `timestamp` is absolute, not
  fight-relative.
- The **cast event stream contains more than the Casts table does** — auto attacks and channel ticks
  among it, surfacing as unnamed ability ids firing twice a second. Anything not present in
  `abilityNames` is filtered out of the opener analysis: if it can't be named, no advice can be given
  about it.
- **Enemy cast events carry no names.** `hostilityType: Enemies` on the Casts *table* does — NPC
  rows with nested abilities — and on a real fight it named 98% of the event casts. That table is the
  boss-ability dictionary; ids it doesn't name are dropped.
- **The enemy-side log files some player effects under `Environment`.** A Death Knight's Anti-Magic
  Zone showed up as a "boss cast" preceding three gaps. Source id can't separate it from real
  environment-spawned mechanics (Caustic Globule shares it), and neither the friendly Casts table nor
  the player's own Buffs table listed it. The **raid-wide Buffs table did**: a "boss ability" that sits
  on friendlies as a beneficial aura is a friendly effect. That is the exclusion used, and the report
  says what it dropped.
- **Mechanic vs auto-attack is a rate, not a name.** Measured on that fight: the melee-like ability ran
  at 30.7 casts/min, every real mechanic between 0.2 and 8.1. `MAX_MECHANIC_CPM = 10` is the line.
  One mechanic appeared under two ids with one name, so begincast/cast pairs are collapsed by *name*,
  within 3s — short, because an 8/min mechanic recurs every 7s and must not collapse into itself.
- **A gap with no boss cast in the previous 8s is reported as exactly that.** Those are the player's
  own — a target swap, resource starvation, hesitation — and the tool says so rather than guessing.

- **Damage-taken events include damage the raid does to itself.** Measured on one pull: a warlock hit
  themselves 753 times at 96/min, two mages at 54/min, two demon hunters at 16/min. Every one passed
  the "faster than any mechanic, on few enough people" melee test, and tank detection returned nine of
  twenty players. The fix is to require a hostile `sourceID`, and it matters well beyond tanks — a
  player's own ability could otherwise be mapped to a boss cast and counted as a mechanic the raid
  failed. Aliveness detection deliberately still reads *every* event, since any damage at all proves
  someone is back on their feet.
- **Tank targeting has to be measured against headcount, not as a share.** Two tanks in twenty taking
  44% of a mechanic's hits is 4.4x their headcount but still under half, so a majority test misses it
  and the tank buster ends up in a tank's own "things you keep failing" note. Measured separation on
  one fight: 6.3x and 4.4x for the two tank-facing mechanics, 1.3x or below for everything else.

All of these were wrong in the first implementation and were only caught by running against a live
report.
