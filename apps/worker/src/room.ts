import { DurableObject } from 'cloudflare:workers';
import {
  CHAT_KEPT,
  CHAT_ON_JOIN,
  CLOSE_REJECTED,
  CLOSE_REPLACED,
  ClientMessage,
  DEFAULT_SETTINGS,
  MAX_MEMBERS,
  hasControl,
  pickHost,
  type ChatMessage,
  type ErrorCode,
  type Member,
  type RoomInfo,
  type RoomSettings,
  type ServerMessage,
} from '@wt/shared';
import type { Env } from './env';
import { publicId } from './ids';

const PURGE_AFTER_MS = 24 * 60 * 60 * 1000;
const CHAT_BURST = 5; // messages allowed at once
const CHAT_REFILL_MS = 1000; // one more every second

/** Survives hibernation: stored on the socket itself. Absent until `hello`. */
interface Seat {
  id: string;
  name: string;
  color: string;
  joinedAt: number;
  chatTokens: number;
  chatAt: number;
}

interface Seated {
  ws: WebSocket;
  seat: Seat;
}

type ChatRow = { id: number; member_id: string; name: string; color: string; text: string; at: number };

export class Room extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
  }

  private migrate(): void {
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS chat (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         member_id TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL,
         text TEXT NOT NULL, at INTEGER NOT NULL)`,
    );
  }

  // ---- called by the Worker (RPC) -----------------------------------------

  /** Returns false when a room with this code already exists. */
  async create(hostId: string): Promise<boolean> {
    if (this.exists()) return false;
    this.put('created', Date.now());
    this.put('hostId', hostId);
    this.put('settings', DEFAULT_SETTINGS);
    await this.ctx.storage.setAlarm(Date.now() + PURGE_AFTER_MS);
    return true;
  }

  info(): RoomInfo {
    if (!this.exists()) return { exists: false, memberCount: 0, locked: false };
    return { exists: true, memberCount: this.seated().length, locked: this.settings().locked };
  }

  override async fetch(): Promise<Response> {
    if (!this.exists()) return Response.json({ error: 'not_found' }, { status: 404 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ---- socket events --------------------------------------------------------

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const msg = parse(raw);
    if (!msg) return send(ws, { t: 'error', code: 'bad_message' });

    const seat = seatOf(ws);
    if (msg.t === 'hello') return seat ? undefined : this.onHello(ws, msg);
    if (!seat) return send(ws, { t: 'error', code: 'bad_message' });

    switch (msg.t) {
      case 'ping':
        return send(ws, { t: 'pong', t0: msg.t0, serverTime: Date.now() });
      case 'chat':
        return this.onChat(ws, seat, msg.text);
      case 'settings': {
        if (!this.isHost(seat)) return send(ws, { t: 'error', code: 'not_host' });
        const settings = { ...this.settings(), ...msg.settings };
        this.put('settings', settings);
        this.broadcast({ t: 'settings', settings });
        return this.broadcastMembers();
      }
      case 'transfer-host': {
        if (!this.isHost(seat)) return send(ws, { t: 'error', code: 'not_host' });
        if (!this.seated().some((s) => s.seat.id === msg.id)) return;
        this.put('hostId', msg.id);
        return this.broadcastMembers();
      }
      case 'kick': {
        if (!this.isHost(seat)) return send(ws, { t: 'error', code: 'not_host' });
        if (msg.id === seat.id) return;
        const target = this.seated().find((s) => s.seat.id === msg.id);
        if (!target) return;
        this.put('kicked', [...this.kicked(), msg.id]);
        reject(target.ws, 'kicked');
        return this.broadcastMembers();
      }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // already closed
    }
    await this.onLeave(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.onLeave(ws);
  }

  /** Fires 24 h after the room emptied (or was created and never used). */
  override async alarm(): Promise<void> {
    if (this.seated().length > 0) return;
    await this.ctx.storage.deleteAll();
    this.migrate();
  }

  // ---- handlers ---------------------------------------------------------------

  private async onHello(ws: WebSocket, msg: Extract<ClientMessage, { t: 'hello' }>): Promise<void> {
    const id = await publicId(msg.clientId);
    if (this.kicked().includes(id)) return reject(ws, 'kicked');

    const others = this.seated();
    const previous = others.find((s) => s.seat.id === id);
    const hostId = this.get<string>('hostId');
    if (!previous) {
      if (this.settings().locked && id !== hostId) return reject(ws, 'room_locked');
      if (others.length >= MAX_MEMBERS) return reject(ws, 'room_full');
    }

    // Same person from a second tab or after a network blip: the new socket takes the seat.
    const joinedAt = previous?.seat.joinedAt ?? Date.now();
    if (previous) {
      previous.ws.serializeAttachment(null);
      previous.ws.close(CLOSE_REPLACED, 'replaced');
    }

    const seat: Seat = { id, name: msg.name, color: msg.color, joinedAt, chatTokens: CHAT_BURST, chatAt: Date.now() };
    ws.serializeAttachment(seat);
    this.settleHost();
    await this.ctx.storage.deleteAlarm();

    send(ws, {
      t: 'welcome',
      you: id,
      members: this.members(),
      chat: this.recentChat(),
      settings: this.settings(),
    });
    this.broadcastMembers(ws);
  }

  private onChat(ws: WebSocket, seat: Seat, text: string): void {
    const now = Date.now();
    const tokens = Math.min(CHAT_BURST, seat.chatTokens + (now - seat.chatAt) / CHAT_REFILL_MS);
    if (tokens < 1) return send(ws, { t: 'error', code: 'rate_limited' });
    ws.serializeAttachment({ ...seat, chatTokens: tokens - 1, chatAt: now } satisfies Seat);

    const row = this.sql
      .exec<ChatRow>(
        'INSERT INTO chat (member_id, name, color, text, at) VALUES (?, ?, ?, ?, ?) RETURNING *',
        seat.id, seat.name, seat.color, text, now,
      )
      .one();
    this.sql.exec('DELETE FROM chat WHERE id <= ?', row.id - CHAT_KEPT);
    this.broadcast({ t: 'chat', message: toChat(row) });
  }

  private async onLeave(ws: WebSocket): Promise<void> {
    if (!seatOf(ws)) return; // never said hello, or was replaced / rejected
    ws.serializeAttachment(null);
    this.settleHost();
    if (this.seated().length === 0) {
      await this.ctx.storage.setAlarm(Date.now() + PURGE_AFTER_MS);
    } else {
      this.broadcastMembers();
    }
  }

  // ---- state ------------------------------------------------------------------

  private seated(): Seated[] {
    const out: Seated[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const seat = seatOf(ws);
      if (seat) out.push({ ws, seat });
    }
    return out;
  }

  private members(): Member[] {
    const hostId = this.get<string>('hostId');
    const mode = this.settings().controlMode;
    return this.seated()
      .map(({ seat }) => ({
        id: seat.id,
        name: seat.name,
        color: seat.color,
        joinedAt: seat.joinedAt,
        isHost: seat.id === hostId,
        hasControl: hasControl(mode, seat.id === hostId),
      }))
      .sort((a, b) => a.joinedAt - b.joinedAt);
  }

  /** Keeps the current host if present, otherwise seats the longest-standing member. */
  private settleHost(): void {
    const current = this.get<string>('hostId');
    const next = pickHost(this.seated().map((s) => s.seat), current);
    if (next && next !== current) this.put('hostId', next);
  }

  private isHost(seat: Seat): boolean {
    return this.get<string>('hostId') === seat.id;
  }

  private exists(): boolean {
    return this.get<number>('created') !== null;
  }

  private settings(): RoomSettings {
    return this.get<RoomSettings>('settings') ?? DEFAULT_SETTINGS;
  }

  private kicked(): string[] {
    return this.get<string[]>('kicked') ?? [];
  }

  private recentChat(): ChatMessage[] {
    return this.sql
      .exec<ChatRow>('SELECT * FROM chat ORDER BY id DESC LIMIT ?', CHAT_ON_JOIN)
      .toArray()
      .reverse()
      .map(toChat);
  }

  private get<T>(key: string): T | null {
    const row = this.sql.exec<{ value: string }>('SELECT value FROM kv WHERE key = ?', key).toArray()[0];
    return row ? (JSON.parse(row.value) as T) : null;
  }

  private put(key: string, value: unknown): void {
    this.sql.exec('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key, JSON.stringify(value));
  }

  private broadcast(msg: ServerMessage, except?: WebSocket): void {
    for (const { ws } of this.seated()) if (ws !== except) send(ws, msg);
  }

  private broadcastMembers(except?: WebSocket): void {
    this.broadcast({ t: 'members', members: this.members() }, except);
  }
}

function seatOf(ws: WebSocket): Seat | null {
  return (ws.deserializeAttachment() as Seat | null | undefined) ?? null;
}

function parse(raw: string | ArrayBuffer): ClientMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    const result = ClientMessage.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // socket is closing; the close handler tidies up
  }
}

/** Tell the client why, then drop it without treating it as a member leaving. */
function reject(ws: WebSocket, code: ErrorCode): void {
  send(ws, { t: 'error', code });
  ws.serializeAttachment(null);
  ws.close(CLOSE_REJECTED, code);
}

function toChat(row: ChatRow): ChatMessage {
  return { id: row.id, memberId: row.member_id, name: row.name, color: row.color, text: row.text, at: row.at };
}
