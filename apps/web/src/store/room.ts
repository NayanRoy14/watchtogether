import { create } from 'zustand';
import { CHAT_KEPT, DEFAULT_SETTINGS, type ChatMessage, type Member, type RoomSettings, type ServerMessage } from '@wt/shared';
import { getIdentity } from '../lib/identity';
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

  join: (code: string) => void;
  leave: () => void;
  sendChat: (text: string) => void;
  updateSettings: (patch: Partial<RoomSettings>) => void;
  transferHost: (id: string) => void;
  kick: (id: string) => void;
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
        return set({ you: msg.you, members: msg.members, chat: msg.chat, settings: msg.settings });
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
        if (msg.code === 'rate_limited') flash('Slow down a little — that message was not sent.');
        if (msg.code === 'not_host') flash('Only the host can do that.');
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
  };
});

export const useMe = (): Member | undefined => useRoom((s) => s.members.find((m) => m.id === s.you));
