import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, stubFetch } from './helpers.ts';
import { fetchFourZida, normalizeFloor } from '../src/sources/fourzida.ts';
import { mapHeating, parseAdPage, parseFloorCode, parseSearchPage } from '../src/sources/halooglasi.ts';
import { parseFloor, parseSearchResults, registeredFromText } from '../src/sources/nekretnine.ts';
import { fetchCityExpert } from '../src/sources/cityexpert.ts';
import type { Listing } from '../src/types.ts';

/** Invariants every source must hold, whatever the site. */
function assertWellFormed(listings: Listing[], source: string, host: string) {
  assert.ok(listings.length > 0, `${source}: no listings parsed`);
  const ids = new Set<string>();
  for (const l of listings) {
    assert.equal(l.source, source);
    assert.ok(!ids.has(l.sourceId), `${source}: duplicate id ${l.sourceId}`);
    ids.add(l.sourceId);
    assert.ok(l.url.startsWith(`https://${host}/`), `${source}: bad url ${l.url}`);
    assert.ok(l.type === 'apartment' || l.type === 'house');
    assert.ok(Number.isInteger(l.price) && l.price > 0, `${source}: bad price ${l.price}`);
    assert.match(l.placeSlug, /^[a-z0-9-]+$/, `${source}: bad place slug ${l.placeSlug}`);
    if (l.groundLevel !== null) assert.ok(l.floor === null || l.floor <= 0, `${source}: groundLevel on floor ${l.floor}`);
  }
}

describe('4zida', () => {
  const run = (path: string, type: 'apartment' | 'house', file: string) =>
    fetchFourZida({ path, type }, { maxPrice: 220_000, pages: 1, fetchImpl: stubFetch(() => fixture(file)) });

  it('parses the apartments search page, including new-build ads', async () => {
    const ls = await run('prodaja-stanova/beograd', 'apartment', 'fourzida/search-apartments.html.gz');
    assertWellFormed(ls, '4zida', 'www.4zida.rs');
    const newBuilds = ls.filter((l) => l.url.includes('/novogradnja/'));
    // Regression: new-build ads come as type "newApartment" and their urlPath leads to a 404.
    assert.ok(newBuilds.length >= 5);
    assert.ok(newBuilds.every((l) => l.isNewBuild === true && l.type === 'apartment'));
  });

  it('treats registration "in_progress" as unknown, not as "no"', async () => {
    const ls = await run('prodaja-stanova/beograd', 'apartment', 'fourzida/search-apartments.html.gz');
    assert.ok(ls.some((l) => l.registered === null));
  });

  it('parses the houses search page', async () => {
    const ls = await run('prodaja-kuca/beograd', 'house', 'fourzida/search-houses.html.gz');
    assertWellFormed(ls, '4zida', 'www.4zida.rs');
    assert.ok(ls.every((l) => l.type === 'house'));
  });

  it('maps floor codes to the shared scale', () => {
    assert.equal(normalizeFloor(3), 3);
    assert.equal(normalizeFloor(0), 0); // visoko prizemlje
    assert.equal(normalizeFloor(-2), 0); // nisko prizemlje
    assert.equal(normalizeFloor(-3), -1); // suteren
    assert.equal(normalizeFloor(undefined), null);
  });
});

describe('halooglasi', () => {
  it('parses search pages', () => {
    const apt = parseSearchPage(fixture('halooglasi/search-apartments.html.gz'));
    assertWellFormed(apt.listings, 'halooglasi', 'www.halooglasi.com');
    assert.ok((apt.totalPages ?? 0) > 1);
    const houses = parseSearchPage(fixture('halooglasi/search-houses.html.gz')).listings;
    assertWellFormed(houses, 'halooglasi', 'www.halooglasi.com');
  });

  it('parses an ad page with the details cards lack', () => {
    const ad = parseAdPage(fixture('halooglasi/ad-5425647135657.html.gz'));
    assert.ok(ad);
    assert.equal(ad.sourceId, '5425647135657');
    assert.equal(ad.registered, true);
    assert.equal(ad.heating, 'district');
    assert.equal(ad.elevator, true);
    assert.equal(ad.isNewBuild, true);
    assert.equal(ad.placeSlug, 'blok-64-novi-beograd-beograd');
  });

  it('maps floor and heating codes', () => {
    assert.deepEqual(
      (({ floor, groundLevel }) => ({ floor, groundLevel }))(parseFloorCode('VPR')),
      { floor: 0, groundLevel: 'high_ground' },
    );
    assert.equal(parseFloorCode('SUT').floor, -1);
    assert.equal(parseFloorCode('PK').attic, true);
    assert.equal(mapHeating('CG'), 'district');
    assert.equal(mapHeating('EG'), 'central');
    assert.equal(mapHeating('TA'), 'storageHeater');
  });
});

describe('nekretnine', () => {
  it('parses the search API responses', () => {
    const apt = parseSearchResults(JSON.parse(fixture('nekretnine/api-apartments.json.gz')), 'apartment');
    assertWellFormed(apt, 'nekretnine', 'www.nekretnine.rs');
    const first = apt.find((l) => l.sourceId === '1556039');
    assert.ok(first);
    assert.equal(first.placeSlug, 'mirijevo-zvezdara-opstina-beograd');
    assert.equal(first.groundLevel, 'high_ground');
    const houses = parseSearchResults(JSON.parse(fixture('nekretnine/api-houses.json.gz')), 'house');
    assertWellFormed(houses, 'nekretnine', 'www.nekretnine.rs');
  });

  it('reads floors and registration from Serbian text', () => {
    assert.equal(parseFloor('visoko prizemlje').groundLevel, 'high_ground');
    assert.equal(parseFloor('suteren').floor, -1);
    assert.equal(registeredFromText('Stan je uknjižen'), true);
    assert.equal(registeredFromText('stan nije uknjižen'), false);
  });
});

describe('cityexpert', () => {
  const route = (url: string) =>
    url.includes('/api/Search')
      ? fixture('cityexpert/search.json.gz')
      : url.includes('/PropertyView/79599/')
        ? fixture('cityexpert/property-79599.json.gz')
        : null;

  it('parses the search API and merges details', async () => {
    const fetchImpl = stubFetch(route);
    const ls = await fetchCityExpert({ maxPrice: 220_000, pages: 1, types: ['apartment', 'house'], delayMs: 0, fetchImpl });
    assertWellFormed(ls, 'cityexpert', 'cityexpert.rs');
    const house = ls.find((l) => l.sourceId === '79599-BS');
    assert.ok(house);
    assert.equal(house.type, 'house');
    assert.equal(house.registered, true);
    assert.equal(house.placeSlug, 'borca-palilula-opstina-beograd');
    // Search API is a GET with the query as JSON in ?req=
    assert.ok(fetchImpl.urls[0].includes('/api/Search?req='));
  });

  it('requests details only for listings the predicate accepts', async () => {
    const fetchImpl = stubFetch(route);
    await fetchCityExpert({ maxPrice: 220_000, pages: 1, types: ['apartment', 'house'], delayMs: 0, fetchImpl, withDetails: () => false });
    assert.equal(fetchImpl.urls.filter((u) => u.includes('PropertyView')).length, 0);
  });
});

describe('cityexpert price changes', () => {
  it('sees a price drop even when the details are cached', async () => {
    const search = JSON.parse(fixture('cityexpert/search.json.gz')) as { result: Array<{ propId: number; price: number }> };
    const route = (body: string) => (url: string) =>
      url.includes('/api/Search') ? body : url.includes('/PropertyView/79599/') ? fixture('cityexpert/property-79599.json.gz') : null;
    const opts = { maxPrice: 220_000, pages: 1, types: ['apartment', 'house'] as ('apartment' | 'house')[], delayMs: 0 };
    const before = await fetchCityExpert({ ...opts, fetchImpl: stubFetch(route(JSON.stringify(search))) });
    const oldPrice = before.find((l) => l.sourceId === '79599-BS')!.price;
    for (const it of search.result) if (it.propId === 79599) it.price -= 20_000;
    const after = await fetchCityExpert({ ...opts, fetchImpl: stubFetch(route(JSON.stringify(search))) });
    assert.equal(after.find((l) => l.sourceId === '79599-BS')!.price, oldPrice - 20_000);
  });
});
