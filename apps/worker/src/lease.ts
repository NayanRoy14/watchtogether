import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

/**
 * There is one shared browser for the whole site, so one room holds it at a time.
 * A single instance of this object (named "browser") remembers which.
 */
export class BrowserLease extends DurableObject<Env> {
  async acquire(code: string): Promise<boolean> {
    const holder = await this.ctx.storage.get<string>('holder');
    if (holder && holder !== code) {
      // Don't trust a stale record: ask the holder whether it still has the browser open.
      const stillOpen = await this.env.ROOM.get(this.env.ROOM.idFromName(holder)).browserActive();
      if (stillOpen) return false;
    }
    await this.ctx.storage.put('holder', code);
    return true;
  }

  async release(code: string): Promise<void> {
    if ((await this.ctx.storage.get<string>('holder')) === code) await this.ctx.storage.delete('holder');
  }
}
