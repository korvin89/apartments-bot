/**
 * Debug helpers that work without Telegram and never change the real database:
 *   pnpm preview — fetch search results and print a table (filters from the database, read-only)
 *   pnpm poll    — one poll cycle on a temporary copy of the database, messages printed to the console
 */
import { env, log } from './config.js';
import { ListingsDb } from './db.js';
import { rejectReason } from './filters.js';
import { prettyPlace } from './format.js';
import { runPoll, summaryText } from './poll.js';
import { loadSearchConfig, readSearchConfig } from './settings.js';
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchAllSources } from './sources/index.js';
import { ConsoleNotifier } from './telegram.js';

const cmd = process.argv[2];

if (cmd === 'fetch') {
  // Filters set from the chat, read without creating or migrating the database
  const searchConfig = readSearchConfig(env.dbPath);
  const results = await fetchAllSources(searchConfig);
  for (const r of results) {
    console.log(`\n=== ${r.source}: ${r.listings.length}${r.error ? ` (error: ${r.error})` : ''}`);
    console.table(
      r.listings.map((l) => ({
        price: l.price,
        m2: l.m2,
        rooms: l.rooms,
        floor: l.floor,
        gl: l.groundLevel,
        top: l.lastFloor,
        new: l.isNewBuild,
        lift: l.elevator,
        mtg: l.creditEligible,
        place: prettyPlace(l.placeSlug).slice(0, 28),
        adv: l.advertiser,
        reg: l.registered,
        heat: l.heating,
        created: l.sourceCreatedAt?.slice(0, 10),
        filter: rejectReason(l, searchConfig) ?? 'ok',
      })),
    );
  }
} else if (cmd === 'poll') {
  // A throwaway copy: a real poll here would use up the first run, mark cards as sent, etc.
  const dir = mkdtempSync(join(tmpdir(), 'apartments-bot-poll-'));
  const copy = join(dir, 'listings.db');
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(env.dbPath + suffix)) copyFileSync(env.dbPath + suffix, copy + suffix);
  }
  log(`Polling on a copy of the database: ${copy}`);
  const db = new ListingsDb(copy);
  const s = await runPoll({ db, notifier: new ConsoleNotifier(), cfg: loadSearchConfig(db), notifyOnFirstRun: env.notifyOnFirstRun });
  log(summaryText(s).replace(/\n/g, ' | '));
  db.close();
} else {
  console.log('usage: tsx src/cli.ts <fetch|poll>');
  process.exit(1);
}
