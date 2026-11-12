import { SELF, env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CLOSE_REJECTED, CLOSE_REPLACED, generateCode, type ClientMessage, type ServerMessage } from '@wt/shared';
import { publicId } from '../src/ids';

type Of<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>;

/** A test client: queues incoming messages so tests can await them in order. */
class Client {
  private queue: ServerMessage[] = [];
  private waiters: Array<() => void> = [];
  closed: { code: number } | null = null;

  constructor(private ws: WebSocket, readonly clientId: string) {
    ws.accept();
    ws.addEventListener('message', (e) => {
      this.queue.push(JSON.parse(e.data as string) as ServerMessage);
      this.wake();
    });
    ws.addEventListener('close', (e) => {
      this.closed = { code: e.code };
      this.wake();
    });
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  send(msg: ClientMessage | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Next message of the given type; earlier messages of other types are discarded. */
  async next<T extends ServerMessage['t']>(t: T): Promise<Of<T>> {
    const deadline = Date.now() + 2000;
    for (;;) {
      while (this.queue.length > 0) {
        const msg = this.queue.shift();
        if (msg?.t === t) return msg as Of<T>;
      }
      if (this.closed) throw new Error(`socket closed (${this.closed.code}) while waiting for "${t}"`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for "${t}"`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  }

  async untilClosed(): Promise<number> {
    const deadline = Date.now() + 2000;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error('timed out waiting for close');
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
    return this.closed.code;
  }

  leave(): void {
    this.ws.close(1000);
  }
}

let counter = 0;
const newClientId = (): string => `client-${++counter}-${crypto.randomUUID()}`;

async function newRoom(hostClientId = newClientId()): Promise<{ code: string; hostClientId: string }> {
  const code = generateCode();
  const created = await env.ROOM.get(env.ROOM.idFromName(code)).create(await publicId(hostClientId));
  expect(created).toBe(true);
  return { code, hostClientId };
}

async function connect(code: string, clientId = newClientId()): Promise<Client> {
  const res = await SELF.fetch(`https://wt.test/ws/${code}`, { headers: { Upgrade: 'websocket' } });
  expect(res.status).toBe(101);
  if (!res.webSocket) throw new Error('no websocket on response');
  return new Client(res.webSocket, clientId);
}

async function join(code: string, name: string, clientId = newClientId()): Promise<{ c: Client; welcome: Of<'welcome'> }> {
  const c = await connect(code, clientId);
  c.send({ t: 'hello', name, clientId, color: '#f2a93b' });
  return { c, welcome: await c.next('welcome') };
}

describe('HTTP routes', () => {
  it('creates a room, reports it, and rate-limits creation per IP', async () => {
    const post = (): Promise<Response> =>
      SELF.fetch('https://wt.test/api/rooms', { method: 'POST', body: JSON.stringify({ clientId: 'creator-0001' }) });

    const first = await post();
    expect(first.status).toBe(201);
    const { code } = await first.json<{ code: string }>();
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);

    const info = await SELF.fetch(`https://wt.test/api/rooms/${code.toLowerCase()}`);
    expect(await info.json()).toEqual({ exists: true, memberCount: 0, locked: false });

    for (let i = 0; i < 9; i++) expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(429);
  });

  it('says a made-up room does not exist and refuses its socket', async () => {
    const info = await SELF.fetch('https://wt.test/api/rooms/ZZZZZZ');
    expect(await info.json()).toEqual({ exists: false, memberCount: 0, locked: false });
    const ws = await SELF.fetch('https://wt.test/ws/ZZZZZZ', { headers: { Upgrade: 'websocket' } });
    expect(ws.status).toBe(404);
  });
});

describe('Room', () => {
  it('welcomes the creator as host and tells everyone when a friend joins', async () => {
    const { code, hostClientId } = await newRoom();
    const a = await join(code, 'Nayan', hostClientId);
    expect(a.welcome.members).toHaveLength(1);
    expect(a.welcome.members[0]).toMatchObject({ name: 'Nayan', isHost: true, hasControl: true });

    const b = await join(code, 'Riya');
    expect(b.welcome.members.map((m) => m.name)).toEqual(['Nayan', 'Riya']);
    expect(b.welcome.members[1]).toMatchObject({ isHost: false, hasControl: true });
    expect((await a.c.next('members')).members).toHaveLength(2);
    // nobody's private clientId is ever sent to another member
    expect(JSON.stringify(b.welcome)).not.toContain(hostClientId);
  });

  it('broadcasts chat, keeps it for late joiners, and throttles floods', async () => {
    const { code, hostClientId } = await newRoom();
    const a = await join(code, 'Nayan', hostClientId);
    const b = await join(code, 'Riya');

    b.c.send({ t: 'chat', text: '  hello  ' });
    const got = await a.c.next('chat');
    expect(got.message).toMatchObject({ name: 'Riya', text: 'hello', memberId: b.welcome.you });
    await b.c.next('chat');

    const late = await join(code, 'Sam');
    expect(late.welcome.chat.map((m) => m.text)).toEqual(['hello']);

    for (let i = 0; i < 8; i++) b.c.send({ t: 'chat', text: `spam ${i}` });
    expect((await b.c.next('error')).code).toBe('rate_limited');
  });

  it('answers ping with the server clock and rejects malformed messages', async () => {
    const { code } = await newRoom();
    const a = await join(code, 'Nayan');
    a.c.send({ t: 'ping', t0: 123 });
    const pong = await a.c.next('pong');
    expect(pong.t0).toBe(123);
    expect(Math.abs(pong.serverTime - Date.now())).toBeLessThan(5000);

    a.c.send({ t: 'chat', text: '' });
    expect((await a.c.next('error')).code).toBe('bad_message');

    const silent = await connect(code);
    silent.send({ t: 'chat', text: 'before hello' });
    expect((await silent.next('error')).code).toBe('bad_message');
  });

  it('hands the host seat to the longest-standing member when the host leaves', async () => {
    const { code, hostClientId } = await newRoom();
    const a = await join(code, 'Nayan', hostClientId);
    const b = await join(code, 'Riya');
    const c = await join(code, 'Sam');
    await b.c.next('members'); // Sam joining

    a.c.leave();
    const after = await b.c.next('members');
    expect(after.members.map((m) => [m.name, m.isHost])).toEqual([['Riya', true], ['Sam', false]]);
    expect((await c.c.next('members')).members).toHaveLength(2);
  });

  it('lets only the host change settings, transfer host and kick', async () => {
    const { code, hostClientId } = await newRoom();
    const a = await join(code, 'Nayan', hostClientId);
    const b = await join(code, 'Riya');

    b.c.send({ t: 'settings', settings: { locked: true } });
    expect((await b.c.next('error')).code).toBe('not_host');
    b.c.send({ t: 'kick', id: a.welcome.you });
    expect((await b.c.next('error')).code).toBe('not_host');

    a.c.send({ t: 'settings', settings: { controlMode: 'driver' } });
    expect((await b.c.next('settings')).settings.controlMode).toBe('driver');
    const driverMode = await b.c.next('members');
    expect(driverMode.members.map((m) => m.hasControl)).toEqual([true, false]);

    a.c.send({ t: 'transfer-host', id: b.welcome.you });
    const swapped = await b.c.next('members');
    expect(swapped.members.map((m) => m.isHost)).toEqual([false, true]);

    b.c.send({ t: 'kick', id: a.welcome.you });
    expect((await a.c.next('error')).code).toBe('kicked');
    expect(await a.c.untilClosed()).toBe(CLOSE_REJECTED);
    expect((await b.c.next('members')).members).toHaveLength(1);

    // a kicked person cannot walk straight back in
    const again = await connect(code, hostClientId);
    again.send({ t: 'hello', name: 'Nayan', clientId: hostClientId, color: '#f2a93b' });
    expect((await again.next('error')).code).toBe('kicked');
  });

  it('keeps strangers out of a locked room but lets members reconnect', async () => {
    const { code, hostClientId } = await newRoom();
    const a = await join(code, 'Nayan', hostClientId);
    const friendId = newClientId();
    const b = await join(code, 'Riya', friendId);
    a.c.send({ t: 'settings', settings: { locked: true } });
    await b.c.next('settings');

    const stranger = await connect(code);
    stranger.send({ t: 'hello', name: 'Stranger', clientId: stranger.clientId, color: '#f2a93b' });
    expect((await stranger.next('error')).code).toBe('room_locked');

    // Riya's second connection replaces her first and keeps her place in the order
    const b2 = await join(code, 'Riya', friendId);
    expect(await b.c.untilClosed()).toBe(CLOSE_REPLACED);
    expect(b2.welcome.members.map((m) => m.name)).toEqual(['Nayan', 'Riya']);
  });

  it('caps the room at 10 people', async () => {
    const { code } = await newRoom();
    for (let i = 0; i < 10; i++) await join(code, `P${i}`);
    const extra = await connect(code);
    extra.send({ t: 'hello', name: 'Eleven', clientId: extra.clientId, color: '#f2a93b' });
    expect((await extra.next('error')).code).toBe('room_full');
  });

  it('deletes everything when the alarm fires on an empty room, but not on a busy one', async () => {
    const { code, hostClientId } = await newRoom();
    const stub = env.ROOM.get(env.ROOM.idFromName(code));
    const a = await join(code, 'Nayan', hostClientId);
    a.c.send({ t: 'chat', text: 'still here' });
    await a.c.next('chat');

    await runDurableObjectAlarm(stub); // no alarm is pending while someone is inside
    expect((await stub.info()).exists).toBe(true);

    a.c.leave();
    await a.c.untilClosed();
    await expect.poll(async () => (await stub.info()).memberCount).toBe(0);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.info()).toEqual({ exists: false, memberCount: 0, locked: false });
  });
});
