import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
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

  /** Skip ahead to the first message of this type that satisfies the check. */
  async until<T extends ServerMessage['t']>(t: T, ok: (msg: Of<T>) => boolean): Promise<Of<T>> {
    for (;;) {
      const msg = await this.next(t);
      if (ok(msg)) return msg;
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
  const created = await env.ROOM.get(env.ROOM.idFromName(code)).create(code, await publicId(hostClientId));
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

/** Pretend the named deadlines have passed, then let the room's alarm run. */
async function elapse(code: string, ...names: Array<'close' | 'purge' | 'sweep'>): Promise<boolean> {
  const stub = env.ROOM.get(env.ROOM.idFromName(code));
  await runInDurableObject(stub, async (_room, state) => {
    const row = state.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'timers'").toArray()[0];
    const timers = JSON.parse(row?.value ?? '{}') as Record<string, number>;
    for (const name of names) if (name in timers) timers[name] = 1;
    state.storage.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('timers', ?)", JSON.stringify(timers));
    await state.storage.setAlarm(Date.now() + 60_000);
  });
  return runDurableObjectAlarm(stub);
}

const KEY = 'open sesame';

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

    await elapse(code, 'purge'); // nothing to purge while someone is inside
    expect((await stub.info()).exists).toBe(true);

    a.c.leave();
    await a.c.untilClosed();
    await expect.poll(async () => (await stub.info()).memberCount).toBe(0);
    await runDurableObjectAlarm(stub); // the alarm firing early must not delete anything
    expect((await stub.info()).exists).toBe(true);
    await elapse(code, 'purge');
    expect(await stub.info()).toEqual({ exists: false, memberCount: 0, locked: false });
  });
});

describe('Shared browser', () => {
  // Storage outlives a test, so hand the browser back for the next one.
  afterEach(async () => {
    const lease = env.BROWSER_LEASE.get(env.BROWSER_LEASE.idFromName('browser'));
    await runInDurableObject(lease, (_lease, state) => state.storage.deleteAll());
  });

  it('needs the owner passphrase, then gives each person their own private address', async () => {
    const { code, hostClientId } = await newRoom();
    const a = await join(code, 'Nayan', hostClientId);
    const b = await join(code, 'Riya');
    expect(a.welcome.browser).toEqual({ status: 'off', engine: null, driverId: null, requests: [] });

    b.c.send({ t: 'browser:open', ownerKey: 'guess' });
    expect((await b.c.next('error')).code).toBe('bad_owner_key');

    a.c.send({ t: 'browser:open', ownerKey: KEY });
    expect((await b.c.next('browser:status')).browser.status).toBe('starting');
    expect((await b.c.next('browser:status')).browser).toMatchObject({ status: 'live', engine: 'fake' });
    const forA = await a.c.next('browser:join');
    const forB = await b.c.next('browser:join');
    expect(forA.url).toContain(`member=${a.welcome.you}`);
    expect(forB.url).toContain(`member=${b.welcome.you}`);
    expect(forA.url).not.toBe(forB.url);

    // someone arriving later is let in without the passphrase
    const late = await join(code, 'Sam');
    expect(late.welcome.browser.status).toBe('live');
    expect((await late.c.next('browser:join')).url).toContain(`member=${late.welcome.you}`);

    // a reconnect gets the same address back, so the stream is not reloaded
    const again = await join(code, 'Riya', b.c.clientId);
    expect((await again.c.next('browser:join')).url).toBe(forB.url);
  });

  it('only the host can close it', async () => {
    const { code, hostClientId } = await newRoom();
    const a = await join(code, 'Nayan', hostClientId);
    const b = await join(code, 'Riya');
    a.c.send({ t: 'browser:open', ownerKey: KEY });
    await b.c.next('browser:join');

    b.c.send({ t: 'browser:close' });
    expect((await b.c.next('error')).code).toBe('not_host');
    a.c.send({ t: 'browser:close' });
    expect((await b.c.next('browser:status')).browser.status).toBe('off');
  });

  it('is held by one room at a time and freed when that room closes it', async () => {
    const one = await newRoom();
    const two = await newRoom();
    const a = await join(one.code, 'Nayan', one.hostClientId);
    const z = await join(two.code, 'Zoe', two.hostClientId);

    a.c.send({ t: 'browser:open', ownerKey: KEY });
    await a.c.next('browser:join');
    z.c.send({ t: 'browser:open', ownerKey: KEY });
    expect((await z.c.next('error')).code).toBe('browser_busy');
    expect((await z.c.next('browser:status')).browser.status).toBe('off');

    a.c.send({ t: 'browser:close' });
    expect((await a.c.next('browser:status')).browser.status).toBe('off');
    z.c.send({ t: 'browser:open', ownerKey: KEY });
    await z.c.next('browser:join');
  });

  it('closes itself two minutes after the room empties', async () => {
    const { code, hostClientId } = await newRoom();
    const stub = env.ROOM.get(env.ROOM.idFromName(code));
    const a = await join(code, 'Nayan', hostClientId);
    a.c.send({ t: 'browser:open', ownerKey: KEY });
    await a.c.next('browser:join');

    await elapse(code, 'close'); // not while someone is watching
    expect(await stub.browserActive()).toBe(true);

    a.c.leave();
    await a.c.untilClosed();
    await expect.poll(async () => (await stub.info()).memberCount).toBe(0);
    expect(await stub.browserActive()).toBe(true); // still open during the grace period
    await elapse(code, 'close');
    expect(await stub.browserActive()).toBe(false);
    expect((await stub.info()).exists).toBe(true); // the room itself stays for 24 h
  });

  it('removes the login of someone who left or was kicked', async () => {
    const { code, hostClientId } = await newRoom();
    const a = await join(code, 'Nayan', hostClientId);
    const riyaId = newClientId();
    const b = await join(code, 'Riya', riyaId);
    a.c.send({ t: 'browser:open', ownerKey: KEY });
    const first = await b.c.next('browser:join');

    b.c.leave();
    await a.c.next('members');
    await elapse(code, 'sweep');
    const back = await join(code, 'Riya', riyaId);
    expect((await back.c.next('browser:join')).url).not.toBe(first.url); // old login was removed
  });

  it('one-driver mode: request, give, take back, and fall back to the host', async () => {
    const { code, hostClientId } = await newRoom();
    const a = await join(code, 'Nayan', hostClientId);
    const b = await join(code, 'Riya');
    const c = await join(code, 'Sam');
    const [A, B, C] = [a.welcome.you, b.welcome.you, c.welcome.you];
    const driver = (who: string) => c.c.until('browser:status', (m) => m.browser.driverId === who);

    a.c.send({ t: 'settings', settings: { controlMode: 'driver' } });
    expect((await driver(A)).browser.requests).toEqual([]); // the host drives by default

    b.c.send({ t: 'browser:request-control' });
    await c.c.until('browser:status', (m) => m.browser.requests.includes(B));

    c.c.send({ t: 'browser:give-control', id: C }); // Sam is neither host nor driver
    expect((await c.c.next('error')).code).toBe('no_control');

    a.c.send({ t: 'browser:give-control', id: B });
    const seats = await a.c.until('members', (m) => m.members[0]?.hasControl === false);
    expect(seats.members.map((m) => m.hasControl)).toEqual([false, true, false]);
    expect((await driver(B)).browser.requests).toEqual([]); // the request is answered

    b.c.send({ t: 'browser:give-control', id: C }); // the driver may pass it on
    await driver(C);
    a.c.send({ t: 'browser:give-control' }); // the host takes it back
    await driver(A);

    a.c.send({ t: 'browser:give-control', id: B });
    await driver(B);
    b.c.leave(); // the driver leaves → control returns to the host
    await driver(A);

    a.c.send({ t: 'settings', settings: { controlMode: 'everyone' } });
    const open = await c.c.until('browser:status', (m) => m.browser.driverId === null);
    expect(open.browser.requests).toEqual([]);
  });

});
