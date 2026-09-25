import type { MechanicWave, NotableMechanic } from "@/lib/model/notable";
import {
  MAX_NOTE_LINES,
  MIN_FAIL_CONSISTENCY,
  noteWorthyWaves,
  TIMER_TIGHT_MS,
} from "@/lib/model/notable";
import type { RaidRoster } from "@/lib/model/raid";
import {
  EVERYONE,
  emitNote,
  sanitizeText,
  toNoteTime,
  type NoteHeader,
  type ParsedNote,
  type TextLine,
} from "./note-syntax";

// Pure. Turns the ranked mechanics into note lines. Nothing here fetches, and
// nothing here knows anything about any boss.

/**
 * How early to fire the reminder, relative to the wave's own p25 time.
 *
 * A reminder that appears as the damage lands is useless. Three seconds is the
 * same granularity TIMER_TIGHT_MS already treats as one event, so it cannot push
 * a warning onto the wrong side of a neighbouring mechanic.
 */
export const LEAD_SECONDS = 3;

/**
 * A player named on a line has to be failing the wave most of the time they see
 * it. Naming someone who ate it twice in nine pulls is noise, and worse, unfair.
 */
export const NAME_SHARE = 0.6;

/**
 * At most this many names on one moment.
 *
 * Naming half the raid is not singling anyone out, it is a second copy of the
 * raid-wide line. If more than three people fail a mechanic this reliably it is
 * a raid problem, and the `everyone` line already says so.
 */
export const MAX_NAMES = 3;

/** One line per generated warning, with everything the editor needs to show its case. */
export interface GeneratedLine {
  /** Stable across regeneration, so edits can be merged back onto it. */
  id: string;
  source: { mechanic: string; ordinal: number };
  enabled: boolean;

  timeSec: number;
  tag: string;
  text: string;

  /** Provenance, for the UI and for sorting. Never emitted into the note. */
  mechanic: string;
  spellId: number;
  priority: number;
  seen: number;
  reached: number;
  failedOn: number;
  deaths: number;
  medianHitCount: number;
  confident: boolean;
  spreadMs: number;
  /** Names, most-failing first, for the optional per-player lines. */
  offenders: string[];
}

/**
 * Stands in for the instruction on an unedited line.
 *
 * The verb cannot be derived — soak, spread, move out and face away all look
 * identical in a damage log — so rather than guess one or leave a line quietly
 * vague, an unwritten call says so in as many words. Seeing `<call>` on screen
 * mid-pull is a reminder to go and write it; seeing a bare mechanic name is not.
 */
export const CALL_PLACEHOLDER = "<call>";

export interface GenerateOptions {
  /**
   * Who the note is addressed to. Any name: whoever is calling need not be in
   * the log, or even in the raid. Defaults to `everyone`, which in a personal
   * note means its owner and nobody else.
   */
  tag?: string;
  /** Append the repeat offenders to the line, so the caller knows who to watch. */
  includeNames?: boolean;
  /** Mark unwritten calls with CALL_PLACEHOLDER. On by default. */
  placeholder?: boolean;
  /** Cap on emitted lines. */
  maxLines?: number;
  leadSeconds?: number;
}

/**
 * The body of a warning.
 *
 * Deliberately just the mechanic, plus the count when it arrives as a burst.
 *
 * The verb is the hard part and it is not derivable: "move out" and "soak" and
 * "spread" and "face away" all look identical in a damage log, and picking one
 * would need boss knowledge this project does not have anywhere. Emitting the
 * name and leaving the instruction to the raid leader is the same honesty
 * `describeLead` applies when it refuses to guess at a cause — and the editor
 * exists precisely so the verb can be typed once and kept.
 */
export function waveText(mechanic: NotableMechanic, wave: MechanicWave): string {
  const casts = Math.round(wave.medianCasts);
  return sanitizeText(casts > 1 ? `${mechanic.name} x${casts}` : mechanic.name);
}

/**
 * A call's identity is the moment it warns about: this mechanic, this wave.
 *
 * Deliberately *not* including the tag. Who is reading the note is an attribute
 * of the line, not what makes it that line — folding the tag in meant renaming
 * the caller changed every id, so the editor could no longer match its own saved
 * edits and silently threw away every rewritten call. Found by doing exactly
 * that in the browser.
 */
function lineId(mechanic: string, ordinal: number): string {
  return `${mechanic}#${ordinal}`;
}

/**
 * The raid leader's callout sheet: one line per moment that needs calling.
 *
 * This is the note the person running the raid keeps, not one handed to the raid.
 * So a mechanic five people keep missing is *one* line reminding the caller to
 * say something, not five lines telling the five to watch out — the call is made
 * once, out loud, by one person.
 *
 * Offenders, when asked for, go on that same line, because the caller wants to
 * know who to watch while they say it.
 */
export function generateLines(
  notable: NotableMechanic[],
  roster: RaidRoster,
  opts: GenerateOptions = {},
): GeneratedLine[] {
  const lead = opts.leadSeconds ?? LEAD_SECONDS;
  const maxLines = opts.maxLines ?? MAX_NOTE_LINES;
  // A blank or whitespace-only name would emit an unaddressed line, so fall back
  // rather than write one.
  const tag = sanitizeText(opts.tag ?? "") || EVERYONE;

  // One entry per moment, which is what the cap counts.
  const moments = notable.flatMap((mechanic) =>
    noteWorthyWaves(mechanic).map((wave) => {
      const offenders = wave.hitPlayers
        // A tank standing in the boss's damage is doing their job. Measured on a
        // real log, the top "offenders" for two mechanics were both tanks —
        // Stone Breaker lands 63% of its hits on them — so naming by raw
        // frequency singles out the two people who are not at fault.
        .filter((p) => !roster.tankIds.has(p.actorId))
        .filter((p) => p.pulls / Math.max(1, wave.seen) >= NAME_SHARE)
        .map((p) => roster.actors[p.actorId]?.name)
        .filter((name): name is string => Boolean(name))
        .slice(0, MAX_NAMES);

      return {
        mechanic,
        wave,
        common: {
          source: { mechanic: mechanic.name, ordinal: wave.ordinal },
          enabled: true,
          timeSec: Math.max(0, toNoteTime(wave.atMs) - lead),
          mechanic: mechanic.name,
          spellId: mechanic.spellId,
          // Waves of the same mechanic share its priority; the death count breaks
          // ties so the wave that actually kills people survives truncation.
          priority: mechanic.priority + wave.deaths,
          seen: wave.seen,
          reached: wave.reached,
          failedOn: wave.failedOn,
          deaths: wave.deaths,
          medianHitCount: wave.medianHitCount,
          confident: wave.confident,
          spreadMs: wave.spreadMs,
          offenders,
        },
      };
    }),
  );

  // Truncate by priority, then present in time order: the note is read top to
  // bottom during a pull, but what survives the cap should be what matters.
  const kept = [...moments]
    .sort((a, b) => b.common.priority - a.common.priority)
    .slice(0, maxLines)
    .sort(
      (a, b) =>
        a.common.timeSec - b.common.timeSec || a.mechanic.name.localeCompare(b.mechanic.name),
    );

  return kept.map(({ mechanic, wave, common }) => {
    const call = opts.placeholder === false ? "" : ` ${CALL_PLACEHOLDER}`;
    const names =
      opts.includeNames && common.offenders.length > 0 ? ` - ${common.offenders.join(", ")}` : "";
    return {
      ...common,
      id: lineId(mechanic.name, wave.ordinal),
      tag,
      text: sanitizeText(waveText(mechanic, wave) + call + names),
    };
  });
}

/**
 * How often one player has to be eating a wave, of the times they saw it, before
 * it belongs in their private note. Matches MIN_FAIL_CONSISTENCY: a line in your
 * own note is the cheapest advice there is, so the bar is lower than for a line
 * the whole raid has to read.
 */
export const PERSONAL_SHARE = MIN_FAIL_CONSISTENCY;

/**
 * Deaths that override everything else. Dying to the same mechanic twice is
 * worth telling someone about even when the rest of the raid eats it too — that
 * is the case a raid-wide note deliberately stays silent on.
 */
export const PERSONAL_DEATHS = 2;

/**
 * Tanks taking this many times their headcount share of a mechanic makes it
 * theirs to eat. Measured on a real fight, the gap is wide: the two tank-facing
 * mechanics came in at 6.3x and 4.4x, everything else at 1.3x or below.
 */
export const TANK_FOCUS = 2;

/** Why a line is in someone's private note. */
export type PersonalReason = "hit" | "deaths" | "both";

export interface PersonalLine extends GeneratedLine {
  personal: {
    actorId: number;
    /** Pulls this wave hit them, out of the pulls they were alive for it. */
    hitPulls: number;
    eligiblePulls: number;
    deaths: number;
    reason: PersonalReason;
  };
}

/**
 * Lines for one player's own note.
 *
 * A different question from the raid note, so a different filter: not "what does
 * the raid keep failing" but "what do *you* keep failing". The control group is
 * the same one the raid analysis uses — everyone else alive at that moment — so a
 * mechanic only lands here if this player ate it while others did not, or if it
 * killed them more than once.
 *
 * Tagged with the player's own name rather than `everyone`, which is both what
 * NSRT shows them and a safeguard: if a private note is ever pasted into a shared
 * one, it still only speaks to the person it was written for.
 */
export function generatePersonalLines(
  notable: NotableMechanic[],
  roster: RaidRoster,
  actorId: number,
  opts: GenerateOptions = {},
): PersonalLine[] {
  const name = roster.actors[actorId]?.name;
  if (!name) return [];
  const isTank = roster.tankIds.has(actorId);

  const lead = opts.leadSeconds ?? LEAD_SECONDS;
  const maxLines = opts.maxLines ?? MAX_NOTE_LINES;
  const candidates: PersonalLine[] = [];

  for (const mechanic of notable) {
    // Not noteWorthyWaves: a mechanic the raid as a whole handles fine can still
    // be the one killing this particular player, and that is worth their knowing.
    for (const wave of mechanic.waves) {
      const hit = wave.hitPlayers.find((p) => p.actorId === actorId);
      const deaths = wave.deathPlayers.find((p) => p.actorId === actorId)?.pulls ?? 0;
      const eligiblePulls = hit?.eligiblePulls ?? wave.seen;
      const hitPulls = hit?.pulls ?? 0;

      const share = eligiblePulls > 0 ? hitPulls / eligiblePulls : 0;
      // A tank eating a mechanic that mostly lands on tanks is doing their job.
      // Without this a tank's private note fills up with the tank buster — the
      // same unfairness the raid note avoids by never naming tanks.
      const theirJob = isTank && mechanic.tankFocus >= TANK_FOCUS;
      // Only count "keeps getting hit" for mechanics the raid can actually dodge;
      // otherwise every raid-wide hit would land in everyone's private note.
      const byHits =
        mechanic.classification === "avoidable" && !theirJob && share >= PERSONAL_SHARE;
      const byDeaths = deaths >= PERSONAL_DEATHS;
      if (!byHits && !byDeaths) continue;
      if (eligiblePulls < mechanic.minPulls) continue;

      candidates.push({
        id: `${mechanic.name}#${wave.ordinal}@personal:${actorId}`,
        source: { mechanic: mechanic.name, ordinal: wave.ordinal },
        enabled: true,
        timeSec: Math.max(0, toNoteTime(wave.atMs) - lead),
        tag: name,
        text: waveText(mechanic, wave),
        mechanic: mechanic.name,
        spellId: mechanic.spellId,
        // Their own deaths outrank the raid's: this note is about them.
        priority: mechanic.priority + deaths * 10,
        seen: wave.seen,
        reached: wave.reached,
        failedOn: wave.failedOn,
        deaths: wave.deaths,
        medianHitCount: wave.medianHitCount,
        confident: wave.confident,
        spreadMs: wave.spreadMs,
        offenders: [],
        personal: {
          actorId,
          hitPulls,
          eligiblePulls,
          deaths,
          reason: byHits && byDeaths ? "both" : byHits ? "hit" : "deaths",
        },
      });
    }
  }

  return candidates
    .sort((a, b) => b.priority - a.priority)
    .slice(0, maxLines)
    .sort((a, b) => a.timeSec - b.timeSec || a.mechanic.localeCompare(b.mechanic));
}

/** Two warnings this close together are one moment; the second is noise. */
export function mergeCloseLines(lines: GeneratedLine[]): GeneratedLine[] {
  const out: GeneratedLine[] = [];
  for (const line of lines) {
    const previous = out.find(
      (l) =>
        l.mechanic === line.mechanic &&
        l.tag === line.tag &&
        Math.abs(l.timeSec - line.timeSec) * 1000 <= TIMER_TIGHT_MS,
    );
    if (previous) continue;
    out.push(line);
  }
  return out;
}

export interface NoteDoc {
  header: NoteHeader;
  lines: GeneratedLine[];
}

export function buildHeader(encounter: {
  id: number;
  name: string;
  difficulty: string;
}): NoteHeader {
  return {
    encounterId: encounter.id,
    difficulty: encounter.difficulty,
    name: encounter.name,
    fields: [
      ["EncounterID", String(encounter.id)],
      ["Difficulty", encounter.difficulty],
      ["Name", encounter.name],
    ],
  };
}

function toTextLine(line: GeneratedLine): TextLine {
  return {
    kind: "text",
    timeSec: line.timeSec,
    // Every sample line carried ph:1, and nothing in the data identifies phases,
    // so 1 is what we write rather than inventing a phase model.
    phase: 1,
    tag: line.tag,
    text: line.text,
    extra: [],
  };
}

/** The finished note, ready to paste into NSRT. */
export function renderNote(doc: NoteDoc): string {
  const parsed: ParsedNote = {
    header: doc.header,
    lines: doc.lines.filter((l) => l.enabled).map(toTextLine),
    trailingNewline: true,
  };
  return emitNote(parsed);
}

/**
 * Splice generated lines into a note the user already has.
 *
 * This is the safe export path: the user's own cooldown assignments, header and
 * anything this parser did not recognise all come through untouched, and only
 * our own lines are replaced. Ours are identified by exact text match on a line
 * we previously wrote, so running it twice does not duplicate them.
 */
export function mergeIntoNote(existing: ParsedNote, doc: NoteDoc): ParsedNote {
  const ours = new Set(doc.lines.map((l) => `${l.tag} ${l.text}`));
  const kept = existing.lines.filter(
    (l) => !(l.kind === "text" && ours.has(`${l.tag} ${l.text}`)),
  );

  const merged = [...kept, ...doc.lines.filter((l) => l.enabled).map(toTextLine)];
  merged.sort((a, b) => {
    const at = a.kind === "opaque" ? Number.POSITIVE_INFINITY : a.timeSec;
    const bt = b.kind === "opaque" ? Number.POSITIVE_INFINITY : b.timeSec;
    return at - bt;
  });

  return { header: existing.header ?? doc.header, lines: merged, trailingNewline: true };
}
