import { describe, expect, it } from 'vitest';
import { NekoEngine } from '../src/engines/neko';

/** A scripted neko: remembers accounts and records every call the engine makes. */
function scriptedNeko(initial: string[] = []) {
  const accounts = new Map<string, { can_host: boolean; name?: string }>(initial.map((id) => [id, { can_host: true }]));
  const calls: string[] = [];
  const screens: string[] = [];
  let down = false;

  const http = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}`);
    if (down) throw new Error('connection refused');
    if (new Headers(init?.headers).get('Authorization') !== 'Bearer admin-token') return new Response(null, { status: 401 });

    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const id = url.pathname.startsWith('/api/members/') ? url.pathname.split('/')[3] : undefined;
    if (url.pathname === '/api/members' && method === 'GET') return Response.json([...accounts.keys()].map((k) => ({ id: k })));
    if (url.pathname === '/api/members' && method === 'POST') {
      const profile = body.profile as { can_host: boolean; name: string };
      accounts.set(body.username as string, { can_host: profile.can_host, name: profile.name });
      return Response.json({ id: body.username });
    }
    if (id && method === 'DELETE') return new Response(null, { status: accounts.delete(id) ? 204 : 404 });
    if (id && method === 'POST') {
      accounts.set(id, { can_host: body.can_host as boolean, name: body.name as string });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/api/room/settings') return new Response(null, { status: 204 });
    if (url.pathname === '/api/room/screen') {
      screens.push(`${body.width}x${body.height}@${body.rate}`);
      return Response.json(body);
    }
    return new Response(null, { status: 404 });
  };

  return { http, accounts, calls, screens, goDown: () => (down = true) };
}

describe('NekoEngine', () => {
  it('reports unhealthy when the server is unreachable or rejects the token', async () => {
    const neko = scriptedNeko();
    expect(await new NekoEngine('https://neko.test/', 'admin-token', neko.http).healthy()).toBe(true);
    expect(await new NekoEngine('https://neko.test', 'wrong', neko.http).healthy()).toBe(false);
    neko.goDown();
    expect(await new NekoEngine('https://neko.test', 'admin-token', neko.http).healthy()).toBe(false);
  });

  it('clears another room’s leftovers on start but keeps unrelated accounts', async () => {
    const neko = scriptedNeko(['wt-oldroom-aaa', 'wt-k7m2qx-bbb', 'nayan']);
    await new NekoEngine('https://neko.test', 'admin-token', neko.http).start('K7M2QX');
    expect([...neko.accounts.keys()].sort()).toEqual(['nayan', 'wt-k7m2qx-bbb']);
    expect(neko.calls).toContain('POST /api/room/settings');
  });

  it('creates one account per person with a fresh password and an embeddable address', async () => {
    const neko = scriptedNeko();
    const engine = new NekoEngine('https://neko.test', 'admin-token', neko.http);
    const first = new URL(await engine.addMember('K7M2QX', { id: 'abc123', name: 'Riya', canControl: true }));
    const second = new URL(await engine.addMember('K7M2QX', { id: 'abc123', name: 'Riya', canControl: false }));

    expect(first.origin).toBe('https://neko.test');
    expect(first.searchParams.get('usr')).toBe('wt-k7m2qx-abc123');
    expect(first.searchParams.get('embed')).toBe('1');
    expect(first.searchParams.get('pwd')).toMatch(/^[0-9a-f]{32}$/);
    expect(second.searchParams.get('pwd')).not.toBe(first.searchParams.get('pwd'));
    expect(neko.accounts.get('wt-k7m2qx-abc123')).toEqual({ can_host: false, name: 'Riya' }); // their real name, for the cursor label
  });

  it('applies control per person and logs only its own room out on stop', async () => {
    const neko = scriptedNeko(['nayan']);
    const engine = new NekoEngine('https://neko.test', 'admin-token', neko.http);
    await engine.addMember('K7M2QX', { id: 'a', name: 'Nayan', canControl: true });
    await engine.addMember('K7M2QX', { id: 'b', name: 'Riya', canControl: true });

    await engine.setControl('K7M2QX', [
      { id: 'a', name: 'Nayan', canControl: true },
      { id: 'b', name: 'Riya', canControl: false },
    ]);
    expect(neko.accounts.get('wt-k7m2qx-a')).toEqual({ can_host: true, name: 'Nayan' });
    expect(neko.accounts.get('wt-k7m2qx-b')).toEqual({ can_host: false, name: 'Riya' });

    await engine.removeMember('K7M2QX', 'b');
    expect(neko.accounts.has('wt-k7m2qx-b')).toBe(false);
    await engine.stop('K7M2QX');
    expect([...neko.accounts.keys()]).toEqual(['nayan']);
  });

  it('maps each quality to a 16:9 screen size neko supports', async () => {
    const neko = scriptedNeko();
    const engine = new NekoEngine('https://neko.test', 'admin-token', neko.http);
    for (const q of ['540p', '720p', '1080p'] as const) await engine.setQuality(q);
    expect(neko.screens).toEqual(['960x540@30', '1280x720@30', '1920x1080@30']);
  });
});
