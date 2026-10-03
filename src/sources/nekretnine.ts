/**
 * nekretnine.rs source (Belgrade, sale).
 *
 * The site runs on the Immobiliare.it platform (Next.js). HTML pages sit behind DataDome
 * and start returning HTTP 403 "Please enable JS" challenges after a handful of plain
 * requests. The JSON endpoint the search page itself calls for pagination,
 * /api-next/search-list/listings/, is served from Varnish without DataDome, so we use it.
 * It returns exactly the same `results` objects the search page embeds in __NEXT_DATA__.
 *
 * Detail pages carry more fields (total floors, precise heating, creation date, condition),
 * but cost one request each and are DataDome-protected, so they are not fetched here;
 * see enrichFromDetail() for an opt-in helper.
 */
import type { Advertiser, GroundLevel, Listing, PropertyType } from '../types.js';
import { slugify, toPlaceSlug } from '../places.js';
import catalog from '../data/places-4zida.json' with { type: 'json' };

const BASE = 'https://www.nekretnine.rs';
const API = `${BASE}/api-next/search-list/listings/`;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const PLACE_CATALOG = new Set<string>(catalog as string[]);

/**
 * Search per property type. `path` is the public SEO list URL (the API requires it);
 * `typologies` are platform idTipologia values, which the API accepts as a list:
 *   4 = stan (apartment, incl. duplex), 31 = potkrovlje (attic apartment),
 *   7 = samostalna kuća (detached house), 13 = kuća u nizu (row house).
 * 11 (vikendica / seosko imanje / seoska kuća: cottages, farms) is deliberately left out.
 */
const SEARCHES: Record<PropertyType, { path: string; typologies: number[] }> = {
  apartment: { path: '/prodaja-stanova/beograd/', typologies: [4, 31] },
  house: { path: '/prodaja-samostalnih-kuca/beograd/', typologies: [7, 13] },
};

/** Belgrade (city id 324) on the platform's geography. */
const GEO = { fkRegione: 'RS_1', idProvincia: 'RS_3', idComune: '324', idNazione: 'RS' };

export interface NekretnineOptions {
  maxPrice: number;
  pages: number;
  types: PropertyType[];
  fetchImpl?: typeof fetch;
}

/** Raw search result (only the fields we use). Labels are in Serbian, ga4* fields in Italian. */
interface RawFloor {
  abbreviation?: string | null;
  value?: string;
}
interface RawPrice {
  visible?: boolean;
  value?: number;
}
interface RawProperty {
  isMain?: boolean;
  url?: string;
  caption?: string;
  price?: RawPrice;
  surface?: string;
  rooms?: string;
  floor?: RawFloor;
  elevator?: boolean;
  typology?: { id?: number; name?: string };
  category?: { id?: number; name?: string };
  ga4Heating?: string;
  ga4Condition?: string;
  matchSearch?: boolean;
  photo?: { urls?: Record<string, string> };
  location?: { address?: string; macrozone?: string; microzone?: string };
}
interface RawResult {
  realEstate: {
    id: number;
    title?: string;
    contract?: string;
    isProjectLike?: boolean;
    price?: RawPrice;
    typology?: { id?: number; name?: string };
    advertiser?: {
      agency?: { id?: number; type?: string; displayName?: string; agencyUrl?: string };
      supervisor?: { type?: string };
    };
    properties: RawProperty[];
  };
  seo?: { url?: string };
}
interface SearchResponse {
  count?: number;
  maxPages?: number;
  results?: RawResult[];
}

export async function fetchNekretnine(opts: NekretnineOptions): Promise<Listing[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const seen = new Map<string, Listing>();
  let first = true;
  for (const type of opts.types) {
    const search = SEARCHES[type];
    for (let page = 1; page <= opts.pages; page++) {
      if (!first) await sleep(1000);
      first = false;
      const params = new URLSearchParams({
        ...GEO,
        idContratto: '1', // sale
        idCategoria: '1', // residential
        prezzoMassimo: String(opts.maxPrice),
        criterio: 'data', // newest first
        ordine: 'desc',
        __lang: 'sr',
        pag: String(page),
        path: search.path,
      });
      search.typologies.forEach((id, i) => params.append(`idTipologia[${i}]`, String(id)));
      const url = `${API}?${params}`;
      const res = await doFetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'Accept-Language': 'sr,en;q=0.8' },
      });
      const body = await res.text();
      if (!res.ok) {
        const reason = body.includes('captcha-delivery') ? ' (DataDome challenge)' : '';
        throw new Error(`nekretnine ${url} -> HTTP ${res.status}${reason}`);
      }
      const data = JSON.parse(body) as SearchResponse;
      const listings = parseSearchResults(data, type);
      for (const l of listings) if (!seen.has(l.sourceId)) seen.set(l.sourceId, l);
      if (!data.results?.length || (data.maxPages !== undefined && page >= data.maxPages)) break;
    }
  }
  return [...seen.values()];
}

/**
 * Converts a search response (API JSON, or the `state.data` of the "real-estate-list"
 * query in a search page's __NEXT_DATA__) to listings. Ads without a visible price are skipped.
 */
export function parseSearchResults(data: SearchResponse, type: PropertyType): Listing[] {
  const out: Listing[] = [];
  for (const r of data.results ?? []) {
    const re = r.realEstate;
    if (!re || (re.contract && re.contract !== 'sale')) continue;
    if (re.isProjectLike) {
      // Developer project: the card lists matching units, each with its own page and price.
      for (const unit of re.properties) {
        if (unit.isMain || !unit.url || unit.matchSearch === false) continue;
        const unitId = unit.url.split('/').filter(Boolean)[2];
        if (!unitId) continue;
        const l = toListing(r, unit, type, `${re.id}-${unitId}`, BASE + unit.url, unit.price);
        if (l) out.push(l);
      }
      continue;
    }
    const prop = re.properties[0];
    if (!prop) continue;
    const url = r.seo?.url ?? `${BASE}/oglasi/${re.id}/`;
    const l = toListing(r, prop, type, String(re.id), url, re.price ?? prop.price);
    if (l) out.push(l);
  }
  return out;
}

function toListing(
  r: RawResult,
  prop: RawProperty,
  type: PropertyType,
  sourceId: string,
  url: string,
  price: RawPrice | undefined,
): Listing | null {
  const re = r.realEstate;
  if (!price?.visible || typeof price.value !== 'number' || price.value <= 0) return null;
  // For project units, location and photo live on the main property.
  const main = re.properties.find((p) => p.isMain) ?? prop;
  const location = prop.location ?? main.location;
  const floor = parseFloor(prop.floor?.value);
  const attic = isAtticTypology(prop.typology?.name ?? re.typology?.name) || floor.attic ? true : null;
  const text = [prop.caption, main.caption, re.title].filter(Boolean).join(' | ');
  const agency = re.advertiser?.agency;
  return {
    source: 'nekretnine',
    sourceId,
    url,
    type,
    title: (re.title || prop.caption || '').trim() || `nekretnine ${sourceId}`,
    price: Math.round(price.value),
    previousPrice: null, // not exposed by the site
    m2: parseNumber(prop.surface),
    rooms: parseNumber(prop.rooms),
    floor: floor.floor,
    totalFloors: null, // detail page only
    groundLevel: floor.groundLevel,
    lastFloor: attic || floor.lastFloor ? true : null,
    attic,
    isNewBuild: isNewBuildOf(re.isProjectLike, prop.ga4Condition ?? main.ga4Condition, prop.category ?? main.category),
    placeSlug: placeSlugOf(location?.macrozone, location?.microzone),
    address: location?.address?.trim() || null,
    registered: registeredFromText(text),
    heating: heatingFromList(prop.ga4Heating),
    elevator: prop.elevator === true || floor.elevator ? true : prop.elevator === false ? false : null,
    creditEligible: creditFromText(text),
    advertiser: advertiserOf(re),
    agencySlug: agency ? slugify(agency.displayName ?? '') || (agency.id ? String(agency.id) : null) : null,
    imageUrl: (prop.photo ?? main.photo)?.urls?.large ?? (prop.photo ?? main.photo)?.urls?.medium ?? null,
    sourceCreatedAt: null, // detail page only
  };
}

/** "45 m²" -> 45, "1.250 m²" -> 1250, "2.5" -> 2.5, "5+" -> 5, "1 - 4" -> 1. */
function parseNumber(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.match(/\d+(?:[.,]\d+)?/);
  if (!m) return null;
  let t = m[0];
  // Thousands separator ("1.250 m²") vs decimal ("2.5" rooms): three digits after the dot = thousands.
  t = /^\d{1,3}[.,]\d{3}$/.test(t) ? t.replace(/[.,]/, '') : t.replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

interface ParsedFloor {
  floor: number | null;
  groundLevel: GroundLevel | null;
  attic: boolean;
  lastFloor: boolean;
  elevator: boolean;
}

/**
 * Floor label -> shared scale. The site writes e.g. "3° sprat, sa liftom", "14, sa liftom",
 * "Visoko prizemlje", "Prizemlje", "Suteren", "Potkrovlje".
 *   visoko prizemlje -> 0 high_ground, prizemlje -> 0 ground, nisko prizemlje -> 0 low_ground,
 *   suteren -> -1 basement, potkrovlje -> attic (and top floor), number -> that floor.
 */
export function parseFloor(value: string | undefined | null): ParsedFloor {
  const res: ParsedFloor = { floor: null, groundLevel: null, attic: false, lastFloor: false, elevator: false };
  if (!value) return res;
  const v = value.toLowerCase();
  res.elevator = /sa liftom|\blift/.test(v);
  if (/suteren/.test(v)) {
    res.floor = -1;
    res.groundLevel = 'basement';
  } else if (/nisko prizemlje/.test(v)) {
    res.floor = 0;
    res.groundLevel = 'low_ground';
  } else if (/visoko prizemlje/.test(v)) {
    res.floor = 0;
    res.groundLevel = 'high_ground';
  } else if (/prizemlje/.test(v)) {
    res.floor = 0;
    res.groundLevel = 'ground';
  } else if (/potkrovlje/.test(v)) {
    res.attic = true;
    res.lastFloor = true;
  } else {
    const m = v.match(/-?\d+/);
    if (m) res.floor = Number(m[0]);
  }
  if (/poslednji/.test(v)) res.lastFloor = true;
  return res;
}

function isAtticTypology(name: string | undefined): boolean {
  return !!name && /potkrovlje/i.test(name);
}

/**
 * Condition comes as an Italian GA4 label (language-independent, unlike the Serbian text):
 * "Nuovo / In costruzione" (novo / u izgradnji) -> new build;
 * "Ottimo / Ristrutturato", "Buono / Abitabile", "Da ristrutturare" -> resale.
 * Developer projects and the "Novogradnje" category (id 27) are new builds too.
 */
function isNewBuildOf(
  projectLike: boolean | undefined,
  ga4Condition: string | undefined,
  category: { id?: number } | undefined,
): boolean | null {
  if (projectLike || category?.id === 27) return true;
  if (!ga4Condition) return null;
  if (/nuovo|costruzione/i.test(ga4Condition)) return true;
  if (/ristruttur|abitabile|buono|ottimo/i.test(ga4Condition)) return false;
  return null;
}

/**
 * The list exposes heating only as a coarse Italian GA4 label:
 *   "Centralizzato" (centralno grejanje; in Belgrade that is city district heating, CG) -> 'district'
 *   "Autonomo" (samostalno grejanje: the flat/house has its own system; closest to
 *              etažno / own boiler, EG) -> 'central'
 *   "Assente" -> null. The site uses it for "not specified" (about half of all ads,
 *              new builds included), so it does not mean 'none'.
 * enrichFromDetail() refines this with the fuel from the detail page.
 */
function heatingFromList(ga4: string | undefined): string | null {
  if (!ga4) return null;
  if (/centralizzat/i.test(ga4)) return 'district';
  if (/autonom/i.test(ga4)) return 'central';
  return null;
}

/**
 * Detail page heating text, e.g. "samostalan", "samostalan, električno napajanje",
 * "centralizovan". Fuel-specific words win over the generic own/central split:
 *   TA / termoakumulaciona -> storageHeater, kaljeva peć -> tileStove, toplotna pumpa -> heatPump,
 *   podno -> underfloor, norveški radijatori -> norwegianRadiators, gas -> gas,
 *   drva / ugalj / pelet / čvrsto gorivo -> solid, struja / električno -> electricity,
 *   klima -> airConditioning, centralizovan / centralno / daljinsko -> district (CG),
 *   etažno / samostalan -> central (own boiler, EG), bez grejanja / nema -> none.
 */
export function heatingFromText(text: string | undefined | null): string | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/\bta\b|termoakumul/.test(t)) return 'storageHeater';
  if (/kaljev/.test(t)) return 'tileStove';
  if (/toplotn\w* pump/.test(t)) return 'heatPump';
  if (/podn\w* grej|podno/.test(t)) return 'underfloor';
  if (/norve/.test(t)) return 'norwegianRadiators';
  if (/\bgas/.test(t)) return 'gas';
  if (/drv|ugalj|ugljem|pelet|čvrst|cvrst/.test(t)) return 'solid';
  if (/struj|električ|elektric/.test(t)) return 'electricity';
  if (/klima/.test(t)) return 'airConditioning';
  if (/centraliz|centraln|daljinsk|\bcg\b/.test(t)) return 'district';
  if (/etažn|etazn|samostal|autonom|\beg\b/.test(t)) return 'central';
  if (/bez grejanja|nema grejanja|\bnema\b/.test(t)) return 'none';
  return null;
}

/**
 * "uknjižen" -> true; "neuknjižen" / "nije uknjižen" / "bez uknjižbe" -> false;
 * registration in progress ("u procesu uknjižbe", "uknjižba u toku", "zahtev za uknjižbu
 * je predat i u postupku") -> null; else null.
 */
export function registeredFromText(text: string): boolean | null {
  const t = text.toLowerCase();
  if (/neuknji|nije uknji|bez uknji/.test(t)) return false;
  if (/zahtev za uknji|(u toku|u postupku|u procesu)[^.]{0,30}uknji|uknji[^.]{0,40}(u toku|u postupku|u procesu)/.test(t)) {
    return null;
  }
  return /uknji/.test(t) ? true : null;
}

/** Explicit mortgage mentions only ("moguć kredit", "pogodan za kredit", "useljiv, kredit"...). */
function creditFromText(text: string): boolean | null {
  const t = text.toLowerCase();
  if (/(nije|ne)\s+(moguć|moguc|za)\s*(na\s+)?kredit/.test(t)) return false;
  if (/(moguć|moguc|pogodan|pogodno|prolazi|odobren)\w*\s+(za\s+|na\s+)?kredit|kredit\w*\s+(moguć|moguc)|\bza kredit\b|\bna kredit\b/.test(t)) {
    return true;
  }
  return null;
}

/**
 * Agencies come as advertiser.agency (type "agency"); private sellers have no agency and a
 * supervisor of type "user" ("privatno lice"). Developer projects (isProjectLike) and
 * agencies typed as builders count as developers.
 */
function advertiserOf(re: RawResult['realEstate']): Advertiser {
  const agency = re.advertiser?.agency;
  if (re.isProjectLike) return 'developer';
  if (agency) {
    if (agency.type && /constr|costrutt|build|develop|invest/i.test(agency.type)) return 'developer';
    return 'agency';
  }
  if (re.advertiser?.supervisor?.type === 'user') return 'owner';
  return 'unknown';
}

/**
 * Site location: macrozone = municipality ("Zvezdara"), microzone = a neighborhood group
 * joined with " - " ("Mirijevo - Novo Mirijevo", "Krnjača - Kotež - Ovča", "Surčin Centar").
 * Tries the whole microzone, then each part, then "<X> Centar" as "centar"; the first one that
 * hits the 4zida catalog wins. Otherwise the first part is used (still filterable by substring).
 */
export function placeSlugOf(macrozone: string | undefined, microzone: string | undefined): string {
  const municipality = macrozone?.trim() || null;
  const micro = microzone?.trim();
  if (!micro) return toPlaceSlug({ municipality });
  const parts = micro.split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  const candidates = [micro, ...parts];
  for (const p of parts) {
    const centar = p.match(/^(.*)\s+centar$/i);
    if (centar) candidates.push('Centar', centar[1]!);
  }
  for (const c of candidates) {
    const slug = toPlaceSlug({ neighborhood: c, municipality });
    if (PLACE_CATALOG.has(slug)) return slug;
  }
  const head = parts[0]!;
  // "Surčin Centar", "Palilula Centar": the municipality itself is the best we have.
  if (/\bcentar$/i.test(head)) return toPlaceSlug({ municipality: municipality ?? head.replace(/\s+centar$/i, '') });
  return toPlaceSlug({ neighborhood: head, municipality });
}

/** Detail page payload (pageProps.detailData.realEstate), only the fields we use. */
interface RawDetail {
  createdAt?: number;
  properties?: Array<{
    floor?: RawFloor;
    floors?: string;
    elevator?: boolean;
    condition?: string;
    ga4Condition?: string;
    energy?: { heatingType?: string };
    defaultDescription?: string;
    caption?: string;
  }>;
}

/**
 * Optional enrichment from an ad page (one extra request per listing, DataDome-protected).
 * Accepts the ad page HTML (https://www.nekretnine.rs/oglasi/<id>/) or the Next.js data JSON
 * (/_next/data/<buildId>/oglasi/<id>.json). Fills: totalFloors, lastFloor, floor (if missing),
 * elevator, heating (with fuel), isNewBuild, registered, creditEligible, sourceCreatedAt.
 */
export function enrichFromDetail(listing: Listing, htmlOrJson: string): Listing {
  const re = extractDetail(htmlOrJson);
  if (!re) return listing;
  const p = re.properties?.[0];
  if (!p) return listing;
  const out: Listing = { ...listing };
  const floor = parseFloor(p.floor?.value);
  if (out.floor === null && floor.floor !== null) {
    out.floor = floor.floor;
    out.groundLevel = floor.groundLevel;
  }
  if (floor.attic) out.attic = true;
  const total = p.floors ? parseNumber(p.floors) : null;
  if (total !== null && listing.type === 'apartment') out.totalFloors = total;
  if (out.attic) out.lastFloor = true;
  else if (out.floor !== null && out.totalFloors !== null && out.floor > 0) out.lastFloor = out.floor >= out.totalFloors;
  if (typeof p.elevator === 'boolean') out.elevator = p.elevator;
  else if (floor.elevator) out.elevator = true;
  out.heating = heatingFromText(p.energy?.heatingType) ?? out.heating;
  if (out.isNewBuild === null && p.ga4Condition) out.isNewBuild = isNewBuildOf(false, p.ga4Condition, undefined);
  const text = [p.caption, p.defaultDescription].filter(Boolean).join(' | ');
  out.registered = out.registered ?? registeredFromText(text);
  out.creditEligible = out.creditEligible ?? creditFromText(text);
  if (re.createdAt) out.sourceCreatedAt = new Date(re.createdAt * 1000).toISOString();
  return out;
}

function extractDetail(htmlOrJson: string): RawDetail | null {
  let json: unknown;
  const trimmed = htmlOrJson.trimStart();
  try {
    if (trimmed.startsWith('{')) {
      json = JSON.parse(trimmed);
    } else {
      const m = htmlOrJson.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) return null;
      json = (JSON.parse(m[1]!) as { props?: unknown }).props;
    }
  } catch {
    return null;
  }
  const pageProps = (json as { pageProps?: { detailData?: { realEstate?: RawDetail } } })?.pageProps;
  return pageProps?.detailData?.realEstate ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
