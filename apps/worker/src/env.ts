import type { Room } from './room';
import type { RateLimit } from './ratelimit';
import type { BrowserLease } from './lease';

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  RATE_LIMIT: DurableObjectNamespace<RateLimit>;
  BROWSER_LEASE: DurableObjectNamespace<BrowserLease>;

  // Secrets (wrangler secret put …). All optional: without them the browser reports "offline".
  /** e.g. https://nayan-watch.duckdns.org */
  NEKO_URL?: string;
  NEKO_ADMIN_TOKEN?: string;
  /** Only someone who knows this may start the shared browser. */
  OWNER_PASSPHRASE?: string;
  /** Cloudflare Realtime TURN key, for calls on networks that block direct connections. */
  TURN_KEY_ID?: string;
  TURN_KEY_TOKEN?: string;
  /** Rooms one IP address may create per hour (default 10). Raised for automated tests. */
  ROOM_CREATE_LIMIT?: string;
  /** "fake" swaps neko for a stand-in page, for local development and tests. */
  BROWSER_ENGINE?: string;
}
