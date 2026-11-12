import { useEffect, useRef, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { CameraIcon, MicIcon, PhoneIcon } from '../components/icons';
import { useRoom } from '../store/room';
import { useCall } from './call';

/** The call: small tiles and controls floating over the stage. Drag it by its tiles. */
export function CallDock() {
  const call = useCall();
  const members = useRoom((s) => s.members);
  const you = useRoom((s) => s.you);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ startX: number; startY: number; x: number; y: number } | null>(null);

  // Hold V to talk, unless typing somewhere.
  useEffect(() => {
    if (!call.on || !call.ptt) return;
    const typing = (e: KeyboardEvent): boolean => {
      const el = e.target as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    };
    const down = (e: KeyboardEvent): void => {
      if (e.code === 'KeyV' && !e.repeat && !e.ctrlKey && !e.metaKey && !typing(e)) call.setTalking(true);
    };
    const up = (e: KeyboardEvent): void => {
      if (e.code === 'KeyV') call.setTalking(false);
    };
    const blur = (): void => call.setTalking(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [call.on, call.ptt, call]);

  if (!call.on) return null;

  const me = members.find((m) => m.id === you);
  const others = members.filter((m) => m.inCall && m.id !== you);
  const micLive = call.ptt ? call.talking : !call.muted;
  const round = 'flex h-10 w-10 items-center justify-center rounded-full transition-colors';

  return (
    <div
      className="border-line bg-surface/95 absolute top-4 left-4 z-10 touch-none rounded-2xl border p-2 shadow-xl shadow-black/50 backdrop-blur select-none"
      style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
      aria-label="Voice call"
    >
      <div
        className="flex cursor-grab gap-2 active:cursor-grabbing"
        onPointerDown={(e) => {
          drag.current = { startX: e.clientX, startY: e.clientY, x: offset.x, y: offset.y };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) setOffset({ x: d.x + e.clientX - d.startX, y: d.y + e.clientY - d.startY });
        }}
        onPointerUp={() => (drag.current = null)}
      >
        {me && <Tile name="You" color={me.color} stream={call.camera ? call.local : null} live={micLive} self />}
        {others.map((m) => {
          const remote = call.remotes[m.id];
          return (
            <Tile
              key={m.id}
              name={m.name}
              color={m.color}
              stream={remote?.stream ?? null}
              showVideo={m.camera}
              connecting={!remote?.connected}
            />
          );
        })}
        {others.length === 0 && <p className="text-dim flex w-28 items-center text-xs leading-snug">Waiting for someone else to join the call</p>}
      </div>

      <div className="mt-2 flex items-center gap-2">
        {call.ptt ? (
          <button
            className={`h-10 flex-1 rounded-full px-4 text-sm font-medium transition-colors ${call.talking ? 'bg-accent text-accent-ink' : 'bg-raised text-fg hover:bg-line'}`}
            aria-pressed={call.talking}
            onPointerDown={() => call.setTalking(true)}
            onPointerUp={() => call.setTalking(false)}
            onPointerLeave={() => call.setTalking(false)}
          >
            {call.talking ? 'Talking…' : 'Hold to talk'}
            <span className="text-faint ml-2 hidden text-xs sm:inline">{call.talking ? '' : 'or hold V'}</span>
          </button>
        ) : (
          <button
            className={`${round} ${call.muted ? 'bg-danger/20 text-danger' : 'bg-raised text-fg hover:bg-line'}`}
            aria-label={call.muted ? 'Unmute microphone' : 'Mute microphone'}
            aria-pressed={call.muted}
            onClick={call.toggleMute}
          >
            <MicIcon off={call.muted} />
          </button>
        )}
        <button
          className={`${round} ${call.camera ? 'bg-raised text-fg' : 'bg-raised text-dim'} hover:bg-line`}
          aria-label={call.camera ? 'Turn camera off' : 'Turn camera on'}
          aria-pressed={call.camera}
          onClick={() => void call.toggleCamera()}
        >
          <CameraIcon off={!call.camera} />
        </button>
        <button className={`${round} bg-danger text-black/80 hover:brightness-110`} aria-label="Leave call" onClick={call.leave}>
          <PhoneIcon className="h-4 w-4 rotate-[135deg]" />
        </button>
      </div>

      <label className="text-dim mt-2 flex cursor-pointer items-center gap-2 px-1 text-xs">
        <input type="checkbox" className="accent-accent h-3.5 w-3.5" checked={call.ptt} onChange={(e) => call.setPtt(e.target.checked)} />
        Push to talk
      </label>
    </div>
  );
}

function Tile({
  name,
  color,
  stream,
  showVideo = true,
  live,
  self,
  connecting,
}: {
  name: string;
  color: string;
  stream: MediaStream | null;
  showVideo?: boolean;
  live?: boolean;
  self?: boolean;
  connecting?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const hasVideo = showVideo && !!stream && stream.getVideoTracks().length > 0;

  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);

  return (
    <div
      className={`bg-raised relative flex h-20 w-20 items-center justify-center overflow-hidden rounded-xl ${live ? 'ring-accent ring-2' : ''}`}
      data-testid={self ? 'call-self' : 'call-peer'}
      data-connected={self ? undefined : String(!connecting)}
    >
      {/* Always mounted: it is what plays the other person's sound. */}
      <video ref={ref} autoPlay playsInline muted={self} className={`h-full w-full object-cover ${hasVideo ? '' : 'hidden'} ${self ? '-scale-x-100' : ''}`} />
      {!hasVideo && <Avatar name={name} color={color} />}
      <span className="absolute inset-x-0 bottom-0 truncate bg-black/50 px-1 text-center text-[10px] leading-4">
        {connecting ? 'Connecting…' : name}
      </span>
    </div>
  );
}
