import { z } from 'zod';

export const MAX_MEMBERS = 10;
export const MAX_CHAT_LENGTH = 500;
export const MAX_NAME_LENGTH = 24;
export const CHAT_KEPT = 200;
export const CHAT_ON_JOIN = 50;

export const AVATAR_COLORS = [
  '#f2a93b', '#ef6b5e', '#e86aa6', '#a98bf0',
  '#6b9cf5', '#45c4c0', '#6cc56f', '#c9c35a',
] as const;

const Name = z.string().trim().min(1).max(MAX_NAME_LENGTH);
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const MemberId = z.string().min(1).max(64);

export const ControlMode = z.enum(['everyone', 'driver']);
export type ControlMode = z.infer<typeof ControlMode>;

export const RoomSettings = z.object({
  controlMode: ControlMode,
  waitForAll: z.boolean(),
  locked: z.boolean(),
});
export type RoomSettings = z.infer<typeof RoomSettings>;

export const DEFAULT_SETTINGS: RoomSettings = { controlMode: 'everyone', waitForAll: true, locked: false };

export const Member = z.object({
  id: MemberId,
  name: Name,
  color: Color,
  isHost: z.boolean(),
  hasControl: z.boolean(),
  joinedAt: z.number(),
});
export type Member = z.infer<typeof Member>;

export const ChatMessage = z.object({
  id: z.number(),
  memberId: MemberId,
  name: Name,
  color: Color,
  text: z.string(),
  at: z.number(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ErrorCode = z.enum([
  'no_control', 'not_host', 'room_full', 'room_locked', 'bad_message', 'kicked', 'rate_limited',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** WebSocket close codes the server uses on purpose. */
export const CLOSE_REPLACED = 4000; // same person connected from another tab
export const CLOSE_REJECTED = 4001; // an `error` message with the reason was sent first

// ---- client → server -------------------------------------------------------

export const ClientMessage = z.discriminatedUnion('t', [
  // clientId is a private per-device secret; other members only ever see a hash of it.
  z.object({ t: z.literal('hello'), name: Name, clientId: z.string().min(8).max(64), color: Color }),
  z.object({ t: z.literal('ping'), t0: z.number() }),
  z.object({ t: z.literal('chat'), text: z.string().trim().min(1).max(MAX_CHAT_LENGTH) }),
  z.object({ t: z.literal('settings'), settings: RoomSettings.partial() }),
  z.object({ t: z.literal('transfer-host'), id: MemberId }),
  z.object({ t: z.literal('kick'), id: MemberId }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---- server → client -------------------------------------------------------

export const ServerMessage = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('welcome'),
    you: MemberId,
    members: z.array(Member),
    chat: z.array(ChatMessage),
    settings: RoomSettings,
  }),
  z.object({ t: z.literal('pong'), t0: z.number(), serverTime: z.number() }),
  z.object({ t: z.literal('members'), members: z.array(Member) }),
  z.object({ t: z.literal('chat'), message: ChatMessage }),
  z.object({ t: z.literal('settings'), settings: RoomSettings }),
  z.object({ t: z.literal('error'), code: ErrorCode }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

// ---- HTTP ------------------------------------------------------------------

export const CreateRoomRequest = z.object({ clientId: z.string().min(8).max(64) });
export const CreateRoomResponse = z.object({ code: z.string() });
export const RoomInfo = z.object({ exists: z.boolean(), memberCount: z.number(), locked: z.boolean() });
export type RoomInfo = z.infer<typeof RoomInfo>;
