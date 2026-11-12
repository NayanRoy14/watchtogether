import { DurableObject } from 'cloudflare:workers';
import {
  BROWSER_OFF,
  DEFAULT_QUALITY,
  CHAT_KEPT,
  CHAT_ON_JOIN,
  CLOSE_REJECTED,
  CLOSE_REPLACED,
  ClientMessage,
  DEFAULT_SETTINGS,
  MAX_MEMBERS,
  MAX_QUEUE,
  expectedPosition,
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
  type PlaybackState,
  type Quality,
  type QueueItem,
  type RoomInfo,
  type RoomMode,
  type RoomSettings,
  type ServerMessage,
  type Source,
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
  inCall: boolean;
  camera: boolean;
  buffering: boolean;
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

  browserActive(): boolean {
    return this.browser().status !== 'off';
  }

  /**
   * Asked by BrowserLease when another room wants the browser. A room with people in it
   * keeps it; an empty room (everyone left, grace period still running) gives it up now.
   */
  async yieldBrowser(): Promise<boolean> {
    if (!this.browserActive()) return true;
    if (this.seated().length > 0) return false;
    await this.stopBrowser();
    return true;
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
      case 'browser:quality': {
        if (!this.canControl(seat.id)) return send(ws, { t: 'error', code: 'no_control' });
        if (msg.quality === this.quality()) return;
        if (this.browser().status === 'live') {
          try {
            await this.engine()?.setQuality(msg.quality);
          } catch (err) {
            console.error('browser quality change failed', err);
            return send(ws, { t: 'error', code: 'browser_offline' }); // nothing changed; say so
          }
        }
        this.put('quality', msg.quality); // while off, remembered for when it opens
        return this.broadcastBrowser();
      }
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

      case 'react':
        if (!this.spend(ws, seat)) return;
        return this.broadcast({ t: 'react', id: Date.now(), memberId: seat.id, emoji: msg.emoji });

      case 'call': {
        const joining = msg.on && !seat.inCall;
        // Before marking them: everyone already in the call is who the joiner must ring.
        const peers = this.seated().filter((s) => s.seat.inCall && s.seat.id !== seat.id).map((s) => s.seat.id);
        ws.serializeAttachment({ ...seatOf(ws), inCall: msg.on, camera: msg.on && msg.camera });
        if (joining) send(ws, { t: 'call:peers', ids: peers });
        return this.broadcastMembers();
      }
      case 'rtc': {
        const target = this.seated().find((s) => s.seat.id === msg.to);
        if (target && seat.inCall) send(target.ws, { t: 'rtc', from: seat.id, kind: msg.kind, data: msg.data });
        return;
      }

      case 'buffering':
        ws.serializeAttachment({ ...seatOf(ws), buffering: msg.value });
        this.broadcastMembers();
        return this.settleWaiting();
      case 'ended': {
        const state = this.playback();
        if (!state || msg.seq !== state.seq) return; // someone else already reported it
        const [next, ...rest] = this.queue();
        if (next) {
          this.setQueue(rest);
          return this.setPlayback(this.fresh(next.source, true, ''));
        }
        return this.setPlayback({ ...state, playing: false, position: expectedPosition(state, Date.now()), by: '' });
      }

      case 'mode':
      case 'load':
      case 'intent':
      case 'queue':
        if (!this.canControl(seat.id)) return send(ws, { t: 'error', code: 'no_control' });
        return this.onDirect(seat, msg);
    }
  }

  // ---- Direct mode ------------------------------------------------------------

  private onDirect(seat: Seat, msg: Extract<ClientMessage, { t: 'mode' | 'load' | 'intent' | 'queue' }>): void {
    switch (msg.t) {
      case 'mode':
        this.put('mode', msg.mode);
        return this.broadcast({ t: 'mode', mode: msg.mode });

      case 'load':
        return this.setPlayback(this.fresh(msg.source, false, seat.name));

      case 'intent': {
        const state = this.playback();
        if (!state) return;
        const base = { ...state, position: msg.position, by: seat.name };
        if (msg.action === 'play') return this.setPlayback({ ...base, playing: true });
        if (msg.action === 'pause') return this.setPlayback({ ...base, playing: false });
        if (msg.action === 'seek') return this.setPlayback(base, true);
        return this.setPlayback({ ...base, rate: msg.rate ?? state.rate }, true);
      }

      case 'queue': {
        const queue = this.queue();
        if (msg.op === 'add') {
          if (queue.length >= MAX_QUEUE) return;
          return this.setQueue([...queue, { id: crypto.randomUUID().slice(0, 8), source: msg.source, addedBy: seat.name }]);
        }
        const item = queue.find((q) => q.id === msg.id);
        if (!item) return;
        const others = queue.filter((q) => q.id !== msg.id);
        if (msg.op === 'remove') return this.setQueue(others);
        if (msg.op === 'move') return this.setQueue([...others.slice(0, msg.to), item, ...others.slice(msg.to)]);
        this.setQueue(others);
        return this.setPlayback(this.fresh(item.source, true, seat.name));
      }
    }
  }

  private fresh(source: Source, playing: boolean, by: string): PlaybackState {
    return { source, playing, position: 0, rate: 1, updatedAt: 0, seq: 0, by };
  }

  /**
   * The only way playback changes: stamp it with the server clock, bump the sequence
   * number and tell everyone, including whoever asked, so all players take the same path.
   * `keepWaiting` is for changes (seek, speed) that should not cancel a pause-for-buffering.
   */
  private setPlayback(next: PlaybackState, keepWaiting = false): void {
    const previous = this.playback();
    const state = { ...next, updatedAt: Date.now(), seq: (previous?.seq ?? 0) + 1 };
    if (previous && previous.source.id !== state.source.id) this.clearBuffering();
    if (!keepWaiting) this.put('resume', false);
    this.put('playback', state);
    this.broadcast({ t: 'state', state });
    if (!keepWaiting) this.broadcast({ t: 'waiting', for: [] });
  }

  /**
   * "Waiting for Riya…": while anyone is stalled, everyone pauses at the same spot;
   * when the last one catches up, playback resumes from there.
   */
  private settleWaiting(): void {
    const state = this.playback();
    if (!state || !this.settings().waitForAll) return;
    const stalled = this.seated().filter((s) => s.seat.buffering).map((s) => s.seat.name);
    const paused = this.get<boolean>('resume') === true;

    if (stalled.length > 0 && state.playing) {
      const frozen = { ...state, playing: false, position: expectedPosition(state, Date.now()), by: '' };
      this.setPlayback(frozen);
      this.put('resume', true);
      return this.broadcast({ t: 'waiting', for: stalled });
    }
    if (paused) {
      if (stalled.length > 0) return this.broadcast({ t: 'waiting', for: stalled });
      this.setPlayback({ ...state, playing: true, by: '' }); // also announces waiting: []
    }
  }

  private clearBuffering(): void {
    for (const { ws, seat } of this.seated()) if (seat.buffering) ws.serializeAttachment({ ...seat, buffering: false });
  }

  private waitingFor(): string[] {
    if (this.get<boolean>('resume') !== true) return [];
    return this.seated().filter((s) => s.seat.buffering).map((s) => s.seat.name);
  }

  private playback(): PlaybackState | null {
    return this.get<PlaybackState>('playback');
  }

  private queue(): QueueItem[] {
    return this.get<QueueItem[]>('queue') ?? [];
  }

  private setQueue(queue: QueueItem[]): void {
    this.put('queue', queue);
    this.broadcast({ t: 'queue', queue });
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

    const seat: Seat = {
      id, name: msg.name, color: msg.color, joinedAt,
      chatTokens: CHAT_BURST, chatAt: Date.now(),
      inCall: false, camera: false, buffering: false,
    };
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
      mode: this.get<RoomMode>('mode') ?? 'browser',
      state: this.playback(),
      queue: this.queue(),
      waiting: this.waitingFor(),
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
        await engine.setQuality(this.quality());
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
        url = await engine.addMember(this.code(), this.engineMember(memberId));
      } catch (err) {
        console.error('browser admit failed', err);
        return send(ws, { t: 'error', code: 'browser_offline' });
      }
      const latest = this.browser();
      if (latest.status !== 'live') return; // closed while we were creating the login
      this.put('browser', { ...latest, urls: { ...latest.urls, [memberId]: url } } satisfies BrowserState);
    } else {
      // Returning with an existing login (reload, network blip). Their control was withdrawn
      // when they left, so give back whatever they are entitled to now.
      try {
        await engine.setControl(this.code(), [this.engineMember(memberId)]);
      } catch (err) {
        console.error('browser control restore failed', err);
      }
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

  private engineMember(memberId: string): { id: string; name: string; canControl: boolean } {
    const seat = this.seated().find((s) => s.seat.id === memberId)?.seat;
    // Someone who has left keeps a login for a minute (see sweep) but must not keep control.
    return { id: memberId, name: seat?.name ?? 'Guest', canControl: seat ? this.canControl(memberId) : false };
  }

  /** Host, driver or mode changed: tell everyone, and make the browser itself enforce it. */
  private async controlChanged(): Promise<void> {
    this.broadcastMembers();
    this.broadcastBrowser();
    const state = this.browser();
    if (state.status !== 'live') return;
    try {
      await this.engine()?.setControl(this.code(), Object.keys(state.urls).map((id) => this.engineMember(id)));
    } catch (err) {
      console.error('browser control update failed', err);
    }
  }

  /** Chat and reactions share one allowance per person. Returns false when it is used up. */
  private spend(ws: WebSocket, seat: Seat): boolean {
    const now = Date.now();
    const tokens = Math.min(CHAT_BURST, seat.chatTokens + (now - seat.chatAt) / CHAT_REFILL_MS);
    if (tokens < 1) {
      send(ws, { t: 'error', code: 'rate_limited' });
      return false;
    }
    ws.serializeAttachment({ ...seat, chatTokens: tokens - 1, chatAt: now } satisfies Seat);
    return true;
  }

  private onChat(ws: WebSocket, seat: Seat, text: string): void {
    if (!this.spend(ws, seat)) return;
    const now = Date.now();

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
      this.settleWaiting(); // don't keep everyone paused for someone who has gone
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
        inCall: seat.inCall,
        camera: seat.camera,
        buffering: seat.buffering,
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
      quality: this.quality(),
    };
  }

  private quality(): Quality {
    return this.get<Quality>('quality') ?? DEFAULT_QUALITY;
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
