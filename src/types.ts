export type PropertyType = 'apartment' | 'house';
export type Advertiser = 'agency' | 'owner' | 'developer' | 'unknown';
export type ListingStatus = 'new' | 'liked' | 'disliked';
/** Detail for floor <= 0, Belgrade style. */
export type GroundLevel = 'basement' | 'low_ground' | 'ground' | 'high_ground';
export type BuildingAge = 'any' | 'resale' | 'new';

/**
 * Normalized listing, identical shape for every source.
 * Fields a site does not provide are null; filters let null values pass.
 */
export interface Listing {
  source: string;
  sourceId: string;
  url: string;
  type: PropertyType;
  title: string;
  price: number;
  previousPrice: number | null;
  m2: number | null;
  rooms: number | null;
  /** 0 = ground floor (any "prizemlje"), negative = below ground ("suteren"). */
  floor: number | null;
  totalFloors: number | null;
  /** suteren / nisko prizemlje / prizemlje / visoko prizemlje, when the floor is at ground level. */
  groundLevel: GroundLevel | null;
  /** Top floor of the building (an attic counts as top too). */
  lastFloor: boolean | null;
  /** Attic ("potkrovlje"). */
  attic: boolean | null;
  /** New build or under construction (true), resale (false). */
  isNewBuild: boolean | null;
  /** Place slug taken from the source URL, e.g. "vracar-beograd". */
  placeSlug: string;
  address: string | null;
  registered: boolean | null;
  heating: string | null;
  elevator: boolean | null;
  /** The seller says the property qualifies for a mortgage. */
  creditEligible: boolean | null;
  advertiser: Advertiser;
  agencySlug: string | null;
  imageUrl: string | null;
  sourceCreatedAt: string | null;
}

export interface StoredListing extends Listing {
  id: number;
  fingerprint: string;
  firstSeenAt: string;
  lastSeenAt: string;
  status: ListingStatus;
  notifiedAt: string | null;
  /** Message id of the listing's main card. */
  tgMessageId: number | null;
  /** Later cards about the same listing (price drops), deleted together on dislike. */
  extraMessageIds: number[];
}

export type ListingEvent =
  | { kind: 'new'; listing: StoredListing }
  | { kind: 'price_drop'; listing: StoredListing; oldPrice: number };
