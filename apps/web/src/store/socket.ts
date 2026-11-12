import { CLOSE_REPLACED, ServerMessage, type ClientMessage } from '@wt/shared';
import { getRoom } from '../lib/api';

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'ended';
/** Why a session ended for good. Server error codes plus two the client works out itself. */
export type EndReason = 'kicked' | 'room_full' | 'room_locked' | 'replaced' | 'not_found';

const FATAL = new Set<string>(['kicked', 'room_full', 'room_locked']);
const PING_EVERY_MS = 30_000;
const CLOCK_BURST = 5;

interface Handlers {
  hello: () => Extract<ClientMessage, { t: 'hello' }>;
  onMessage: (msg: ServerMessage) => void;
  onConnection: (state: Connection, reason?: EndReason) => void;
}

/** One room connection that keeps itself alive: 0.5 s, 1 s, 2 s … 10 s between retries. */
export class RoomSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(private readonly code: string, private readonly handlers: Handlers) {}

  start(): void {
    this.handlers.onConnection('connecting');
    this.open();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    this.ws?.close(1000);
    this.ws = null;
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private end(reason: EndReason): void {
    this.stop();
    this.handlers.onConnection('ended', reason);
  }

  private open(): void {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${location.host}/ws/${this.code}`);
    this.ws = ws;

    ws.onopen = () => {
      this.send(this.handlers.hello());
      // A quick burst to pin down the server clock, then a slow trickle to keep it honest.
      for (let i = 0; i < CLOCK_BURST; i++) setTimeout(() => ws === this.ws && this.ping(), i * 250);
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.ping(), PING_EVERY_MS);
    };

    ws.onmessage = (event) => {
      if (ws !== this.ws || typeof event.data !== 'string') return;
      let parsed;
      try {
        parsed = ServerMessage.safeParse(JSON.parse(event.data));
      } catch {
        return;
      }
      if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.t === 'welcome') {
        this.attempt = 0;
        this.handlers.onConnection('live');
      }
      if (msg.t === 'error' && FATAL.has(msg.code)) return this.end(msg.code as EndReason);
      this.handlers.onMessage(msg);
    };

    ws.onclose = (event) => {
      if (ws !== this.ws || this.stopped) return;
      clearInterval(this.pingTimer);
      if (event.code === CLOSE_REPLACED) return this.end('replaced');
      this.handlers.onConnection('reconnecting');
      void this.retry();
    };
  }

  private async retry(): Promise<void> {
    // After a few failures, check the room is still there before trying forever.
    if (this.attempt >= 3) {
      const info = await getRoom(this.code).catch(() => null);
      if (this.stopped) return;
      if (info && !info.exists) return this.end('not_found');
    }
    const delay = Math.min(500 * 2 ** this.attempt, 10_000);
    this.attempt += 1;
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  private ping(): void {
    this.send({ t: 'ping', t0: Date.now() });
  }
}
