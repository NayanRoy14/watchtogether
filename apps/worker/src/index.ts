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

    if (url.pathname === '/api/fake-browser' && env.BROWSER_ENGINE === 'fake') return fakeBrowserPage(url);

    return json({ error: 'not_found' }, 404);
  },
} satisfies ExportedHandler<Env>;

async function createRoom(request: Request, env: Env): Promise<Response> {
  const body = CreateRoomRequest.safeParse(await request.json().catch(() => null));
  if (!body.success) return json({ error: 'bad_request' }, 400);

  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  const limiter = env.RATE_LIMIT.get(env.RATE_LIMIT.idFromName(`create:${ip}`));
  if (!(await limiter.take(CREATE_LIMIT, CREATE_WINDOW_MS))) return json({ error: 'rate_limited' }, 429);

  const hostId = await publicId(body.data.clientId);
  // A collision with a live room is ~1 in 887 million per attempt; retry anyway.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    if (await env.ROOM.get(env.ROOM.idFromName(code)).create(code, hostId)) return json({ code }, 201);
  }
  return json({ error: 'try_again' }, 503);
}
