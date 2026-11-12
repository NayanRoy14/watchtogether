import type { ControlMode } from './messages';

/** Who may act on the shared content: everyone, or only the current driver. */
export function hasControl(mode: ControlMode, isDriver: boolean): boolean {
  return mode === 'everyone' || isDriver;
}

/** The driver is whoever was handed control, falling back to the host if they left. */
export function pickDriver(memberIds: readonly string[], driverId: string | null, hostId: string | null): string | null {
  return driverId && memberIds.includes(driverId) ? driverId : hostId;
}

/** May `actor` hand control to `target`? The host always can; the driver can pass it on. */
export function mayGiveControl(actor: string, hostId: string | null, driverId: string | null): boolean {
  return actor === hostId || actor === driverId;
}

/** A room has several deadlines but a Durable Object has one alarm: wake at the earliest. */
export function nextAlarm(timers: Readonly<Record<string, number | undefined>>): number | null {
  let next: number | null = null;
  for (const at of Object.values(timers)) if (at !== undefined && (next === null || at < next)) next = at;
  return next;
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
