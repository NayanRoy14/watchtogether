import { driftAction, expectedPosition, type PlaybackState } from '@wt/shared';
import type { PlayerAdapter } from '../players/PlayerAdapter';

/** What the engine needs from the room. Kept as plain functions so it can be tested alone. */
export interface SyncIO {
  serverNow(): number;
  hasControl(): boolean;
  sendIntent(action: 'play' | 'pause' | 'seek' | 'rate', position: number, rate?: number): void;
  sendBuffering(value: boolean): void;
  sendEnded(seq: number): void;
  /** The browser refused to start playback until this person clicks. */
  onBlocked(blocked: boolean): void;
}

const GUARD_MS = 1000; // how long player events are treated as echoes of our own commands
const STALL_REPORT_MS = 1000; // buffering this long pauses the room
const BLOCK_AFTER_MS = 1500; // should be playing but isn't, and isn't loading either

/**
 * Keeps one player in step with the room's playback state.
 *
 * The room's state is the truth. This engine nudges the local player toward it, and
 * turns things the person does to the player (click to pause, media keys) into
 * requests to the room, never into direct peer-to-peer commands.
 */
export class SyncEngine {
  private state: PlaybackState | null = null;
  private timer: ReturnType<typeof setInterval>;
  /** Until this time, a player event matching `guardPlaying` is our own doing. */
  private guardUntil = 0;
  private guardPlaying = false;
  private nudging = false;
  private stalledSince = 0;
  private reportedStall = false;
  private notPlayingSince = 0;
  private blocked = false;
  private finishedSeq = -1;

  constructor(private readonly player: PlayerAdapter, private readonly io: SyncIO) {
    player.on('play', () => this.onPlayerToggled(true));
    player.on('pause', () => this.onPlayerToggled(false));
    player.on('seeked', () => this.onPlayerSeeked());
    player.on('ratechange', () => this.onPlayerRate());
    player.on('ended', () => this.finish());
    // Start the stall clock the moment it happens rather than at the next tick.
    player.on('buffering', () => (this.stalledSince ||= Date.now()));
    player.on('ready', () => this.reportStall());
    this.timer = setInterval(() => this.tick(), 1000);
  }

  destroy(): void {
    clearInterval(this.timer);
    if (this.reportedStall) this.io.sendBuffering(false);
  }

  /** A new state from the room: make the player match it. */
  apply(state: PlaybackState): void {
    this.state = state;
    this.nudging = false;
    this.notPlayingSince = 0;
    this.guard(state.playing);

    const target = expectedPosition(state, this.io.serverNow());
    if (state.playing && this.pastEnd(target)) return this.finish();
    if (Math.abs(this.player.currentTime() - target) > (state.playing ? 0.3 : 0.05)) this.player.seek(target);
    this.player.setRate(state.rate);
    if (state.playing) {
      void this.player.play().then((started) => {
        if (!started) this.setBlocked(true);
      });
    } else {
      this.player.pause();
    }
  }

  /** Called from a real click, which is what browsers require before sound may start. */
  unblock(): void {
    this.setBlocked(false);
    if (this.state) this.apply(this.state);
  }

  // ---- once a second ------------------------------------------------------------

  private tick(): void {
    const state = this.state;
    if (!state) return;
    const now = Date.now();
    const buffering = this.player.isBuffering();

    this.reportStall();
    if (buffering) return;

    const target = expectedPosition(state, this.io.serverNow());
    if (!state.playing) {
      if (Math.abs(this.player.currentTime() - target) > 0.5) {
        this.guard(false);
        this.player.seek(target);
      }
      return;
    }

    if (this.finishedSeq === state.seq) return;
    if (this.player.isPaused()) {
      // Should be playing. Give it a moment, then assume the browser wants a click.
      this.notPlayingSince ||= now;
      if (now - this.notPlayingSince > BLOCK_AFTER_MS && now > this.guardUntil) this.setBlocked(true);
      return;
    }
    this.notPlayingSince = 0;
    if (this.blocked) this.setBlocked(false);

    if (this.pastEnd(target)) return this.finish();

    const action = driftAction(this.player.currentTime() - target, state.rate, this.player.canNudge, this.nudging);
    if (action.do === 'seek') {
      this.nudging = false;
      this.guard(true);
      this.player.setRate(state.rate);
      this.player.seek(target);
    } else if (action.do === 'nudge') {
      this.nudging = true;
      this.player.setRate(action.rate);
    } else if (this.nudging) {
      this.nudging = false;
      this.player.setRate(state.rate);
    }
  }

  /** Tell the room when we have been stalled for a while, and when we recover. */
  private reportStall(): void {
    const now = Date.now();
    if (this.player.isBuffering()) {
      if (!this.state?.playing && !this.reportedStall) return;
      this.stalledSince ||= now;
      if (!this.reportedStall && now - this.stalledSince >= STALL_REPORT_MS) {
        this.reportedStall = true;
        this.io.sendBuffering(true);
      }
      return;
    }
    this.stalledSince = 0;
    if (this.reportedStall) {
      this.reportedStall = false;
      this.io.sendBuffering(false);
    }
  }

  // ---- things the player did ------------------------------------------------------

  private onPlayerToggled(playing: boolean): void {
    const state = this.state;
    if (!state) return;
    if (Date.now() < this.guardUntil && this.guardPlaying === playing) return; // echo of our own command
    if (state.playing === playing) return; // already what the room wants
    if (!playing && this.nearEnd()) return; // pausing at the very end is the video finishing

    // A person did this (clicked the video, pressed a media key).
    if (this.io.hasControl()) this.io.sendIntent(playing ? 'play' : 'pause', this.player.currentTime());
    else this.apply(state); // not theirs to change: snap back
  }

  private onPlayerSeeked(): void {
    const state = this.state;
    if (!state || Date.now() < this.guardUntil) return;
    const target = expectedPosition(state, this.io.serverNow());
    if (Math.abs(this.player.currentTime() - target) < 0.5) return;
    if (this.io.hasControl()) this.io.sendIntent('seek', this.player.currentTime());
    else this.apply(state);
  }

  private onPlayerRate(): void {
    const state = this.state;
    if (!state || this.nudging || Date.now() < this.guardUntil) return;
    const rate = this.player.rate();
    if (Math.abs(rate - state.rate) < 0.06) return; // our own ±5 % nudge settling
    if (this.io.hasControl()) this.io.sendIntent('rate', this.player.currentTime(), rate);
    else this.player.setRate(state.rate);
  }

  private pastEnd(target: number): boolean {
    const duration = this.player.duration();
    return duration > 0 && target >= duration - 0.25;
  }

  /**
   * The video is over, whether the player said so or the room's clock ran past its length
   * (a seek to the end, or someone joining after it finished). Reported once per state.
   */
  private finish(): void {
    const state = this.state;
    if (!state || this.finishedSeq === state.seq) return;
    this.finishedSeq = state.seq;
    this.guard(false);
    this.player.pause(); // calling play() on a finished video would restart it from zero
    this.io.sendEnded(state.seq);
  }

  private guard(playing: boolean): void {
    this.guardUntil = Date.now() + GUARD_MS;
    this.guardPlaying = playing;
  }

  private nearEnd(): boolean {
    const duration = this.player.duration();
    return duration > 0 && this.player.currentTime() >= duration - 0.5;
  }

  private setBlocked(blocked: boolean): void {
    if (this.blocked === blocked) return;
    this.blocked = blocked;
    this.io.onBlocked(blocked);
  }
}
