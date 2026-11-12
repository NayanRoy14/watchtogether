import type { Source } from '@wt/shared';
import { localFiles } from './localFiles';
import { Emitter, PlaybackError, type PlayerAdapter, type PlayerEvent } from './PlayerAdapter';

/** Plain <video>: direct links, HLS streams (through hls.js) and local files. */
export class Html5Adapter implements PlayerAdapter {
  readonly canNudge = true;
  private readonly video: HTMLVideoElement;
  private readonly events = new Emitter();
  private stalled = false;
  private objectUrl: string | null = null;
  private hls: { destroy(): void } | null = null;
  private loaded = false;
  onFailure: ((message: string) => void) | null = null;

  constructor(container: HTMLElement) {
    const v = document.createElement('video');
    v.playsInline = true;
    v.preload = 'auto';
    v.className = 'absolute inset-0 h-full w-full bg-black object-contain';
    container.replaceChildren(v);
    this.video = v;

    v.addEventListener('play', () => this.events.emit('play'));
    v.addEventListener('pause', () => !v.ended && this.events.emit('pause'));
    v.addEventListener('seeked', () => this.events.emit('seeked'));
    v.addEventListener('ratechange', () => this.events.emit('ratechange'));
    v.addEventListener('ended', () => this.events.emit('ended'));
    v.addEventListener('error', () => this.loaded && this.onFailure?.('The video stopped loading. Check your connection, or try the shared browser.'));
    v.addEventListener('waiting', () => {
      this.stalled = true;
      this.events.emit('buffering');
    });
    for (const name of ['playing', 'canplay'] as const) {
      v.addEventListener(name, () => {
        this.stalled = false;
        this.events.emit('ready');
      });
    }
  }

  async load(source: Source): Promise<void> {
    const v = this.video;
    const ready = new Promise<void>((resolve, reject) => {
      v.addEventListener('loadedmetadata', () => resolve(), { once: true });
      v.addEventListener(
        'error',
        () => reject(new PlaybackError('This link can’t be played here. The site may not allow it — try the shared browser.')),
        { once: true },
      );
    });

    if (source.kind === 'local') {
      const file = localFiles.get(source.id);
      if (!file) throw new PlaybackError('Choose your copy of the file first.');
      this.objectUrl = URL.createObjectURL(file);
      v.src = this.objectUrl;
    } else if (/\.m3u8($|\?)/i.test(source.id) && !v.canPlayType('application/vnd.apple.mpegurl')) {
      const { default: Hls } = await import('hls.js');
      if (!Hls.isSupported()) throw new PlaybackError('This browser can’t play HLS streams.');
      const hls = new Hls();
      this.hls = hls;
      hls.loadSource(source.id);
      hls.attachMedia(v);
    } else {
      v.src = source.id;
    }
    await ready;
    this.loaded = true;
  }

  async play(): Promise<boolean> {
    try {
      await this.video.play();
      return true;
    } catch (err) {
      // NotAllowedError: the browser wants a click first. Anything else (e.g. an
      // interrupting pause) is not a block.
      return !(err instanceof DOMException && err.name === 'NotAllowedError');
    }
  }
  pause(): void {
    this.video.pause();
  }
  seek(seconds: number): void {
    this.video.currentTime = seconds;
  }
  setRate(rate: number): void {
    if (this.video.playbackRate !== rate) this.video.playbackRate = rate;
  }
  setVolume(volume: number, muted: boolean): void {
    this.video.volume = volume;
    this.video.muted = muted;
  }
  currentTime(): number {
    return this.video.currentTime;
  }
  duration(): number {
    return Number.isFinite(this.video.duration) ? this.video.duration : 0;
  }
  rate(): number {
    return this.video.playbackRate;
  }
  isPaused(): boolean {
    return this.video.paused;
  }
  isBuffering(): boolean {
    return this.stalled || this.video.seeking;
  }
  on(event: PlayerEvent, cb: () => void): void {
    this.events.on(event, cb);
  }
  destroy(): void {
    this.events.clear();
    this.hls?.destroy();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.video.remove();
  }
}
