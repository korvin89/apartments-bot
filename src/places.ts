/**
 * Shared place naming. Filters and dedup work on 4zida-style place slugs
 * ("<neighborhood>-<municipality-suffix>", e.g. "banovo-brdo-cukarica-opstina-beograd"),
 * so every source converts its own place names with toPlaceSlug().
 * The catalog is the full list of Belgrade places on 4zida (api.4zida.rs autocomplete).
 */
import catalog from './data/places-4zida.json' with { type: 'json' };

const CATALOG = new Set<string>(catalog as string[]);

/** placeSlug for a listing whose site gave no usable location. */
export const UNKNOWN_PLACE = 'beograd';

/** Municipality -> suffix used by 4zida. Keys are slugified names. */
const MUNICIPALITY_SUFFIX: Record<string, string> = {
  'stari-grad': 'stari-grad-opstina-beograd',
  vracar: 'vracar-beograd',
  'savski-venac': 'savski-venac-beograd',
  zvezdara: 'zvezdara-opstina-beograd',
  palilula: 'palilula-opstina-beograd',
  vozdovac: 'vozdovac-opstina-beograd',
  cukarica: 'cukarica-opstina-beograd',
  rakovica: 'rakovica-opstina-beograd',
  'novi-beograd': 'novi-beograd-beograd',
  zemun: 'zemun-opstina-beograd',
  surcin: 'surcin-opstina-beograd',
  grocka: 'grocka-opstina-beograd',
  barajevo: 'barajevo-opstina-beograd',
  mladenovac: 'mladenovac-opstina-beograd',
  lazarevac: 'lazarevac-opstina-beograd',
  obrenovac: 'obrenovac-opstina-beograd',
  sopot: 'sopot-opstina-beograd',
};

const TRANSLIT: Record<string, string> = { š: 's', č: 'c', ć: 'c', ž: 'z', đ: 'dj', dž: 'dz' };

/** "Banovo Brdo" -> "banovo-brdo", "Čukarica" -> "cukarica". */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/dž|[ščćžđ]/g, (c) => TRANSLIT[c] ?? c)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function municipalityKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const s = slugify(name);
  if (MUNICIPALITY_SUFFIX[s]) return s;
  // "Opština Zvezdara", "Beograd - Novi Beograd": longest contained key wins
  return Object.keys(MUNICIPALITY_SUFFIX)
    .sort((a, b) => b.length - a.length)
    .find((k) => s.includes(k)) ?? null;
}

const MUNICIPALITY_NAME: Record<string, string> = {
  'stari-grad': 'Stari Grad', vracar: 'Vračar', 'savski-venac': 'Savski Venac', zvezdara: 'Zvezdara',
  palilula: 'Palilula', vozdovac: 'Voždovac', cukarica: 'Čukarica', rakovica: 'Rakovica',
  'novi-beograd': 'Novi Beograd', zemun: 'Zemun', surcin: 'Surčin', grocka: 'Grocka', barajevo: 'Barajevo',
  mladenovac: 'Mladenovac', lazarevac: 'Lazarevac', obrenovac: 'Obrenovac', sopot: 'Sopot',
};

/** Municipality display name for a 4zida-style slug, e.g. "kalenic-vracar-beograd" -> "Vračar". */
export function municipalityName(slug: string): string | null {
  const key = Object.keys(MUNICIPALITY_SUFFIX)
    .sort((a, b) => b.length - a.length)
    .find((k) => slug === MUNICIPALITY_SUFFIX[k] || slug.endsWith(`-${MUNICIPALITY_SUFFIX[k]}`));
  return key ? MUNICIPALITY_NAME[key] : null;
}

/** The neighborhood part of a slug, without the municipality: "kalenic-vracar-beograd" -> "kalenic". */
export function neighborhoodSlug(slug: string): string {
  const suffix = Object.values(MUNICIPALITY_SUFFIX)
    .sort((a, b) => b.length - a.length)
    .find((s) => slug === s || slug.endsWith(`-${s}`));
  return suffix ? slug.slice(0, Math.max(0, slug.length - suffix.length - 1)) : slug;
}

export interface PlaceInput {
  /** Neighborhood as the site shows it, e.g. "Banovo Brdo", "Blok 45". */
  neighborhood?: string | null;
  /** Municipality, e.g. "Čukarica", "Novi Beograd". */
  municipality?: string | null;
}

/**
 * Converts a site's place names to a 4zida-style slug.
 * Prefers an exact catalog entry; otherwise builds "<neighborhood>-<suffix>",
 * which still matches the substring filters (they key on the neighborhood part).
 */
export function toPlaceSlug({ neighborhood, municipality }: PlaceInput): string {
  const n = neighborhood ? slugify(neighborhood) : '';
  const mKey = municipalityKey(municipality) ?? (n && MUNICIPALITY_SUFFIX[n] ? n : null);
  const suffix = mKey ? MUNICIPALITY_SUFFIX[mKey] : null;

  if (suffix) {
    if (!n || n === mKey) return suffix;
    const exact = `${n}-${suffix}`;
    if (CATALOG.has(exact)) return exact;
    // Catalog has a longer form, e.g. "konjarnik-vozdovacki-deo-vozdovac-opstina-beograd"
    const longer = [...CATALOG].filter((s) => s.startsWith(`${n}-`) && s.endsWith(suffix)).sort((a, b) => a.length - b.length);
    if (longer[0]) return longer[0];
    return exact;
  }

  if (n) {
    const candidates = [...CATALOG].filter((s) => s.startsWith(`${n}-`)).sort((a, b) => a.length - b.length);
    if (candidates[0]) return candidates[0];
    return `${n}-beograd`;
  }
  return UNKNOWN_PLACE;
}
