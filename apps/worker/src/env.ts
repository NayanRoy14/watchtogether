import type { Room } from './room';
import type { RateLimit } from './ratelimit';

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  RATE_LIMIT: DurableObjectNamespace<RateLimit>;
}
