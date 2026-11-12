import { fileFingerprint } from '@wt/shared';

/**
 * Local files never leave the device. Each person picks their own copy and it is kept
 * here, keyed by the id of the source the room is playing.
 */
const files = new Map<string, File>();

export const localFiles = {
  get: (sourceId: string): File | undefined => files.get(sourceId),
  set: (sourceId: string, file: File): void => void files.set(sourceId, file),
};

/** Reads just enough of the file to learn its length. */
export function probe(file: File): Promise<{ duration: number; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = (): void => URL.revokeObjectURL(url);
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      done();
      resolve({ duration: video.duration, fingerprint: fileFingerprint(file.size, video.duration) });
    };
    video.onerror = () => {
      done();
      reject(new Error('This browser can’t play that file. MP4 (H.264) and WebM work best.'));
    };
    video.src = url;
  });
}
