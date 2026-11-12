import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MAX_CHAT_LENGTH } from '@wt/shared';
import { SendIcon } from '../components/icons';
import { useRoom } from '../store/room';
import { ReactionBar } from './Reactions';

const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export function ChatPanel() {
  const chat = useRoom((s) => s.chat);
  const you = useRoom((s) => s.you);
  const live = useRoom((s) => s.connection === 'live');
  const sendChat = useRoom((s) => s.sendChat);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true); // stay at the bottom unless the reader scrolled up

  useEffect(() => {
    const list = listRef.current;
    if (list && pinned.current) list.scrollTop = list.scrollHeight;
  }, [chat]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !live) return;
    sendChat(text);
    setDraft('');
    pinned.current = true;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {chat.length === 0 ? (
          <p className="text-faint mt-8 text-center text-sm">No messages yet. Say hi.</p>
        ) : (
          <ul className="space-y-3">
            {chat.map((m, i) => {
              const prev = chat[i - 1];
              const continued = prev?.memberId === m.memberId && m.at - prev.at < 120_000;
              return (
                <li key={m.id} className={continued ? '-mt-2' : ''}>
                  {!continued && (
                    <div className="mb-0.5 flex items-baseline gap-2">
                      <span className="text-sm font-semibold" style={{ color: m.color }}>
                        {m.name}
                        {m.memberId === you && <span className="text-faint font-normal"> (you)</span>}
                      </span>
                      <time className="text-faint text-[11px]">{clock.format(m.at)}</time>
                    </div>
                  )}
                  <p className="text-fg text-sm leading-relaxed break-words whitespace-pre-wrap">{m.text}</p>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-line border-t">
        <ReactionBar />
      </div>
      <form className="flex gap-2 p-3" onSubmit={submit}>
        <input
          id="chat-input"
          className="field"
          value={draft}
          maxLength={MAX_CHAT_LENGTH}
          placeholder={live ? 'Message the room' : 'Reconnecting…'}
          aria-label="Message"
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="btn btn-quiet w-10 shrink-0 px-0" disabled={!draft.trim() || !live} aria-label="Send">
          <SendIcon />
        </button>
      </form>
    </div>
  );
}
