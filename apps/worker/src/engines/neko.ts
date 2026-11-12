import type { Quality } from '@wt/shared';
import type { BrowserEngine, EngineMember } from './types';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 6000;

/** 16:9 sizes neko's virtual screen accepts at 30 fps (checked against a running server). */
const SCREENS: Record<Quality, { width: number; height: number; rate: number }> = {
  '540p': { width: 960, height: 540, rate: 30 },
  '720p': { width: 1280, height: 720, rate: 30 },
  '1080p': { width: 1920, height: 1080, rate: 30 },
};

/**
 * neko (m1k1o/neko v3) through its admin API.
 *
 * Each person gets a throw-away neko account named "wt-<room>-<member>", so the browser
 * can be embedded without anyone sharing a password, and removing the account logs that
 * person out at once. Control is steered per account with `can_host`: with implicit
 * hosting on, whoever is allowed to host takes control simply by clicking.
 */
export class NekoEngine implements BrowserEngine {
  readonly name = 'neko' as const;
  private readonly base: string;

  constructor(baseUrl: string, private readonly token: string, private readonly http: Fetch = (i, o) => fetch(i, o)) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  async healthy(): Promise<boolean> {
    try {
      // /health needs no token; the members call proves our token is accepted too.
      const res = await this.call('GET', '/api/members?limit=1');
      return res.ok;
    } catch {
      return false;
    }
  }

  async start(room: string): Promise<void> {
    // Anything named wt-* that isn't ours was left by a room that no longer holds the browser.
    const stale = (await this.accounts()).filter((id) => !id.startsWith(prefix(room)));
    await this.removeAccounts(stale);
    await this.expect('POST', '/api/room/settings', {
      implicit_hosting: true,
      locked_controls: false,
      inactive_cursors: true,
      private_mode: false,
    });
  }

  async addMember(room: string, member: EngineMember): Promise<string> {
    const username = account(room, member.id);
    const password = randomHex(16);
    await this.call('DELETE', `/api/members/${username}`); // fine if it did not exist
    await this.expect('POST', '/api/members', { username, password, profile: profile(member) });
    const q = new URLSearchParams({ usr: username, pwd: password, embed: '1' });
    return `${this.base}/?${q}`;
  }

  async removeMember(room: string, memberId: string): Promise<void> {
    await this.call('DELETE', `/api/members/${account(room, memberId)}`);
  }

  async setControl(room: string, members: readonly EngineMember[]): Promise<void> {
    await Promise.all(members.map((m) => this.call('POST', `/api/members/${account(room, m.id)}`, profile(m))));
  }

  async setQuality(quality: Quality): Promise<void> {
    await this.expect('POST', '/api/room/screen', SCREENS[quality]);
  }

  async stop(room: string): Promise<void> {
    const ours = (await this.accounts()).filter((id) => id.startsWith(prefix(room)));
    await this.removeAccounts(ours);
  }

  // ---- helpers ----------------------------------------------------------------

  private async accounts(): Promise<string[]> {
    const res = await this.expect('GET', '/api/members');
    const list = (await res.json()) as Array<{ id?: unknown }>;
    return list.map((m) => m.id).filter((id): id is string => typeof id === 'string' && id.startsWith('wt-'));
  }

  private async removeAccounts(ids: string[]): Promise<void> {
    await Promise.all(ids.map((id) => this.call('DELETE', `/api/members/${id}`)));
  }

  private call(method: string, path: string, body?: unknown): Promise<Response> {
    return this.http(this.base + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  private async expect(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await this.call(method, path, body);
    if (!res.ok) throw new Error(`neko ${method} ${path} → ${res.status}`);
    return res;
  }
}

const prefix = (room: string): string => `wt-${room.toLowerCase()}-`;
const account = (room: string, memberId: string): string => prefix(room) + memberId;

function profile({ name, canControl }: EngineMember): Record<string, unknown> {
  return {
    name,
    is_admin: false,
    can_login: true,
    can_connect: true,
    can_watch: true,
    can_host: canControl,
    can_share_media: false,
    can_access_clipboard: canControl,
    sends_inactive_cursor: true,
    can_see_inactive_cursors: true,
  };
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}
