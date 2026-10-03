import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.ts';
import { ListingsDb } from '../src/db.ts';
import { runPoll } from '../src/poll.ts';
import { searchConfig, type SearchConfig } from '../src/search.config.ts';
import { updateFilters, loadSearchConfig } from '../src/settings.ts';
import type { Notifier } from '../src/telegram.ts';
import type { ListingEvent } from '../src/types.ts';

/** Sites answered from fixtures; anything else is a 404. */
function siteFetch(url: string): Response {
  const body = url.includes('4zida.rs/prodaja-stanova')
    ? fixture('fourzida/search-apartments.html.gz')
    : url.includes('4zida.rs/prodaja-kuca')
      ? fixture('fourzida/search-houses.html.gz')
      : url.includes('cityexpert.rs/api/Search')
        ? fixture('cityexpert/search.json.gz')
        : null;
  return body === null ? new Response('nope', { status: 404 }) : new Response(body);
}

function recorder() {
  const events: ListingEvent[] = [];
  const alerts: string[] = [];
  const notifier: Notifier = {
    send: async (ev) => (events.push(ev), null),
    alert: async (html) => void alerts.push(html),
  };
  return { events, alerts, notifier };
}

const onlySources = (on: Partial<SearchConfig['sources']>): SearchConfig['sources'] => ({
  fourzida: false, nekretnine: false, halooglasi: false, cityexpert: false, ...on,
});

describe('poll cycle', () => {
  let db: ListingsDb;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    db = new ListingsDb(join(mkdtempSync(join(tmpdir(), 'bot-test-')), 'db.sqlite'));
    // Wide-open filters so fixture listings pass; sources limited to fixtures we have.
    updateFilters(db, { includePlaces: [], includePlacesHousesOnly: [], maxPrice: 1_000_000, minM2: null, minRooms: null, excludeGroundFloor: false });
    globalThis.fetch = (async (input: string | URL | Request) =>
      siteFetch(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    db.close();
  });

  const poll = (notifier: Notifier, sources: SearchConfig['sources']) =>
    runPoll({ db, notifier, cfg: { ...loadSearchConfig(db), sources, pagesPerPoll: 1 }, notifyOnFirstRun: false });

  it('posts an overview instead of cards on the first run, then reports nothing twice', async () => {
    const r = recorder();
    const first = await poll(r.notifier, onlySources({ fourzida: true }));
    assert.ok(first.inserted > 30);
    assert.equal(r.events.length, 0);
    assert.match(r.alerts[0] ?? '', /Belgrade home finder/, 'help comes first');
    assert.match(r.alerts[1] ?? '', /On the market now: \d+ listings/);
    assert.match(r.alerts[1], /<blockquote expandable>/);
    const alertsAfterFirst = r.alerts.length;
    const second = await poll(r.notifier, onlySources({ fourzida: true }));
    assert.equal(second.inserted, 0);
    assert.equal(r.events.length, 0);
    assert.equal(r.alerts.length, alertsAfterFirst);
  });

  it('notifies about a price drop on a known listing', async () => {
    const r = recorder();
    await poll(r.notifier, onlySources({ fourzida: true }));
    const target = db.listByStatus('new', 1)[0];
    (db as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db
      .prepare('UPDATE listings SET price = price + 20000 WHERE id = ?')
      .run(target.id);
    await poll(r.notifier, onlySources({ fourzida: true }));
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0].kind, 'price_drop');
    assert.equal(r.events[0].listing.id, target.id);
  });

  it('does not alert about price drops on disliked listings', async () => {
    const r = recorder();
    await poll(r.notifier, onlySources({ fourzida: true }));
    const target = db.listByStatus('new', 1)[0];
    db.setStatus(target.id, 'disliked');
    (db as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db
      .prepare('UPDATE listings SET price = price + 20000 WHERE id = ?')
      .run(target.id);
    await poll(r.notifier, onlySources({ fourzida: true }));
    assert.equal(r.events.length, 0);
  });

  it("a new source's first poll is silent too", async () => {
    const r = recorder();
    await poll(r.notifier, onlySources({ fourzida: true }));
    const s = await poll(r.notifier, onlySources({ fourzida: true, cityexpert: true }));
    assert.ok(s.inserted > 0);
    assert.ok((s.skipped['first_poll_of_cityexpert'] ?? 0) > 0);
    assert.equal(r.events.length, 0);
    assert.ok(r.alerts.some((a) => /New source cityexpert/.test(a)));
  });

  it('after a filter change only listings newer than the previous poll are sent', async () => {
    const r = recorder();
    // First poll: the site returns houses only (as if apartments were outside the old filters).
    const withApartments = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.includes('prodaja-stanova') ? new Response('<html></html>') : siteFetch(url);
    }) as typeof fetch;
    await poll(r.notifier, onlySources({ fourzida: true }));
    // Widening the filters makes older apartments appear in the results.
    updateFilters(db, { minRooms: null });
    globalThis.fetch = withApartments;
    const s = await poll(r.notifier, onlySources({ fourzida: true }));
    assert.ok(s.inserted > 0);
    assert.ok((s.skipped['older_than_filter_change'] ?? 0) > 0);
    assert.equal(r.events.length, 0);
    assert.ok(r.alerts.some((a) => /With the new filters/.test(a)));
  });

  it('retries a card that failed to send on the next poll', async () => {
    const r = recorder();
    await poll(r.notifier, onlySources({ fourzida: true }));
    const target = db.listByStatus('new', 1)[0];
    // Deleting the row makes the next poll see this listing as brand new
    const raw = (db as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db;
    raw.prepare('DELETE FROM price_history WHERE listing_id = ?').run(target.id);
    raw.prepare('DELETE FROM listings WHERE id = ?').run(target.id);
    let fail = true;
    const flaky: Notifier = {
      send: async (ev) => {
        if (fail) throw new Error('Telegram is down');
        r.events.push(ev);
        return null;
      },
      alert: r.notifier.alert,
    };
    const failedPoll = await poll(flaky, onlySources({ fourzida: true }));
    assert.equal(failedPoll.notified, 0);
    assert.equal(failedPoll.errors.length, 1);
    fail = false;
    await poll(flaky, onlySources({ fourzida: true }));
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0].listing.sourceId, target.sourceId);
  });

  it('a source that was down when the budget rose sends an overview, not cards, when it recovers', async () => {
    const r = recorder();
    const full = JSON.parse(fixture('cityexpert/search.json.gz')) as { result: Array<Record<string, unknown>>; info: Record<string, unknown> };
    for (const it of full.result) it.firstPublished = '2020-01-01T00:00:00';
    const page = (n: number) => JSON.stringify({ ...full, result: full.result.slice(0, n), info: { ...full.info, isLastPage: true } });
    let cityexpert: string | null = page(5);
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('cityexpert.rs/api/Search')) return cityexpert === null ? new Response('down', { status: 503 }) : new Response(cityexpert);
      return siteFetch(url);
    }) as typeof fetch;
    const sources = onlySources({ fourzida: true, cityexpert: true });
    await poll(r.notifier, sources); // first run
    updateFilters(db, { maxPrice: 2_000_000 }); // budget raised...
    cityexpert = null; // ...while cityexpert is down
    await poll(r.notifier, sources);
    cityexpert = page(30); // back, now returning older listings that fit the new budget
    const s = await poll(r.notifier, sources);
    assert.ok(s.inserted >= 20);
    assert.equal(r.events.length, 0, 'no flood of cards');
    assert.ok(r.alerts.some((a) => /With the new filters/.test(a)));
  });

  it('a filter change made during a poll is not lost', async () => {
    const r = recorder();
    let changed = false;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!changed) {
        changed = true;
        updateFilters(db, { minRooms: null }); // someone edits /filters mid-poll
      }
      return url.includes('prodaja-stanova') ? new Response('<html></html>') : siteFetch(url);
    }) as typeof fetch;
    await poll(r.notifier, onlySources({ fourzida: true }));
    globalThis.fetch = (async (input: string | URL | Request) =>
      siteFetch(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)) as typeof fetch;
    const s = await poll(r.notifier, onlySources({ fourzida: true }));
    assert.ok(s.inserted > 0);
    assert.equal(r.events.length, 0, 'older apartments go to an overview');
  });

  it('widening filters shows matching listings that were stored but never shown', async () => {
    const r = recorder();
    updateFilters(db, { minM2: 500 }); // nothing matches
    await poll(r.notifier, onlySources({ fourzida: true }));
    assert.ok(!r.alerts.some((a) => /On the market now/.test(a)));
    updateFilters(db, { minM2: null });
    await poll(r.notifier, onlySources({ fourzida: true }));
    const overview = r.alerts.find((a) => /With the new filters, \d+ more listings match/.test(a));
    assert.ok(overview, 'overview of stored listings');
    assert.equal(r.events.length, 0);
    // ...and only once
    const before = r.alerts.length;
    await poll(r.notifier, onlySources({ fourzida: true }));
    assert.equal(r.alerts.length, before);
  });

  it('retries the welcome when it could not be delivered', async () => {
    const r = recorder();
    let down = true;
    const flaky: Notifier = {
      send: r.notifier.send,
      alert: async (html) => {
        if (down) throw new Error('Telegram is down');
        r.alerts.push(html);
      },
    };
    await poll(flaky, onlySources({ fourzida: true }));
    assert.equal(r.alerts.length, 0);
    down = false;
    await poll(flaky, onlySources({ fourzida: true }));
    assert.match(r.alerts[0] ?? '', /Belgrade home finder/);
    assert.ok(r.alerts.some((a) => /On the market now: \d+ listings/.test(a)));
  });

  it('retries a price-drop card that failed to send', async () => {
    const r = recorder();
    await poll(r.notifier, onlySources({ fourzida: true }));
    const target = db.listByStatus('new', 1)[0];
    const raw = (db as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db;
    raw.prepare('UPDATE listings SET price = price + 20000 WHERE id = ?').run(target.id);
    let fail = true;
    const flaky: Notifier = {
      send: async (ev) => {
        if (fail) throw new Error('Telegram is down');
        r.events.push(ev);
        return 42;
      },
      alert: r.notifier.alert,
    };
    await poll(flaky, onlySources({ fourzida: true }));
    fail = false;
    await poll(flaky, onlySources({ fourzida: true }));
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0].kind, 'price_drop');
  });

  it('warns in the chat when a source keeps failing', async () => {
    const r = recorder();
    globalThis.fetch = (async () => new Response('down', { status: 503 })) as typeof fetch;
    for (let i = 0; i < 3; i++) {
      await runPoll({ db, notifier: r.notifier, cfg: { ...searchConfig, sources: onlySources({ cityexpert: true }), pagesPerPoll: 1 }, notifyOnFirstRun: false, healthAlertAfter: 3 });
    }
    const warnings = r.alerts.filter((a) => a.startsWith('⚠️'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /cityexpert/);
  });
});
