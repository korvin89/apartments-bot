import type { BuildingAge, PropertyType } from './types.js';

export interface FourZidaSearch {
  /** Path on 4zida without domain and query, e.g. "prodaja-stanova/beograd". */
  path: string;
  type: PropertyType;
}

/**
 * Default search settings. The filters below can be changed from the chat
 * with /filters; those overrides are stored in the database and win over
 * the values here. null = filter disabled.
 *
 * Filters are site-agnostic: when a listing lacks the data a filter needs
 * (the site does not publish it), the listing passes that filter.
 * Defaults lean towards showing more: we tighten later if noise gets through.
 */
export const searchConfig = {
  maxPrice: 210_000,
  /** 0 = off. A floor like 20_000 drops placeholder prices such as 1 EUR. */
  minPrice: 0,
  minM2: 60 as number | null,
  maxM2: null as number | null,
  minRooms: 2 as number | null,
  maxPricePerM2: null as number | null,
  /** Skip apartments above this floor when the building has no elevator. */
  maxFloorWithoutElevator: null as number | null,
  /** Resale only, new builds only, or both. */
  buildingAge: 'any' as BuildingAge,
  /** Skip basement apartments ("suteren"). */
  excludeBasement: false,
  /** Skip "prizemlje" and "nisko prizemlje". "Visoko prizemlje" still passes. */
  excludeGroundFloor: true,
  /** Skip attics ("potkrovlje"). */
  excludeAttic: false,
  /** Skip any top floor, attic included. */
  excludeLastFloor: false,
  /** Only listings marked as mortgage-eligible. */
  requireCreditEligible: false,
  /**
   * Skip listings explicitly marked as not registered ("nije uknjižen").
   * Unknown passes; new builds are exempt because they can't be registered before completion.
   */
  requireRegistered: false,
  /** Substrings of the place slug to skip: ["barajevo", "grocka", "mladenovac"]. */
  excludePlaces: [] as string[],
  /**
   * If not empty, only places matching one of these substrings.
   * Derived from the "New Apartment Area" polygon on our Google My Map
   * (checked against all 586 Belgrade place slugs on 4zida).
   * Substrings are tuned to avoid collisions, e.g. 'kosutnjak-cukarica'
   * so Stari Kosutnjak in Rakovica does not match.
   */
  includePlaces: [
    // Whole municipalities
    'stari-grad-opstina', 'savski-venac-beograd', 'vracar-beograd',
    // Zvezdara
    'bulbulder', 'crveni-krst-zvezdara', 'denkova-basta', 'djeram', 'lion-zvezdara', 'lipov-lad', 'mirijevo',
    'slavujev-venac', 'vukov-spomenik', 'olimp-zvezdara', 'zvezdara-2-', 'zvezdara-3-', 'zvezdarska-suma',
    'cvetkova-pijaca', 'kluz-', 'novo-groblje', 'severni-bulevar', 'gradska-bolnica', 'depo-zvezdara',
    'dimitrija-tucovica', 'bulevar-kralja-aleksandra-zvezdara', 'konjarnik', 'rudo-zvezdara',
    'uciteljsko-naselje', 'zeleno-brdo-zvezdara', 'centar-zvezdara',
    // Palilula (south of the Danube)
    'tasmajdan', 'bogoslovija', 'calije', 'hadzipopovac', 'karaburma', 'profesorska-kolonija',
    'rospi-cuprija', 'botanicka-basta', 'cvijiceva', 'palilulska-pijaca', 'bulevar-despota-stefana',
    'dalmatinska', 'hala-pionir', 'ruzveltova', 'zira-', '27-marta', 'masinski-fakultet', 'centar-palilula',
    'ada-huja', 'viline-vode', 'visnjica-', 'visnjicka-banja', 'visnjicko-polje',
    // Voždovac (north)
    'centar-vozdovac', 'autokomanda', 'dusanovac', 'lekino-brdo', 'marinkova-bara', 'pasino-brdo', 'sumice',
    'siva-stena', 'cinovnicka-kolonija', 'fon-vozdovac', 'frans-', 'gospodara-vucica-vozdovac', 'hotel-m-',
    'bulevar-oslobodjenja', 'ustanicka', 'vitanovacka', 'tc-stadion', 'kumodraska', 'jove-ilica',
    'bioskop-vozdovac', 'zaplanjska', 'brace-jerkovic', 'medakovic-vozdovac', 'medakovic-2-', 'trosarina',
    'saobracajni-fakultet', 'vojislava-ilica', 'vozdovacka-crkva', 'darvinova-posta', 'vojvode-stepe',
    'medakovic-padina',
    // Čukarica (east)
    'centar-cukarica', 'careva-cuprija', 'golf-naselje', 'banovo-brdo', 'cukaricka-padina',
    'kosutnjak-cukarica', 'suncana-padina',
  ] as string[],
  /** Extra places accepted for houses only, on top of includePlaces: areas on the polygon's edge. */
  includePlacesHousesOnly: [
    'banjica', 'medakovic-3-', 'stepa-stepanovic', 'mali-mokri-lug',
    'zarkovo', 'julino-brdo', 'repiste', 'lesce',
  ] as string[],
  /** Which property types to search. */
  types: ['apartment', 'house'] as PropertyType[],
  /** Pages (~20 listings each) to scan per poll. Sorted by newest first. */
  pagesPerPoll: 3,
  /** Which sites to poll. */
  sources: {
    fourzida: true,
    nekretnine: true,
    halooglasi: true,
    cityexpert: true,
  },
  fourzida: [
    { path: 'prodaja-stanova/beograd', type: 'apartment' },
    { path: 'prodaja-kuca/beograd', type: 'house' },
  ] as FourZidaSearch[],
};

export type SearchConfig = typeof searchConfig;
