import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { generateCode, type ClientMessage, type ServerMessage, type Source } from '@wt/shared';
import { publicId } from '../src/ids';

type Of<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>;

class Client {
  private queue: ServerMessage[] = [];
  private wake: Array<() => void> = [];
  you = '';

  constructor(private ws: WebSocket) {
    ws.accept();
    ws.addEventListener('message', (e) => {
      this.queue.push(JSON.parse(e.data as string) as ServerMessage);
      for (const w of this.wake.splice(0)) w();
    });
  }
  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }
  leave(): void {
    this.ws.close(1000);
  }
  /** First message of this type that passes the check; everything before it is dropped. */
  async until<T extends ServerMessage['t']>(t: T, ok: (m: Of<T>) => boolean = () => true): Promise<Of<T>> {
    const deadline = Date.now() + 2000;
    for (;;) {
      while (this.queue.length > 0) {
        const msg = this.queue.shift();
        if (msg?.t === t && ok(msg as Of<T>)) return msg as Of<T>;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for "${t}"`);
      await new Promise<void>((r) => {
        this.wake.push(r);
        setTimeout(r, 50);
      });
    }
  }
}

async function room(names: string[]): Promise<Client[]> {
  const code = generateCode();
  const hostClientId = `host-${crypto.randomUUID()}`;
  await env.ROOM.get(env.ROOM.idFromName(code)).create(code, await publicId(hostClientId));
  const clients: Client[] = [];
  for (const [i, name] of names.entries()) {
    const res = await SELF.fetch(`https://wt.test/ws/${code}`, { headers: { Upgrade: 'websocket' } });
    if (!res.webSocket) throw new Error('no websocket');
    const c = new Client(res.webSocket);
    c.send({ t: 'hello', name, clientId: i === 0 ? hostClientId : `guest-${crypto.randomUUID()}`, color: '#f2a93b' });
    c.you = (await c.until('welcome')).you;
    clients.push(c);
  }
  return clients;
}

const movie: Source = { kind: 'url', id: 'https://cdn.test/movie.mp4', title: 'movie.mp4' };
const short: Source = { kind: 'youtube', id: 'dQw4w9WgXcQ', title: 'YouTube video' };

describe('Direct mode playback', () => {
  it('loads paused at zero, then every change is stamped, numbered and sent to all', async () => {
    const [a, b] = await room(['Nayan', 'Riya']);
    a!.send({ t: 'load', source: movie });
    const loaded = (await b!.until('state')).state;
    expect(loaded).toMatchObject({ source: movie, playing: false, position: 0, rate: 1, by: 'Nayan' });

    b!.send({ t: 'intent', action: 'play', position: 12 });
    const played = (await a!.until('state', (m) => m.state?.playing === true)).state;
    expect(played).toMatchObject({ playing: true, position: 12, by: 'Riya' });
    expect(played!.seq).toBe(loaded!.seq + 1);
    expect(Math.abs(played!.updatedAt - Date.now())).toBeLessThan(3000);
    // the person who pressed play gets the same message as everyone else
    expect((await b!.until('state', (m) => m.state?.playing === true)).state).toEqual(played);

    a!.send({ t: 'intent', action: 'rate', position: 20, rate: 1.5 });
    expect((await b!.until('state', (m) => m.state?.rate === 1.5)).state).toMatchObject({ playing: true, position: 20 });
    a!.send({ t: 'intent', action: 'seek', position: 300 });
    expect((await b!.until('state', (m) => m.state?.position === 300)).state).toMatchObject({ playing: true, rate: 1.5 });
  });

  it('gives late joiners the current state, queue and mode', async () => {
    const code = generateCode();
    const hostClientId = `host-${crypto.randomUUID()}`;
    await env.ROOM.get(env.ROOM.idFromName(code)).create(code, await publicId(hostClientId));
    const open = async (name: string, clientId: string): Promise<{ c: Client; welcome: Of<'welcome'> }> => {
      const res = await SELF.fetch(`https://wt.test/ws/${code}`, { headers: { Upgrade: 'websocket' } });
      const c = new Client(res.webSocket!);
      c.send({ t: 'hello', name, clientId, color: '#f2a93b' });
      return { c, welcome: await c.until('welcome') };
    };
    const { c: a, welcome } = await open('Nayan', hostClientId);
    expect(welcome).toMatchObject({ mode: 'browser', state: null, queue: [], waiting: [] });

    a.send({ t: 'mode', mode: 'direct' });
    a.send({ t: 'load', source: movie });
    a.send({ t: 'intent', action: 'play', position: 40 });
    a.send({ t: 'queue', op: 'add', source: short });
    await a.until('queue', (m) => m.queue.length === 1);

    const late = (await open('Riya', `guest-${crypto.randomUUID()}`)).welcome;
    expect(late.mode).toBe('direct');
    expect(late.state).toMatchObject({ source: movie, playing: true, position: 40 });
    expect(late.queue.map((q) => q.source.id)).toEqual([short.id]);
  });

  it('refuses playback changes from people without control', async () => {
    const [a, b] = await room(['Nayan', 'Riya']);
    a!.send({ t: 'settings', settings: { controlMode: 'driver' } });
    await b!.until('settings');
    for (const msg of [
      { t: 'load', source: movie },
      { t: 'intent', action: 'play', position: 0 },
      { t: 'queue', op: 'add', source: short },
      { t: 'mode', mode: 'direct' },
    ] as ClientMessage[]) {
      b!.send(msg);
      expect((await b!.until('error')).code).toBe('no_control');
    }
  });

  it('pauses everyone while someone buffers and resumes from the same spot', async () => {
    const [a, b] = await room(['Nayan', 'Riya']);
    a!.send({ t: 'load', source: movie });
    a!.send({ t: 'intent', action: 'play', position: 100 });
    await a!.until('state', (m) => m.state?.playing === true);
    await b!.until('state', (m) => m.state?.playing === true);

    b!.send({ t: 'buffering', value: true });
    const frozen = (await a!.until('state', (m) => m.state?.playing === false)).state!;
    expect(frozen.position).toBeGreaterThanOrEqual(100);
    expect(frozen.position).toBeLessThan(103);
    expect((await a!.until('waiting', (m) => m.for.length > 0)).for).toEqual(['Riya']);
    expect((await b!.until('members', (m) => m.members[1]?.buffering === true)).members).toHaveLength(2);

    b!.send({ t: 'buffering', value: false });
    const resumed = (await a!.until('state', (m) => m.state?.playing === true)).state!;
    expect(resumed.position).toBe(frozen.position);
    expect((await a!.until('waiting')).for).toEqual([]);
  });

  it('does not resume by itself if someone paused during the wait, or stay stuck if the staller leaves', async () => {
    const [a, b] = await room(['Nayan', 'Riya']);
    a!.send({ t: 'load', source: movie });
    a!.send({ t: 'intent', action: 'play', position: 0 });
    await b!.until('state', (m) => m.state?.playing === true);
    b!.send({ t: 'buffering', value: true });
    await a!.until('waiting', (m) => m.for.length > 0);
    a!.send({ t: 'intent', action: 'pause', position: 1 });
    const paused = (await a!.until('state', (m) => m.state?.by === 'Nayan' && m.state.playing === false)).state!;
    b!.send({ t: 'buffering', value: false });
    a!.send({ t: 'ping', t0: 1 });
    await a!.until('pong'); // nothing resumed in between
    a!.send({ t: 'intent', action: 'play', position: 1 });
    expect((await a!.until('state', (m) => m.state?.playing === true)).state!.seq).toBe(paused.seq + 1);

    b!.send({ t: 'buffering', value: true });
    await a!.until('waiting', (m) => m.for.length > 0);
    b!.leave();
    expect((await a!.until('state', (m) => m.state?.playing === true)).state!.by).toBe('');
  });

  it('respects the "wait for everyone" switch', async () => {
    const [a, b] = await room(['Nayan', 'Riya']);
    a!.send({ t: 'settings', settings: { waitForAll: false } });
    a!.send({ t: 'load', source: movie });
    a!.send({ t: 'intent', action: 'play', position: 0 });
    const playing = (await a!.until('state', (m) => m.state?.playing === true)).state!;
    await b!.until('state', (m) => m.state?.playing === true);
    b!.send({ t: 'buffering', value: true });
    await a!.until('members', (m) => m.members[1]?.buffering === true);
    a!.send({ t: 'intent', action: 'seek', position: 5 });
    expect((await a!.until('state', (m) => m.state?.position === 5)).state!.seq).toBe(playing.seq + 1); // no pause in between
  });

  it('runs the queue: add, reorder, remove, play now, and advance when a video ends', async () => {
    const [a, b] = await room(['Nayan', 'Riya']);
    const second: Source = { ...movie, id: 'https://cdn.test/two.mp4', title: 'two.mp4' };
    a!.send({ t: 'queue', op: 'add', source: short });
    a!.send({ t: 'queue', op: 'add', source: movie });
    await b!.until('queue', (m) => m.queue.length === 2);
    b!.send({ t: 'queue', op: 'add', source: second });
    const three = (await a!.until('queue', (m) => m.queue.length === 3)).queue;
    expect(three.map((q) => [q.source.title, q.addedBy])).toEqual([
      ['YouTube video', 'Nayan'], ['movie.mp4', 'Nayan'], ['two.mp4', 'Riya'],
    ]);

    a!.send({ t: 'queue', op: 'move', id: three[2]!.id, to: 0 });
    expect((await b!.until('queue', (m) => m.queue[0]?.source.title === 'two.mp4')).queue).toHaveLength(3);
    a!.send({ t: 'queue', op: 'remove', id: three[0]!.id });
    await b!.until('queue', (m) => m.queue.length === 2);

    a!.send({ t: 'queue', op: 'play', id: three[1]!.id });
    const now = (await b!.until('state')).state!;
    expect(now).toMatchObject({ source: movie, playing: true, position: 0 });
    await a!.until('queue', (m) => m.queue.length === 1);

    // both players report the end; only the first report advances the queue
    a!.send({ t: 'ended', seq: now.seq });
    b!.send({ t: 'ended', seq: now.seq });
    const next = (await a!.until('state', (m) => m.state?.source.id === second.id)).state!;
    expect(next).toMatchObject({ playing: true, position: 0, seq: now.seq + 1 });
    a!.send({ t: 'ended', seq: next.seq });
    expect((await b!.until('state', (m) => m.state?.playing === false)).state!.source.id).toBe(second.id);
  });
});

describe('Call and reactions', () => {
  it('tells a joiner who to ring, and relays signalling only to the addressee', async () => {
    const [a, b, c] = await room(['Nayan', 'Riya', 'Sam']);
    a!.send({ t: 'call', on: true, camera: false });
    expect((await a!.until('call:peers')).ids).toEqual([]);
    b!.send({ t: 'call', on: true, camera: true });
    expect((await b!.until('call:peers')).ids).toEqual([a!.you]);
    const seen = await c!.until('members', (m) => m.members[1]?.inCall === true);
    expect(seen.members.map((m) => [m.inCall, m.camera])).toEqual([[true, false], [true, true], [false, false]]);

    b!.send({ t: 'rtc', to: a!.you, kind: 'offer', data: { sdp: 'v=0' } });
    expect(await a!.until('rtc')).toMatchObject({ from: b!.you, kind: 'offer', data: { sdp: 'v=0' } });

    c!.send({ t: 'rtc', to: a!.you, kind: 'offer', data: {} }); // Sam is not in the call
    c!.send({ t: 'react', emoji: '🔥' });
    expect(await a!.until('react')).toMatchObject({ memberId: c!.you, emoji: '🔥' });
    a!.send({ t: 'ping', t0: 1 });
    await a!.until('pong');

    b!.send({ t: 'call', on: false, camera: false });
    expect((await c!.until('members', (m) => m.members[1]?.inCall === false)).members[1]?.camera).toBe(false);
  });
});
