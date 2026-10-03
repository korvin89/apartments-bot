import type { Listing } from '../types.js';
import type { SearchConfig } from '../search.config.js';
import { fetchFourZida } from './fourzida.js';
import { fetchNekretnine } from './nekretnine.js';
import { createCurlImpersonateFetch, fetchHaloOglasi } from './halooglasi.js';
import { fetchCityExpert } from './cityexpert.js';
import { existsSync } from 'node:fs';
import { env, log } from '../config.js';
import { rejectReason } from '../filters.js';

export interface SourceResult {
  source: string;
  listings: Listing[];
  error?: string;
}

export type SourceKey = keyof SearchConfig['sources'];

/** What the poll knows about the database, so sources can skip extra work. */
export interface SourceContext {
  /** The listing is already stored. */
  isKnown(source: string, sourceId: string): boolean;
  /** The source has been polled before (its first poll only seeds the database). */
  isSeeded(source: string): boolean;
}

const NO_CONTEXT: SourceContext = { isKnown: () => false, isSeeded: () => false };
let warnedNoCurl = false;

interface SourceJob {
  /** Shown in logs and health alerts, e.g. "4zida:prodaja-stanova/beograd". */
  name: string;
  run: () => Promise<Listing[]>;
}

/** One entry per site. Each returns the jobs to run for the current config. */
const SOURCES: Record<SourceKey, (cfg: SearchConfig, ctx: SourceContext) => SourceJob[]> = {
  fourzida: (cfg) =>
    cfg.fourzida
      .filter((s) => cfg.types.includes(s.type))
      .map((s) => ({
        name: `4zida:${s.path}`,
        run: () => fetchFourZida(s, { maxPrice: cfg.maxPrice, pages: cfg.pagesPerPoll }),
      })),
  nekretnine: (cfg) => [
    {
      name: 'nekretnine',
      run: () => fetchNekretnine({ maxPrice: cfg.maxPrice, pages: cfg.pagesPerPoll, types: cfg.types }),
    },
  ],
  cityexpert: (cfg, ctx) => [
    {
      name: 'cityexpert',
      run: () =>
        fetchCityExpert({
          maxPrice: cfg.maxPrice,
          pages: cfg.pagesPerPoll,
          types: cfg.types,
          // Exact floor, registration and heating need one request per listing:
          // only for new listings that pass the filters on search-level data.
          withDetails: (l) => ctx.isSeeded('cityexpert') && !ctx.isKnown('cityexpert', l.sourceId) && !rejectReason(l, cfg),
        }),
    },
  ],
  halooglasi: (cfg, ctx) => {
    if (!existsSync(env.curlImpersonate)) {
      if (!warnedNoCurl) log(`halooglasi skipped: curl-impersonate not found at ${env.curlImpersonate}`);
      warnedNoCurl = true;
      return [];
    }
    return [
      {
        name: 'halooglasi',
        run: () =>
          fetchHaloOglasi({
            maxPrice: cfg.maxPrice,
            pages: cfg.pagesPerPoll,
            types: cfg.types,
            fetchImpl: createCurlImpersonateFetch({ binary: env.curlImpersonate }),
            // Search cards lack heating, registration etc. Open the ad page only for
            // listings we will actually notify about: new, past the card-level filters,
            // and not during its first poll (those listings go into an overview).
            details: (l) => ctx.isSeeded('halooglasi') && !ctx.isKnown('halooglasi', l.sourceId) && !rejectReason(l, cfg),
            maxDetails: 20,
          }),
      },
    ];
  },
};

/** Polls every enabled source. A failure in one source does not break the others. */
export async function fetchAllSources(cfg: SearchConfig, ctx: SourceContext = NO_CONTEXT): Promise<SourceResult[]> {
  const jobs = (Object.keys(SOURCES) as SourceKey[])
    .filter((k) => cfg.sources[k])
    .flatMap((k) => SOURCES[k](cfg, ctx));
  const results: SourceResult[] = [];
  for (const job of jobs) {
    try {
      results.push({ source: job.name, listings: await job.run() });
    } catch (e) {
      results.push({ source: job.name, listings: [], error: String(e) });
    }
  }
  return results;
}
