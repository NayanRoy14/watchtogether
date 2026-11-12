import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackState } from '@wt/shared';
import { Emitter, type PlayerAdapter, type PlayerEvent } from '../players/PlayerAdapter';
import { SyncEngine, type SyncIO } from './engine';

/** A player that does what it is told and lets the test pretend a person touched it. */
class FakePlayer implements PlayerAdapter {
  canNudge = true;
  time = 0;
  paused = true;
  speed = 1;
  buffering = false;
  length = 600;
  allowPlay = true;
  calls: string[] = [];
  onFailure = null;
  private events = new Emitter();

  async load(): Promise<void> {}
  async play(): Promise<boolean> {
    this.calls.push('play');
    if (!this.allowPlay) return false;
    this.paused = false;
    this.events.emit('play'); // real players fire this for programmatic play too
    return true;
  }
  pause(): void {
    this.calls.push('pause');
    this.paused = true;
    this.events.emit('pause');
  }
  seek(t: number): void {
    this.calls.push(`seek ${t.toFixed(1)}`);
    this.time = t;
    this.events.emit('seeked');
  }
  setRate(r: number): void {
    if (r === this.speed) return;
    this.calls.push(`rate ${r.toFixed(2)}`);
    this.speed = r;
    this.events.emit('ratechange');
  }
  setVolume(): void {}
  currentTime = (): number => this.time;
  duration = (): number => this.length;
  rate = (): number => this.speed;
  isPaused = (): boolean => this.paused;
  isBuffering = (): boolean => this.buffering;
  on(event: PlayerEvent, cb: () => void): void {
    this.events.on(event, cb);
  }
  destroy(): void {}

  stall(on: boolean): void {
    this.buffering = on;
    this.events.emit(on ? 'buffering' : 'ready');
  }

  /** Something outside our code changed the player: a click on the video, a media key. */
  byPerson(change: 'pause' | 'play' | 'ended'): void {
    if (change !== 'ended') this.paused = change === 'pause';
    this.events.emit(change);
  }
}

const T0 = 1_000_000;
const state = (over: Partial<PlaybackState> = {}): PlaybackState => ({
  source: { kind: 'url', id: 'https://cdn.test/a.mp4', title: 'a.mp4' },
  playing: true, position: 100, rate: 1, updatedAt: T0, seq: 7, by: 'Riya', ...over,
});

function setup(control = true) {
  const player = new FakePlayer();
  const sent: string[] = [];
  const io: SyncIO = {
    serverNow: () => Date.now(),
    hasControl: () => control,
    sendIntent: (action, position, rate) => sent.push(`${action} ${position.toFixed(1)}${rate ? ` @${rate}` : ''}`),
    sendBuffering: (v) => sent.push(`buffering ${v}`),
    sendEnded: (seq) => sent.push(`ended ${seq}`),
    onBlocked: (b) => sent.push(`blocked ${b}`),
  };
  const engine = new SyncEngine(player, io);
  /** Let time pass with the video advancing at its current speed, as a real player would. */
  const run = async (seconds: number): Promise<void> => {
    for (let i = 0; i < seconds * 10; i++) {
      if (!player.paused && !player.buffering) player.time += 0.1 * player.speed;
      await vi.advanceTimersByTimeAsync(100);
    }
  };
  return { player, sent, engine, run };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe('SyncEngine', () => {
  it('moves the player to where the room is and does not echo its own commands back', async () => {
    const { player, sent, engine, run } = setup();
    vi.setSystemTime(T0 + 4000); // the state is 4 s old when it reaches us
    engine.apply(state());
    expect(player.calls).toEqual(['seek 104.0', 'play']);
    await run(3);
    expect(sent).toEqual([]); // the play and seek events it caused were recognised as its own

    engine.apply(state({ playing: false, position: 107, seq: 8 }));
    await run(2);
    expect(player.paused).toBe(true);
    expect(sent).toEqual([]);
  });

  it('turns a person pausing the video into a request to the room', async () => {
    const { player, sent, engine, run } = setup(true);
    engine.apply(state());
    await run(3);
    player.byPerson('pause');
    expect(sent).toEqual(['pause 103.0']);
  });

  it('snaps back when someone without control touches the player', async () => {
    const { player, sent, engine, run } = setup(false);
    engine.apply(state());
    await run(3);
    player.calls = [];
    player.byPerson('pause');
    expect(sent).toEqual([]);
    expect(player.calls).toContain('play');
    expect(player.paused).toBe(false);
  });

  it('closes a small gap by playing 5% faster, then returns to normal speed', async () => {
    const { player, engine, run } = setup();
    engine.apply(state());
    await run(2);
    player.calls = [];
    player.time -= 0.8; // fell behind
    await run(1.1);
    expect(player.speed).toBeCloseTo(1.05);
    await run(20);
    expect(player.speed).toBe(1);
    expect(Math.abs(player.time - (100 + (Date.now() - T0) / 1000))).toBeLessThan(0.3);
    expect(player.calls.filter((c) => c.startsWith('seek'))).toEqual([]); // never jumped
  });

  it('jumps when the gap is large, and always on players that cannot fine-tune speed', async () => {
    const big = setup();
    big.engine.apply(state());
    await big.run(2);
    big.player.calls = [];
    big.player.time += 5;
    await big.run(1.1);
    expect(big.player.calls.some((c) => c.startsWith('seek'))).toBe(true);
    expect(big.sent).toEqual([]); // its own corrective seek is not reported as a person seeking

    const yt = setup();
    yt.player.canNudge = false;
    yt.engine.apply(state());
    await yt.run(2);
    yt.player.calls = [];
    yt.player.time -= 0.8;
    await yt.run(1.1);
    expect(yt.player.calls.some((c) => c.startsWith('seek'))).toBe(true);
    expect(yt.player.speed).toBe(1);
  });

  it('reports buffering after a second, and recovery once it is over', async () => {
    const { player, sent, engine, run } = setup();
    engine.apply(state());
    await run(2);
    player.stall(true);
    await run(0.9);
    expect(sent).toEqual([]); // a brief hiccup is not worth pausing the room for
    await run(1.2);
    expect(sent).toEqual(['buffering true']);
    player.stall(false);
    expect(sent).toEqual(['buffering true', 'buffering false']); // recovery is reported at once
  });

  it('notices when the browser refuses to autoplay and recovers on a click', async () => {
    const { player, sent, engine, run } = setup();
    player.allowPlay = false;
    engine.apply(state());
    await run(0.1);
    expect(sent).toEqual(['blocked true']);
    player.allowPlay = true;
    engine.unblock();
    await run(0.1);
    expect(sent).toEqual(['blocked true', 'blocked false']);
    expect(player.paused).toBe(false);
  });

  it('reports the end once, with the sequence number it was watching', async () => {
    const { player, sent, engine, run } = setup();
    engine.apply(state({ position: 598 }));
    await run(1.9);
    player.time = 600;
    player.byPerson('pause'); // browsers fire pause right before ended
    player.byPerson('ended');
    expect(sent).toEqual(['ended 7']);
  });

  it('treats a position past the end as finished instead of restarting the video', async () => {
    const { player, sent, engine, run } = setup();
    engine.apply(state({ position: 600 })); // someone dragged the seek bar to the end
    await run(3);
    expect(sent).toEqual(['ended 7']);
    expect(player.calls).not.toContain('play');

    const late = setup();
    vi.setSystemTime(T0 + 700_000); // joined long after a 10-minute video was started
    late.engine.apply(state({ position: 0 }));
    await late.run(2);
    expect(late.sent).toEqual(['ended 7']);
  });
});
