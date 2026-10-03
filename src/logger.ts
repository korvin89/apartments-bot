/**
 * Logging to the console and to daily files: logs/bot-YYYY-MM-DD.log.
 * Files older than LOG_RETENTION_DAYS are deleted. Writes are synchronous,
 * so the last lines before a crash are on disk. The volume is a few lines per poll.
 */
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

type Level = 'INFO' | 'WARN' | 'ERROR';

const LOG_DIR = process.env.LOG_DIR ?? './logs';
const RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS ?? 14);

let currentDay = '';

function fileFor(day: string): string {
  return join(LOG_DIR, `bot-${day}.log`);
}

function rotate(day: string): void {
  if (day === currentDay) return;
  currentDay = day;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
    for (const f of readdirSync(LOG_DIR)) {
      const m = /^bot-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
      if (m && m[1] < cutoff) unlinkSync(join(LOG_DIR, f));
    }
  } catch (e) {
    console.error('log rotation failed', e);
  }
}

function describe(extra: unknown): string {
  if (extra === undefined) return '';
  if (extra instanceof Error) return `\n${extra.stack ?? `${extra.name}: ${extra.message}`}`;
  if (typeof extra === 'string') return ` ${extra}`;
  try {
    return ` ${JSON.stringify(extra)}`;
  } catch {
    return ` ${String(extra)}`;
  }
}

function write(level: Level, msg: string, extra?: unknown): void {
  const now = new Date();
  const iso = now.toISOString();
  const line = `${iso} ${level.padEnd(5)} ${msg}${describe(extra)}`;
  (level === 'ERROR' ? console.error : console.log)(`[${iso.slice(11, 19)}] ${level === 'INFO' ? '' : `${level} `}${msg}${describe(extra)}`);
  const day = iso.slice(0, 10);
  rotate(day);
  try {
    appendFileSync(fileFor(day), line + '\n');
  } catch (e) {
    console.error('log write failed', e);
  }
}

/** Info by default; an Error passed as `extra` makes it an ERROR line with the stack. */
export function log(msg: string, extra?: unknown): void {
  write(extra instanceof Error ? 'ERROR' : 'INFO', msg, extra);
}

export function warn(msg: string, extra?: unknown): void {
  write('WARN', msg, extra);
}

export function logError(msg: string, extra?: unknown): void {
  write('ERROR', msg, extra);
}
