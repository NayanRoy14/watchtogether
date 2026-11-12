import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { formatCode, normalizeCode } from '@wt/shared';
import { BrowserView } from '../browser/BrowserView';
import { ChatPanel } from '../chat/ChatPanel';
import { PeoplePanel } from '../chat/PeoplePanel';
import { ReactionLayer } from '../chat/Reactions';
import { Avatar } from '../components/Avatar';
import { CheckIcon, ExitIcon, LinkIcon, LockIcon, PanelIcon, PhoneIcon } from '../components/icons';
import { Mark } from '../components/Mark';
import { SettingsMenu } from '../components/SettingsMenu';
import { DirectView } from '../direct/DirectView';
import { getIdentity } from '../lib/identity';
import { useCall } from '../rtc/call';
import { CallDock } from '../rtc/CallDock';
import { useMe, useRoom } from '../store/room';
import type { EndReason } from '../store/socket';
import { Join } from './Join';

export function RoomRoute() {
  const code = normalizeCode(useParams().code ?? '');
  const location = useLocation();
  // Arriving from Home skips the join screen; arriving from a shared link shows it.
  const [ready, setReady] = useState(
    () => (location.state as { autoJoin?: boolean } | null)?.autoJoin === true && getIdentity().name !== '',
  );

  if (!code) return <Ended reason="not_found" />;
  return ready ? <Room code={code} /> : <Join code={code} onReady={() => setReady(true)} />;
}

function Room({ code }: { code: string }) {
  const join = useRoom((s) => s.join);
  const leave = useRoom((s) => s.leave);
  const connection = useRoom((s) => s.connection);
  const endReason = useRoom((s) => s.endReason);
  const notice = useRoom((s) => s.notice);
  const mode = useRoom((s) => s.mode);
  const callError = useCall((s) => s.error);
  const [panelOpen, setPanelOpen] = useState(() => window.matchMedia('(min-width: 768px)').matches);

  useEffect(() => {
    join(code);
    return () => {
      useCall.getState().leave();
      leave();
    };
  }, [code, join, leave]);

  // Fullscreen covers the whole room, so chat and notices stay visible over the stream.
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen().catch(() => undefined);
  };

  if (connection === 'ended') return <Ended reason={endReason ?? 'not_found'} />;

  return (
    <div ref={rootRef} className="bg-canvas flex h-full flex-col">
      <TopBar code={code} panelOpen={panelOpen} onTogglePanel={() => setPanelOpen((v) => !v)} />
      <div className="relative flex min-h-0 flex-1">
        <main className="relative flex min-w-0 flex-1 justify-center overflow-y-auto p-2 sm:p-4">
          <div className="my-auto flex w-full justify-center">
            {mode === 'browser' ? <BrowserView onFullscreen={toggleFullscreen} /> : <DirectView onFullscreen={toggleFullscreen} />}
          </div>
          <ReactionLayer />
          <CallDock />
          {(connection !== 'live' || notice || callError) && (
            <div
              role="status"
              className="border-line bg-surface absolute top-4 left-1/2 z-20 max-w-[90%] -translate-x-1/2 rounded-full border px-4 py-2 text-center text-sm shadow-lg shadow-black/50"
            >
              {connection === 'connecting' ? 'Joining…' : connection === 'reconnecting' ? 'Reconnecting…' : (notice ?? callError)}
            </div>
          )}
        </main>
        <SidePanel open={panelOpen} onClose={() => setPanelOpen(false)} />
      </div>
    </div>
  );
}

function TopBar({ code, panelOpen, onTogglePanel }: { code: string; panelOpen: boolean; onTogglePanel: () => void }) {
  const members = useRoom((s) => s.members);
  const locked = useRoom((s) => s.settings.locked);
  const me = useMe();
  const amHost = me?.isHost ?? false;
  const mode = useRoom((s) => s.mode);
  const setMode = useRoom((s) => s.setMode);
  const inCall = useCall((s) => s.on);
  const joiningCall = useCall((s) => s.joining);
  const [copied, setCopied] = useState(false);

  const copyLink = async (): Promise<void> => {
    const link = `${location.origin}/r/${code}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      window.prompt('Copy this link', link);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <header className="border-line flex h-14 shrink-0 items-center gap-2 border-b px-2 sm:px-4">
      <Link to="/" aria-label="Watch Together home" className="hidden p-2 sm:block">
        <Mark />
      </Link>
      <button
        className="hover:bg-raised group flex h-10 items-center gap-2 rounded-lg px-3 transition-colors"
        onClick={() => void copyLink()}
        title="Copy invite link"
      >
        {locked && <LockIcon className="text-faint h-3.5 w-3.5" />}
        <span className="font-mono text-sm font-semibold tracking-[0.14em] whitespace-nowrap">{formatCode(code)}</span>
        <span className={`flex items-center gap-1 text-xs ${copied ? 'text-accent' : 'text-dim group-hover:text-fg'}`}>
          {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <LinkIcon className="h-3.5 w-3.5" />}
          <span className="hidden sm:inline">{copied ? 'Link copied' : 'Copy link'}</span>
        </span>
      </button>

      <div
        className="bg-surface ml-1 grid grid-cols-2 gap-1 rounded-lg p-1"
        role="radiogroup"
        aria-label="What the room is watching"
        title={me?.hasControl ? undefined : 'Only someone with control can switch'}
      >
        {(['browser', 'direct'] as const).map((m) => (
          <button
            key={m}
            role="radio"
            aria-checked={mode === m}
            disabled={!me?.hasControl}
            className={`h-8 rounded-md px-2 text-xs font-medium transition-colors sm:px-3 ${mode === m ? 'bg-raised text-fg' : 'text-dim enabled:hover:text-fg'}`}
            onClick={() => mode !== m && setMode(m)}
          >
            {m === 'browser' ? 'Browser' : 'Direct'}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      <div className="hidden -space-x-2 pr-1 sm:flex" aria-label={`${members.length} in the room`}>
        {members.slice(0, 5).map((m) => (
          <span key={m.id} title={m.isHost ? `${m.name} · host` : m.name}>
            <Avatar name={m.name} color={m.color} ring />
          </span>
        ))}
        {members.length > 5 && (
          <span className="bg-raised ring-canvas text-dim inline-flex h-8 w-8 items-center justify-center rounded-full text-xs ring-2">
            +{members.length - 5}
          </span>
        )}
      </div>

      {!inCall && (
        <button
          className="text-dim hover:bg-raised hover:text-fg flex h-10 items-center gap-2 rounded-lg px-3 text-sm transition-colors disabled:opacity-50"
          disabled={joiningCall}
          onClick={() => void useCall.getState().join()}
        >
          <PhoneIcon />
          <span className="hidden sm:inline">{joiningCall ? 'Joining…' : 'Join call'}</span>
        </button>
      )}
      {amHost && <SettingsMenu />}
      <button
        className={`hover:bg-raised flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${panelOpen ? 'text-fg' : 'text-dim'}`}
        aria-label={panelOpen ? 'Hide chat and people' : 'Show chat and people'}
        aria-pressed={panelOpen}
        onClick={onTogglePanel}
      >
        <PanelIcon />
      </button>
      <Link
        to="/"
        className="text-dim hover:bg-raised hover:text-danger flex h-10 w-10 items-center justify-center rounded-lg transition-colors"
        aria-label="Leave room"
        title="Leave room"
      >
        <ExitIcon />
      </Link>
    </header>
  );
}

function SidePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<'chat' | 'people'>('chat');
  const count = useRoom((s) => s.members.length);

  return (
    <>
      {open && <div className="fixed inset-0 z-10 bg-black/50 md:hidden" onClick={onClose} aria-hidden />}
      <aside
        className={`border-line bg-surface fixed inset-x-0 bottom-0 z-20 flex h-[72dvh] flex-col rounded-t-2xl border-t transition-transform md:static md:z-auto md:h-auto md:w-[352px] md:shrink-0 md:rounded-none md:border-t-0 md:border-l md:transition-none ${open ? 'translate-y-0' : 'translate-y-full md:hidden'}`}
        aria-hidden={!open}
        inert={!open}
      >
        <div className="border-line flex shrink-0 gap-1 border-b px-2 pt-2" role="tablist">
          {(['chat', 'people'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`-mb-px h-10 border-b-2 px-3 text-sm font-medium transition-colors ${tab === t ? 'border-accent text-fg' : 'text-dim hover:text-fg border-transparent'}`}
              onClick={() => setTab(t)}
            >
              {t === 'chat' ? 'Chat' : `People · ${count}`}
            </button>
          ))}
        </div>
        {tab === 'chat' ? <ChatPanel /> : <PeoplePanel />}
      </aside>
    </>
  );
}

const ENDINGS: Record<EndReason, { title: string; body: string }> = {
  kicked: { title: 'You were removed from the room', body: 'The host removed you, so this code won’t let you back in.' },
  room_full: { title: 'This room is full', body: 'Rooms hold 10 people. Ask someone to make space, then try the link again.' },
  room_locked: { title: 'This room is locked', body: 'The host isn’t letting new people in right now. Ask them to unlock it.' },
  replaced: { title: 'You’re in this room in another tab', body: 'Only one tab per device can be in a room. Carry on there, or rejoin here.' },
  not_found: { title: 'This room doesn’t exist', body: 'The code may be mistyped, or the room closed after sitting empty for a day.' },
};

function Ended({ reason }: { reason: EndReason }) {
  const { title, body } = ENDINGS[reason];
  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-12">
      <Mark className="mb-8 h-8 w-8" />
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-dim mt-2 text-sm leading-relaxed">{body}</p>
      <div className="mt-8 flex gap-2">
        {reason === 'replaced' && (
          <button className="btn btn-accent" onClick={() => window.location.reload()}>
            Rejoin here
          </button>
        )}
        <Link to="/" className="btn btn-quiet">
          Back to start
        </Link>
      </div>
    </div>
  );
}
