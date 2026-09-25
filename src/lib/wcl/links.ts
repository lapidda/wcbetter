// URL builders for the two places a finding can send you: the WarcraftLogs
// replay of the user's own pull, and wowhead for an ability. Pure; safe in
// client bundles.

const WCL_REPORTS = "https://www.warcraftlogs.com/reports";

/** WCL's start=/end= are report-relative ms; a fight's startTime is that base. */
export interface ReplayWindow {
  /** The fight's report-relative start, from `Fight.startTime` / `PullTimeline.startTime`. */
  startTime: number;
  /** Fight-relative ms. */
  startMs: number;
  endMs?: number;
}

export interface WclLinkOptions {
  /** Report-local actor id — what WCL calls `source`. */
  source?: number;
  window?: ReplayWindow;
  /** Padding either side of the window so the event has context in the replay. */
  padMs?: number;
  /** WCL view: casts, damage-done, healing, deaths, ... */
  type?: string;
}

export function wclUrl(code: string, fightId: number, opts: WclLinkOptions = {}): string {
  const params: string[] = [`fight=${fightId}`];
  if (opts.source != null) params.push(`source=${opts.source}`);

  if (opts.window) {
    const pad = opts.padMs ?? 2000;
    const { startTime, startMs, endMs } = opts.window;
    const start = startTime + Math.max(0, startMs - pad);
    const end = startTime + (endMs ?? startMs) + pad;
    params.push(`start=${Math.round(start)}`, `end=${Math.round(end)}`);
  }

  params.push(`type=${opts.type ?? "casts"}`);
  return `${WCL_REPORTS}/${code}#${params.join("&")}`;
}

/**
 * WCL ability icons are bare file names ("ability_smash.jpg") served from
 * rpglogs' asset host. Verified against a real icon in the browser.
 */
export function iconUrl(file: string | null | undefined): string | null {
  if (!file) return null;
  return `https://assets.rpglogs.com/img/warcraft/abilities/${file}`;
}

export function wowheadSpellUrl(gameID: number): string {
  return `https://www.wowhead.com/spell=${gameID}`;
}
