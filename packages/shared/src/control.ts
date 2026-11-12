import type { ControlMode } from './messages';

/** Who may act on the shared content. One-driver hand-offs arrive with the shared browser. */
export function hasControl(mode: ControlMode, isHost: boolean): boolean {
  return mode === 'everyone' || isHost;
}

/** The host seat goes to whoever has been in the room longest. */
export function pickHost<T extends { id: string; joinedAt: number }>(
  members: readonly T[],
  currentHostId: string | null,
): string | null {
  if (currentHostId && members.some((m) => m.id === currentHostId)) return currentHostId;
  let oldest: T | undefined;
  for (const m of members) if (!oldest || m.joinedAt < oldest.joinedAt) oldest = m;
  return oldest?.id ?? null;
}
