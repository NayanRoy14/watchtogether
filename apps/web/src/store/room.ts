import { create } from 'zustand';
import {
  BROWSER_OFF, CHAT_KEPT, DEFAULT_SETTINGS, bestOffset, clockSample,
  type BrowserStatus, type ChatMessage, type ClientMessage, type ClockSample, type Member, type PlaybackState,
  type QueueItem, type RoomMode, type RoomSettings, type ServerMessage, type Source,
} from '@wt/shared';
import { getIdentity, ownerKey } from '../lib/identity';
import { RoomSocket, type Connection, type EndReason } from './socket';

export interface Reaction {
  id: number;
  emoji: string;
  color: string;
  /** Horizontal position, 0–1, so they don't stack on one spot. */
  x: number;
}

type RtcMessage = Extract<ServerMessage, { t: 'rtc' }>;

interface RoomState {
  code: string | null;
  connection: Connection;
  endReason: EndReason | null;
  you: string | null;
  members: Member[];
  chat: ChatMessage[];
  settings: RoomSettings;
  /** Add to Date.now() to get the server's clock. */
  clockOffset: number;
  /** A short-lived notice such as "Riya paused". */
  notice: string | null;
  browser: BrowserStatus;
  /** This person's own address for the live browser; null until the server sends it. */
  browserUrl: string | null;
  /** Why the last attempt to open the browser failed. */
  browserError: 'bad_owner_key' | 'browser_busy' | 'browser_offline' | null;
  mode: RoomMode;
  playback: PlaybackState | null;
  queue: QueueItem[];
  /** Names everyone is paused for while their video buffers. */
  waiting: string[];
  reactions: Reaction[];

  join: (code: string) => void;
  leave: () => void;
  /** Send any message; used by the pieces that speak their own small protocol. */
  send: (msg: ClientMessage) => void;
  flash: (notice: string) => void;
  sendChat: (text: string) => void;
  updateSettings: (patch: Partial<RoomSettings>) => void;
  transferHost: (id: string) => void;
  kick: (id: string) => void;
  openBrowser: (key: string) => void;
  closeBrowser: () => void;
  requestControl: () => void;
  /** Hand control to someone; with no id, take it yourself (host). */
  giveControl: (id?: string) => void;
  setMode: (mode: RoomMode) => void;
  load: (source: Source) => void;
}

const blank = {
  code: null,
  connection: 'connecting' as Connection,
  endReason: null,
  you: null,
  members: [] as Member[],
  chat: [] as ChatMessage[],
  settings: DEFAULT_SETTINGS,
  clockOffset: 0,
  notice: null,
  browser: BROWSER_OFF,
  browserUrl: null,
  browserError: null as RoomState['browserError'],
  mode: 'browser' as RoomMode,
  playback: null as PlaybackState | null,
  queue: [] as QueueItem[],
  waiting: [] as string[],
  reactions: [] as Reaction[],
};

let socket: RoomSocket | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let clock: ClockSample[] = [];

/** The voice call plugs in here to receive its signalling without the store knowing WebRTC. */
export const callSignals: {
  onPeers: ((ids: string[]) => void) | null;
  onRtc: ((msg: RtcMessage) => void) | null;
  onWelcome: (() => void) | null;
} = { onPeers: null, onRtc: null, onWelcome: null };

export const useRoom = create<RoomState>((set, get) => {
  const flash = (notice: string): void => {
    clearTimeout(noticeTimer);
    set({ notice });
    noticeTimer = setTimeout(() => set({ notice: null }), 3000);
  };

  /** "Riya paused" — only for changes someone else made. */
  const announce = (before: PlaybackState | null, after: PlaybackState | null): void => {
    if (!after || !after.by || after.by === getIdentity().name) return;
    if (before?.source.id !== after.source.id) return flash(`${after.by} started ${after.source.title}`);
    if (before.playing !== after.playing) return flash(`${after.by} ${after.playing ? 'pressed play' : 'paused'}`);
    if (before.rate !== after.rate) return flash(`${after.by} set the speed to ${after.rate}×`);
    flash(`${after.by} jumped to ${formatTime(after.position)}`);
  };

  const onMessage = (msg: ServerMessage): void => {
    switch (msg.t) {
      case 'welcome':
        set({
          you: msg.you,
          members: msg.members,
          chat: msg.chat,
          settings: msg.settings,
          browser: msg.browser,
          // Keep our address across a reconnect so the stream is not reloaded.
          browserUrl: msg.browser.status === 'live' ? get().browserUrl : null,
          mode: msg.mode,
          playback: msg.state,
          queue: msg.queue,
          waiting: msg.waiting,
        });
        return callSignals.onWelcome?.();
      case 'members':
        return set({ members: msg.members });
      case 'settings':
        return set({ settings: msg.settings });
      case 'chat':
        return set({ chat: [...get().chat, msg.message].slice(-CHAT_KEPT) });
      case 'pong': {
        clock = [...clock, clockSample(msg.t0, msg.serverTime, Date.now())].slice(-8);
        return set({ clockOffset: bestOffset(clock) });
      }
      case 'browser:status':
        return set({
          browser: msg.browser,
          browserUrl: msg.browser.status === 'live' ? get().browserUrl : null,
          browserError: msg.browser.status === 'off' ? get().browserError : null,
        });
      case 'browser:join':
        if (msg.url !== get().browserUrl) set({ browserUrl: msg.url });
        return;
      case 'mode':
        return set({ mode: msg.mode });
      case 'state': {
        const before = get().playback;
        // An older change that arrived late must not undo a newer one.
        if (before && msg.state && msg.state.seq < before.seq) return;
        set({ playback: msg.state });
        return announce(before, msg.state);
      }
      case 'queue':
        return set({ queue: msg.queue });
      case 'waiting':
        return set({ waiting: msg.for });
      case 'react': {
        const color = get().members.find((m) => m.id === msg.memberId)?.color ?? '#ffffff';
        const reaction: Reaction = { id: msg.id + Math.random(), emoji: msg.emoji, color, x: 0.1 + Math.random() * 0.8 };
        set({ reactions: [...get().reactions, reaction].slice(-24) });
        setTimeout(() => set({ reactions: get().reactions.filter((r) => r.id !== reaction.id) }), 2600);
        return;
      }
      case 'call:peers':
        return callSignals.onPeers?.(msg.ids);
      case 'rtc':
        return callSignals.onRtc?.(msg);
      case 'error':
        if (msg.code === 'rate_limited') flash('Slow down a little, then try again.');
        if (msg.code === 'not_host') flash('Only the host can do that.');
        if (msg.code === 'no_control') flash('You don’t have control right now.');
        if (msg.code === 'bad_owner_key') ownerKey.clear();
        if (msg.code === 'bad_owner_key' || msg.code === 'browser_busy' || msg.code === 'browser_offline') {
          set({ browserError: msg.code });
        }
        return;
    }
  };

  return {
    ...blank,

    join: (code) => {
      socket?.stop();
      clock = [];
      set({ ...blank, code });
      const me = getIdentity();
      socket = new RoomSocket(code, {
        hello: () => ({ t: 'hello', name: me.name, clientId: me.clientId, color: me.color }),
        onMessage,
        onConnection: (connection, reason) => set({ connection, endReason: reason ?? null }),
      });
      socket.start();
    },

    leave: () => {
      socket?.stop();
      socket = null;
      set({ ...blank });
    },

    send: (msg) => socket?.send(msg),
    flash,
    sendChat: (text) => socket?.send({ t: 'chat', text }),
    // Show the change at once; the server's broadcast confirms or corrects it.
    updateSettings: (patch) => {
      set({ settings: { ...get().settings, ...patch } });
      socket?.send({ t: 'settings', settings: patch });
    },
    transferHost: (id) => socket?.send({ t: 'transfer-host', id }),
    kick: (id) => socket?.send({ t: 'kick', id }),

    openBrowser: (key) => {
      ownerKey.set(key); // forgotten again if the server says it is wrong
      set({ browserError: null });
      socket?.send({ t: 'browser:open', ownerKey: key });
    },
    closeBrowser: () => socket?.send({ t: 'browser:close' }),
    requestControl: () => socket?.send({ t: 'browser:request-control' }),
    giveControl: (id) => socket?.send({ t: 'browser:give-control', id }),

    setMode: (mode) => {
      set({ mode });
      socket?.send({ t: 'mode', mode });
    },
    load: (source) => socket?.send({ t: 'load', source }),
  };
});

export const useMe = (): Member | undefined => useRoom((s) => s.members.find((m) => m.id === s.you));

/** The server's clock, as best this device can tell. */
export const serverNow = (): number => Date.now() + useRoom.getState().clockOffset;

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
