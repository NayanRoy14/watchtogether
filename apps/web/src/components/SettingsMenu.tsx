import { useEffect, useRef, useState } from 'react';
import type { ControlMode } from '@wt/shared';
import { useRoom } from '../store/room';
import { GearIcon } from './icons';

const MODES: Array<{ value: ControlMode; label: string; hint: string }> = [
  { value: 'everyone', label: 'Everyone', hint: 'Anyone in the room can control what’s playing.' },
  { value: 'driver', label: 'One driver', hint: 'One person controls at a time. Others can ask for a turn.' },
];

/** Host-only room settings. Changes apply to everyone immediately. */
export function SettingsMenu() {
  const settings = useRoom((s) => s.settings);
  const update = useRoom((s) => s.updateSettings);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const hint = MODES.find((m) => m.value === settings.controlMode)?.hint;

  return (
    <div ref={ref} className="relative">
      <button
        className={`hover:bg-raised flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${open ? 'bg-raised text-fg' : 'text-dim'}`}
        aria-label="Room settings"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <GearIcon />
      </button>
      {open && (
        <div className="border-line bg-surface absolute top-12 right-0 z-30 w-72 rounded-xl border p-4 shadow-2xl shadow-black/60">
          <p className="label">Who controls</p>
          <div className="bg-canvas grid grid-cols-2 gap-1 rounded-lg p-1" role="radiogroup" aria-label="Who controls">
            {MODES.map((m) => (
              <button
                key={m.value}
                role="radio"
                aria-checked={settings.controlMode === m.value}
                className={`h-8 rounded-md text-sm transition-colors ${settings.controlMode === m.value ? 'bg-raised text-fg font-medium' : 'text-dim hover:text-fg'}`}
                onClick={() => update({ controlMode: m.value })}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className="text-faint mt-2 text-xs leading-relaxed">{hint}</p>

          <div className="bg-line my-4 h-px" />

          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="accent-accent mt-0.5 h-4 w-4"
              checked={settings.locked}
              onChange={(e) => update({ locked: e.target.checked })}
            />
            <span>
              <span className="block text-sm font-medium">Lock the room</span>
              <span className="text-faint block text-xs leading-relaxed">
                Nobody new can join. People already here can still reconnect.
              </span>
            </span>
          </label>
        </div>
      )}
    </div>
  );
}
