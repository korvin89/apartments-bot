# Sources

How each site is scraped, what breaks, and how to tell. Every source module lives in `src/sources/`, returns the shared `Listing` shape (`src/types.ts`) and is registered in `src/sources/index.ts`. Captured responses for tests are in `test/fixtures/<site>/`.

Common rules for all sources:

- **Unknown is `null`.** Never guess a field. Filters let `null` through.
- **Place names go through `toPlaceSlug()`** (`src/places.ts`), which maps a site's neighborhood and municipality to 4zida-style slugs. Place filters and duplicate detection depend on it.
- **Floors use the shared scale:** positive numbers are floors. Ground-level variants are `floor: 0` plus `groundLevel` (`high_ground` = visoko prizemlje, `ground` = prizemlje, `low_ground` = nisko prizemlje). Suteren is `floor: -1`, `groundLevel: 'basement'`. Potkrovlje sets `attic: true` and `lastFloor: true`.
- **Heating codes:** CG / centralno = city heating → `district`. EG / etažno = own boiler → `central`. TA → `storageHeater`. The full set of values is in `HEATING_LABEL` in `src/format.ts`.
- **Be polite:** sequential requests, about one second apart.
- **Ad pages are fetched only for new listings that pass the filters on search-level data**, and never during a source's first poll (its listings go into an overview). Sources get this through `SourceContext` from the poll.

## 4zida.rs

- **Access:** plain `fetch`. Search URL `https://www.4zida.rs/<path>?jeftinije_od=<maxPrice>&sortiranje=najnoviji&strana=<n>`, paths `prodaja-stanova/beograd` and `prodaja-kuca/beograd`.
- **Data:** a Next.js page. Ads are inside the React Flight payload in `self.__next_f.push([1,"..."])` chunks. Ads arrive as text rows `id:T<hex byte length>,{json}`, so the payload must be read sequentially by byte length, not split on newlines (`flightRows()`).
- **Ad types:** `apartment`, `house`, plus promoted new builds `newApartment` / `newHouse`.
- **New-build trap:** new-build ads carry both `urlPath` and `url`. `urlPath` renders a 404 page with HTTP 200. Always prefer `url` (`/novogradnja/...`). New builds also use `searchNgImageContext` for the photo.
- **Floor codes:** `0` visoko prizemlje, `-1` prizemlje, `-2` nisko prizemlje, lower is suteren (`normalizeFloor()`, `groundLevelOf()`).
- **registered:** `yes` / `no` / `in_progress`. `in_progress` means unknown, not "no".
- **advertiserType:** 1 agency, 3 developer, 4 owner.
- **Fill rates (120 listings):** registered 85%, top floor 48%, elevator 23%, mortgage 14%.
- **Not covered:** the full new-build catalog at `/novogradnja`. Only new builds promoted into regular results are seen.

## nekretnine.rs

- **Access:** HTML pages are behind **DataDome** (a captcha after about 20 requests per IP, even with browser headers). Don't scrape HTML.
- **Data:** the JSON endpoint behind their own search, `https://www.nekretnine.rs/api-next/search-list/listings/`, is served from a cache without DataDome. The `path` parameter is required (without it: HTTP 500).
- **Typology ids:** apartments 4 (incl. duplex) and 31 (attic apartment), houses 7 (detached) and 13 (row house). Cottages and farms (11) are left out.
- **Developer projects:** each unit with a price becomes its own listing, id `<projectId>-<unitId>`. Units with "price on request" are skipped.
- **Heating in search results is coarse:** "Centralizzato" → `district`, "Autonomo" → `central`, "Assente" → `null`. Assente appears on half of all ads, new builds included, so it means "not specified".
- **Location:** municipality plus a neighborhood group like "Mirijevo - Novo Mirijevo". Each part is tried against the catalog. Some houses hide the location and fall back to `beograd` (`UNKNOWN_PLACE`), which passes the place filters like any unknown value.
- **Detail data:** `enrichFromDetail()` exists but is not called. Ad pages are behind DataDome. `/_next/data/<buildId>/oglasi/<id>.json` works but `buildId` changes with every deploy.
- **Fill rates (100 listings):** heating 53%, floor 45%, new build 40%, elevator 20%, registered 12%. No previous price, total floors or creation date.
- **Failure mode:** if they move the endpoint behind DataDome, requests return 403 with a DataDome body. The only fallback would be a real browser.

## halooglasi.com

- **Access:** behind **Cloudflare**, which decides on the TLS fingerprint alone. Node's fetch, plain curl and headless-shell Chromium all get 403. No `cf_clearance` cookie is issued, so there is nothing to reuse.
- **What passes:** [curl-impersonate](https://github.com/lexiforest/curl-impersonate) with `--impersonate chrome146`. Install with `scripts/install-curl-impersonate.sh` (pinned version and checksums). Path in `CURL_IMPERSONATE`, default `./bin/curl-impersonate`. Without the binary the source is skipped with a log line.
- **Fallback if Cloudflare starts rejecting the profile:** upgrade curl-impersonate and use a newer profile, or a full (not headless-shell) Playwright Chromium.
- **Search:** `/nekretnine/prodaja-stanova/beograd` and `/nekretnine/prodaja-kuca/beograd` with `?cena_d_to=<maxPrice>&cena_d_unit=4&page=<n>` (unit 4 = EUR). Default order is newest first. Data is in `QuidditaEnvironment.serverListData`, 20 ads per page, each with a `ListHTML` card.
- **Ad page:** `QuidditaEnvironment.CurrentClassified.OtherFields`. Cards lack heating, registration, elevator, building type and agency. These come from the ad page (`parseAdPage()`, `mergeDetails()`), at most 20 per poll.
- **The old JSON endpoint** `AdSearchWidgetAux/GetSearchResultsAsync` is gone (302 to /404).
- **Floors:** numeric or Roman ("VI/7"). VPR / PR / NPR are ground variants. SUT and PSUT (half-basement) map to basement. PK / PTK mean attic.
- **registered:** "Uknjižen" → true, otherwise null. The site has no "not registered" value. Elevator: "Lift" → true, otherwise null.
- **sourceCreatedAt caveat:** on cards it is the publish day, and promoted re-publications (`?kid=4`) look new. The ad page gives the real first publication.
- **Place names** match the 4zida catalog for 64 of 67 places seen.

## cityexpert.rs

- **Access:** public JSON API, no auth or captcha. A User-Agent and `Accept: application/json` are enough.
- **Search:** `GET https://cityexpert.rs/api/Search?req=<urlencoded JSON>` with `{"ptId":[1,2,5],"cityId":1,"rentOrSale":"s","currentPage":N,"resultsPerPage":30,"maxPrice":M,"searchSource":"regular","sort":"datedsc"}`. The POST `/api/Search/` is for saved searches only (400). The response has `result[]` and `info` (`pageCount`, `isLastPage`).
- **Property types (`ptId`):** 1 apartment, 2 house, 5 apartment in a house (treated as apartment). Others (offices, land, garages) are skipped.
- **Detail:** `GET /api/PropertyView/<propId>/s` gives the exact floor, total floors, elevator, registration (`basInfFiled`: 2 = registered, 1 = not, 3 to 5 = permits, treated as unknown) and heating codes. Search results only have floor buckets (`2_4`, `5_10`). Details are cached in memory per process.
- **URLs** are built like the site's own: `https://cityexpert.rs/prodaja-nekretnina/beograd/{propId}/{structure}-{stan|kuca|stan-u-kuci}-{street}-{municipality}`.
- **Images:** files are AVIF; the `@jpg` suffix makes their image server return JPEG, which Telegram accepts.
- **Advertiser** is always the agency itself (`cityexpert`).
- **Volume:** the whole Belgrade sale inventory under 220k is about 200 listings.
- **Places:** broad areas (Centar, Krug dvojke, Zvezdara bez Mirijeva and so on) are skipped in favor of the neighborhood. A few municipalities differ from 4zida, for example Terazije under Savski venac. Substring filters on the neighborhood still match.

## sasomange.rs

Shut down. Category URLs redirect to a Kurir news section, ad URLs return 410 Gone. Not implemented.

## Candidates

- **kupujemprodajem.com:** the largest Serbian classifieds site, many private sellers. Not investigated.
- **4zida new-build catalog** (`/novogradnja`): would cover all new-build projects, not only promoted ones.
