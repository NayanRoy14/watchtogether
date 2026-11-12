import type { BrowserEngine, EngineMember } from './types';

/** A stand-in for local development and tests: no server needed, the "browser" is a plain page. */
export class FakeEngine implements BrowserEngine {
  readonly name = 'fake' as const;
  /** What the room last told the engine about each person's control, for tests to inspect. */
  static control = new Map<string, boolean>();

  constructor(private readonly origin: string) {}

  async healthy(): Promise<boolean> {
    return true;
  }
  async start(): Promise<void> {}
  async addMember(room: string, member: EngineMember): Promise<string> {
    FakeEngine.control.set(`${room}:${member.id}`, member.canControl);
    const q = new URLSearchParams({ room, member: member.id, control: String(member.canControl), n: crypto.randomUUID().slice(0, 8) });
    return `${this.origin}/api/fake-browser?${q}`;
  }
  async removeMember(): Promise<void> {}
  async setControl(room: string, members: readonly EngineMember[]): Promise<void> {
    for (const m of members) FakeEngine.control.set(`${room}:${m.id}`, m.canControl);
  }
  async setQuality(): Promise<void> {}
  async stop(): Promise<void> {}
}

export function fakeBrowserPage(url: URL): Response {
  const safe = (key: string): string => (url.searchParams.get(key) ?? '').replace(/[^a-zA-Z0-9-]/g, '');
  const html = `<!doctype html><meta charset="utf-8"><title>Fake browser</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#1b2030;color:#dfe3f0;font:16px system-ui">
<div style="text-align:center"><p style="font-size:24px;font-weight:600;margin:0 0 8px">Stand-in browser</p>
<p style="margin:0;opacity:.7">room <b data-testid="room">${safe('room')}</b> · member <b data-testid="member">${safe('member')}</b></p></div>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
