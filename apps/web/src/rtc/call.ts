import { create } from 'zustand';
import { callSignals, useRoom } from '../store/room';

/**
 * Voice (and optional camera) call between everyone in the room who joins it.
 * Each pair connects directly ("mesh"); the room's WebSocket only carries the setup
 * messages. Fine for a handful of people, which is all a room holds.
 */

interface Peer {
  pc: RTCPeerConnection;
  stream: MediaStream;
  video: RTCRtpSender | null;
  /** ICE candidates that arrived before the offer/answer they belong to. */
  early: RTCIceCandidateInit[];
}

interface CallState {
  on: boolean;
  joining: boolean;
  error: string | null;
  /** Push-to-talk: the mic is live only while `talking`. Otherwise `muted` decides. */
  ptt: boolean;
  talking: boolean;
  muted: boolean;
  camera: boolean;
  local: MediaStream | null;
  /** Remote streams by member id; `connected` flips once audio can flow. */
  remotes: Record<string, { stream: MediaStream; connected: boolean }>;

  join: () => Promise<void>;
  leave: () => void;
  setPtt: (ptt: boolean) => void;
  setTalking: (talking: boolean) => void;
  toggleMute: () => void;
  toggleCamera: () => Promise<void>;
}

const peers = new Map<string, Peer>();
let iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
let stopWatching: (() => void) | null = null;

const idle = { on: false, joining: false, error: null, talking: false, muted: false, camera: false, local: null, remotes: {} };

export const useCall = create<CallState>((set, get) => {
  const room = (): ReturnType<typeof useRoom.getState> => useRoom.getState();
  const announce = (): void => room().send({ t: 'call', on: get().on, camera: get().camera });

  /** The one place that decides whether the microphone is actually sending. */
  const applyMic = (): void => {
    const { local, ptt, talking, muted } = get();
    for (const track of local?.getAudioTracks() ?? []) track.enabled = ptt ? talking : !muted;
  };

  const publish = (): void => {
    const remotes: CallState['remotes'] = {};
    for (const [id, peer] of peers) {
      remotes[id] = { stream: peer.stream, connected: peer.pc.connectionState === 'connected' };
    }
    set({ remotes });
  };

  const drop = (id: string): void => {
    const peer = peers.get(id);
    if (!peer) return;
    peer.pc.close();
    peers.delete(id);
    publish();
  };

  const connect = (id: string, caller: boolean): Peer => {
    const existing = peers.get(id);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers });
    const peer: Peer = { pc, stream: new MediaStream(), video: null, early: [] };
    peers.set(id, peer);

    const { local } = get();
    for (const track of local?.getAudioTracks() ?? []) pc.addTrack(track, local as MediaStream);
    // The caller reserves a video slot up front so turning a camera on later needs no renegotiation.
    if (caller) {
      peer.video = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
      void peer.video.replaceTrack(local?.getVideoTracks()[0] ?? null);
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) room().send({ t: 'rtc', to: id, kind: 'ice', data: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      peer.stream.addTrack(e.track);
      publish();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') drop(id);
      else publish();
    };
    publish();
    return peer;
  };

  const flushEarly = async (peer: Peer): Promise<void> => {
    for (const candidate of peer.early.splice(0)) await peer.pc.addIceCandidate(candidate).catch(() => undefined);
  };

  callSignals.onPeers = (ids) => {
    if (!get().on) return;
    for (const id of ids) {
      if (peers.has(id)) continue;
      const { pc } = connect(id, true);
      void pc
        .createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => room().send({ t: 'rtc', to: id, kind: 'offer', data: pc.localDescription?.toJSON() }));
    }
  };

  callSignals.onRtc = (msg) => {
    if (!get().on) return;
    void (async () => {
      if (msg.kind === 'offer') {
        drop(msg.from); // a fresh offer replaces any half-open connection
        const peer = connect(msg.from, false);
        await peer.pc.setRemoteDescription(msg.data as RTCSessionDescriptionInit);
        const slot = peer.pc.getTransceivers().find((t) => t.receiver.track.kind === 'video');
        if (slot) {
          slot.direction = 'sendrecv';
          peer.video = slot.sender;
          await slot.sender.replaceTrack(get().local?.getVideoTracks()[0] ?? null);
        }
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        room().send({ t: 'rtc', to: msg.from, kind: 'answer', data: peer.pc.localDescription?.toJSON() });
        await flushEarly(peer);
        return;
      }
      const peer = peers.get(msg.from);
      if (!peer) return;
      if (msg.kind === 'answer') {
        await peer.pc.setRemoteDescription(msg.data as RTCSessionDescriptionInit);
        await flushEarly(peer);
      } else if (peer.pc.remoteDescription) {
        await peer.pc.addIceCandidate(msg.data as RTCIceCandidateInit).catch(() => undefined);
      } else {
        peer.early.push(msg.data as RTCIceCandidateInit);
      }
    })().catch((err: unknown) => console.error('call signalling failed', err));
  };

  // After the room connection drops and returns, the server has forgotten we were in the call.
  callSignals.onWelcome = () => {
    if (get().on) announce();
  };

  return {
    ...idle,
    ptt: true,

    join: async () => {
      if (get().on || get().joining) return;
      set({ joining: true, error: null });
      try {
        const [local, ice] = await Promise.all([
          navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }),
          fetch('/api/ice')
            .then((r) => r.json() as Promise<{ iceServers: RTCIceServer[] }>)
            .catch(() => null),
        ]);
        if (ice?.iceServers.length) iceServers = ice.iceServers;
        // The shared browser has its own sound, so start hands-off there: hold to talk.
        set({ on: true, joining: false, local, ptt: room().mode === 'browser', talking: false, muted: false, camera: false });
        applyMic();
        announce();

        // Hang up on anyone who leaves the call or the room.
        stopWatching = useRoom.subscribe((state) => {
          const inCall = new Set(state.members.filter((m) => m.inCall).map((m) => m.id));
          for (const id of [...peers.keys()]) if (!inCall.has(id)) drop(id);
        });
      } catch (err) {
        const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
        set({
          joining: false,
          error: denied
            ? 'Microphone access was blocked. Allow it in your browser’s site settings to join the call.'
            : 'No microphone was found.',
        });
      }
    },

    leave: () => {
      if (!get().on && !get().joining) return;
      stopWatching?.();
      stopWatching = null;
      for (const id of [...peers.keys()]) drop(id);
      for (const track of get().local?.getTracks() ?? []) track.stop();
      set({ ...idle });
      announce();
    },

    setPtt: (ptt) => {
      set({ ptt, talking: false });
      applyMic();
    },
    setTalking: (talking) => {
      if (!get().on || !get().ptt || get().talking === talking) return;
      set({ talking });
      applyMic();
    },
    toggleMute: () => {
      set({ muted: !get().muted });
      applyMic();
    },

    toggleCamera: async () => {
      const { local, camera } = get();
      if (!local) return;
      if (camera) {
        for (const track of local.getVideoTracks()) {
          track.stop();
          local.removeTrack(track);
        }
        for (const peer of peers.values()) void peer.video?.replaceTrack(null);
        set({ camera: false, local: new MediaStream(local.getTracks()) });
      } else {
        try {
          const cam = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, frameRate: 15 } });
          const track = cam.getVideoTracks()[0];
          if (!track) return;
          local.addTrack(track);
          for (const peer of peers.values()) void peer.video?.replaceTrack(track);
          set({ camera: true, local: new MediaStream(local.getTracks()) });
        } catch {
          return room().flash('Camera access was blocked or no camera was found.');
        }
      }
      announce();
    },
  };
});
