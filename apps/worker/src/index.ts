import { CreateRoomRequest, generateCode, normalizeCode } from '@wt/shared';
import type { Env } from './env';
import { fakeBrowserPage } from './engines/fake';
import { publicId } from './ids';

export { Room } from './room';
export { RateLimit } from './ratelimit';
export { BrowserLease } from './lease';

const CREATE_LIMIT = 10;
const CREATE_WINDOW_MS = 60 * 60 * 1000;

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts[0] === 'api' && parts[1] === 'rooms') {
      if (parts.length === 2 && request.method === 'POST') return createRoom(request, env);
      if (parts.length === 3 && request.method === 'GET') {
        const code = normalizeCode(parts[2] ?? '');
        if (!code) return json({ exists: false, memberCount: 0, locked: false });
        return json(await env.ROOM.get(env.ROOM.idFromName(code)).info());
      }
    }

    if (parts[0] === 'ws' && parts.length === 2) {
      const code = normalizeCode(parts[1] ?? '');
      if (!code) return json({ error: 'not_found' }, 404);
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected_websocket' }, 426);
      return env.ROOM.get(env.ROOM.idFromName(code)).fetch(request);
    }

    if (url.pathname === '/api/ice' && request.method === 'GET') return json({ iceServers: await iceServers(env) });

    if (url.pathname === '/api/fake-browser' && env.BROWSER_ENGINE === 'fake') return fakeBrowserPage(url);

    return json({ error: 'not_found' }, 404);
  },
} satisfies ExportedHandler<Env>;

async function createRoom(request: Request, env: Env): Promise<Response> {
  const body = CreateRoomRequest.safeParse(await request.json().catch(() => null));
  if (!body.success) return json({ error: 'bad_request' }, 400);

  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  const limiter = env.RATE_LIMIT.get(env.RATE_LIMIT.idFromName(`create:${ip}`));
  const limit = Number(env.ROOM_CREATE_LIMIT) || CREATE_LIMIT;
  if (!(await limiter.take(limit, CREATE_WINDOW_MS))) return json({ error: 'rate_limited' }, 429);

  const hostId = await publicId(body.data.clientId);
  // A collision with a live room is ~1 in 887 million per attempt; retry anyway.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    if (await env.ROOM.get(env.ROOM.idFromName(code)).create(code, hostId)) return json({ code }, 201);
  }
  return json({ error: 'try_again' }, 503);
}

const STUN = [{ urls: 'stun:stun.l.google.com:19302' }];

/**
 * Servers the voice call uses to connect two people. STUN is enough on most networks;
 * with a Cloudflare TURN key configured, short-lived relay credentials are added for the rest.
 */
async function iceServers(env: Env): Promise<unknown[]> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_TOKEN) return STUN;
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 6 * 60 * 60 }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`TURN credentials → ${res.status}`);
    const body = (await res.json()) as { iceServers?: unknown };
    const relay = Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : [];
    return [...STUN, ...relay];
  } catch (err) {
    console.error('TURN unavailable, falling back to STUN', err);
    return STUN;
  }
}
