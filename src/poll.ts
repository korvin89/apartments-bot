import type { ListingsDb } from './db.js';
import { fingerprint } from './dedup.js';
import { rejectReason } from './filters.js';
import type { SearchConfig } from './search.config.js';
import { fetchAllSources } from './sources/index.js';
import type { Notifier } from './telegram.js';
import type { ListingEvent, StoredListing } from './types.js';
import { esc, formatDigest } from './format.js';
import { HELP_TEXT } from './help.js';
import { env, log, logError, warn } from './config.js';
import { trackHealth, type HealthCheck } from './health.js';
import { filtersVersion } from './settings.js';

export interface PollOptions {
  db: ListingsDb;
  notifier: Notifier;
  cfg: SearchConfig;
  notifyOnFirstRun: boolean;
  /** Failed polls in a row before alerting; defaults to HEALTH_ALERT_AFTER. */
  healthAlertAfter?: number;
}

export interface PollSummary {
  fetched: number;
  inserted: number;
  notified: number;
  skipped: Record<string, number>;
  errors: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Cards that failed to send; retried on the next poll. */
const PENDING_KEY = 'pending_notifications';
/** Set on the first run until the help text and the first overview reach the chat. */
const WELCOME_PENDING_KEY = 'welcome_pending';
/** Set when an overview failed to send, so the next poll re-sends what wasn't seen. */
const CATCHUP_PENDING_KEY = 'catchup_pending';
/** Filters version for which stored, never-shown listings were last re-checked. */
const REVIEWED_VERSION_KEY = 'filters_reviewed_version';
/** Re-checks after a filter change only look at listings seen on a site this recently. */
const REVIEW_WINDOW_MS = 3 * 86_400_000;
/**
 * A listing created more than this before a source's previous successful poll is
 * "older" (it surfaced because filters widened, not because it was just posted).
 * A day of slack: some sites only give the publication day, not the time.
 */
const CREATED_SLACK_MS = 26 * 3_600_000;

interface PendingCard {
  id: number;
  kind: 'new' | 'price_drop';
  oldPrice?: number;
}

const TITLES = {
  firstRun: (n: number) => `📋 <b>On the market now: ${n} listings match our filters</b>`,
  newSource: (source: string) => (n: number) => `📋 <b>New source ${esc(source)}: ${n} matching listings there now</b>`,
  filters: (n: number) => `📋 <b>With the new filters, ${n} more listings match</b>`,
  catchUp: (n: number) => `📋 <b>${n} matching listings you haven't seen yet</b>`,
};
/** Per-source result of the last poll, shown by /status. */
export const SOURCE_STATS_KEY = 'source_stats';
let running = false;

export async function runPoll(opts: PollOptions): Promise<PollSummary> {
  if (running) throw new Error('Poll already running');
  running = true;
  const threshold = opts.healthAlertAfter ?? env.healthAlertAfter;
  try {
    const { summary, checks } = await doPoll(opts);
    await postAlerts(opts.notifier, trackHealth(opts.db, [...checks, { key: 'poll', ok: true }], threshold));
    return summary;
  } catch (e) {
    // The whole cycle crashed (database error, bug). Count it and rethrow.
    await postAlerts(opts.notifier, trackHealth(opts.db, [{ key: 'poll', ok: false, detail: String(e) }], threshold));
    throw e;
  } finally {
    running = false;
  }
}

async function postAlerts(notifier: Notifier, messages: string[]): Promise<void> {
  for (const m of messages) {
    warn(`Health alert: ${m.replace(/<[^>]+>/g, '').replace(/\n/g, ' ')}`);
    try {
      await notifier.alert(m);
    } catch (e) {
      logError('Failed to post health alert', e);
    }
  }
}

async function doPoll({ db, notifier, cfg, notifyOnFirstRun }: PollOptions): Promise<{ summary: PollSummary; checks: HealthCheck[] }> {
  const startedAt = new Date();
  const now = startedAt.toISOString();
  const firstRun = db.getMeta('first_poll_done') !== '1';
  // Read before fetching: a filter change made while this poll runs bumps the version
  // again, so the next poll still treats it as a change.
  const version = filtersVersion(db);
  const prevPollAt = db.getMeta('last_poll_at') ?? now;
  const summary: PollSummary = { fetched: 0, inserted: 0, notified: 0, skipped: {}, errors: [] };
  const skip = (reason: string) => {
    summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
  };

  // A source with nothing stored yet is new: its listings go into an overview, not cards.
  const seededSources = db.knownSources();
  const results = await fetchAllSources(cfg, {
    isKnown: (source, id) => db.getBySource(source, id) !== undefined,
    isSeeded: (source) => seededSources.has(source),
  });
  const events: ListingEvent[] = [];
  // Matching listings that should not each get a card go into one overview per reason:
  // "this is what's there now", collapsed by municipality.
  const digests = new Map<string, { title: (n: number) => string; listings: StoredListing[] }>();
  const toDigest = (key: string, title: (n: number) => string, l: StoredListing) => {
    const d = digests.get(key) ?? { title, listings: [] };
    d.listings.push(l);
    digests.set(key, d);
  };
  const insertedIds = new Set<number>();

  // What each source returned this poll, for /status
  db.setMeta(
    SOURCE_STATS_KEY,
    JSON.stringify(results.map((r) => ({ name: r.source, checked: r.listings.length, error: r.error ?? null }))),
  );
  // A source that errors or returns nothing counts as failing: with our budget in all of
  // Belgrade there are always listings, so zero means the parser broke.
  const checks: HealthCheck[] = results.map((r) =>
    r.error
      ? { key: r.source, ok: false, detail: r.error }
      : r.listings.length === 0
        ? { key: r.source, ok: false, detail: 'Returned 0 listings. The site layout may have changed.' }
        : { key: r.source, ok: true },
  );

  for (const r of results) {
    if (r.error) {
      summary.errors.push(`${r.source}: ${r.error}`);
      warn(`Source ${r.source} failed: ${r.error}`);
      continue;
    }
    log(`${r.source}: ${r.listings.length} listings`);
    if (r.listings.length === 0) warn(`${r.source} returned no listings`);
    summary.fetched += r.listings.length;

    // Per source: the filters version and time of its last successful poll. A source that
    // was down when filters changed still sees the change when it comes back.
    const jobVersion = Number(db.getMeta(`job:${r.source}:filters_version`) ?? version);
    const jobOkAt = db.getMeta(`job:${r.source}:ok_at`) ?? prevPollAt;
    const filtersChangedForJob = jobVersion < version;
    const olderThan = new Date(new Date(jobOkAt).getTime() - CREATED_SLACK_MS).toISOString();

    for (const l of r.listings) {
      const existing = db.getBySource(l.source, l.sourceId);
      if (existing) {
        const oldPrice = existing.price;
        db.touch(existing.id, l.price, now);
        if (existing.url !== l.url || (!existing.imageUrl && l.imageUrl)) db.refreshLinks(existing.id, l.url, l.imageUrl);
        const dropped = l.price < oldPrice * 0.99;
        if (dropped && existing.status !== 'disliked' && !rejectReason(l, cfg)) {
          events.push({ kind: 'price_drop', listing: { ...existing, price: l.price, previousPrice: oldPrice }, oldPrice });
        }
        continue;
      }

      const stored = db.insert(l, fingerprint(l), now);
      insertedIds.add(stored.id);
      summary.inserted++;

      const reason = rejectReason(l, cfg);
      if (reason) {
        skip(reason.split(' ')[0]);
        continue;
      }
      const dupes = db.findDuplicates(stored.fingerprint, stored.id);
      if (dupes.length > 0) {
        skip('duplicate');
        log(`Duplicate: ${l.url} looks like ${dupes[0].url}`);
        continue;
      }
      if (firstRun && !notifyOnFirstRun) {
        skip('first_run');
        toDigest('first_run', TITLES.firstRun, stored);
        continue;
      }
      if (!firstRun && !seededSources.has(l.source)) {
        skip(`first_poll_of_${l.source}`);
        toDigest(`source:${l.source}`, TITLES.newSource(l.source), stored);
        continue;
      }
      if (filtersChangedForJob && !(l.sourceCreatedAt && l.sourceCreatedAt >= olderThan)) {
        skip('older_than_filter_change');
        toDigest('filters', TITLES.filters, stored);
        continue;
      }
      events.push({ kind: 'new', listing: stored });
    }

    db.setMeta(`job:${r.source}:filters_version`, String(version));
    db.setMeta(`job:${r.source}:ok_at`, now);
  }

  // Cards that failed to send last time: the listing is stored, so without this retry
  // it would never be sent. Skip ones disliked or filtered out since.
  const pending = (JSON.parse(db.getMeta(PENDING_KEY) ?? '[]') as Array<number | PendingCard>).map((p) =>
    typeof p === 'number' ? { id: p, kind: 'new' as const } : p,
  );
  for (const p of pending) {
    const l = db.get(p.id);
    if (!l || l.status === 'disliked' || rejectReason(l, cfg) || events.some((e) => e.listing.id === p.id)) continue;
    if (p.kind === 'price_drop' && p.oldPrice) events.push({ kind: 'price_drop', listing: l, oldPrice: p.oldPrice });
    else if (!l.notifiedAt) events.push({ kind: 'new', listing: l });
  }

  // Stored listings never shown that match now: after a filter change (lower minimum
  // area, another place...), or when an earlier overview or the welcome didn't arrive.
  const welcomePending = firstRun || db.getMeta(WELCOME_PENDING_KEY) === '1';
  const reviewNeeded =
    !firstRun &&
    (welcomePending || db.getMeta(CATCHUP_PENDING_KEY) === '1' || Number(db.getMeta(REVIEWED_VERSION_KEY) ?? version) < version);
  if (reviewNeeded) {
    const queued = new Set([...digests.values()].flatMap((d) => d.listings.map((l) => l.id)));
    const since = new Date(startedAt.getTime() - REVIEW_WINDOW_MS).toISOString();
    const seenPrints = new Set<string>();
    const title = welcomePending ? TITLES.firstRun : Number(db.getMeta(REVIEWED_VERSION_KEY) ?? version) < version ? TITLES.filters : TITLES.catchUp;
    for (const l of db.unshown(since)) {
      if (insertedIds.has(l.id) || queued.has(l.id) || pending.some((p) => p.id === l.id)) continue;
      if (rejectReason(l, cfg) || seenPrints.has(l.fingerprint) || db.fingerprintShown(l.fingerprint)) continue;
      seenPrints.add(l.fingerprint);
      toDigest(welcomePending ? 'first_run' : 'filters', title, l);
    }
  }
  if (welcomePending) db.setMeta(WELCOME_PENDING_KEY, '1');

  // The very first message in the chat explains what the bot does
  let welcomeDelivered = true;
  if (welcomePending) {
    try {
      await notifier.alert(HELP_TEXT);
    } catch (e) {
      welcomeDelivered = false;
      logError('Failed to send the help message, will retry next poll', e);
    }
  }

  // Oldest first, so the newest ends up at the bottom of the chat
  events.sort((a, b) => a.listing.firstSeenAt.localeCompare(b.listing.firstSeenAt));
  const failed: PendingCard[] = [];
  for (const ev of events) {
    try {
      const msgId = await notifier.send(ev);
      log(`Sent ${ev.kind} ${ev.listing.source} ${ev.listing.price} EUR ${ev.listing.url}`);
      // A price drop is a second card: keep the main card's id so Dislike can remove both.
      if (ev.kind === 'price_drop' && ev.listing.tgMessageId && msgId) db.addExtraMessage(ev.listing.id, msgId);
      else db.markNotified(ev.listing.id, msgId, now);
      summary.notified++;
      await sleep(1500);
    } catch (e) {
      summary.errors.push(`notify ${ev.listing.url}: ${String(e)}`);
      logError(`Failed to send ${ev.listing.url}, will retry next poll`, e);
      failed.push(ev.kind === 'price_drop' ? { id: ev.listing.id, kind: 'price_drop', oldPrice: ev.oldPrice } : { id: ev.listing.id, kind: 'new' });
    }
  }
  db.setMeta(PENDING_KEY, JSON.stringify(failed.slice(-50)));

  let digestsDelivered = true;
  for (const [key, d] of digests) {
    let delivered = true;
    for (const html of formatDigest(d.title(d.listings.length), d.listings)) {
      try {
        await notifier.alert(html);
        await sleep(1500);
      } catch (e) {
        delivered = false;
        summary.errors.push(`digest: ${String(e)}`);
        logError('Failed to send an overview, will retry next poll', e);
        break;
      }
    }
    if (delivered) {
      db.markShown(d.listings.map((l) => l.id), now);
      log(`Sent overview "${key}" of ${d.listings.length} listings`);
    } else {
      digestsDelivered = false;
      if (key === 'first_run') welcomeDelivered = false;
    }
  }

  db.setMeta('first_poll_done', '1');
  db.setMeta(WELCOME_PENDING_KEY, welcomePending && !welcomeDelivered ? '1' : '0');
  db.setMeta(CATCHUP_PENDING_KEY, digestsDelivered ? '0' : '1');
  if (reviewNeeded || firstRun) db.setMeta(REVIEWED_VERSION_KEY, String(version));
  db.setMeta('last_poll_at', now);
  return { summary, checks };
}

export function summaryText(s: PollSummary): string {
  const skipped = Object.entries(s.skipped)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
  const parts = [
    `Fetched ${s.fetched}, new in db ${s.inserted}, sent ${s.notified}`,
    skipped ? `Skipped: ${skipped}` : null,
    s.errors.length ? `Errors: ${s.errors.join('; ')}` : null,
  ];
  return parts.filter(Boolean).join('\n');
}
