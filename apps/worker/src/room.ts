import { DurableObject } from 'cloudflare:workers';
import {
  BROWSER_OFF,
  CHAT_KEPT,
  CHAT_ON_JOIN,
  CLOSE_REJECTED,
  CLOSE_REPLACED,
  ClientMessage,
  DEFAULT_SETTINGS,
  MAX_MEMBERS,
  hasControl,
  mayGiveControl,
  nextAlarm,
  pickDriver,
  pickHost,
  type BrowserStatus,
  type ChatMessage,
  type EngineName,
  type ErrorCode,
  type Member,
  type RoomInfo,
  type RoomSettings,
  type ServerMessage,
} from '@wt/shared';
import { makeEngine, type BrowserEngine } from './engines/types';
import type { Env } from './env';
import { publicId } from './ids';

const PURGE_AFTER_MS = 24 * 60 * 60 * 1000;
const CLOSE_BROWSER_AFTER_MS = 2 * 60 * 1000; // room empty this long → stop the browser
const SWEEP_AFTER_MS = 60 * 1000; // someone left this long ago → remove their browser login
const OWNER_KEY_TRIES = 8;
const OWNER_KEY_WINDOW_MS = 10 * 60 * 1000;

/** The room's deadlines. One alarm serves all of them (see nextAlarm). */
type Timers = { close?: number; purge?: number; sweep?: number };

/** The browser as stored: who has a login, and the address each person embeds. */
interface BrowserState {
  status: 'off' | 'starting' | 'live';
  engine: EngineName | null;
  urls: Record<string, string>;
}
const NO_BROWSER: BrowserState = { status: 'off', engine: null, urls: {} };
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
  async create(code: string, hostId: string): Promise<boolean> {
    if (this.exists()) return false;
    this.put('created', Date.now());
    this.put('code', code);
    this.put('hostId', hostId);
    this.put('settings', DEFAULT_SETTINGS);
    await this.setTimers({ purge: Date.now() + PURGE_AFTER_MS });
    return true;
  }

  /** Asked by BrowserLease before it hands the browser to another room. */
  browserActive(): boolean {
    return this.browser().status !== 'off';
  }

  info(): RoomInfo {
    if (!this.exists()) return { exists: false, memberCount: 0, locked: false };
    return { exists: true, memberCount: this.seated().length, locked: this.settings().locked };
  }

  override async fetch(request: Request): Promise<Response> {
    if (!this.exists()) return Response.json({ error: 'not_found' }, { status: 404 });
    this.put('origin', new URL(request.url).origin);
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
        if (settings.controlMode === 'everyone') this.put('requests', []);
        this.broadcast({ t: 'settings', settings });
        return this.controlChanged();
      }
      case 'transfer-host': {
        if (!this.isHost(seat)) return send(ws, { t: 'error', code: 'not_host' });
        if (!this.seated().some((s) => s.seat.id === msg.id)) return;
        this.put('hostId', msg.id);
        return this.controlChanged();
      }
      case 'kick': {
        if (!this.isHost(seat)) return send(ws, { t: 'error', code: 'not_host' });
        if (msg.id === seat.id) return;
        const target = this.seated().find((s) => s.seat.id === msg.id);
        if (!target) return;
        this.put('kicked', [...this.kicked(), msg.id]);
        reject(target.ws, 'kicked');
        await this.dropBrowserLogin(msg.id);
        return this.controlChanged();
      }
      case 'browser:open':
        return this.onBrowserOpen(ws, seat, msg.ownerKey);
      case 'browser:close':
        if (!this.isHost(seat)) return send(ws, { t: 'error', code: 'not_host' });
        return this.stopBrowser();
      case 'browser:request-control': {
        if (this.settings().controlMode !== 'driver' || seat.id === this.driver()) return;
        this.put('requests', [...new Set([...this.requests(), seat.id])]);
        return this.broadcastBrowser();
      }
      case 'browser:give-control': {
        if (this.settings().controlMode !== 'driver') return;
        if (!mayGiveControl(seat.id, this.get<string>('hostId'), this.driver())) {
          return send(ws, { t: 'error', code: 'no_control' });
        }
        const target = msg.id ?? seat.id;
        if (!this.seated().some((s) => s.seat.id === target)) return;
        this.put('driverId', target);
        this.put('requests', this.requests().filter((id) => id !== target));
        return this.controlChanged();
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

  override async alarm(): Promise<void> {
    const now = Date.now();
    const timers = this.timers();
    const empty = this.seated().length === 0;

    if (timers.sweep !== undefined && timers.sweep <= now) {
      delete timers.sweep;
      await this.sweepBrowserLogins();
    }
    if (timers.close !== undefined && timers.close <= now) {
      delete timers.close;
      if (empty) await this.stopBrowser();
    }
    if (timers.purge !== undefined && timers.purge <= now) {
      delete timers.purge;
      if (empty) {
        await this.stopBrowser();
        await this.ctx.storage.deleteAll();
        this.migrate();
        return;
      }
    }
    await this.setTimers(timers);
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
    const { sweep } = this.timers();
    await this.setTimers({ sweep }); // someone is here: cancel "close browser" and "purge"

    send(ws, {
      t: 'welcome',
      you: id,
      members: this.members(),
      chat: this.recentChat(),
      settings: this.settings(),
      browser: this.browserStatus(),
    });
    this.broadcastMembers(ws);
    if (this.browser().status === 'live') await this.admit(ws, id);
  }

  // ---- shared browser -------------------------------------------------------

  private async onBrowserOpen(ws: WebSocket, seat: Seat, ownerKey: string): Promise<void> {
    const current = this.browser();
    if (current.status === 'live') return this.admit(ws, seat.id);
    if (current.status === 'starting') return;

    const code = this.code();
    const limiter = this.env.RATE_LIMIT.get(this.env.RATE_LIMIT.idFromName(`owner:${code}`));
    if (!(await limiter.take(OWNER_KEY_TRIES, OWNER_KEY_WINDOW_MS))) return send(ws, { t: 'error', code: 'rate_limited' });
    if (!(await sameSecret(ownerKey, this.env.OWNER_PASSPHRASE))) return send(ws, { t: 'error', code: 'bad_owner_key' });

    const engine = this.engine();
    if (!engine) return send(ws, { t: 'error', code: 'browser_offline' });
    if (this.browser().status !== 'off') return; // someone else got here while we were checking

    this.put('browser', { status: 'starting', engine: engine.name, urls: {} } satisfies BrowserState);
    this.broadcastBrowser();

    const lease = this.env.BROWSER_LEASE.get(this.env.BROWSER_LEASE.idFromName('browser'));
    let failure: ErrorCode | null = null;
    if (!(await lease.acquire(code))) {
      failure = 'browser_busy';
    } else {
      try {
        if (!(await engine.healthy())) throw new Error('engine not healthy');
        await engine.start(code);
      } catch (err) {
        console.error('browser start failed', err);
        failure = 'browser_offline';
        await lease.release(code);
      }
    }
    if (failure) {
      this.put('browser', NO_BROWSER);
      send(ws, { t: 'error', code: failure });
      return this.broadcastBrowser();
    }

    this.put('browser', { status: 'live', engine: engine.name, urls: {} } satisfies BrowserState);
    this.broadcastBrowser();
    // Sequential on purpose: each admit() re-reads state, so nobody who joined meanwhile is missed.
    for (const { ws: socket, seat: member } of this.seated()) await this.admit(socket, member.id);
  }

  /** Give this person their own way into the live browser (reusing it across reconnects). */
  private async admit(ws: WebSocket, memberId: string): Promise<void> {
    const engine = this.engine();
    const state = this.browser();
    if (!engine || state.status !== 'live') return;

    let url = state.urls[memberId];
    if (!url) {
      try {
        url = await engine.addMember(this.code(), memberId, this.canControl(memberId));
      } catch (err) {
        console.error('browser admit failed', err);
        return send(ws, { t: 'error', code: 'browser_offline' });
      }
      const latest = this.browser();
      if (latest.status !== 'live') return; // closed while we were creating the login
      this.put('browser', { ...latest, urls: { ...latest.urls, [memberId]: url } } satisfies BrowserState);
    }
    send(ws, { t: 'browser:join', engine: engine.name, url });
  }

  private async stopBrowser(): Promise<void> {
    const state = this.browser();
    if (state.status === 'off') return;
    this.put('browser', NO_BROWSER);
    this.put('requests', []);
    this.broadcastBrowser();
    try {
      await this.engine()?.stop(this.code());
    } catch (err) {
      console.error('browser stop failed', err); // start() of the next room clears leftovers
    }
    await this.env.BROWSER_LEASE.get(this.env.BROWSER_LEASE.idFromName('browser')).release(this.code());
  }

  private async dropBrowserLogin(memberId: string): Promise<void> {
    const state = this.browser();
    if (!(memberId in state.urls)) return;
    const urls = Object.fromEntries(Object.entries(state.urls).filter(([id]) => id !== memberId));
    this.put('browser', { ...state, urls } satisfies BrowserState);
    try {
      await this.engine()?.removeMember(this.code(), memberId);
    } catch (err) {
      console.error('browser login removal failed', err);
    }
  }

  /** People who left a while ago should not keep a working login to the browser. */
  private async sweepBrowserLogins(): Promise<void> {
    const here = new Set(this.seated().map((s) => s.seat.id));
    for (const memberId of Object.keys(this.browser().urls)) {
      if (!here.has(memberId)) await this.dropBrowserLogin(memberId);
    }
  }

  /** Host, driver or mode changed: tell everyone, and make the browser itself enforce it. */
  private async controlChanged(): Promise<void> {
    this.broadcastMembers();
    this.broadcastBrowser();
    const state = this.browser();
    if (state.status !== 'live') return;
    const allowed: Record<string, boolean> = {};
    for (const memberId of Object.keys(state.urls)) allowed[memberId] = this.canControl(memberId);
    try {
      await this.engine()?.setControl(this.code(), allowed);
    } catch (err) {
      console.error('browser control update failed', err);
    }
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
    const gone = seatOf(ws)?.id;
    ws.serializeAttachment(null);
    this.settleHost();
    if (gone) this.put('requests', this.requests().filter((id) => id !== gone));

    const now = Date.now();
    const live = this.browser().status !== 'off';
    const timers = this.timers();
    if (live) timers.sweep = now + SWEEP_AFTER_MS;
    if (this.seated().length === 0) {
      if (live) timers.close = now + CLOSE_BROWSER_AFTER_MS;
      timers.purge = now + PURGE_AFTER_MS;
      await this.setTimers(timers);
    } else {
      await this.setTimers(timers);
      await this.controlChanged(); // the driver or host may have been the one who left
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
    return this.seated()
      .map(({ seat }) => ({
        id: seat.id,
        name: seat.name,
        color: seat.color,
        joinedAt: seat.joinedAt,
        isHost: seat.id === hostId,
        hasControl: this.canControl(seat.id),
      }))
      .sort((a, b) => a.joinedAt - b.joinedAt);
  }

  /** Keeps the current host if present, otherwise seats the longest-standing member. */
  private settleHost(): void {
    const current = this.get<string>('hostId');
    const next = pickHost(this.seated().map((s) => s.seat), current);
    if (next && next !== current) this.put('hostId', next);
  }

  /** Who drives in one-driver mode: whoever was handed control, else the host. */
  private driver(): string | null {
    const ids = this.seated().map((s) => s.seat.id);
    return pickDriver(ids, this.get<string>('driverId'), this.get<string>('hostId'));
  }

  private canControl(memberId: string): boolean {
    return hasControl(this.settings().controlMode, memberId === this.driver());
  }

  private browser(): BrowserState {
    return this.get<BrowserState>('browser') ?? NO_BROWSER;
  }

  private browserStatus(): BrowserStatus {
    const { status, engine } = this.browser();
    const driverMode = this.settings().controlMode === 'driver';
    return {
      ...BROWSER_OFF,
      status,
      engine,
      driverId: driverMode ? this.driver() : null,
      requests: driverMode ? this.requests() : [],
    };
  }

  private requests(): string[] {
    return this.get<string[]>('requests') ?? [];
  }

  private engine(): BrowserEngine | null {
    return makeEngine(this.env, this.get<string>('origin') ?? 'http://localhost');
  }

  private code(): string {
    return this.get<string>('code') ?? '';
  }

  private timers(): Timers {
    return this.get<Timers>('timers') ?? {};
  }

  private async setTimers(timers: Timers): Promise<void> {
    this.put('timers', timers);
    const next = nextAlarm(timers);
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  private broadcastBrowser(): void {
    this.broadcast({ t: 'browser:status', browser: this.browserStatus() });
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

/** Compares hashes in constant time, so response timing says nothing about the passphrase. */
async function sameSecret(given: string, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
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
