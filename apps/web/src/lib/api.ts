import { CreateRoomResponse, RoomInfo } from '@wt/shared';

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`request failed (${status})`);
  }
}

export async function createRoom(clientId: string): Promise<string> {
  const res = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId }),
  });
  if (!res.ok) throw new ApiError(res.status);
  return CreateRoomResponse.parse(await res.json()).code;
}

export async function getRoom(code: string): Promise<RoomInfo> {
  const res = await fetch(`/api/rooms/${code}`);
  if (!res.ok) throw new ApiError(res.status);
  return RoomInfo.parse(await res.json());
}
