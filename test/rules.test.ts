import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rejectReason } from '../src/filters.ts';
import { searchConfig } from '../src/search.config.ts';
import { applyPlacesEdit, parseField, parseMoney, parsePlaces } from '../src/settings.ts';
import { toPlaceSlug } from '../src/places.ts';
import { trackHealth } from '../src/health.ts';
import { ListingsDb } from '../src/db.ts';
import { escAttr, formatCard, formatDigest } from '../src/format.ts';
import type { StoredListing } from '../src/types.ts';
import type { Listing } from '../src/types.ts';
import { baseListing } from './helpers.ts';


/** Neutral filters, independent of the owners' defaults: only the price cap is on. */
const open = {
  ...searchConfig, maxPrice: 220_000, minPrice: 0, minM2: null, minRooms: null, excludeGroundFloor: false,
  includePlaces: [] as string[], includePlacesHousesOnly: [] as string[],
};
const reject = (patch: Partial<Listing>, cfg: Partial<typeof searchConfig> = {}) =>
  rejectReason({ ...baseListing, ...patch }, { ...open, ...cfg });

describe('filters', () => {
  it('lets unknown values through every filter', () => {
    const strict = {
      minM2: 50, maxM2: 100, minRooms: 2, maxPricePerM2: 3000, maxFloorWithoutElevator: 2,
      excludeBasement: true, excludeGroundFloor: true, excludeAttic: true, excludeLastFloor: true,
      requireRegistered: true, requireCreditEligible: true, buildingAge: 'resale' as const,
    };
    const unknown = { m2: null, rooms: null, floor: null, lastFloor: null, attic: null, registered: null,
      creditEligible: null, elevator: null, isNewBuild: null, advertiser: 'unknown' as const };
    assert.equal(reject(unknown, strict), null);
  });

  it('rejects on explicit data', () => {
    assert.match(reject({ price: 250_000 }) ?? '', /price/);
    assert.match(reject({ m2: 120 }, { maxM2: 100 }) ?? '', /area/);
    assert.match(reject({ m2: 40 }, { maxPricePerM2: 3000 }) ?? '', /price\/m2/);
    assert.match(reject({ elevator: false, floor: 4 }, { maxFloorWithoutElevator: 3 }) ?? '', /elevator/);
  });

  it('distinguishes ground-level variants', () => {
    const cfg = { excludeBasement: true, excludeGroundFloor: true };
    assert.equal(reject({ floor: 0, groundLevel: 'high_ground' }, cfg), null);
    assert.equal(reject({ floor: 0, groundLevel: 'ground' }, cfg), 'ground floor');
    assert.equal(reject({ floor: 0, groundLevel: 'low_ground' }, cfg), 'ground floor');
    assert.equal(reject({ floor: -1, groundLevel: 'basement' }, cfg), 'basement');
    assert.equal(reject({ type: 'house', floor: 0, groundLevel: 'ground' }, cfg), null);
  });

  it('separates attic from top floor', () => {
    assert.equal(reject({ attic: true, lastFloor: true }, { excludeAttic: true }), 'attic');
    assert.equal(reject({ lastFloor: true }, { excludeAttic: true }), null);
    assert.equal(reject({ attic: true }, { excludeLastFloor: true }), 'top floor');
  });

  it('switches between resale and new builds', () => {
    assert.equal(reject({ isNewBuild: true }, { buildingAge: 'resale' }), 'new build');
    assert.equal(reject({ isNewBuild: false }, { buildingAge: 'new' }), 'resale');
    assert.equal(reject({ isNewBuild: true }, { buildingAge: 'any' }), null);
  });

  it('never hides new builds for not being registered yet', () => {
    assert.equal(reject({ registered: false, isNewBuild: true }, { requireRegistered: true }), null);
    assert.equal(reject({ registered: false, isNewBuild: false }, { requireRegistered: true }), 'not registered');
  });

  it('applies the houses-only place list to houses only', () => {
    const cfg = { includePlaces: ['vracar'], includePlacesHousesOnly: ['banjica'] };
    const banjica = 'banjica-vozdovac-opstina-beograd';
    assert.equal(reject({ placeSlug: banjica, type: 'house' }, cfg), null);
    assert.equal(reject({ placeSlug: banjica, type: 'apartment' }, cfg), 'place not in list');
  });

  it('lets listings without a known place through the place list', () => {
    assert.equal(rejectReason({ ...baseListing, placeSlug: 'beograd' }, searchConfig), null);
  });

  it('default place list keeps Stari Kosutnjak (Rakovica) out', () => {
    const slug = 'stari-kosutnjak-rakovica-opstina-beograd';
    assert.equal(rejectReason({ ...baseListing, placeSlug: slug }, searchConfig), 'place not in list');
    assert.equal(rejectReason({ ...baseListing, placeSlug: 'kosutnjak-cukarica-opstina-beograd' }, searchConfig), null);
  });
});

describe('chat input parsing', () => {
  it('reads prices in common formats', () => {
    for (const t of ['200000', '200 000', '200,000', '200.000', '200k', '200k €']) assert.equal(parseMoney(t), 200_000, t);
    assert.equal(parseMoney('abc'), null);
  });

  it('validates numeric fields against each other', () => {
    assert.equal(parseField('maxPrice', '5000', searchConfig).ok, false);
    assert.equal(parseField('minPrice', '300k', searchConfig).ok, false);
    assert.deepEqual(parseField('minRooms', 'any', searchConfig), { ok: true, value: { minRooms: null } });
    assert.deepEqual(parseField('maxFloorWithoutElevator', '0', searchConfig), { ok: true, value: { maxFloorWithoutElevator: 0 } });
  });

  it('edits place lists with + and -', () => {
    assert.deepEqual(parsePlaces('Novi Beograd, Čukarica; grocka'), ['novi-beograd', 'cukarica', 'grocka']);
    assert.deepEqual(applyPlacesEdit(['a'], '+ Žarkovo, a'), ['a', 'zarkovo']);
    assert.deepEqual(applyPlacesEdit(['a', 'zarkovo'], '- zarkovo'), ['a']);
    assert.deepEqual(applyPlacesEdit(['a'], 'none'), []);
    assert.deepEqual(applyPlacesEdit(['a'], 'x, y'), ['x', 'y']);
  });
});

describe('place slugs', () => {
  const cases: Array<[string | null, string | null, string]> = [
    ['Banovo Brdo', 'Čukarica', 'banovo-brdo-cukarica-opstina-beograd'],
    ['Blok 45', 'Novi Beograd', 'blok-45-novi-beograd-beograd'],
    ['Vračar', 'Vračar', 'vracar-beograd'],
    [null, 'Opština Zvezdara', 'zvezdara-opstina-beograd'],
    ['Konjarnik', 'Voždovac', 'konjarnik-vozdovacki-deo-vozdovac-opstina-beograd'],
    ['Mirijevo', null, 'mirijevo-zvezdara-opstina-beograd'],
    ['Neki Novi Kraj', 'Zvezdara', 'neki-novi-kraj-zvezdara-opstina-beograd'],
  ];
  for (const [n, m, want] of cases) {
    it(`${n} / ${m}`, () => assert.equal(toPlaceSlug({ neighborhood: n, municipality: m }), want));
  }
});

describe('health alerts', () => {
  it('alerts once after the threshold and once on recovery', () => {
    const db = new ListingsDb(join(mkdtempSync(join(tmpdir(), 'bot-test-')), 'db.sqlite'));
    const fail = [{ key: 'site', ok: false, detail: 'HTTP 503' }];
    assert.equal(trackHealth(db, fail, 3).length, 0);
    assert.equal(trackHealth(db, fail, 3).length, 0);
    assert.match(trackHealth(db, fail, 3)[0] ?? '', /failed 3 polls/);
    assert.equal(trackHealth(db, fail, 3).length, 0);
    assert.match(trackHealth(db, [{ key: 'site', ok: true }], 3)[0] ?? '', /working again/);
    assert.equal(trackHealth(db, [{ key: 'site', ok: true }], 3).length, 0);
    db.close();
  });
});

describe('digest', () => {
  const stored = (i: number, placeSlug: string): StoredListing => ({
    ...baseListing, id: i, sourceId: String(i), url: `https://example.com/${i}`, price: 100_000 + i * 1000, placeSlug,
    fingerprint: String(i), firstSeenAt: '', lastSeenAt: '', status: 'new', notifiedAt: null, tgMessageId: null, extraMessageIds: [],
  });

  it('groups by municipality, cheapest first, collapsed', () => {
    const [msg] = formatDigest('Title', [
      stored(3, 'kalenic-vracar-beograd'),
      stored(1, 'mirijevo-zvezdara-opstina-beograd'),
      stored(2, 'kalenic-vracar-beograd'),
    ]);
    assert.match(msg, /<b>Vračar<\/b> \(2\)\n<blockquote expandable>/);
    assert.ok(msg.indexOf('102,000') < msg.indexOf('103,000'));
    assert.ok(msg.indexOf('Vračar') < msg.indexOf('Zvezdara'), 'bigger group first');
    assert.match(msg, /Kalenic/);
  });

  it('splits long digests into messages under the Telegram limit', () => {
    const many = Array.from({ length: 300 }, (_, i) => stored(i, i % 2 ? 'kalenic-vracar-beograd' : 'blok-45-novi-beograd-beograd'));
    const msgs = formatDigest('Title', many);
    assert.ok(msgs.length > 1);
    for (const m of msgs) assert.ok(m.length <= 4096, `message of ${m.length} chars`);
    const links = msgs.join('').match(/<a href=/g) ?? [];
    assert.equal(links.length, 300, 'every listing appears once');
  });
});

describe('HTML safety', () => {
  it('escapes quotes and ampersands inside links', () => {
    assert.equal(escAttr('https://x.rs/a"b&c'), 'https://x.rs/a&quot;b&amp;c');
    const listing = { ...baseListing, url: 'https://cityexpert.rs/x/"evil"&a', id: 1, fingerprint: '', firstSeenAt: '', lastSeenAt: '',
      status: 'new' as const, notifiedAt: null, tgMessageId: null, extraMessageIds: [] };
    const html = formatCard({ kind: 'new', listing });
    assert.ok(html.includes('href="https://cityexpert.rs/x/&quot;evil&quot;&amp;a"'));
  });
});
