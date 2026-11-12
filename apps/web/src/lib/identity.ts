import { AVATAR_COLORS, MAX_NAME_LENGTH } from '@wt/shared';

export interface Identity {
  clientId: string;
  name: string;
  color: string;
}

// Storage can be unavailable (private windows, blocked site data); fall back to memory.
const memory = new Map<string, string>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

function write(key: string, value: string): void {
  memory.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    // kept in memory for this visit
  }
}

function ensure(key: string, make: () => string): string {
  const existing = read(key);
  if (existing) return existing;
  const value = make();
  write(key, value);
  return value;
}

export function getIdentity(): Identity {
  return {
    clientId: ensure('wt.clientId', () => crypto.randomUUID()),
    color: ensure('wt.color', () => AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)] ?? AVATAR_COLORS[0]),
    name: read('wt.name') ?? '',
  };
}

export function saveName(name: string): string {
  const clean = name.trim().slice(0, MAX_NAME_LENGTH);
  write('wt.name', clean);
  return clean;
}

/** The owner's passphrase, remembered on the owner's own device after it first works. */
export const ownerKey = {
  get: (): string => read('wt.ownerKey') ?? '',
  set: (value: string): void => write('wt.ownerKey', value),
  clear: (): void => {
    memory.delete('wt.ownerKey');
    try {
      localStorage.removeItem('wt.ownerKey');
    } catch {
      // nothing stored
    }
  },
};
