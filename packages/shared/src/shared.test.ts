import { describe, expect, it } from 'vitest';
import {
  CODE_ALPHABET, ClientMessage, formatCode, generateCode, hasControl, mayGiveControl, nextAlarm, normalizeCode,
  pickDriver, pickHost,
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
