/**
 * cityexpert.rs source (Belgrade agency with verified listings).
 *
 * API contract (reverse-engineered from the Angular bundles, no auth, no captcha):
 * - Search: GET https://cityexpert.rs/api/Search?req=<url-encoded JSON>
 *   JSON: { ptId: number[], cityId: 1, rentOrSale: 's', currentPage, resultsPerPage, maxPrice,
 *           searchSource: 'regular', sort: 'datedsc' }
 *   Response: { result: RawSearchItem[], info: { pageCount, isLastPage, documentCount, ... }, facetItems, ... }
 *   The search item carries bucketed values only (floor "2_4", heating facet groups, "filed" always 0).
 * - Detail: GET https://cityexpert.rs/api/PropertyView/<propId>/s
 *   Exact floor, total floors, elevator, registration ("basInfFiled"), heating codes, year of construction.
 * Property types (ptId): 1 apartment, 2 house, 5 apartment in a house, 3 office, 4 shop, 6 land, 7 garage, 8 float house.
 */
import type { GroundLevel, Listing, PropertyType } from '../types.js';
import { toPlaceSlug } from '../places.js';
import catalog from '../data/places-4zida.json' with { type: 'json' };

const BASE = 'https://cityexpert.rs';
const IMG_BASE = 'https://img.cityexpert.rs';
const CITY_ID_BELGRADE = 1;
const RESULTS_PER_PAGE = 30;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const CATALOG = new Set<string>(catalog as string[]);

/** Search result item (only the fields we use). */
interface RawSearchItem {
  uniqueID: string;
  propId: number;
  cityId: number;
  street?: string | null;
  /** Bucketed: "1", "2_4", "5_10", "11+", "PR", "VPR", "NPR", "SU", "PTK". */
  floor?: string | null;
  size?: number | null;
  /** "0.5" (studio), "1.0", "1.5", ... "4.5", "5+", "OTHER". */
  structure?: string | null;
  municipality?: string | null;
  /** [municipality, neighborhoods..., wider areas like "Centar", "Krug dvojke"]. */
  polygons?: string[] | null;
  ptId: number;
  price: number;
  oldPrice?: number | null;
  coverPhoto?: string | null;
  rentOrSale: string;
  underConstruction?: boolean;
  newDevelopment?: boolean;
  /** Facet groups: 1 central (CG), 99 storey (EG), 10 storage heater, 4 electricity, 21 underfloor, 26 heat pump. */
  heatingArray?: number[] | null;
  bldgOptsArray?: string[] | null;
  /** 1 before 1941, 2 1941-1980, 3 1981-2000, 4 2001-2017, 5 after 2017, 6 unknown. */
  yearOfConstruction?: number | null;
  isNotLastFloor?: boolean;
  firstPublished?: string | null;
  newImagePipeline?: boolean;
}

/** PropertyView detail (only the fields we use). */
interface RawDetail {
  propId: number;
  ptId?: number;
  floor?: string | null;
  price?: number;
  oldPrice?: number | null;
  newDevelopment?: boolean;
  habitableNewBuilding?: boolean;
  underConstruction?: boolean;
  municipality?: string | null;
  neighbourhoods?: string[] | null;
  onsite?: {
    basInfFloorTotal?: number | null;
    bldgOptsElevator?: boolean | null;
    /** 1 not registered, 2 registered, 3 building permit, 4 use permit, 5 legalization decision. */
    basInfFiled?: number | null;
    heatingOptions?: number[] | null;
    basInfYearOfConstruction?: number | null;
    basInfUnderConstruction?: boolean | null;
    adpAttic?: boolean | null;
    basInfPenthouse?: boolean | null;
  } | null;
}

export interface CityExpertOptions {
  maxPrice: number;
  pages: number;
  types: PropertyType[];
  fetchImpl?: typeof fetch;
  /**
   * Load the detail endpoint (exact floor, registration, heating). true = every listing,
   * a function = only listings it accepts, judged on search-level data. Default true.
   */
  withDetails?: boolean | ((l: Listing) => boolean);
  /** Pause between requests, ms. Default 1000. */
  delayMs?: number;
}

/** ptId -> shared type. "Apartment in a house" (5) is an apartment. */
const PT_TYPE: Record<number, PropertyType> = { 1: 'apartment', 2: 'house', 5: 'apartment' };
const PT_URL: Record<number, string> = { 1: 'stan', 2: 'kuca', 5: 'stan-u-kuci' };
const STRUCTURE_URL: Record<string, string> = {
  '0.5': 'garsonjera',
  '1.0': 'jednosoban',
  '1.5': 'jednoiposoban',
  '2.0': 'dvosoban',
  '2.5': 'dvoiposoban',
  '3.0': 'trosoban',
  '3.5': 'troiposoban',
  '4.0': 'cetvorosoban',
  '4.5': 'cetvoroiposoban',
  '5+': 'petosoban-i-veci',
  OTHER: 'ostalo',
};

/** Details rarely change, so they are cached for the lifetime of the process. */
const detailCache = new Map<number, RawDetail>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchCityExpert(opts: CityExpertOptions): Promise<Listing[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const delayMs = opts.delayMs ?? 1000;
  const ptIds = Object.entries(PT_TYPE)
    .filter(([, t]) => opts.types.includes(t))
    .map(([id]) => Number(id));
  if (ptIds.length === 0) return [];

  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json', 'Accept-Language': 'sr,en;q=0.8' };
  let first = true;
  const politeGet = async (url: string): Promise<Response> => {
    if (!first) await sleep(delayMs);
    first = false;
    return doFetch(url, { headers });
  };

  const items = new Map<number, RawSearchItem>();
  for (let page = 1; page <= opts.pages; page++) {
    const req = {
      ptId: ptIds,
      cityId: CITY_ID_BELGRADE,
      rentOrSale: 's',
      currentPage: page,
      resultsPerPage: RESULTS_PER_PAGE,
      maxPrice: opts.maxPrice,
      searchSource: 'regular',
      sort: 'datedsc',
    };
    const url = `${BASE}/api/Search?req=${encodeURIComponent(JSON.stringify(req))}`;
    const res = await politeGet(url);
    if (!res.ok) throw new Error(`cityexpert ${url} -> HTTP ${res.status}`);
    const body = (await res.json()) as { result?: RawSearchItem[]; info?: { isLastPage?: boolean } };
    const result = body.result ?? [];
    for (const it of result) {
      if (it.rentOrSale === 's' && PT_TYPE[it.ptId] && !items.has(it.propId)) items.set(it.propId, it);
    }
    if (result.length === 0 || body.info?.isLastPage) break;
  }

  const listings: Listing[] = [];
  for (const it of items.values()) {
    let detail = detailCache.get(it.propId) ?? null;
    const wanted =
      typeof opts.withDetails === 'function'
        ? (() => {
            const coarse = toListing(it, null);
            return coarse !== null && opts.withDetails(coarse);
          })()
        : opts.withDetails !== false;
    if (!detail && wanted) {
      try {
        const res = await politeGet(`${BASE}/api/PropertyView/${it.propId}/s`);
        if (res.ok) {
          detail = (await res.json()) as RawDetail;
          detailCache.set(it.propId, detail);
        }
      } catch {
        // fall back to search-level data
      }
    }
    const listing = toListing(it, detail);
    if (listing && listing.price <= opts.maxPrice) listings.push(listing);
  }
  return listings;
}

/** Same slug rules as the site (its Angular "Mp" helper). */
export function siteSlug(text: string | null | undefined): string {
  if (!text) return '';
  let s = text.toLowerCase();
  for (const [a, b] of [
    ['č', 'c'], ['ć', 'c'], ['ž', 'z'], ['š', 's'], ['đ', 'dj'], [' ', '-'], ['.', ''],
    ['ä', 'ae'], ['ö', 'oe'], ['ü', 'ue'], ['ß', 'ss'],
  ] as const) {
    s = s.replaceAll(a, b);
  }
  return s;
}

function propertyUrl(it: RawSearchItem): string {
  const str = STRUCTURE_URL[it.structure ?? ''] ?? 'ostalo';
  const pt = PT_URL[it.ptId] ?? 'stan';
  const street = siteSlug(it.street) || String(it.propId);
  return `${BASE}/prodaja-nekretnina/beograd/${it.propId}/${str}-${pt}-${street}-${siteSlug(it.municipality)}`;
}

/** Mirrors the site's getImageUrl(); "@jpg" forces JPEG (the files are AVIF, which Telegram cannot show). */
function imageUrl(it: RawSearchItem): string | null {
  if (!it.coverPhoto) return null;
  const file = it.coverPhoto.toLowerCase().replaceAll(' ', '_');
  if (it.newImagePipeline === false) return `${IMG_BASE}/sites/default/files/styles/720x/public/image/${file}`;
  const bucket = Math.floor(it.propId / 1000) * 1000;
  return `${IMG_BASE}/properties/720x/${bucket}/${it.propId}/slike/${file}@jpg`;
}

/** "structure" -> rooms: "0.5" studio, "1.0".."4.5" as is, "5+" -> 5, "OTHER" -> null. */
export function roomsOf(structure: string | null | undefined): number | null {
  if (!structure) return null;
  const n = parseFloat(structure);
  return Number.isFinite(n) && n > 0 ? n : null;
}

interface FloorInfo {
  floor: number | null;
  groundLevel: GroundLevel | null;
  attic: boolean | null;
}

/** Detail floors are exact ("3", "PR", ...); search floors may be buckets ("2_4", "5_10", "11+") -> unknown. */
export function floorOf(code: string | null | undefined, totalFloors: number | null): FloorInfo {
  switch (code) {
    case undefined:
    case null:
    case '':
      return { floor: null, groundLevel: null, attic: null };
    case 'VPR':
      return { floor: 0, groundLevel: 'high_ground', attic: false };
    case 'PR':
      return { floor: 0, groundLevel: 'ground', attic: false };
    case 'NPR':
      return { floor: 0, groundLevel: 'low_ground', attic: false };
    case 'SU':
      return { floor: -1, groundLevel: 'basement', attic: false };
    case 'PTK': // potkrovlje
    case 'TVN': // tavan
      return { floor: totalFloors, groundLevel: null, attic: true };
  }
  if (/^\d+$/.test(code)) {
    const n = Number(code);
    return n === 0
      ? { floor: 0, groundLevel: 'ground', attic: false }
      : { floor: n, groundLevel: null, attic: false };
  }
  return { floor: null, groundLevel: null, attic: false };
}

/**
 * Detail heating codes (HEATING-n labels on the site) -> shared heating names.
 * CG = city district heating -> district; EG = own boiler (etažno) -> central.
 */
const HEATING_DETAIL: Record<number, string> = {
  1: 'district', // CG
  2: 'district', // CG po utrošku
  3: 'gas', // EG na gas
  4: 'central', // EG na struju
  5: 'central', // EG na ulje
  6: 'solid', // EG na pelet
  7: 'solid', // EG na ugalj
  8: 'central', // EG na mazut
  9: 'solid', // EG na drva
  10: 'storageHeater', // TA peć
  11: 'electricity', // el. grejalica
  12: 'electricity', // uljani radijator
  13: 'norwegianRadiators',
  14: 'electricity', // mermerni radijator
  15: 'airConditioning', // klima
  16: 'electricity', // kalorifer
  17: 'electricity', // kvarcna peć
  18: 'tileStove', // kaljeva peć
  19: 'solid', // drva
  21: 'underfloor', // podno
  23: 'central', // EG
  24: 'solid', // EG na čvrsto gorivo
  25: 'electricity', // struja
  26: 'heatPump',
  27: 'airConditioning', // inverter klima
  // 20 solar, 22 other -> no mapping
};

/** Search facet heating groups -> shared names (fallback when no detail). */
const HEATING_FACET: Record<number, string> = {
  1: 'district',
  99: 'central',
  10: 'storageHeater',
  4: 'electricity',
  21: 'underfloor',
  26: 'heatPump',
};

/** When a property lists several systems, the main (most significant) one wins. */
const HEATING_PRIORITY = [
  'district', 'central', 'gas', 'heatPump', 'underfloor', 'storageHeater',
  'tileStove', 'norwegianRadiators', 'solid', 'electricity', 'airConditioning',
];

function pickHeating(codes: number[] | null | undefined, map: Record<number, string>): string | null {
  const names = new Set((codes ?? []).map((c) => map[c]).filter((x): x is string => !!x));
  return HEATING_PRIORITY.find((h) => names.has(h)) ?? null;
}

/** Areas that span several neighborhoods; never used as the neighborhood. */
const AGGREGATE_POLYGONS = new Set(
  [
    'Centar', 'Širi centar', 'Uži centar', 'Krug dvojke', 'Opština Novi Beograd', 'Zvezdara bez Mirijeva',
    'Zvezdara 4', 'Palilula - uži deo', 'Palilula 2', 'Blokovi (61-64 i 72)', 'Zemunski kej - NBG',
    'Centralni NBG', 'Savski blokovi',
  ].map((s) => s.toLowerCase()),
);

/** cityexpert polygon name -> name 4zida uses for the same place. */
const PLACE_ALIASES: Record<string, string> = {
  'Nova Galenika': 'Galenika',
};

/**
 * Spellings to try against the 4zida catalog, most specific first:
 * "Blok 9 (Zemunski kej)" -> "Blok 9", "Zemunski kej"; "A / B" -> "A", "B";
 * "Naselje Sava Kovačević" -> "Sava Kovačević"; "Miljakovac 2" / "Mirijevo II" -> "Miljakovac" / "Mirijevo".
 */
function nameVariants(name: string): string[] {
  const out = [name];
  if (PLACE_ALIASES[name]) out.push(PLACE_ALIASES[name]);
  const paren = name.match(/^(.*?)\s*\((.*)\)\s*$/);
  if (paren) out.push(paren[1]!, paren[2]!);
  if (name.includes('/')) out.push(...name.split('/').map((s) => s.trim()));
  if (/^naselje\s+/i.test(name)) out.push(name.replace(/^naselje\s+/i, ''));
  // Numbered sub-areas; "Blok N" is a place of its own, and a bare "Blok" would prefix-match any block
  if (!/^blok\b/i.test(name) && /\s+(\d+|[IVX]+)$/.test(name)) out.push(name.replace(/\s+(\d+|[IVX]+)$/, ''));
  return out.filter(Boolean);
}

export function placeSlugOf(municipality: string | null | undefined, polygons: string[]): string {
  const mun = municipality?.trim() || null;
  const candidates = polygons.filter(
    (p) => p && p.toLowerCase() !== mun?.toLowerCase() && !AGGREGATE_POLYGONS.has(p.toLowerCase()),
  );
  let fallback: string | null = null;
  for (const c of candidates) {
    for (const v of nameVariants(c)) {
      const slug = toPlaceSlug({ neighborhood: v, municipality: mun });
      if (CATALOG.has(slug)) return slug;
      fallback ??= slug;
    }
  }
  return fallback ?? toPlaceSlug({ municipality: mun });
}

const NEW_BUILD_MAX_AGE_YEARS = 5;

function isNewBuildOf(it: RawSearchItem, d: RawDetail | null): boolean | null {
  if (it.newDevelopment || it.underConstruction || d?.newDevelopment || d?.underConstruction || d?.habitableNewBuilding) {
    return true;
  }
  if (d?.onsite?.basInfUnderConstruction) return true;
  const year = d?.onsite?.basInfYearOfConstruction;
  if (year && year > 1800) return new Date().getFullYear() - year <= NEW_BUILD_MAX_AGE_YEARS ? null : false;
  // Buckets: 1..4 = built up to 2017 -> resale
  if (it.yearOfConstruction && it.yearOfConstruction >= 1 && it.yearOfConstruction <= 4) return false;
  return null;
}

function registeredOf(filed: number | null | undefined): boolean | null {
  if (filed === 2) return true;
  if (filed === 1) return false;
  return null; // 3-5: permits/legalization in progress, 0/null: unknown
}

function toListing(it: RawSearchItem, d: RawDetail | null): Listing | null {
  const type = PT_TYPE[d?.ptId ?? it.ptId];
  if (!type || typeof it.price !== 'number') return null;
  // Always the search price: details are cached per process and would hide price drops
  const price = Math.round(it.price);
  const oldPrice = d?.oldPrice ?? it.oldPrice ?? null;
  const onsite = d?.onsite ?? null;
  const totalFloors = onsite?.basInfFloorTotal && onsite.basInfFloorTotal > 0 ? onsite.basInfFloorTotal : null;
  const isApartment = type === 'apartment';

  const fl = isApartment ? floorOf(d?.floor ?? it.floor, totalFloors) : { floor: null, groundLevel: null, attic: null };
  let lastFloor: boolean | null = null;
  if (isApartment) {
    if (fl.attic || onsite?.basInfPenthouse) lastFloor = true;
    else if (fl.floor !== null && fl.floor > 0 && totalFloors !== null) lastFloor = fl.floor >= totalFloors;
    else if (fl.floor !== null && fl.floor <= 0 && totalFloors !== null && totalFloors > 0) lastFloor = false;
  }

  let elevator: boolean | null = null;
  if (isApartment) {
    if (typeof onsite?.bldgOptsElevator === 'boolean') elevator = onsite.bldgOptsElevator;
    else if (it.bldgOptsArray?.includes('bldgOptsElevator')) elevator = true;
  }

  const municipality = d?.municipality ?? it.municipality ?? null;
  const polygons = [...(it.polygons ?? []), ...(d?.neighbourhoods ?? [])];
  const street = it.street?.trim() || null;

  return {
    source: 'cityexpert',
    sourceId: it.uniqueID || String(it.propId),
    url: propertyUrl(it),
    type,
    title: street ?? municipality ?? 'Beograd',
    price,
    previousPrice: typeof oldPrice === 'number' && oldPrice > price ? Math.round(oldPrice) : null,
    m2: it.size ?? null,
    rooms: roomsOf(it.structure),
    floor: fl.floor,
    totalFloors,
    groundLevel: fl.groundLevel,
    lastFloor,
    attic: fl.attic,
    isNewBuild: isNewBuildOf(it, d),
    placeSlug: placeSlugOf(municipality, polygons),
    address: street ? [street, municipality].filter(Boolean).join(', ') : null,
    registered: registeredOf(onsite?.basInfFiled),
    heating: pickHeating(onsite?.heatingOptions, HEATING_DETAIL) ?? pickHeating(it.heatingArray, HEATING_FACET),
    elevator,
    creditEligible: null,
    advertiser: 'agency',
    agencySlug: 'cityexpert',
    imageUrl: imageUrl(it),
    sourceCreatedAt: it.firstPublished ? new Date(it.firstPublished).toISOString() : null,
  };
}
