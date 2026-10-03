import type { Listing } from './types.js';

/**
 * Fingerprint used to collapse duplicates across agencies and sites.
 * Coarse: type + rooms + area + price rounded to 1000 + place slug. Works across sites
 * because every source normalizes places to 4zida-style slugs (src/places.ts); a small
 * price difference between sites or a different neighborhood name breaks the match.
 */
export function fingerprint(l: Listing): string {
  return [
    l.type,
    l.rooms ?? '?',
    l.m2 ?? '?',
    Math.round(l.price / 1000),
    l.placeSlug,
  ].join('|');
}
