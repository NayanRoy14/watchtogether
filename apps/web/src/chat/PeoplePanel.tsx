import { MAX_MEMBERS } from '@wt/shared';
import { Avatar } from '../components/Avatar';
import { useMe, useRoom } from '../store/room';

export function PeoplePanel() {
  const members = useRoom((s) => s.members);
  const you = useRoom((s) => s.you);
  const transferHost = useRoom((s) => s.transferHost);
  const kick = useRoom((s) => s.kick);
  const amHost = useMe()?.isHost ?? false;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
      <ul>
        {members.map((m) => (
          <li key={m.id} className="hover:bg-raised flex min-h-12 items-center gap-3 rounded-lg px-2 transition-colors">
            <Avatar name={m.name} color={m.color} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {m.name}
                {m.id === you && <span className="text-faint font-normal"> (you)</span>}
              </p>
              {m.isHost && <p className="text-accent text-[11px] font-medium">Host</p>}
            </div>
            {amHost && m.id !== you && (
              <div className="flex shrink-0 gap-1">
                <button
                  className="text-dim hover:text-fg hover:bg-line h-8 rounded-md px-2 text-xs transition-colors"
                  onClick={() => transferHost(m.id)}
                >
                  Make host
                </button>
                <button
                  className="text-dim hover:text-danger hover:bg-line h-8 rounded-md px-2 text-xs transition-colors"
                  onClick={() => kick(m.id)}
                >
                  Remove
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="text-faint px-2 pt-4 text-xs">
        {members.length} of {MAX_MEMBERS} seats taken
      </p>
    </div>
  );
}
