import { MAX_MEMBERS } from '@wt/shared';
import { Avatar } from '../components/Avatar';
import { useMe, useRoom } from '../store/room';

export function PeoplePanel() {
  const members = useRoom((s) => s.members);
  const you = useRoom((s) => s.you);
  const transferHost = useRoom((s) => s.transferHost);
  const kick = useRoom((s) => s.kick);
  const giveControl = useRoom((s) => s.giveControl);
  const driverId = useRoom((s) => s.browser.driverId);
  const requests = useRoom((s) => s.browser.requests);
  const amHost = useMe()?.isHost ?? false;
  const mayGive = driverId !== null && (amHost || driverId === you);

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
              <p className="text-[11px] font-medium">
                {m.isHost && <span className="text-accent">Host</span>}
                {m.isHost && m.id === driverId && <span className="text-faint"> · </span>}
                {m.id === driverId && <span className="text-fg">Controlling</span>}
                {requests.includes(m.id) && <span className="text-dim">Asked for control</span>}
              </p>
            </div>
            {mayGive && m.id !== driverId && (
              <button
                className="text-dim hover:text-fg hover:bg-line h-8 shrink-0 rounded-md px-2 text-xs transition-colors"
                onClick={() => giveControl(m.id === you ? undefined : m.id)}
              >
                {m.id === you ? 'Take control' : 'Give control'}
              </button>
            )}
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
