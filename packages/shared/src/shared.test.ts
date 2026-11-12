import { describe, expect, it } from 'vitest';
import {
  CODE_ALPHABET, ClientMessage, formatCode, generateCode, hasControl, mayGiveControl, nextAlarm, normalizeCode,
  pickDriver, pickHost, bestOffset, clockSample, driftAction, expectedPosition, fileFingerprint, parseSource,
} from './index';

describe('room codes', () => {
  it('generates 6 unambiguous characters', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode();
      expect(code).toHaveLength(6);
      for (const ch of code) expect(CODE_ALPHABET).toContain(ch);
    }
  });
  it('normalises what people type', () => {
    expect(normalizeCode('k7m-2qx')).toBe('K7M2QX');
    expect(normalizeCode(' K7M 2QX ')).toBe('K7M2QX');
    expect(normalizeCode('K7M2Q')).toBeNull();
    expect(normalizeCode('K7M-2Q0')).toBeNull(); // 0 is not in the alphabet
  });
  it('formats with a dash', () => expect(formatCode('K7M2QX')).toBe('K7M-2QX'));
});

describe('messages', () => {
  it('accepts a valid hello and trims the name', () => {
    const r = ClientMessage.parse({ t: 'hello', name: '  Riya ', clientId: 'abcdefgh1234', color: '#f2a93b' });
    expect(r).toMatchObject({ t: 'hello', name: 'Riya' });
  });
  it('rejects unknown types, long chat and blank chat', () => {
    expect(ClientMessage.safeParse({ t: 'nope' }).success).toBe(false);
    expect(ClientMessage.safeParse({ t: 'chat', text: 'x'.repeat(501) }).success).toBe(false);
    expect(ClientMessage.safeParse({ t: 'chat', text: '   ' }).success).toBe(false);
  });
});

describe('control rules', () => {
  it('the driver is whoever was handed control, or the host if they are gone', () => {
    expect(pickDriver(['h', 'a'], 'a', 'h')).toBe('a');
    expect(pickDriver(['h'], 'a', 'h')).toBe('h');
    expect(pickDriver(['h'], null, 'h')).toBe('h');
  });
  it('only the host or the current driver can hand control on', () => {
    expect(mayGiveControl('h', 'h', 'd')).toBe(true);
    expect(mayGiveControl('d', 'h', 'd')).toBe(true);
    expect(mayGiveControl('x', 'h', 'd')).toBe(false);
  });
  it('wakes at the earliest deadline', () => {
    expect(nextAlarm({ close: 200, purge: 900, sweep: undefined })).toBe(200);
    expect(nextAlarm({})).toBeNull();
  });
  it('everyone mode gives control to all; driver mode only to the driver', () => {
    expect(hasControl('everyone', false)).toBe(true);
    expect(hasControl('driver', false)).toBe(false);
    expect(hasControl('driver', true)).toBe(true);
  });
  it('keeps a present host, otherwise picks the longest-standing member', () => {
    const members = [{ id: 'b', joinedAt: 20 }, { id: 'a', joinedAt: 10 }];
    expect(pickHost(members, 'b')).toBe('b');
    expect(pickHost(members, 'gone')).toBe('a');
    expect(pickHost([], 'gone')).toBeNull();
  });
});

describe('sync maths', () => {
  it('estimates the server clock from the fastest round trip', () => {
    // server is 1000 ms ahead; the slow sample is skewed by an uneven trip
    const fast = clockSample(0, 1010, 20);
    const slow = clockSample(100, 1400, 500);
    expect(fast).toEqual({ offset: 1000, rtt: 20 });
    expect(bestOffset([slow, fast])).toBe(1000);
    expect(bestOffset([])).toBe(0);
  });

  it('works out where the video should be now', () => {
    const base = { position: 60, rate: 1, updatedAt: 10_000 };
    expect(expectedPosition({ ...base, playing: false }, 99_000)).toBe(60);
    expect(expectedPosition({ ...base, playing: true }, 14_000)).toBe(64);
    expect(expectedPosition({ ...base, playing: true, rate: 1.5 }, 14_000)).toBe(66);
  });

  it('ignores small drift, nudges medium drift, seeks large drift', () => {
    expect(driftAction(0.2, 1, true, false)).toEqual({ do: 'nothing' });
    expect(driftAction(-0.8, 1, true, false)).toEqual({ do: 'nudge', rate: 1.05 }); // behind → faster
    expect(driftAction(0.8, 1.5, true, false)).toEqual({ do: 'nudge', rate: 1.5 * 0.95 }); // ahead → slower
    expect(driftAction(2, 1, true, false)).toEqual({ do: 'seek' });
    expect(driftAction(0.5, 1, false, false)).toEqual({ do: 'seek' }); // YouTube cannot nudge
  });

  it('keeps nudging until nearly exact once it has started', () => {
    expect(driftAction(-0.2, 1, true, true)).toEqual({ do: 'nudge', rate: 1.05 });
    expect(driftAction(-0.05, 1, true, true)).toEqual({ do: 'nothing' });
  });
});

describe('sources', () => {
  it('recognises YouTube links in their usual shapes', () => {
    for (const link of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
      'https://youtu.be/dQw4w9WgXcQ?si=abc',
      'https://m.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    ]) {
      expect(parseSource(link)).toMatchObject({ kind: 'youtube', id: 'dQw4w9WgXcQ' });
    }
  });
  it('treats other links as direct media and rejects the rest', () => {
    expect(parseSource('https://cdn.example.com/films/My%20Movie.mp4')).toEqual({
      kind: 'url', id: 'https://cdn.example.com/films/My%20Movie.mp4', title: 'My Movie.mp4',
    });
    expect(parseSource('https://www.youtube.com/feed/library')).toBeNull();
    expect(parseSource('not a link')).toBeNull();
    expect(parseSource('javascript:alert(1)')).toBeNull();
  });
  it('fingerprints a local file by size and whole seconds', () => {
    expect(fileFingerprint(734_003_200, 5400.4)).toBe('734003200-5400');
  });
});
