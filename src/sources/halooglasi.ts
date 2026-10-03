/**
 * halooglasi.com source (Belgrade, sale of apartments and houses).
 *
 * Access: the site sits behind Cloudflare, which rejects clients by TLS fingerprint.
 * Node's built-in fetch (undici / OpenSSL) always gets HTTP 403 "Just a moment...",
 * even with full browser headers or cookies taken from a real browser session.
 * Clients with a Chrome-like TLS fingerprint pass without any challenge or cookie:
 * curl-impersonate, curl_cffi, a real (non "headless shell") Chromium.
 * So fetchHaloOglasi() needs a `fetchImpl` backed by such a client; this module ships
 * one built on the curl-impersonate binary (createCurlImpersonateFetch), no npm deps.
 *
 * Data:
 * - Search pages embed `QuidditaEnvironment.serverListData = {...}` with 20 ads per page.
 *   Each ad has Id, RelativeUrl, Title and a pre-rendered `ListHTML` card holding price,
 *   area, rooms, floor ("VI/7"), places, advertiser type, publish date and a thumbnail.
 * - Ad pages embed `QuidditaEnvironment.CurrentClassified = {...}` with all attributes
 *   (heating, building type, registration, elevator, exact publish time...). They are
 *   fetched only when asked for (see HaloOglasiOptions.details), one request per ad.
 */
import { execFile } from 'node:child_process';
import type { Advertiser, GroundLevel, Listing, PropertyType } from '../types.js';
import { slugify, toPlaceSlug } from '../places.js';

const BASE = 'https://www.halooglasi.com';
const IMAGE_BASE = 'https://img.halooglasi.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
/** Pause between consecutive requests to the site. */
const REQUEST_GAP_MS = 1500;

const SEARCH_PATH: Record<PropertyType, string> = {
  apartment: '/nekretnine/prodaja-stanova/beograd',
  house: '/nekretnine/prodaja-kuca/beograd',
};

export interface HaloOglasiOptions {
  maxPrice: number;
  pages: number;
  types: PropertyType[];
  /**
   * Must pass Cloudflare's TLS fingerprint check, e.g. createCurlImpersonateFetch(...).
   * Defaults to the global fetch, which is blocked (the call then throws a clear error).
   */
  fetchImpl?: typeof fetch;
  /**
   * Enrich listings from their ad pages (heating, registered, elevator, new build...).
   * true = every listing, a function = only listings it accepts (e.g. ones not in the DB yet).
   * Each enriched listing costs one extra request. Default: no enrichment.
   */
  details?: boolean | ((l: Listing) => boolean);
  /** Upper bound on ad-page requests per call. Default 40. */
  maxDetails?: number;
}

export async function fetchHaloOglasi(opts: HaloOglasiOptions): Promise<Listing[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const seen = new Map<string, Listing>();
  let first = true;
  const get = async (url: string): Promise<string> => {
    if (!first) await sleep(REQUEST_GAP_MS);
    first = false;
    const res = await doFetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'sr-RS,sr;q=0.9,en;q=0.8',
      },
    });
    const body = await res.text();
    if (isCloudflareBlock(res.status, body)) {
      throw new Error(
        `halooglasi: blocked by Cloudflare (HTTP ${res.status}) at ${url}. ` +
          'Node fetch is rejected by TLS fingerprint; pass fetchImpl: createCurlImpersonateFetch(...) ' +
          'or a browser-backed fetch, see the source report',
      );
    }
    if (!res.ok) throw new Error(`halooglasi ${url} -> HTTP ${res.status}`);
    return body;
  };

  for (const type of opts.types) {
    for (let page = 1; page <= opts.pages; page++) {
      // Default order on the site is "Prvo najnoviji" (newest first); cena_d_unit=4 is EUR.
      const url = `${BASE}${SEARCH_PATH[type]}?cena_d_to=${opts.maxPrice}&cena_d_unit=4${page > 1 ? `&page=${page}` : ''}`;
      const html = await get(url);
      const { listings, totalPages } = parseSearchPage(html);
      for (const l of listings) {
        if (l.type === type && l.price <= opts.maxPrice && !seen.has(l.sourceId)) seen.set(l.sourceId, l);
      }
      if (listings.length === 0 || (totalPages !== null && page >= totalPages)) break;
    }
  }

  if (opts.details) {
    const want = typeof opts.details === 'function' ? opts.details : () => true;
    let budget = opts.maxDetails ?? 40;
    for (const [id, l] of seen) {
      if (budget <= 0) break;
      if (!want(l)) continue;
      budget--;
      try {
        const detail = parseAdPage(await get(l.url));
        if (detail) seen.set(id, mergeDetails(l, detail));
      } catch (e) {
        if (e instanceof Error && e.message.includes('Cloudflare')) throw e;
        // a removed or broken ad page keeps the search-card data
      }
    }
  }
  return [...seen.values()].filter((l) => l.price <= opts.maxPrice);
}

function isCloudflareBlock(status: number, body: string): boolean {
  return (status === 403 || status === 503) && /<title>(Just a moment|Sačekajte|Attention Required)/i.test(body);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// curl-impersonate adapter
// ---------------------------------------------------------------------------

export interface CurlImpersonateOptions {
  /** Path to the `curl-impersonate` binary (github.com/lexiforest/curl-impersonate releases). */
  binary: string;
  /** Browser profile; null when `binary` is a wrapper script like curl_chrome146. Default 'chrome146'. */
  impersonate?: string | null;
  timeoutMs?: number;
}

const STATUS_MARK = '\n__HALO_STATUS__:';

/**
 * A minimal fetch replacement (GET, headers) that runs curl-impersonate.
 * Its Chrome TLS/HTTP2 fingerprint passes halooglasi's Cloudflare without a challenge.
 * The impersonation profile sets browser headers itself, so only Accept-Language
 * and Referer are forwarded (overriding User-Agent would break the fingerprint match).
 */
export function createCurlImpersonateFetch(o: CurlImpersonateOptions): typeof fetch {
  const impersonate = o.impersonate === undefined ? 'chrome146' : o.impersonate;
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const args = ['-s', '-L', '--max-redirs', '5', '--compressed'];
    if (impersonate) args.push('--impersonate', impersonate);
    for (const name of ['accept-language', 'referer']) {
      const v = headers.get(name);
      if (v) args.push('-H', `${name}: ${v}`);
    }
    args.push('-w', `${STATUS_MARK}%{http_code}`, url);
    const out = await new Promise<string>((resolve, reject) => {
      execFile(o.binary, args, { maxBuffer: 32 * 1024 * 1024, timeout: o.timeoutMs ?? 60_000 }, (err, stdout) =>
        err ? reject(new Error(`curl-impersonate failed for ${url}: ${err.message}`)) : resolve(stdout),
      );
    });
    const at = out.lastIndexOf(STATUS_MARK);
    const status = at >= 0 ? Number(out.slice(at + STATUS_MARK.length)) : 0;
    const body = at >= 0 ? out.slice(0, at) : out;
    if (!status) throw new Error(`curl-impersonate: no HTTP status for ${url}`);
    return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  return impl as typeof fetch;
}

// ---------------------------------------------------------------------------
// Parsing (pure)
// ---------------------------------------------------------------------------

interface RawSearchAd {
  Id: string;
  RelativeUrl?: string;
  Title?: string;
  AdvertiserId?: string;
  ListHTML?: string;
}

interface RawServerListData {
  PageNumber?: number;
  TotalPages?: number;
  Ads?: RawSearchAd[];
}

/** Reads the JSON value assigned to `QuidditaEnvironment.<name>` in a page. */
function extractAssigned(html: string, name: string): unknown {
  const re = new RegExp(`QuidditaEnvironment\\.${name}\\s*=\\s*`);
  const m = re.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = jsonEnd(html, start);
  if (end < 0) return null;
  try {
    return JSON.parse(html.slice(start, end));
  } catch {
    return null;
  }
}

/** Finds the end of a JSON object/array starting at `start` (string-aware bracket matching). */
function jsonEnd(s: string, start: number): number {
  const open = s[start];
  if (open !== '{' && open !== '[') return -1;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code === 160 ? ' ' : String.fromCodePoint(code);
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** "219.000" / "59,07" / "2.5" -> number. Dots are thousand separators only when followed by 3 digits. */
function parseNumber(s: string | null | undefined): number | null {
  if (!s) return null;
  let t = s.replace(/\s/g, '');
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(',', '.');
  const m = /^-?\d+(\.\d+)?/.exec(t);
  return m ? Number(m[0]) : null;
}

/** Serbian room counts: "1.5" (jednoiposoban), "2.0", "5+" (-> 5), "0.5" (garsonjera). */
function parseRooms(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = parseNumber(s.replace('+', ''));
  return n !== null && n > 0 && n < 50 ? n : null;
}

const ROMAN: Record<string, number> = { I: 1, V: 5, X: 10, L: 50 };

function romanToInt(s: string): number | null {
  if (!/^[IVXL]+$/.test(s)) return null;
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const v = ROMAN[s[i]!]!;
    const next = ROMAN[s[i + 1] ?? ''] ?? 0;
    total += v < next ? -v : v;
  }
  return total;
}

interface FloorInfo {
  floor: number | null;
  groundLevel: GroundLevel | null;
  attic: boolean | null;
}

/**
 * Floor codes used by halooglasi (filter list: SUT PSUT NPR PR VPR 1..30, plus attic codes):
 *   SUT  suteren          -> -1, basement
 *   PSUT polusuteren      -> -1, basement (half below ground, treated as basement)
 *   NPR  nisko prizemlje  ->  0, low_ground
 *   PR   prizemlje        ->  0, ground
 *   VPR  visoko prizemlje ->  0, high_ground
 *   PK / PTK potkrovlje   -> attic (floor stays unknown unless given elsewhere)
 *   "6" or Roman "VI"     ->  6
 */
export function parseFloorCode(code: string | null | undefined): FloorInfo {
  const none: FloorInfo = { floor: null, groundLevel: null, attic: null };
  if (!code) return none;
  const c = code.trim().toUpperCase().replace(/\.$/, '');
  switch (c) {
    case 'SUT':
    case 'PSUT':
      return { floor: -1, groundLevel: 'basement', attic: false };
    case 'NPR':
      return { floor: 0, groundLevel: 'low_ground', attic: false };
    case 'PR':
      return { floor: 0, groundLevel: 'ground', attic: false };
    case 'VPR':
      return { floor: 0, groundLevel: 'high_ground', attic: false };
    case 'PK':
    case 'PTK':
    case 'POTKROVLJE':
      return { floor: null, groundLevel: null, attic: true };
  }
  if (/^\d+\+?$/.test(c)) return { floor: Number(c.replace('+', '')), groundLevel: null, attic: null };
  const r = romanToInt(c);
  return r !== null ? { floor: r, groundLevel: null, attic: null } : none;
}

/**
 * Heating ("grejanje") -> shared heating codes:
 *   CG (centralno grejanje, city district heating) -> district
 *   EG (etažno grejanje, own boiler for the flat/building) -> central
 *   TA (termoakumulacione peći) -> storageHeater
 *   Gas -> gas
 *   Podno (underfloor) -> underfloor
 *   Kaljeva peć (tile stove) -> tileStove
 *   Toplotne pumpe -> heatPump
 *   Norveški radijatori -> norwegianRadiators
 *   Mermerni radijatori (electric marble panels), struja / električno -> electricity
 *   Klima (air conditioning) -> airConditioning
 *   čvrsto gorivo / drva / ugalj / peć na drva -> solid
 *   nema / bez grejanja -> none
 * Unknown values -> null.
 */
export function mapHeating(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = slugify(raw);
  if (s === 'cg' || s.startsWith('central')) return 'district';
  if (s === 'eg' || s.startsWith('etaz')) return 'central';
  if (s === 'ta' || s.startsWith('termoakum')) return 'storageHeater';
  if (s.includes('gas')) return 'gas';
  if (s.startsWith('podno')) return 'underfloor';
  if (s.includes('kaljev')) return 'tileStove';
  if (s.includes('toplotn') || s.includes('pump')) return 'heatPump';
  if (s.includes('norvesk')) return 'norwegianRadiators';
  if (s.includes('mermer') || s.includes('struj') || s.includes('elektri')) return 'electricity';
  if (s.includes('klima') || s.includes('inverter')) return 'airConditioning';
  if (s.includes('cvrst') || s.includes('drva') || s.includes('ugalj') || s.includes('pec')) return 'solid';
  if (s.startsWith('nema') || s.startsWith('bez')) return 'none';
  return null;
}

function advertiserOf(raw: string | null | undefined): Advertiser {
  const s = raw ? slugify(raw) : '';
  if (s.startsWith('agencij')) return 'agency';
  if (s.startsWith('vlasnik')) return 'owner';
  if (s.startsWith('investitor')) return 'developer';
  return 'unknown';
}

/** "/slike/.../Thumbs/260815/m/x.jpg" (or absolute with "//slike") -> absolute large JPEG. */
function imageUrlOf(src: string | null | undefined): string | null {
  if (!src) return null;
  const path = src.replace(/^https?:\/\/[^/]+/, '').replace(/^\/+/, '/');
  if (!path.startsWith('/slike/')) return null;
  // m/s thumbnails are small; "l" is the large rendition used on the ad page
  return IMAGE_BASE + path.replace(/\/Thumbs\/(\d+)\/[sm]\//, '/Thumbs/$1/l/');
}

/**
 * Absolute ad URL without the instance query (?kid=4 = promoted copy). The bare URL
 * redirects to the ad's basic instance (?kid=1), so it keeps working after a promotion ends.
 */
function adUrlOf(relative: string): string {
  return BASE + relative.split('?')[0];
}

function typeFromUrl(relative: string): PropertyType | null {
  if (relative.includes('/prodaja-stanova/')) return 'apartment';
  if (relative.includes('/prodaja-kuca/')) return 'house';
  return null;
}

/** Offset of Europe/Belgrade at a given instant, e.g. "+02:00". */
function belgradeOffset(at: Date): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Belgrade', timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = /GMT([+-]\d{2}:\d{2})/.exec(part ?? '');
  return m ? m[1]! : '+01:00';
}

/**
 * "03.10.2026." (card publish date, local day) -> ISO instant of local midnight.
 * For promoted re-publications this is the re-publication day, not the original one;
 * parseAdPage() gives the original time.
 */
function dayToIso(s: string | null | undefined): string | null {
  const m = s ? /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s) : null;
  if (!m) return null;
  const ymd = `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  const d = new Date(`${ymd}T00:00:00${belgradeOffset(new Date(`${ymd}T12:00:00Z`))}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isNewBuildFromText(text: string): boolean | null {
  const s = slugify(text);
  if (/(^|-)novogradnj|(^|-)u-izgradnji(-|$)|(^|-)nova-gradnja(-|$)/.test(s)) return true;
  return null;
}

function lastFloorOf(floor: number | null, total: number | null, attic: boolean | null): boolean | null {
  if (attic) return true;
  if (floor !== null && total !== null && floor > 0 && total > 0) return floor >= total;
  if (floor !== null && floor <= 0 && total !== null && total > 0) return false;
  return null;
}

/** Parses one search card (`ListHTML`) into a Listing. Returns null when unusable (no numeric price...). */
function cardToListing(ad: RawSearchAd): Listing | null {
  if (!ad.Id || !ad.RelativeUrl || !ad.ListHTML) return null;
  const type = typeFromUrl(ad.RelativeUrl);
  if (!type) return null;
  // ListHTML is HTML-escaped once inside the JSON string
  const h = decodeEntities(ad.ListHTML);

  const priceRaw = /class="central-feature"[\s\S]*?data-value="([^"]*)"/.exec(h)?.[1];
  const price = parseNumber(priceRaw);
  // "po dogovoru" / missing price cards are skipped; EUR is the only currency shown on the card
  if (price === null || price < 1000) return null;

  const features = new Map<string, string>();
  for (const m of h.matchAll(/<div class='value-wrapper'>([\s\S]*?)<span class='legend'>([\s\S]*?)<\/span>/g)) {
    features.set(stripTags(m[2]!), stripTags(m[1]!));
  }
  const m2 = parseNumber(features.get('Kvadratura'));
  const rooms = parseRooms(features.get('Broj soba'));

  let floor: FloorInfo = { floor: null, groundLevel: null, attic: null };
  let totalFloors: number | null = null;
  const spratnost = features.get('Spratnost'); // "VI/7", "PR/3", "VPR", "SUT/4"
  if (type === 'apartment' && spratnost) {
    const [f, t] = spratnost.split('/');
    floor = parseFloorCode(f);
    totalFloors = parseNumber(t ?? null);
    if (floor.attic === null && floor.floor !== null && totalFloors !== null && floor.floor < totalFloors) floor.attic = false;
  }

  const placesHtml = /<ul class="subtitle-places">([\s\S]*?)<\/ul>/.exec(h)?.[1] ?? '';
  const places = [...placesHtml.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => stripTags(m[1]!));
  // [city, municipality ("Opština X"), microlocation, street]
  const [, municipality, neighborhood, street] = places;

  const advertiserRaw = /data-field-name='oglasivac_nekretnine_s' data-field-value='([^']*)'/.exec(h)?.[1];
  const advertiser = advertiserOf(advertiserRaw);
  const img = /<figure class="pi-img-wrapper">[\s\S]*?<img src='([^']+)'/.exec(h)?.[1];
  const publishDate = /<span class="publish-date">([^<]*)<\/span>/.exec(h)?.[1];
  const title = decodeEntities(ad.Title ?? '').trim() || street || neighborhood || 'halooglasi';
  const description = stripTags(/<p class="[^"]*short-desc">([\s\S]*?)<\/p>/.exec(h)?.[1] ?? '');

  return {
    source: 'halooglasi',
    sourceId: ad.Id,
    url: adUrlOf(ad.RelativeUrl),
    type,
    title,
    price: Math.round(price),
    previousPrice: null,
    m2,
    rooms,
    floor: floor.floor,
    totalFloors,
    groundLevel: floor.groundLevel,
    lastFloor: type === 'apartment' ? lastFloorOf(floor.floor, totalFloors, floor.attic) : null,
    attic: type === 'apartment' ? floor.attic : null,
    isNewBuild: advertiser === 'developer' ? true : isNewBuildFromText(`${title} ${description}`),
    placeSlug: toPlaceSlug({ neighborhood, municipality }),
    address: joinAddress(street, neighborhood),
    registered: null,
    heating: null,
    elevator: null,
    creditEligible: null,
    advertiser,
    agencySlug: null,
    imageUrl: imageUrlOf(img),
    sourceCreatedAt: dayToIso(publishDate),
  };
}

/** Parses a search results page (HTML with serverListData, or that JSON object/string itself). */
export function parseSearchPage(htmlOrJson: string | object): { listings: Listing[]; totalPages: number | null } {
  let data: RawServerListData | null;
  if (typeof htmlOrJson === 'object') data = htmlOrJson as RawServerListData;
  else if (/^\s*\{/.test(htmlOrJson)) data = JSON.parse(htmlOrJson) as RawServerListData;
  else data = extractAssigned(htmlOrJson, 'serverListData') as RawServerListData | null;
  const listings: Listing[] = [];
  for (const ad of data?.Ads ?? []) {
    const l = cardToListing(ad);
    if (l) listings.push(l);
  }
  return { listings, totalPages: typeof data?.TotalPages === 'number' ? data.TotalPages : null };
}

/** Listings from a search results page. */
export function parseSearchResults(htmlOrJson: string | object): Listing[] {
  return parseSearchPage(htmlOrJson).listings;
}

interface RawClassified {
  Id: string;
  Title?: string;
  RelativeUrl?: string;
  ValidFrom?: string;
  ImageURLs?: string[];
  CategoryNames?: string[];
  OtherFields?: Record<string, unknown>;
}

interface RawContactData {
  Advertiser?: { DisplayName?: string; IsInvestor?: boolean };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : parseNumber(str(v));
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Parses an ad page (QuidditaEnvironment.CurrentClassified + CurrentContactData) into a full Listing.
 * Returns null for non-sale, non-EUR or price-less ads.
 */
export function parseAdPage(html: string): Listing | null {
  const ad = extractAssigned(html, 'CurrentClassified') as RawClassified | null;
  if (!ad?.Id || !ad.OtherFields) return null;
  const f = ad.OtherFields;
  const contact = extractAssigned(html, 'CurrentContactData') as RawContactData | null;

  const relative = ad.RelativeUrl ?? '';
  const kind = slugify(str(f.tip_nekretnine_s) ?? '');
  const type: PropertyType | null =
    typeFromUrl(relative) ?? (kind === 'stan' ? 'apartment' : kind.startsWith('kuc') ? 'house' : null);
  if (!type || !relative) return null;

  const currency = str(f.cena_d_unit_s);
  const price = num(f.defaultunit_cena_d) ?? (currency === 'EUR' ? num(f.cena_d) : null);
  if (price === null || price < 1000) return null;

  const extras = strList(f.dodatno_ss).map(slugify); // "Uknjižen", "Nije poslednji sprat", "Potkrovlje"...
  const other = strList(f.ostalo_ss).map(slugify); // "Lift", "Terasa", "Klima"...

  let floor: FloorInfo = { floor: null, groundLevel: null, attic: null };
  let totalFloors: number | null = null;
  let lastFloor: boolean | null = null;
  if (type === 'apartment') {
    floor = parseFloorCode(str(f.sprat_s));
    totalFloors = num(f.sprat_od_s);
    if (extras.includes('potkrovlje')) floor.attic = true;
    const notLast = extras.includes('nije-poslednji-sprat');
    if (floor.attic === null && (notLast || (floor.floor !== null && totalFloors !== null && floor.floor < totalFloors))) {
      floor.attic = false;
    }
    lastFloor = floor.attic ? true : notLast ? false : lastFloorOf(floor.floor, totalFloors, floor.attic);
  }

  const advertiser = contact?.Advertiser?.IsInvestor ? 'developer' : advertiserOf(str(f.oglasivac_nekretnine_s));
  const buildingType = slugify(str(f.tip_objekta_s) ?? ''); // "Stara gradnja" | "Novogradnja" | "U izgradnji"
  const condition = slugify(str(f.stanje_objekta_s) ?? ''); // "Izvorno stanje" | "Renovirano" | "Lux" | "Za renoviranje" | "Za rušenje"
  let isNewBuild: boolean | null = null;
  if (buildingType.startsWith('novogradnj') || buildingType.includes('izgradnj') || advertiser === 'developer') isNewBuild = true;
  else if (buildingType.startsWith('stara')) isNewBuild = false;
  else if (['izvorno-stanje', 'renovirano', 'za-renoviranje', 'za-rusenje'].includes(condition)) isNewBuild = false;
  else isNewBuild = isNewBuildFromText(ad.Title ?? '');

  const neighborhood = str(f.mikrolokacija_s);
  const municipality = str(f.lokacija_s);
  const street = str(f.ulica_t);
  const agencyName = advertiser === 'agency' || advertiser === 'developer' ? contact?.Advertiser?.DisplayName : undefined;

  return {
    source: 'halooglasi',
    sourceId: ad.Id,
    url: adUrlOf(relative),
    type,
    title: decodeEntities(ad.Title ?? '').trim() || street || neighborhood || 'halooglasi',
    price: Math.round(price),
    previousPrice: null,
    m2: num(f.defaultunit_kvadratura_d) ?? num(f.kvadratura_d),
    rooms: parseRooms(str(f.broj_soba_s)),
    floor: floor.floor,
    totalFloors,
    groundLevel: floor.groundLevel,
    lastFloor,
    attic: type === 'apartment' ? floor.attic : null,
    isNewBuild,
    placeSlug: toPlaceSlug({ neighborhood, municipality }),
    address: joinAddress(street, neighborhood),
    // The site only has a positive "Uknjižen" flag; its absence does not mean "not registered".
    registered: extras.includes('uknjizen') ? true : null,
    heating: mapHeating(str(f.grejanje_s)),
    // Only a positive "Lift" flag exists; absence is not proof of no elevator.
    elevator: other.includes('lift') ? true : null,
    creditEligible: null,
    advertiser,
    agencySlug: agencyName ? slugify(agencyName) || null : null,
    imageUrl: imageUrlOf(ad.ImageURLs?.[0]),
    sourceCreatedAt: firstPublishedAt(ad, extractAssigned(html, 'CurrentClassifiedInstances')),
  };
}

/**
 * An ad can have several instances (?kid=1 basic, ?kid=4 promoted re-publication...),
 * each with its own ValidFrom. The earliest one is the original publication time.
 */
function firstPublishedAt(ad: RawClassified, instances: unknown): string | null {
  const dates = [ad.ValidFrom];
  if (Array.isArray(instances)) {
    for (const i of instances) dates.push((i as { ValidFrom?: string } | null)?.ValidFrom);
  }
  const times = dates.map((d) => (d ? Date.parse(d) : NaN)).filter((t) => !Number.isNaN(t));
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

/** Search-card listing enriched with ad-page fields; the ad page wins where it knows more. */
export function mergeDetails(card: Listing, detail: Listing): Listing {
  const out: Listing = { ...card };
  for (const key of Object.keys(detail) as (keyof Listing)[]) {
    const v = detail[key];
    if (v === null || v === undefined) continue;
    if (key === 'advertiser' && v === 'unknown') continue;
    if (key === 'url' || key === 'sourceId' || key === 'source') continue;
    (out as unknown as Record<string, unknown>)[key] = v;
  }
  return out;
}

function joinAddress(street: string | null | undefined, neighborhood: string | null | undefined): string | null {
  const parts = [street, neighborhood].filter((p): p is string => !!p);
  return [...new Set(parts)].join(', ') || null;
}
