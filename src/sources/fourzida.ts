import type { Advertiser, GroundLevel, Listing, PropertyType } from '../types.js';
import type { FourZidaSearch } from '../search.config.js';
import { UNKNOWN_PLACE } from '../places.js';

const BASE = 'https://www.4zida.rs';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

/** Raw ad object from the RSC payload of a 4zida search page (only the fields we use). */
interface RawAd {
  id: string;
  /** Regular ads. New-build ads carry one too, but it leads to a 404 page. */
  urlPath?: string;
  /** New-build (novogradnja) ads: the working link to the unit inside its project. */
  url?: string;
  searchNgImageContext?: Record<string, string>;
  projectTitle?: string;
  state?: string;
  inhabitable?: boolean;
  for: string;
  type: string;
  title?: string;
  address?: string;
  price: number;
  previousPrice?: number;
  m2?: number;
  roomCount?: number;
  floor?: number;
  totalFloors?: number;
  registered?: 'yes' | 'no' | 'in_progress' | string;
  heatingType?: string;
  elevator?: number;
  lastFloor?: boolean;
  atticFloor?: boolean;
  creditEligible?: boolean;
  creditEligibility?: 'yes' | 'no' | string;
  advertiserType?: number;
  companyUrlPath?: string;
  createdAt?: string;
  lastActivatedAt?: string;
  image?: { search?: Record<string, string> };
}

export interface FourZidaOptions {
  maxPrice: number;
  pages: number;
  fetchImpl?: typeof fetch;
}

export async function fetchFourZida(
  search: FourZidaSearch,
  opts: FourZidaOptions,
): Promise<Listing[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const seen = new Map<string, Listing>();
  for (let page = 1; page <= opts.pages; page++) {
    const url = `${BASE}/${search.path}?jeftinije_od=${opts.maxPrice}&sortiranje=najnoviji&strana=${page}`;
    const res = await doFetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html', 'Accept-Language': 'sr,en;q=0.8' },
    });
    if (!res.ok) throw new Error(`4zida ${url} -> HTTP ${res.status}`);
    const html = await res.text();
    const ads = extractAds(html);
    if (ads.length === 0) break;
    for (const ad of ads) {
      const listing = toListing(ad, search);
      if (listing && !seen.has(listing.sourceId)) seen.set(listing.sourceId, listing);
    }
  }
  return [...seen.values()];
}

/**
 * 4zida runs on Next.js: data lives in self.__next_f.push([1,"..."]) chunks.
 * We join the chunks into a React Flight payload and walk its "id:value" rows.
 * Ads are delivered as text rows "id:T<hex-length>,{json}", so the payload
 * cannot be split by newlines; it has to be read sequentially.
 */
export function extractAds(html: string): RawAd[] {
  const chunkRe = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  const parts: string[] = [];
  for (const m of html.matchAll(chunkRe)) {
    try {
      parts.push(JSON.parse(`"${m[1]}"`) as string);
    } catch {
      // chunk with non-standard escaping, skip it
    }
  }
  const found = new Map<string, RawAd>();
  for (const body of flightRows(parts.join(''))) {
    if (body[0] !== '[' && body[0] !== '{') continue;
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      continue;
    }
    walk(value, (o) => {
      if (isRawAd(o)) found.set(o.id, o);
    });
  }
  return [...found.values()];
}

/** Iterates over Flight payload row values. T-row length is given in UTF-8 bytes. */
function* flightRows(payload: string): Generator<string> {
  let i = 0;
  while (i < payload.length) {
    const colon = payload.indexOf(':', i);
    if (colon < 0) break;
    const j = colon + 1;
    if (payload[j] === 'T') {
      const comma = payload.indexOf(',', j);
      if (comma < 0) break;
      const byteLen = parseInt(payload.slice(j + 1, comma), 16);
      const start = comma + 1;
      const end = advanceBytes(payload, start, byteLen);
      yield payload.slice(start, end);
      i = payload[end] === '\n' ? end + 1 : end;
    } else {
      const nl = payload.indexOf('\n', j);
      const end = nl < 0 ? payload.length : nl;
      yield payload.slice(j, end);
      i = end + 1;
    }
  }
}

function advanceBytes(s: string, start: number, byteLen: number): number {
  let bytes = 0;
  let i = start;
  while (i < s.length && bytes < byteLen) {
    const cp = s.codePointAt(i)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    i += cp > 0xffff ? 2 : 1;
  }
  return i;
}

/** 4zida ad types -> shared type. New builds come as newApartment / newHouse. */
const TYPE_MAP: Record<string, PropertyType> = {
  apartment: 'apartment',
  house: 'house',
  newApartment: 'apartment',
  newHouse: 'house',
};

function isRawAd(o: unknown): o is RawAd {
  if (!o || typeof o !== 'object') return false;
  const r = o as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    (typeof r.urlPath === 'string' || typeof r.url === 'string') &&
    r.for === 'sale' &&
    typeof r.price === 'number' &&
    typeof r.type === 'string' &&
    r.type in TYPE_MAP
  );
}

function walk(v: unknown, visit: (o: unknown) => void): void {
  if (Array.isArray(v)) {
    for (const x of v) walk(x, visit);
  } else if (v && typeof v === 'object') {
    visit(v);
    for (const x of Object.values(v as Record<string, unknown>)) walk(x, visit);
  }
}

function advertiserFrom(code: number | undefined): Advertiser {
  switch (code) {
    case 1:
      return 'agency';
    case 3:
      return 'developer';
    case 4:
      return 'owner';
    default:
      return 'unknown';
  }
}

/**
 * 4zida floor codes: 0 = visoko prizemlje, -1 = prizemlje, -2 = nisko prizemlje,
 * lower = suteren. Map to the shared scale: 0 = ground, -1 = below ground.
 */
export function normalizeFloor(f: number | undefined): number | null {
  if (f === undefined) return null;
  if (f > 0) return f;
  return f >= -2 ? 0 : -1;
}

function groundLevelOf(f: number | undefined): GroundLevel | null {
  if (f === undefined || f > 0) return null;
  if (f === 0) return 'high_ground';
  if (f === -1) return 'ground';
  if (f === -2) return 'low_ground';
  return 'basement';
}

const RESALE_STATES = new Set(['original', 'repaired', 'needs_repair', 'renovated', 'lux']);

function isNewBuildOf(ad: RawAd): boolean | null {
  if (ad.type.startsWith('new') || ad.state === 'new' || ad.advertiserType === 3 || ad.inhabitable === false) return true;
  if (ad.state && RESALE_STATES.has(ad.state)) return false;
  return null;
}

function toListing(ad: RawAd, search: FourZidaSearch): Listing | null {
  const type = TYPE_MAP[ad.type];
  const path = ad.url ?? ad.urlPath;
  if (!type || !path) return null;
  // /prodaja-stanova/<place>/... or /novogradnja/<place>/<developer>/<project>/...
  const segments = path.split('/').filter(Boolean);
  const placeSlug = segments[1] ?? UNKNOWN_PLACE;
  const title = ad.title?.trim() || ad.projectTitle?.trim() || ad.address?.trim() || placeSlug;
  return {
    source: '4zida',
    sourceId: ad.id,
    url: BASE + path,
    type,
    title,
    price: ad.price,
    previousPrice: typeof ad.previousPrice === 'number' && ad.previousPrice > 1000 ? ad.previousPrice : null,
    m2: ad.m2 ?? null,
    rooms: ad.roomCount ?? null,
    floor: normalizeFloor(ad.floor),
    totalFloors: ad.totalFloors ?? null,
    placeSlug,
    address: ad.address ?? null,
    // 'in_progress' (registration underway) is not a no
    registered: ad.registered === 'yes' ? true : ad.registered === 'no' ? false : null,
    heating: ad.heatingType ?? null,
    elevator: ad.elevator === undefined ? null : ad.elevator === 1,
    groundLevel: groundLevelOf(ad.floor),
    attic: ad.atticFloor ?? null,
    isNewBuild: isNewBuildOf(ad),
    lastFloor:
      ad.lastFloor || ad.atticFloor
        ? true
        : ad.lastFloor === false
          ? false
          : ad.floor !== undefined && ad.totalFloors !== undefined && ad.floor > 0
            ? ad.floor >= ad.totalFloors
            : null,
    creditEligible:
      ad.creditEligibility === 'yes' ? true : ad.creditEligibility === 'no' ? false : (ad.creditEligible ?? null),
    advertiser: advertiserFrom(ad.advertiserType),
    agencySlug: ad.companyUrlPath ? ad.companyUrlPath.split('/').filter(Boolean)[2] ?? null : null,
    imageUrl:
      ad.image?.search?.['840x0_fill_0_jpeg'] ??
      ad.image?.search?.['420x0_fill_0_jpeg'] ??
      ad.searchNgImageContext?.['420x0_fill_0_jpeg'] ??
      null,
    sourceCreatedAt: ad.createdAt ?? null,
  };
}
