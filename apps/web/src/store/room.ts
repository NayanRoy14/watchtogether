import { create } from 'zustand';
import {
  BROWSER_OFF, CHAT_KEPT, DEFAULT_SETTINGS,
  type BrowserStatus, type ChatMessage, type Member, type RoomSettings, type ServerMessage,
} from '@wt/shared';
import { getIdentity, ownerKey } from '../lib/identity';
import { RoomSocket, type Connection, type EndReason } from './socket';

interface RoomState {
  code: string | null;
  connection: Connection;
  endReason: EndReason | null;
  you: string | null;
  members: Member[];
  chat: ChatMessage[];
  settings: RoomSettings;
  /** Add to Date.now() to get the server's clock. Used by Direct mode later. */
  clockOffset: number;
  /** A short-lived notice such as "Slow down". */
  notice: string | null;
  browser: BrowserStatus;
  /** This person's own address for the live browser; null until the server sends it. */
  browserUrl: string | null;
  /** Why the last attempt to open the browser failed. */
  browserError: 'bad_owner_key' | 'browser_busy' | 'browser_offline' | null;

  join: (code: string) => void;
  leave: () => void;
  sendChat: (text: string) => void;
  updateSettings: (patch: Partial<RoomSettings>) => void;
  transferHost: (id: string) => void;
  kick: (id: string) => void;
  openBrowser: (key: string) => void;
  closeBrowser: () => void;
  requestControl: () => void;
  /** Hand control to someone; with no id, take it yourself (host). */
  giveControl: (id?: string) => void;
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
};

let socket: RoomSocket | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

export const useRoom = create<RoomState>((set, get) => {
  const flash = (notice: string): void => {
    clearTimeout(noticeTimer);
    set({ notice });
    noticeTimer = setTimeout(() => set({ notice: null }), 3000);
  };

  const onMessage = (msg: ServerMessage): void => {
    switch (msg.t) {
      case 'welcome':
        return set({
          you: msg.you,
          members: msg.members,
          chat: msg.chat,
          settings: msg.settings,
          browser: msg.browser,
          // Keep our address across a reconnect so the stream is not reloaded.
          browserUrl: msg.browser.status === 'live' ? get().browserUrl : null,
        });
      case 'browser:status':
        return set({
          browser: msg.browser,
          browserUrl: msg.browser.status === 'live' ? get().browserUrl : null,
          browserError: msg.browser.status === 'off' ? get().browserError : null,
        });
      case 'browser:join':
        if (msg.url !== get().browserUrl) set({ browserUrl: msg.url });
        return;
      case 'members':
        return set({ members: msg.members });
      case 'settings':
        return set({ settings: msg.settings });
      case 'chat':
        return set({ chat: [...get().chat, msg.message].slice(-CHAT_KEPT) });
      case 'pong': {
        const t1 = Date.now();
        return set({ clockOffset: msg.serverTime - (msg.t0 + t1) / 2 });
      }
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
  };
});

export const useMe = (): Member | undefined => useRoom((s) => s.members.find((m) => m.id === s.you));
