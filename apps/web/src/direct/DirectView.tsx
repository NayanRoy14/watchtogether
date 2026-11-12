import { useEffect, useRef, useState, type FormEvent } from 'react';
import { RATES, parseSource, type PlaybackState, type Source } from '@wt/shared';
import { ExpandIcon, PauseIcon, PlayIcon, VolumeIcon } from '../components/icons';
import { Html5Adapter } from '../players/Html5Adapter';
import { localFiles, probe } from '../players/localFiles';
import { PlaybackError, type PlayerAdapter } from '../players/PlayerAdapter';
import { YouTubeAdapter } from '../players/YouTubeAdapter';
import { formatTime, serverNow, useMe, useRoom } from '../store/room';
import { SyncEngine } from '../sync/engine';

/** Direct mode: everyone plays the video themselves and the room keeps the players in step. */
export function DirectView({ onFullscreen }: { onFullscreen: () => void }) {
  const playback = useRoom((s) => s.playback);
  const waiting = useRoom((s) => s.waiting);
  const canControl = useMe()?.hasControl ?? false;
  const source = playback?.source ?? null;
  const sourceKey = source ? `${source.kind}:${source.id}` : '';

  const mountRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<PlayerAdapter | null>(null);
  const engineRef = useRef<SyncEngine | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [blocked, setBlocked] = useState(false);
  /** Bumped when this person picks their copy of a local file, to retry loading. */
  const [picked, setPicked] = useState(0);
  const needsFile = source?.kind === 'local' && !localFiles.get(source.id);

  // One player per source. It is torn down and rebuilt when the room loads something else.
  useEffect(() => {
    const mount = mountRef.current;
    const room = useRoom.getState();
    const current = room.playback?.source;
    setProblem(null);
    setBlocked(false);
    if (!mount || !current || (current.kind === 'local' && !localFiles.get(current.id))) return;

    let alive = true;
    const player: PlayerAdapter = current.kind === 'youtube' ? new YouTubeAdapter(mount) : new Html5Adapter(mount);
    setLoading(true);
    player.onFailure = (message) => {
      if (!alive) return;
      setBlocked(false);
      setProblem(message);
    };
    player
      .load(current)
      .then(() => {
        if (!alive) return;
        const engine = new SyncEngine(player, {
          serverNow,
          hasControl: () => {
            const s = useRoom.getState();
            return s.members.find((m) => m.id === s.you)?.hasControl ?? false;
          },
          sendIntent: (action, position, rate) => room.send({ t: 'intent', action, position, rate }),
          sendBuffering: (value) => room.send({ t: 'buffering', value }),
          sendEnded: (seq) => room.send({ t: 'ended', seq }),
          onBlocked: setBlocked,
        });
        playerRef.current = player;
        engineRef.current = engine;
        setLoading(false);
        const now = useRoom.getState().playback;
        if (now) engine.apply(now);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setLoading(false);
        setProblem(err instanceof PlaybackError ? err.message : 'Something went wrong loading this video.');
      });

    return () => {
      alive = false;
      engineRef.current?.destroy();
      engineRef.current = null;
      playerRef.current = null;
      player.destroy();
    };
  }, [sourceKey, picked]);

  // Every later change to the room's state is handed to the engine.
  useEffect(() => {
    if (playback) engineRef.current?.apply(playback);
  }, [playback]);

  return (
    <div className="flex w-full max-w-[min(1280px,calc((100dvh-16rem)*16/9))] min-w-[min(100%,20rem)] flex-col gap-2">
      <div className="border-line relative aspect-video w-full overflow-hidden rounded-xl border bg-black">
        <div ref={mountRef} className="absolute inset-0" />
        {!source && <Empty canControl={canControl} />}
        {source && needsFile && <PickYourCopy source={source} by={playback?.by ?? ''} onPicked={() => setPicked((n) => n + 1)} />}
        {loading && <Overlay>Loading…</Overlay>}
        {problem && <Overlay tone="danger">{problem}</Overlay>}
        {blocked && !problem && (
          <button
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-center"
            onClick={() => engineRef.current?.unblock()}
          >
            <span className="btn btn-accent h-12 px-8 text-base">Click to join playback</span>
            <span className="text-dim max-w-xs text-xs leading-relaxed">
              Your browser needs one click before it plays sound.
              {source?.kind === 'youtube' && ' If nothing happens, YouTube may not allow this video here — try the shared browser.'}
            </span>
          </button>
        )}
        {waiting.length > 0 && (
          <p role="status" className="border-line bg-surface absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border px-4 py-2 text-sm">
            Waiting for {waiting.join(', ')}…
          </p>
        )}
      </div>

      {playback && <ControlBar playback={playback} player={playerRef} canControl={canControl} onFullscreen={onFullscreen} />}
      <SourceBar canControl={canControl} />
      <Queue canControl={canControl} />
    </div>
  );
}

function Overlay({ children, tone }: { children: string; tone?: 'danger' }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/70 px-6 text-center">
      <p role={tone ? 'alert' : 'status'} className={`max-w-sm text-sm leading-relaxed ${tone ? 'text-danger' : 'text-dim'}`}>
        {children}
      </p>
    </div>
  );
}

function Empty({ canControl }: { canControl: boolean }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
      <p className="text-lg font-semibold">Nothing is loaded</p>
      <p className="text-dim mt-2 max-w-sm text-sm leading-relaxed">
        {canControl
          ? 'Paste a YouTube or video link below, or choose a movie file. Each person plays it on their own device, in full quality, and the room keeps you in step.'
          : 'Whoever has control can load a YouTube link, a video link or a movie file.'}
      </p>
    </div>
  );
}

/** Everyone needs the file themselves; this is where the others pick theirs. */
function PickYourCopy({ source, by, onPicked }: { source: Source; by: string; onPicked: () => void }) {
  const [note, setNote] = useState<string | null>(null);

  const choose = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      const { fingerprint } = await probe(file);
      localFiles.set(source.id, file);
      if (fingerprint !== source.fingerprint) {
        useRoom.getState().flash('Your file’s size or length differs from theirs — it may not line up.');
      }
      onPicked();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'That file could not be opened.');
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
      <p className="text-lg font-semibold break-all">{source.title}</p>
      <p className="text-dim mt-2 max-w-sm text-sm leading-relaxed">
        {by ? `${by} is playing this from their own device.` : 'This is playing from a file.'} Choose your copy of the same
        file to watch along. Nothing is uploaded.
      </p>
      <label className="btn btn-accent mt-6 cursor-pointer">
        Choose your copy
        <input type="file" accept="video/*,.mkv" className="sr-only" onChange={(e) => void choose(e.target.files?.[0])} />
      </label>
      {note && <p role="alert" className="text-danger mt-4 text-sm">{note}</p>}
    </div>
  );
}

function ControlBar({
  playback,
  player,
  canControl,
  onFullscreen,
}: {
  playback: PlaybackState;
  player: React.RefObject<PlayerAdapter | null>;
  canControl: boolean;
  onFullscreen: () => void;
}) {
  const send = useRoom((s) => s.send);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [dragging, setDragging] = useState<number | null>(null);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    const read = (): void => {
      const p = player.current;
      if (!p) return;
      setTime(p.currentTime());
      setDuration(p.duration());
    };
    read();
    const timer = setInterval(read, 250);
    return () => clearInterval(timer);
  }, [player, playback.source.id]);

  useEffect(() => {
    player.current?.setVolume(volume, muted);
  }, [player, volume, muted, playback.seq]);

  const position = (): number => player.current?.currentTime() ?? playback.position;
  const quiet = 'text-dim hover:text-fg hover:bg-raised flex h-8 items-center justify-center rounded-md transition-colors disabled:opacity-40 disabled:hover:bg-transparent';

  return (
    <div className="flex items-center gap-2 px-1">
      <button
        className={`${quiet} text-fg w-8`}
        disabled={!canControl}
        aria-label={playback.playing ? 'Pause' : 'Play'}
        title={canControl ? undefined : 'You don’t have control'}
        onClick={() => send({ t: 'intent', action: playback.playing ? 'pause' : 'play', position: position() })}
      >
        {playback.playing ? <PauseIcon /> : <PlayIcon />}
      </button>

      <span className="text-dim w-12 text-right font-mono text-xs tabular-nums">{formatTime(dragging ?? time)}</span>
      <input
        type="range"
        className="accent-accent h-1 min-w-0 flex-1 cursor-pointer disabled:cursor-default"
        aria-label="Seek"
        min={0}
        max={duration || 1}
        step={1}
        value={dragging ?? Math.min(time, duration || 1)}
        disabled={!canControl || duration === 0}
        onChange={(e) => setDragging(Number(e.target.value))}
        onPointerUp={() => commit()}
        onKeyUp={() => commit()}
      />
      <span className="text-faint w-12 font-mono text-xs tabular-nums">{formatTime(duration)}</span>

      <select
        className="bg-raised text-dim hover:text-fg h-8 rounded-md px-1 text-xs disabled:opacity-40"
        aria-label="Speed"
        value={playback.rate}
        disabled={!canControl}
        onChange={(e) => send({ t: 'intent', action: 'rate', position: position(), rate: Number(e.target.value) })}
      >
        {RATES.map((r) => (
          <option key={r} value={r}>
            {r}×
          </option>
        ))}
      </select>

      <button className={`${quiet} w-8`} aria-label={muted ? 'Unmute' : 'Mute'} aria-pressed={muted} onClick={() => setMuted((m) => !m)}>
        <VolumeIcon off={muted || volume === 0} />
      </button>
      <input
        type="range"
        className="accent-accent hidden h-1 w-16 cursor-pointer sm:block"
        aria-label="Volume (only for you)"
        min={0}
        max={1}
        step={0.05}
        value={muted ? 0 : volume}
        onChange={(e) => {
          setVolume(Number(e.target.value));
          setMuted(false);
        }}
      />
      <button className={`${quiet} w-8`} aria-label="Fullscreen" title="Fullscreen" onClick={onFullscreen}>
        <ExpandIcon />
      </button>
    </div>
  );

  function commit(): void {
    if (dragging === null) return;
    send({ t: 'intent', action: 'seek', position: dragging });
    setTime(dragging);
    setDragging(null);
  }
}

function SourceBar({ canControl }: { canControl: boolean }) {
  const send = useRoom((s) => s.send);
  const load = useRoom((s) => s.load);
  const hasPlayback = useRoom((s) => s.playback !== null);
  const [link, setLink] = useState('');
  const [note, setNote] = useState<string | null>(null);

  if (!canControl) return null;

  const parsed = (): Source | null => {
    const source = parseSource(link);
    if (!source) setNote('That doesn’t look like a YouTube or video link. Other sites belong in the shared browser.');
    return source;
  };

  const play = (event: FormEvent): void => {
    event.preventDefault();
    const source = parsed();
    if (!source) return;
    load(source);
    setLink('');
  };

  const queue = (): void => {
    const source = parsed();
    if (!source) return;
    send({ t: 'queue', op: 'add', source });
    setLink('');
  };

  const chooseFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      const { fingerprint } = await probe(file);
      localFiles.set(fingerprint, file);
      load({ kind: 'local', id: fingerprint, title: file.name.slice(0, 200), fingerprint });
      setNote(null);
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'That file could not be opened.');
    }
  };

  return (
    <div className="mt-2">
      <form className="flex flex-wrap gap-2" onSubmit={play}>
        <input
          className="field min-w-40 flex-1"
          value={link}
          placeholder="Paste a YouTube or video link"
          aria-label="Video link"
          autoComplete="off"
          onChange={(e) => {
            setLink(e.target.value);
            setNote(null);
          }}
        />
        <button className="btn btn-accent" disabled={!link.trim()}>
          Play
        </button>
        {hasPlayback && (
          <button type="button" className="btn btn-quiet" disabled={!link.trim()} onClick={queue}>
            Add to queue
          </button>
        )}
        <label className="btn btn-quiet cursor-pointer">
          Choose file
          <input
            type="file"
            accept="video/*,.mkv"
            className="sr-only"
            onChange={(e) => {
              void chooseFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </label>
      </form>
      {note && <p role="alert" className="text-danger mt-2 text-sm">{note}</p>}
    </div>
  );
}

function Queue({ canControl }: { canControl: boolean }) {
  const queue = useRoom((s) => s.queue);
  const send = useRoom((s) => s.send);
  if (queue.length === 0) return null;
  const quiet = 'text-dim hover:text-fg hover:bg-line h-8 rounded-md px-2 text-xs transition-colors';

  return (
    <section className="mt-2" aria-label="Up next">
      <p className="label">Up next</p>
      <ol className="border-line divide-line divide-y rounded-lg border">
        {queue.map((item, i) => (
          <li key={item.id} className="flex min-h-10 items-center gap-3 px-3">
            <span className="text-faint w-4 font-mono text-xs">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate text-sm">
              {item.source.title}
              <span className="text-faint"> · {item.source.kind === 'youtube' ? item.source.id : new URL(item.source.id).hostname}</span>
            </span>
            <span className="text-faint hidden text-xs sm:block">{item.addedBy}</span>
            {canControl && (
              <>
                <button className={quiet} onClick={() => send({ t: 'queue', op: 'play', id: item.id })}>
                  Play now
                </button>
                <button className={quiet} aria-label={`Remove ${item.source.title}`} onClick={() => send({ t: 'queue', op: 'remove', id: item.id })}>
                  Remove
                </button>
              </>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
