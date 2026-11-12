import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { MAX_NAME_LENGTH, formatCode, normalizeCode } from '@wt/shared';
import { Mark } from '../components/Mark';
import { ApiError, createRoom, getRoom } from '../lib/api';
import { getIdentity, saveName } from '../lib/identity';

/** Types the dash for you: "k7m2" → "K7M-2". */
function tidyCode(raw: string): string {
  const chars = raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 6);
  return chars.length > 3 ? formatCode(chars) : chars;
}

export function Home() {
  const navigate = useNavigate();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(() => getIdentity().name);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<{ field: 'name' | 'code' | 'create'; text: string } | null>(null);

  const requireName = (): boolean => {
    if (saveName(name)) return true;
    setError({ field: 'name', text: 'Add a name so your friend knows it’s you.' });
    nameRef.current?.focus();
    return false;
  };

  const start = async (): Promise<void> => {
    if (!requireName()) return;
    setBusy('create');
    setError(null);
    try {
      const created = await createRoom(getIdentity().clientId);
      navigate(`/r/${created}`, { state: { autoJoin: true } });
    } catch (e) {
      const limited = e instanceof ApiError && e.status === 429;
      setError({
        field: 'create',
        text: limited ? 'You’ve started a lot of rooms this hour. Try again later.' : 'Couldn’t reach the server. Try again.',
      });
      setBusy(null);
    }
  };

  const join = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const clean = normalizeCode(code);
    if (!clean) return setError({ field: 'code', text: 'Codes are 6 characters, like K7M-2QX.' });
    if (!requireName()) return;
    setBusy('join');
    setError(null);
    try {
      const info = await getRoom(clean);
      if (!info.exists) {
        setError({ field: 'code', text: 'No room with that code. Check it with your friend.' });
        return setBusy(null);
      }
      navigate(`/r/${clean}`, { state: { autoJoin: true } });
    } catch {
      setError({ field: 'code', text: 'Couldn’t reach the server. Try again.' });
      setBusy(null);
    }
  };

  return (
    <div className="relative min-h-dvh overflow-hidden">
      {/* projector light */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-64 right-[-10%] h-[720px] w-[720px] rounded-full opacity-[0.13] blur-3xl"
        style={{ background: 'radial-gradient(circle, var(--color-accent), transparent 65%)' }}
      />
      <div className="relative mx-auto flex min-h-dvh max-w-6xl flex-col px-4 sm:px-8">
        <header className="flex h-16 items-center gap-2">
          <Mark />
          <span className="text-sm font-semibold tracking-tight">Watch Together</span>
        </header>

        <main className="grid flex-1 items-center gap-12 py-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-16">
          <div className="max-w-md">
            <h1 className="text-4xl leading-[1.05] font-semibold tracking-tight sm:text-5xl">
              One screen.
              <br />
              <span className="text-accent">Both of you.</span>
            </h1>
            <p className="text-dim mt-4 text-base leading-relaxed">
              Open a room, send the code, and watch the same thing at the same moment — with chat alongside. No
              accounts.
            </p>

            <div className="mt-8">
              <label className="label" htmlFor="name">
                Your name
              </label>
              <input
                id="name"
                ref={nameRef}
                className="field"
                value={name}
                maxLength={MAX_NAME_LENGTH}
                autoComplete="nickname"
                placeholder="What should people call you?"
                aria-invalid={error?.field === 'name'}
                onChange={(e) => {
                  setName(e.target.value);
                  if (error?.field === 'name') setError(null);
                }}
              />
              {error?.field === 'name' && <p className="text-danger mt-2 text-sm">{error.text}</p>}
            </div>

            <button className="btn btn-accent mt-4 h-12 w-full text-base" disabled={busy !== null} onClick={() => void start()}>
              {busy === 'create' ? 'Opening…' : 'Start a room'}
            </button>
            {error?.field === 'create' && <p className="text-danger mt-2 text-sm">{error.text}</p>}

            <div className="text-faint my-6 flex items-center gap-4 text-xs uppercase tracking-wide">
              <span className="bg-line h-px flex-1" />
              or join with a code
              <span className="bg-line h-px flex-1" />
            </div>

            <form className="flex gap-2" onSubmit={(e) => void join(e)}>
              <input
                className="field h-12 font-mono text-lg tracking-[0.2em] uppercase placeholder:tracking-[0.2em]"
                value={code}
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                placeholder="K7M-2QX"
                aria-label="Room code"
                aria-invalid={error?.field === 'code'}
                onChange={(e) => {
                  setCode(tidyCode(e.target.value));
                  if (error?.field === 'code') setError(null);
                }}
              />
              <button className="btn btn-quiet h-12 px-6" disabled={busy !== null}>
                {busy === 'join' ? 'Checking…' : 'Join'}
              </button>
            </form>
            {error?.field === 'code' && <p className="text-danger mt-2 text-sm">{error.text}</p>}
          </div>

          <Preview />
        </main>
      </div>
    </div>
  );
}

/** A quiet picture of the room: one screen, two cursors. */
function Preview() {
  return (
    <div aria-hidden className="hidden lg:block">
      <div className="border-line bg-surface rounded-2xl border p-2 shadow-2xl shadow-black/60">
        <div className="flex items-center gap-2 px-2 pt-1 pb-2">
          <span className="bg-line h-2 w-2 rounded-full" />
          <span className="bg-line h-2 w-2 rounded-full" />
          <span className="bg-raised text-faint ml-2 h-6 flex-1 rounded-md px-3 font-mono text-[11px] leading-6">
            lectures / week-7 / signals
          </span>
        </div>
        <div className="relative aspect-video overflow-hidden rounded-xl bg-black">
          <div
            className="absolute inset-0 opacity-70"
            style={{
              background:
                'radial-gradient(120% 90% at 20% 10%, #3a2a12 0%, transparent 55%), radial-gradient(90% 80% at 85% 90%, #1c2238 0%, transparent 60%)',
            }}
          />
          <div className="absolute inset-x-6 bottom-6 flex items-center gap-3">
            <span className="h-2 w-2 rounded-full bg-white/80" />
            <span className="relative h-1 flex-1 rounded-full bg-white/15">
              <span className="bg-accent absolute inset-y-0 left-0 w-[38%] rounded-full" />
            </span>
            <span className="font-mono text-[11px] text-white/60">18:42</span>
          </div>
          <Cursor name="You" color="#f2a93b" className="top-[34%] left-[30%]" />
          <Cursor name="Riya" color="#6b9cf5" className="top-[58%] left-[62%]" />
        </div>
      </div>
    </div>
  );
}

function Cursor({ name, color, className }: { name: string; color: string; className: string }) {
  return (
    <div className={`absolute ${className}`}>
      <svg viewBox="0 0 16 16" className="h-4 w-4" style={{ color }}>
        <path d="M2 1.5 13.5 7 8.3 8.6 6.5 14Z" fill="currentColor" stroke="#0c0b0d" strokeWidth="1" />
      </svg>
      <span className="ml-3 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-black/80" style={{ backgroundColor: color }}>
        {name}
      </span>
    </div>
  );
}
