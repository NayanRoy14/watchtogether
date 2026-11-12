import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

/** Sliding-window counter, one object per key (e.g. "create:<ip>"). Cleans itself up. */
export class RateLimit extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS hits (at INTEGER NOT NULL)');
  }

  async take(limit: number, windowMs: number): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    sql.exec('DELETE FROM hits WHERE at <= ?', now - windowMs);
    const used = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM hits').one().n;
    if (used >= limit) return false;
    sql.exec('INSERT INTO hits (at) VALUES (?)', now);
    await this.ctx.storage.setAlarm(now + windowMs);
    return true;
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
