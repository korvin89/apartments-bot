import type { ListingsDb } from './db.js';
import { esc } from './format.js';

export interface HealthCheck {
  /** Stable name, e.g. "4zida:prodaja-stanova/beograd" or "poll". */
  key: string;
  ok: boolean;
  /** What went wrong; ignored when ok. */
  detail?: string;
}

/**
 * Tracks consecutive failures per check in the meta table and returns
 * the alert texts to post: one when a check crosses the threshold,
 * one when it recovers. Nothing in between, so the chat is not spammed.
 */
export function trackHealth(db: ListingsDb, checks: HealthCheck[], threshold: number, now = new Date()): string[] {
  const messages: string[] = [];
  for (const c of checks) {
    const k = `health:${c.key}`;
    const fails = Number(db.getMeta(`${k}:fails`) ?? 0);
    const alerted = db.getMeta(`${k}:alerted`) === '1';

    if (c.ok) {
      if (alerted) messages.push(`✅ <b>${esc(c.key)}</b> is working again.`);
      db.setMeta(`${k}:fails`, '0');
      db.setMeta(`${k}:alerted`, '0');
      continue;
    }

    const nextFails = fails + 1;
    if (fails === 0) db.setMeta(`${k}:since`, now.toISOString());
    db.setMeta(`${k}:fails`, String(nextFails));
    if (nextFails >= threshold && !alerted) {
      const since = clock(db.getMeta(`${k}:since`) ?? now.toISOString());
      messages.push(
        `⚠️ <b>${esc(c.key)}</b> has failed ${nextFails} polls in a row (since ${since}).\n` +
          `${esc(c.detail ?? 'unknown error')}\n` +
          `I'll post again when it recovers.`,
      );
      db.setMeta(`${k}:alerted`, '1');
    }
  }
  return messages;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', {
    timeZone: 'Europe/Belgrade',
    hour: '2-digit',
    minute: '2-digit',
  });
}
