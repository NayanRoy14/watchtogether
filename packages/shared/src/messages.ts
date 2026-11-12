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
  /** In the voice call, and whether their camera is on. */
  inCall: z.boolean(),
  camera: z.boolean(),
  /** Direct mode: their player is stalled waiting for data. */
  buffering: z.boolean(),
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
  'bad_owner_key', 'browser_busy', 'browser_offline',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const EngineName = z.enum(['neko', 'fake']);
export type EngineName = z.infer<typeof EngineName>;

/** The shared browser as everyone in the room sees it. */
export const BrowserStatus = z.object({
  status: z.enum(['off', 'starting', 'live']),
  engine: EngineName.nullable(),
  /** Who is driving, in one-driver mode; null when everyone controls. */
  driverId: MemberId.nullable(),
  /** Members who pressed "Request control". */
  requests: z.array(MemberId),
});
export type BrowserStatus = z.infer<typeof BrowserStatus>;

export const BROWSER_OFF: BrowserStatus = { status: 'off', engine: null, driverId: null, requests: [] };

// ---- Direct mode -------------------------------------------------------------

export const RoomMode = z.enum(['browser', 'direct']);
export type RoomMode = z.infer<typeof RoomMode>;

export const Source = z.object({
  kind: z.enum(['youtube', 'url', 'local']),
  /** YouTube video id, the media address, or (local files) the fingerprint. */
  id: z.string().min(1).max(2000),
  title: z.string().max(200),
  /** Local files: "<bytes>-<whole seconds>", so two copies can be compared. */
  fingerprint: z.string().max(64).optional(),
});
export type Source = z.infer<typeof Source>;

/** The one truth about playback. The server owns it; players only follow it. */
export const PlaybackState = z.object({
  source: Source,
  playing: z.boolean(),
  /** Seconds into the video at the moment of `updatedAt`. */
  position: z.number(),
  rate: z.number(),
  /** Server clock, ms. */
  updatedAt: z.number(),
  /** Goes up on every change; clients ignore anything older than what they hold. */
  seq: z.number(),
  /** Name of whoever made the change; empty when the room did it (queue, buffering). */
  by: z.string(),
});
export type PlaybackState = z.infer<typeof PlaybackState>;

export const QueueItem = z.object({ id: z.string().min(1).max(40), source: Source, addedBy: z.string() });
export type QueueItem = z.infer<typeof QueueItem>;
export const MAX_QUEUE = 50;

export const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export const REACTIONS = ['😂', '❤️', '😮', '👏', '🔥', '😢'] as const;

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
  // Starting the browser needs the owner's passphrase: it holds the owner's logins.
  z.object({ t: z.literal('browser:open'), ownerKey: z.string().min(1).max(200) }),
  z.object({ t: z.literal('browser:close') }),
  z.object({ t: z.literal('browser:request-control') }),
  // Without an id the sender takes control themselves (host only).
  z.object({ t: z.literal('browser:give-control'), id: MemberId.optional() }),

  z.object({ t: z.literal('react'), emoji: z.enum(REACTIONS) }),
  // Voice call: presence, then WebRTC signalling relayed to exactly one member.
  z.object({ t: z.literal('call'), on: z.boolean(), camera: z.boolean() }),
  z.object({ t: z.literal('rtc'), to: MemberId, kind: z.enum(['offer', 'answer', 'ice']), data: z.unknown() }),

  // Direct mode. All of these need control except `buffering` and `ended`.
  z.object({ t: z.literal('mode'), mode: RoomMode }),
  z.object({ t: z.literal('load'), source: Source }),
  z.object({
    t: z.literal('intent'),
    action: z.enum(['play', 'pause', 'seek', 'rate']),
    position: z.number().min(0).max(86_400 * 2),
    rate: z.number().min(0.25).max(4).optional(),
  }),
  z.object({ t: z.literal('buffering'), value: z.boolean() }),
  /** "The video finished" — carries the seq it was watching so duplicates are ignored. */
  z.object({ t: z.literal('ended'), seq: z.number() }),
  z.discriminatedUnion('op', [
    z.object({ t: z.literal('queue'), op: z.literal('add'), source: Source }),
    z.object({ t: z.literal('queue'), op: z.literal('remove'), id: z.string() }),
    z.object({ t: z.literal('queue'), op: z.literal('move'), id: z.string(), to: z.number().int().min(0) }),
    z.object({ t: z.literal('queue'), op: z.literal('play'), id: z.string() }),
  ]),
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
    browser: BrowserStatus,
    mode: RoomMode,
    state: PlaybackState.nullable(),
    queue: z.array(QueueItem),
    waiting: z.array(z.string()),
  }),
  z.object({ t: z.literal('react'), id: z.number(), memberId: MemberId, emoji: z.enum(REACTIONS) }),
  /** Reply to joining the call: who is already in it, so the joiner calls each of them. */
  z.object({ t: z.literal('call:peers'), ids: z.array(MemberId) }),
  z.object({ t: z.literal('rtc'), from: MemberId, kind: z.enum(['offer', 'answer', 'ice']), data: z.unknown() }),
  z.object({ t: z.literal('mode'), mode: RoomMode }),
  z.object({ t: z.literal('state'), state: PlaybackState.nullable() }),
  z.object({ t: z.literal('queue'), queue: z.array(QueueItem) }),
  /** Names of people everyone is paused for; empty when playback may resume. */
  z.object({ t: z.literal('waiting'), for: z.array(z.string()) }),
  z.object({ t: z.literal('browser:status'), browser: BrowserStatus }),
  // Sent only to the member it is for: the address carries that member's own login.
  z.object({ t: z.literal('browser:join'), engine: EngineName, url: z.string().url() }),
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
