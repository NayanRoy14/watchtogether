import type { Source } from '@wt/shared';
import { Emitter, PlaybackError, type PlayerAdapter, type PlayerEvent } from './PlayerAdapter';

// The small part of YouTube's IFrame Player API this app uses.
interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setPlaybackRate(rate: number): void;
  getPlaybackRate(): number;
  setVolume(volume: number): void;
  mute(): void;
  unMute(): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  destroy(): void;
}
interface YTNamespace {
  Player: new (
    el: HTMLElement,
    options: {
      videoId: string;
      width: string;
      height: string;
      playerVars: Record<string, string | number>;
      events: {
        onReady: () => void;
        onStateChange: (e: { data: number }) => void;
        onError: (e: { data: number }) => void;
      };
    },
  ) => YTPlayer;
}
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const ENDED = 0, PLAYING = 1, PAUSED = 2, BUFFERING = 3, CUED = 5;

let api: Promise<YTNamespace> | null = null;
function loadApi(): Promise<YTNamespace> {
  api ??= new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    window.onYouTubeIframeAPIReady = () => (window.YT ? resolve(window.YT) : reject(new Error('YouTube API missing')));
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => {
      api = null;
      reject(new PlaybackError('Couldn’t reach YouTube. Check your connection.'));
    };
    document.head.append(script);
  });
  return api;
}

/**
 * YouTube through its official embedded player. Its own controls are hidden so that
 * seeking only happens through the room's control bar; clicking the video still
 * plays/pauses, which the sync engine picks up like any other player event.
 */
export class YouTubeAdapter implements PlayerAdapter {
  readonly canNudge = false;
  private readonly events = new Emitter();
  private player: YTPlayer | null = null;
  private state = -1;
  onFailure: ((message: string) => void) | null = null;

  constructor(private readonly container: HTMLElement) {}

  async load(source: Source): Promise<void> {
    const YT = await loadApi();
    const mount = document.createElement('div');
    this.container.replaceChildren(mount);

    await new Promise<void>((resolve, reject) => {
      this.player = new YT.Player(mount, {
        videoId: source.id,
        width: '100%',
        height: '100%',
        playerVars: { controls: 0, disablekb: 1, rel: 0, playsinline: 1, fs: 0, origin: location.origin },
        events: {
          onReady: () => resolve(),
          onError: (e) => {
            const blocked = e.data === 101 || e.data === 150;
            const message = blocked
              ? 'This video’s owner doesn’t allow it to play on other sites. Open it in the shared browser instead.'
              : 'YouTube won’t play this video here. Try it in the shared browser instead.';
            reject(new PlaybackError(message)); // no effect if it had already loaded
            this.onFailure?.(message);
          },
          onStateChange: (e) => {
            this.state = e.data;
            if (e.data === PLAYING) {
              this.events.emit('ready');
              this.events.emit('play');
            } else if (e.data === PAUSED) this.events.emit('pause');
            else if (e.data === BUFFERING) this.events.emit('buffering');
            else if (e.data === CUED) this.events.emit('ready');
            else if (e.data === ENDED) this.events.emit('ended');
          },
        },
      });
    });
    const frame = this.container.querySelector('iframe');
    if (frame) frame.className = 'absolute inset-0 h-full w-full';
  }

  async play(): Promise<boolean> {
    this.player?.playVideo();
    return true; // YouTube gives no signal when autoplay is refused; the engine notices it stayed paused
  }
  pause(): void {
    this.player?.pauseVideo();
  }
  seek(seconds: number): void {
    this.player?.seekTo(seconds, true);
  }
  setRate(rate: number): void {
    if (this.player && this.player.getPlaybackRate() !== rate) this.player.setPlaybackRate(rate);
  }
  setVolume(volume: number, muted: boolean): void {
    if (!this.player) return;
    this.player.setVolume(Math.round(volume * 100));
    if (muted) this.player.mute();
    else this.player.unMute();
  }
  currentTime(): number {
    return this.player?.getCurrentTime() ?? 0;
  }
  duration(): number {
    return this.player?.getDuration() ?? 0;
  }
  rate(): number {
    return this.player?.getPlaybackRate() ?? 1;
  }
  isPaused(): boolean {
    return this.state !== PLAYING && this.state !== BUFFERING;
  }
  isBuffering(): boolean {
    return this.state === BUFFERING;
  }
  on(event: PlayerEvent, cb: () => void): void {
    this.events.on(event, cb);
  }
  destroy(): void {
    this.events.clear();
    this.player?.destroy();
    this.player = null;
    this.container.replaceChildren();
  }
}
