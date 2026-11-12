import { useState, type FormEvent } from 'react';
import { ExpandIcon, PointerIcon } from '../components/icons';
import { ownerKey } from '../lib/identity';
import { useMe, useRoom } from '../store/room';

const PROBLEMS = {
  bad_owner_key: 'That passphrase isn’t right.',
  browser_busy: 'The browser is being used in another room right now. Try again when they’re done.',
  browser_offline: 'The browser server isn’t answering. It may be restarting — try again in a minute.',
} as const;

/** The shared browser: a start screen while it is off, the live stream once it is on. */
export function BrowserView({ onFullscreen }: { onFullscreen: () => void }) {
  const status = useRoom((s) => s.browser.status);
  const url = useRoom((s) => s.browserUrl);

  // Sized so the 16:9 screen plus its control strip always fit the space under the top bar.
  return (
    <div className="flex w-full max-w-[min(1280px,calc((100dvh-9.5rem)*16/9))] flex-col gap-2">
      {status === 'live' && <ControlStrip onFullscreen={onFullscreen} />}
      <div className="border-line relative aspect-video w-full overflow-hidden rounded-xl border bg-black">
        {status === 'live' && url ? (
          <iframe
            key={url}
            src={url}
            title="Shared browser"
            className="absolute inset-0 h-full w-full"
            allow="autoplay; fullscreen; clipboard-read; clipboard-write"
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
            {status === 'off' ? <StartScreen /> : <Waiting text={status === 'starting' ? 'Starting browser…' : 'Connecting you…'} />}
          </div>
        )}
      </div>
    </div>
  );
}

function Waiting({ text }: { text: string }) {
  return (
    <p role="status" className="text-dim flex items-center gap-3 text-sm">
      <span className="border-line border-t-accent h-4 w-4 animate-spin rounded-full border-2" />
      {text}
    </p>
  );
}

function StartScreen() {
  const openBrowser = useRoom((s) => s.openBrowser);
  const problem = useRoom((s) => s.browserError);
  const live = useRoom((s) => s.connection === 'live');
  const [asking, setAsking] = useState(false);
  const [key, setKey] = useState('');

  const needsKey = asking || problem === 'bad_owner_key';

  const start = (): void => {
    const saved = ownerKey.get();
    if (saved) openBrowser(saved);
    else setAsking(true);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (key.trim()) openBrowser(key.trim());
  };

  return (
    <div className="w-full max-w-sm">
      <p className="text-lg font-semibold">The shared browser is off</p>
      <p className="text-dim mt-2 text-sm leading-relaxed">
        One real browser that everyone here sees, hears and can click in. Open any site — a lecture, YouTube, anything.
      </p>

      {needsKey ? (
        <form className="mt-6 text-left" onSubmit={submit}>
          <label className="label" htmlFor="owner-key">
            Owner passphrase
          </label>
          <div className="flex gap-2">
            <input
              id="owner-key"
              type="password"
              className="field"
              value={key}
              autoFocus
              autoComplete="current-password"
              aria-invalid={problem === 'bad_owner_key'}
              onChange={(e) => setKey(e.target.value)}
            />
            <button className="btn btn-accent shrink-0" disabled={!key.trim() || !live}>
              Open
            </button>
          </div>
          <p className="text-faint mt-2 text-xs leading-relaxed">
            The browser keeps its owner’s logins, so only they can start it. Once it’s open, everyone in the room can
            use it.
          </p>
        </form>
      ) : (
        <button className="btn btn-accent mt-6 h-12 px-8 text-base" disabled={!live} onClick={start}>
          Open browser
        </button>
      )}

      {problem && (
        <p role="alert" className="text-danger mt-4 text-sm">
          {PROBLEMS[problem]}
        </p>
      )}
      <p className="text-faint mt-6 text-xs">Netflix, Prime Video and Hotstar won’t play here — they block shared browsers.</p>
    </div>
  );
}

/** Who is controlling, and the buttons to change that. */
function ControlStrip({ onFullscreen }: { onFullscreen: () => void }) {
  const me = useMe();
  const members = useRoom((s) => s.members);
  const driverId = useRoom((s) => s.browser.driverId);
  const requests = useRoom((s) => s.browser.requests);
  const requestControl = useRoom((s) => s.requestControl);
  const giveControl = useRoom((s) => s.giveControl);
  const closeBrowser = useRoom((s) => s.closeBrowser);
  if (!me) return null;

  const driver = members.find((m) => m.id === driverId);
  const iDrive = driverId === me.id;
  const iAsked = requests.includes(me.id);
  const asking = members.filter((m) => requests.includes(m.id) && m.id !== me.id);
  const quiet = 'text-dim hover:text-fg hover:bg-raised h-8 rounded-md px-2 text-xs transition-colors';

  return (
    <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 px-1 text-sm">
      <span className={`flex items-center gap-2 ${me.hasControl ? 'text-fg' : 'text-dim'}`}>
        <PointerIcon className="h-3.5 w-3.5" style={{ color: (iDrive ? me : driver)?.color }} />
        {driverId === null
          ? 'Everyone can control — click the screen to take over'
          : iDrive
            ? 'You’re controlling'
            : `${driver?.name ?? 'Someone'} is controlling`}
      </span>

      {driverId !== null && !iDrive && (
        me.isHost ? (
          <button className={quiet} onClick={() => giveControl()}>
            Take control
          </button>
        ) : (
          <button className={quiet} disabled={iAsked} onClick={requestControl}>
            {iAsked ? 'Asked — waiting' : 'Request control'}
          </button>
        )
      )}

      {(iDrive || me.isHost) &&
        asking.map((m) => (
          <button key={m.id} className="bg-raised hover:bg-line h-8 rounded-md px-2 text-xs transition-colors" onClick={() => giveControl(m.id)}>
            <span style={{ color: m.color }}>{m.name}</span> wants control · Give
          </button>
        ))}

      <span className="flex-1" />
      {me.isHost && (
        <button className={quiet} onClick={closeBrowser}>
          Close browser
        </button>
      )}
      <button className={`${quiet} flex w-8 items-center justify-center px-0`} aria-label="Fullscreen" title="Fullscreen" onClick={onFullscreen}>
        <ExpandIcon />
      </button>
    </div>
  );
}
