import type { PlaybackState, Source } from './messages';

/** One ping/pong round trip, as measured by the client. */
export interface ClockSample {
  /** Add to the local clock to get the server's. */
  offset: number;
  /** Round-trip time, ms. A shorter trip means a more trustworthy offset. */
  rtt: number;
}

export function clockSample(t0: number, serverTime: number, t1: number): ClockSample {
  return { offset: serverTime - (t0 + t1) / 2, rtt: t1 - t0 };
}

/** The offset from the fastest round trip. */
export function bestOffset(samples: readonly ClockSample[]): number {
  let best: ClockSample | undefined;
  for (const s of samples) if (!best || s.rtt < best.rtt) best = s;
  return best?.offset ?? 0;
}

/** Where the video should be at `serverNow`. */
export function expectedPosition(state: Pick<PlaybackState, 'playing' | 'position' | 'rate' | 'updatedAt'>, serverNow: number): number {
  if (!state.playing) return state.position;
  return Math.max(0, state.position + ((serverNow - state.updatedAt) / 1000) * state.rate);
}

export const DRIFT_IGNORE = 0.3;
export const DRIFT_SEEK = 1.5;
export const DRIFT_SETTLED = 0.1;

export type DriftAction =
  | { do: 'nothing' }
  | { do: 'seek' }
  /** Play slightly fast or slow until the gap closes. */
  | { do: 'nudge'; rate: number };

/**
 * What a player should do about being `drift` seconds off (positive = ahead of the room).
 * `nudging` is whether it is already catching up, in which case it keeps going until
 * nearly exact instead of stopping at the "ignore" threshold.
 */
export function driftAction(drift: number, rate: number, canNudge: boolean, nudging: boolean): DriftAction {
  const gap = Math.abs(drift);
  if (gap < (nudging ? DRIFT_SETTLED : DRIFT_IGNORE)) return { do: 'nothing' };
  if (gap > DRIFT_SEEK || !canNudge) return { do: 'seek' };
  return { do: 'nudge', rate: rate * (drift > 0 ? 0.95 : 1.05) };
}

/** Turns what someone pasted into a source, or null if it is not playable in Direct mode. */
export function parseSource(input: string): Source | null {
  const text = input.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let videoId: string | null = null;
  if (host === 'youtu.be') videoId = url.pathname.slice(1).split('/')[0] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') videoId = url.searchParams.get('v');
    else {
      const m = /^\/(embed|shorts|live)\/([^/]+)/.exec(url.pathname);
      if (m) videoId = m[2] ?? null;
    }
  }
  if (videoId !== null) {
    return /^[\w-]{11}$/.test(videoId) ? { kind: 'youtube', id: videoId, title: 'YouTube video' } : null;
  }
  if (host === 'youtube.com' || host === 'youtu.be') return null;

  const name = decodeURIComponent(url.pathname.split('/').pop() ?? '') || url.hostname;
  return { kind: 'url', id: url.href, title: name.slice(0, 200) };
}

/** Local files are matched by size and length, since each person plays their own copy. */
export function fileFingerprint(bytes: number, durationSeconds: number): string {
  return `${bytes}-${Math.round(durationSeconds)}`;
}
