import type { Source } from '@wt/shared';

export type PlayerEvent = 'play' | 'pause' | 'seeked' | 'ratechange' | 'buffering' | 'ready' | 'ended';

/**
 * Every kind of video sits behind this, so the sync engine never cares what is playing.
 * Adapters only report what their player did; deciding whether a person or our own code
 * caused it is the engine's job.
 */
export interface PlayerAdapter {
  /** Can the speed be set finely (±5 %) to close a small gap? YouTube cannot. */
  readonly canNudge: boolean;
  /** Resolves once the video can be controlled; rejects with a readable reason if it cannot play. */
  load(source: Source): Promise<void>;
  /** Resolves false when the browser refused to start playback without a click. */
  play(): Promise<boolean>;
  pause(): void;
  seek(seconds: number): void;
  setRate(rate: number): void;
  setVolume(volume: number, muted: boolean): void;
  currentTime(): number;
  duration(): number;
  rate(): number;
  isPaused(): boolean;
  isBuffering(): boolean;
  on(event: PlayerEvent, cb: () => void): void;
  /** Called if the video breaks after it had loaded (removed, blocked, network gone). */
  onFailure: ((message: string) => void) | null;
  destroy(): void;
}

export class Emitter {
  private listeners = new Map<PlayerEvent, Array<() => void>>();
  on(event: PlayerEvent, cb: () => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]);
  }
  emit(event: PlayerEvent): void {
    for (const cb of this.listeners.get(event) ?? []) cb();
  }
  clear(): void {
    this.listeners.clear();
  }
}

/** Shown to people when a source will not play in Direct mode. */
export class PlaybackError extends Error {}
