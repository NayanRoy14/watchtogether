import { REACTIONS } from '@wt/shared';
import { useRoom } from '../store/room';

/** The row of emoji buttons above the chat box. */
export function ReactionBar() {
  const send = useRoom((s) => s.send);
  return (
    <div className="flex justify-between px-3 pt-2" role="group" aria-label="React">
      {REACTIONS.map((emoji) => (
        <button
          key={emoji}
          className="hover:bg-raised h-8 w-10 rounded-md text-lg transition-transform active:scale-125"
          aria-label={`React ${emoji}`}
          onClick={() => send({ t: 'react', emoji })}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}

/** Reactions float up over whatever is on the stage, then fade. */
export function ReactionLayer() {
  const reactions = useRoom((s) => s.reactions);
  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-hidden>
      {reactions.map((r) => (
        <span
          key={r.id}
          className="float-up absolute bottom-8 text-4xl"
          style={{ left: `${r.x * 100}%`, filter: `drop-shadow(0 0 8px ${r.color})` }}
        >
          {r.emoji}
        </span>
      ))}
    </div>
  );
}
