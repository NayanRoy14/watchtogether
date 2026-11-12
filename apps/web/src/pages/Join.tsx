import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { MAX_MEMBERS, MAX_NAME_LENGTH, formatCode, type RoomInfo } from '@wt/shared';
import { Mark } from '../components/Mark';
import { getRoom } from '../lib/api';
import { getIdentity, saveName } from '../lib/identity';

type Lookup = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; info: RoomInfo };

export function Join({ code, onReady }: { code: string; onReady: () => void }) {
  const [lookup, setLookup] = useState<Lookup>({ state: 'loading' });
  const [name, setName] = useState(() => getIdentity().name);
  const [nameError, setNameError] = useState(false);

  useEffect(() => {
    let current = true;
    getRoom(code)
      .then((info) => current && setLookup({ state: 'ready', info }))
      .catch(() => current && setLookup({ state: 'failed' }));
    return () => {
      current = false;
    };
  }, [code]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!saveName(name)) return setNameError(true);
    onReady();
  };

  const info = lookup.state === 'ready' ? lookup.info : null;
  const blocked =
    lookup.state === 'failed'
      ? { title: 'Couldn’t reach the server', body: 'Check your connection and reload this page.' }
      : info && !info.exists
        ? { title: 'This room doesn’t exist', body: 'The code may be mistyped, or the room closed after sitting empty for a day.' }
        : info && info.memberCount >= MAX_MEMBERS
          ? { title: 'This room is full', body: `Rooms hold ${MAX_MEMBERS} people. Ask someone to make space.` }
          : null;

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-12">
      <Link to="/" className="text-dim hover:text-fg mb-12 flex items-center gap-2 text-sm font-semibold transition-colors">
        <Mark />
        Watch Together
      </Link>

      <p className="label">Room</p>
      <p className="font-mono text-4xl font-semibold tracking-[0.12em]">{formatCode(code)}</p>

      {lookup.state === 'loading' && <p className="text-dim mt-4 text-sm">Looking for the room…</p>}

      {blocked && (
        <div className="mt-6">
          <h1 className="text-lg font-semibold">{blocked.title}</h1>
          <p className="text-dim mt-2 text-sm leading-relaxed">{blocked.body}</p>
          <Link to="/" className="btn btn-quiet mt-6">
            Start your own room
          </Link>
        </div>
      )}

      {info && !blocked && (
        <form className="mt-4" onSubmit={submit}>
          <p className="text-dim text-sm">
            {info.memberCount === 0
              ? 'Nobody’s inside yet — you’ll be first.'
              : info.memberCount === 1
                ? '1 person is waiting inside.'
                : `${info.memberCount} people are inside.`}
            {info.locked && ' The host has locked it, so only people who were already in can rejoin.'}
          </p>
          <label className="label mt-8" htmlFor="join-name">
            Your name
          </label>
          <input
            id="join-name"
            className="field"
            value={name}
            maxLength={MAX_NAME_LENGTH}
            autoFocus
            autoComplete="nickname"
            placeholder="What should people call you?"
            aria-invalid={nameError}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(false);
            }}
          />
          {nameError && <p className="text-danger mt-2 text-sm">Add a name so people know it’s you.</p>}
          <button className="btn btn-accent mt-4 h-12 w-full text-base">Join room</button>
        </form>
      )}
    </div>
  );
}
