import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Listing } from '../src/types.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Reads a gzipped capture from test/fixtures, e.g. fixture('fourzida/search-houses.html.gz'). */
export function fixture(path: string): string {
  return gunzipSync(readFileSync(join(FIXTURES, path))).toString('utf8');
}

/**
 * A fetch stand-in that answers from fixtures. `route` maps a URL to a body
 * (string) or to null for 404. Records requested URLs for assertions.
 */
export function stubFetch(route: (url: string) => string | null): typeof fetch & { urls: string[] } {
  const urls: string[] = [];
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    const body = route(url);
    return body === null ? new Response('not found', { status: 404 }) : new Response(body, { status: 200 });
  };
  return Object.assign(impl as typeof fetch, { urls });
}

/** A listing with every optional detail unknown; tests override what they need. */
export const baseListing: Listing = {
  source: 'test', sourceId: '1', url: 'https://example.com/1', type: 'apartment', title: 'Test',
  price: 150_000, previousPrice: null, m2: 60, rooms: 2, floor: 3, totalFloors: 5, groundLevel: null,
  lastFloor: false, attic: null, isNewBuild: null, placeSlug: 'vracar-beograd', address: null,
  registered: null, heating: null, elevator: null, creditEligible: null, advertiser: 'unknown',
  agencySlug: null, imageUrl: null, sourceCreatedAt: null,
};
