import type { EngineName } from '@wt/shared';
import type { Env } from '../env';
import { FakeEngine } from './fake';
import { NekoEngine } from './neko';

/**
 * The room only ever talks to this. neko is the one real engine; another
 * (for example a hosted backup) can be added here without touching the room or the UI.
 */
export interface BrowserEngine {
  readonly name: EngineName;
  healthy(): Promise<boolean>;
  /** Get the browser ready for this room, clearing anything a previous room left behind. */
  start(room: string): Promise<void>;
  /** Create (or re-create) this person's own login and return the address to embed. */
  addMember(room: string, memberId: string, canControl: boolean): Promise<string>;
  removeMember(room: string, memberId: string): Promise<void>;
  /** Apply who can control right now. Takes effect immediately for people already watching. */
  setControl(room: string, canControl: Readonly<Record<string, boolean>>): Promise<void>;
  /** Log everyone from this room out. The browser itself and its saved logins stay. */
  stop(room: string): Promise<void>;
}

export function makeEngine(env: Env, origin: string): BrowserEngine | null {
  if (env.BROWSER_ENGINE === 'fake') return new FakeEngine(origin);
  if (env.NEKO_URL && env.NEKO_ADMIN_TOKEN) return new NekoEngine(env.NEKO_URL, env.NEKO_ADMIN_TOKEN);
  return null;
}
