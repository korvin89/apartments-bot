import type { ListingsDb } from './db.js';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { searchConfig, type SearchConfig } from './search.config.js';
import type { BuildingAge, PropertyType } from './types.js';

/** The part of the search config that can be edited from the chat. */
export interface EditableFilters {
  maxPrice: number;
  minPrice: number;
  minM2: number | null;
  maxM2: number | null;
  buildingAge: BuildingAge;
  excludeBasement: boolean;
  excludeAttic: boolean;
  minRooms: number | null;
  maxPricePerM2: number | null;
  maxFloorWithoutElevator: number | null;
  excludeGroundFloor: boolean;
  excludeLastFloor: boolean;
  excludeStorageHeating: boolean;
  requireCreditEligible: boolean;
  requireRegistered: boolean;
  excludePlaces: string[];
  includePlaces: string[];
  includePlacesHousesOnly: string[];
  types: PropertyType[];
}

const META_KEY = 'filters';
/** Bumped on every filter change; each source remembers the version it last polled with. See poll.ts. */
export const FILTERS_VERSION_KEY = 'filters_version';

export function filtersVersion(db: ListingsDb): number {
  return Number(db.getMeta(FILTERS_VERSION_KEY) ?? 0);
}

function bumpFiltersVersion(db: ListingsDb): void {
  db.setMeta(FILTERS_VERSION_KEY, String(filtersVersion(db) + 1));
}

function storedOverrides(db: ListingsDb): Partial<EditableFilters> {
  const raw = db.getMeta(META_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Partial<EditableFilters>;
  } catch {
    return {};
  }
}

/** Like loadSearchConfig, but reads the database file read-only, or defaults if there is none. */
export function readSearchConfig(dbPath: string): SearchConfig {
  if (!existsSync(dbPath)) return { ...searchConfig };
  const raw = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = raw.prepare('SELECT value FROM meta WHERE key = ?').get(META_KEY) as { value: string } | undefined;
    return { ...searchConfig, ...(row ? (JSON.parse(row.value) as Partial<EditableFilters>) : {}) };
  } catch {
    return { ...searchConfig };
  } finally {
    raw.close();
  }
}

/** Defaults from search.config.ts with chat overrides applied. */
export function loadSearchConfig(db: ListingsDb): SearchConfig {
  return { ...searchConfig, ...storedOverrides(db) };
}

export function updateFilters(db: ListingsDb, patch: Partial<EditableFilters>): SearchConfig {
  db.setMeta(META_KEY, JSON.stringify({ ...storedOverrides(db), ...patch }));
  bumpFiltersVersion(db);
  return loadSearchConfig(db);
}

export function resetFilters(db: ListingsDb): SearchConfig {
  db.setMeta(META_KEY, '{}');
  bumpFiltersVersion(db);
  return loadSearchConfig(db);
}

// ---------- parsing user input ----------

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const CLEAR_WORDS = new Set(['any', 'none', 'off', 'no', '-', '0']);

/** "200000", "200 000", "200,000", "200.000", "200k", "200k €" -> 200000 */
export function parseMoney(text: string): number | null {
  let t = text.toLowerCase().replace(/€|eur(o|os)?/g, '').replace(/\s/g, '');
  let mult = 1;
  if (t.endsWith('k')) {
    mult = 1000;
    t = t.slice(0, -1).replace(',', '.');
    const n = Number(t);
    return Number.isFinite(n) && n > 0 ? Math.round(n * mult) : null;
  }
  t = t.replace(/[.,]/g, '');
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
}

/** "2", "2.5", "2,5", "55 m2" -> number */
export function parseNumber(text: string): number | null {
  const t = text.toLowerCase().replace(/m2|m²|sqm|rooms?/g, '').replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/** Turns "Novi Beograd, Grocka; Barajevo" into slug fragments: ["novi-beograd", "grocka", "barajevo"]. */
export function parsePlaces(text: string): string[] {
  if (CLEAR_WORDS.has(text.trim().toLowerCase())) return [];
  const translit: Record<string, string> = { š: 's', č: 'c', ć: 'c', ž: 'z', đ: 'dj' };
  return [
    ...new Set(
      text
        .split(/[,;\n]/)
        .map((p) =>
          p
            .trim()
            .toLowerCase()
            .replace(/[ščćžđ]/g, (c) => translit[c] ?? c)
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, ''),
        )
        .filter(Boolean),
    ),
  ];
}

/**
 * Edits a place list from a chat reply:
 *   "+ banjica, zarkovo"  adds,  "- lesce"  removes,  anything else replaces,
 *   "none" clears.
 */
export function applyPlacesEdit(current: string[], text: string): string[] {
  const t = text.trim();
  if (t.startsWith('+')) return [...new Set([...current, ...parsePlaces(t.slice(1))])];
  if (t.startsWith('-') && t.length > 1) {
    const remove = new Set(parsePlaces(t.slice(1)));
    return current.filter((p) => !remove.has(p));
  }
  return parsePlaces(t);
}

export type NumericField = 'maxPrice' | 'minPrice' | 'minM2' | 'maxM2' | 'minRooms' | 'maxPricePerM2' | 'maxFloorWithoutElevator';

/** Validates a reply for a numeric filter against the current config. */
export function parseField(field: NumericField, text: string, cfg: SearchConfig): ParseResult<Partial<EditableFilters>> {
  const clear = CLEAR_WORDS.has(text.trim().toLowerCase());
  switch (field) {
    case 'maxPrice': {
      const v = parseMoney(text);
      if (v === null || v < 10_000) return { ok: false, error: 'Send a price in EUR, at least 10,000. Example: 200000 or 200k.' };
      if (v < cfg.minPrice) return { ok: false, error: `Max price can't be below the min price (${cfg.minPrice.toLocaleString('en-US')} €).` };
      return { ok: true, value: { maxPrice: v } };
    }
    case 'minPrice': {
      if (clear) return { ok: true, value: { minPrice: 0 } };
      const v = parseMoney(text);
      if (v === null) return { ok: false, error: 'Send a price in EUR, e.g. 50000 or 50k, or "any".' };
      if (v > cfg.maxPrice) return { ok: false, error: `Min price can't be above the max price (${cfg.maxPrice.toLocaleString('en-US')} €).` };
      return { ok: true, value: { minPrice: v } };
    }
    case 'minM2': {
      if (clear) return { ok: true, value: { minM2: null } };
      const v = parseNumber(text);
      if (v === null || v > 1000) return { ok: false, error: 'Send an area in m², e.g. 55, or "any".' };
      return { ok: true, value: { minM2: v } };
    }
    case 'maxM2': {
      if (clear) return { ok: true, value: { maxM2: null } };
      const v = parseNumber(text);
      if (v === null || v > 5000) return { ok: false, error: 'Send an area in m², e.g. 120, or "any".' };
      if (cfg.minM2 !== null && v < cfg.minM2) return { ok: false, error: `Max area can't be below the min area (${cfg.minM2} m²).` };
      return { ok: true, value: { maxM2: v } };
    }
    case 'minRooms': {
      if (clear) return { ok: true, value: { minRooms: null } };
      const v = parseNumber(text);
      if (v === null || v > 20) return { ok: false, error: 'Send a number of rooms, e.g. 2 or 2.5, or "any".' };
      return { ok: true, value: { minRooms: v } };
    }
    case 'maxPricePerM2': {
      if (clear) return { ok: true, value: { maxPricePerM2: null } };
      const v = parseMoney(text);
      if (v === null || v < 300 || v > 20_000) return { ok: false, error: 'Send a price per m² in EUR, e.g. 2800, or "any".' };
      return { ok: true, value: { maxPricePerM2: v } };
    }
    case 'maxFloorWithoutElevator': {
      if (text.trim().toLowerCase() === 'any') return { ok: true, value: { maxFloorWithoutElevator: null } };
      const v = parseNumber(text);
      if (v === null || !Number.isInteger(v) || v > 30) return { ok: false, error: 'Send a whole floor number, e.g. 3, or "any".' };
      return { ok: true, value: { maxFloorWithoutElevator: v } };
    }
  }
}
