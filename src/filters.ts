import type { Listing } from './types.js';
import type { SearchConfig } from './search.config.js';
import { UNKNOWN_PLACE } from './places.js';

/**
 * Returns a rejection reason, or null when the listing passes all filters.
 * Rule: a filter rejects only on data that is present. Unknown (null) passes,
 * so sites that publish fewer fields are not silently filtered out.
 */
export function rejectReason(l: Listing, cfg: SearchConfig): string | null {
  if (l.price > cfg.maxPrice) return `price ${l.price} > ${cfg.maxPrice}`;
  if (cfg.minPrice > 0 && l.price < cfg.minPrice) return `price ${l.price} < ${cfg.minPrice}`;
  if (cfg.minM2 !== null && l.m2 !== null && l.m2 < cfg.minM2) return `area ${l.m2} < ${cfg.minM2}`;
  if (cfg.maxM2 !== null && l.m2 !== null && l.m2 > cfg.maxM2) return `area ${l.m2} > ${cfg.maxM2}`;
  if (cfg.minRooms !== null && l.rooms !== null && l.rooms < cfg.minRooms) return `rooms ${l.rooms} < ${cfg.minRooms}`;
  if (cfg.maxPricePerM2 !== null && l.m2) {
    const ppm = l.price / l.m2;
    if (ppm > cfg.maxPricePerM2) return `price/m2 ${Math.round(ppm)} > ${cfg.maxPricePerM2}`;
  }
  if (cfg.buildingAge === 'resale' && l.isNewBuild === true) return 'new build';
  if (cfg.buildingAge === 'new' && l.isNewBuild === false) return 'resale';
  if (cfg.requireRegistered && l.registered === false && l.isNewBuild !== true) return 'not registered';
  if (cfg.requireCreditEligible && l.creditEligible === false) return 'not mortgage-eligible';

  if (l.type === 'apartment') {
    const basement = l.groundLevel === 'basement' || (l.floor !== null && l.floor < 0);
    const ground = l.groundLevel === 'ground' || l.groundLevel === 'low_ground' || (l.floor === 0 && l.groundLevel === null);
    if (cfg.excludeBasement && basement) return 'basement';
    if (cfg.excludeGroundFloor && ground) return 'ground floor';
    if (cfg.excludeAttic && l.attic === true) return 'attic';
    if (cfg.excludeLastFloor && (l.lastFloor === true || l.attic === true)) return 'top floor';
    if (cfg.maxFloorWithoutElevator !== null && l.elevator === false && l.floor !== null && l.floor > cfg.maxFloorWithoutElevator) {
      return `floor ${l.floor} without elevator`;
    }
  }

  const place = l.placeSlug.toLowerCase();
  const allowed = l.type === 'house' ? [...cfg.includePlaces, ...cfg.includePlacesHousesOnly] : cfg.includePlaces;
  // Exception to "unknown passes": the owners found ads without a location useless, so with a
  // place list set, 'beograd' (the site gave no neighborhood, e.g. a seller hid it) is rejected.
  if (cfg.includePlaces.length > 0) {
    if (place === UNKNOWN_PLACE) return 'place unknown';
    if (!allowed.some((p) => place.includes(p.toLowerCase()))) return 'place not in list';
  }
  const excluded = cfg.excludePlaces.find((p) => place.includes(p.toLowerCase()));
  if (excluded) return `place ${excluded}`;
  return null;
}
