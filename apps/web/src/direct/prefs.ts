import { create } from 'zustand';

/** Volume is personal: it never leaves this device. */
export const usePlayerPrefs = create<{ volume: number; muted: boolean; setVolume: (v: number) => void; toggleMute: () => void }>(
  (set, get) => ({
    volume: 1,
    muted: false,
    setVolume: (volume) => set({ volume, muted: false }),
    toggleMute: () => set({ muted: !get().muted }),
  }),
);
