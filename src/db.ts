import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Listing, ListingStatus, StoredListing } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  price INTEGER NOT NULL,
  previous_price INTEGER,
  m2 REAL,
  rooms REAL,
  floor INTEGER,
  total_floors INTEGER,
  last_floor INTEGER,
  ground_level TEXT,
  attic INTEGER,
  is_new_build INTEGER,
  place_slug TEXT NOT NULL,
  address TEXT,
  registered INTEGER,
  heating TEXT,
  elevator INTEGER,
  credit_eligible INTEGER,
  advertiser TEXT NOT NULL,
  agency_slug TEXT,
  image_url TEXT,
  source_created_at TEXT,
  fingerprint TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  notified_at TEXT,
  tg_message_id INTEGER,
  extra_message_ids TEXT,
  UNIQUE(source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_listings_fingerprint ON listings(fingerprint);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);

CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  price INTEGER NOT NULL,
  seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

function bool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  return Number(v) === 1;
}

function rowToListing(r: Row): StoredListing {
  return {
    id: r.id as number,
    source: r.source as string,
    sourceId: r.source_id as string,
    url: r.url as string,
    type: r.type as StoredListing['type'],
    title: r.title as string,
    price: r.price as number,
    previousPrice: (r.previous_price as number | null) ?? null,
    m2: (r.m2 as number | null) ?? null,
    rooms: (r.rooms as number | null) ?? null,
    floor: (r.floor as number | null) ?? null,
    totalFloors: (r.total_floors as number | null) ?? null,
    lastFloor: bool(r.last_floor),
    groundLevel: (r.ground_level as StoredListing['groundLevel']) ?? null,
    attic: bool(r.attic),
    isNewBuild: bool(r.is_new_build),
    placeSlug: r.place_slug as string,
    address: (r.address as string | null) ?? null,
    registered: bool(r.registered),
    heating: (r.heating as string | null) ?? null,
    elevator: bool(r.elevator),
    creditEligible: bool(r.credit_eligible),
    advertiser: r.advertiser as StoredListing['advertiser'],
    agencySlug: (r.agency_slug as string | null) ?? null,
    imageUrl: (r.image_url as string | null) ?? null,
    sourceCreatedAt: (r.source_created_at as string | null) ?? null,
    fingerprint: r.fingerprint as string,
    firstSeenAt: r.first_seen_at as string,
    lastSeenAt: r.last_seen_at as string,
    status: r.status as ListingStatus,
    notifiedAt: (r.notified_at as string | null) ?? null,
    tgMessageId: (r.tg_message_id as number | null) ?? null,
    extraMessageIds: r.extra_message_ids ? (JSON.parse(r.extra_message_ids as string) as number[]) : [],
  };
}

export class ListingsDb {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.migrate();
    // Statuses from the first prototype: shortlist/contacted became like, hide became dislike.
    this.db.exec(`
      UPDATE listings SET status = 'liked' WHERE status IN ('starred', 'contacted');
      UPDATE listings SET status = 'disliked' WHERE status = 'hidden';
    `);
  }

  /** Brings databases created by earlier versions up to the current schema. */
  private migrate(): void {
    const cols = new Set(
      (this.db.prepare('PRAGMA table_info(listings)').all() as { name: string }[]).map((c) => c.name),
    );
    const added: Record<string, string> = {
      last_floor: 'INTEGER',
      credit_eligible: 'INTEGER',
      ground_level: 'TEXT',
      attic: 'INTEGER',
      is_new_build: 'INTEGER',
      extra_message_ids: 'TEXT',
    };
    for (const [col, type] of Object.entries(added)) {
      if (!cols.has(col)) this.db.exec(`ALTER TABLE listings ADD COLUMN ${col} ${type}`);
    }
    // 4zida floor codes used to be stored raw; move them to the shared scale once.
    if (this.getMeta('migration_floor_scale') !== '1') {
      this.db.exec(`
        UPDATE listings SET floor = 0 WHERE source = '4zida' AND floor IN (-2, -1, 0);
        UPDATE listings SET floor = -1 WHERE source = '4zida' AND floor < -2;
      `);
      this.setMeta('migration_floor_scale', '1');
    }
  }

  close(): void {
    this.db.close();
  }

  getBySource(source: string, sourceId: string): StoredListing | undefined {
    const row = this.db
      .prepare('SELECT * FROM listings WHERE source = ? AND source_id = ?')
      .get(source, sourceId) as Row | undefined;
    return row ? rowToListing(row) : undefined;
  }

  get(id: number): StoredListing | undefined {
    const row = this.db.prepare('SELECT * FROM listings WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToListing(row) : undefined;
  }

  insert(l: Listing, fingerprint: string, now: string): StoredListing {
    const info = this.db
      .prepare(
        `INSERT INTO listings (
          source, source_id, url, type, title, price, previous_price, m2, rooms, floor, total_floors, last_floor, ground_level, attic, is_new_build,
          place_slug, address, registered, heating, elevator, credit_eligible, advertiser, agency_slug, image_url,
          source_created_at, fingerprint, first_seen_at, last_seen_at
        ) VALUES (
          @source, @sourceId, @url, @type, @title, @price, @previousPrice, @m2, @rooms, @floor, @totalFloors, @lastFloor, @groundLevel, @attic, @isNewBuild,
          @placeSlug, @address, @registered, @heating, @elevator, @creditEligible, @advertiser, @agencySlug, @imageUrl,
          @sourceCreatedAt, @fingerprint, @now, @now
        )`,
      )
      .run({
        ...l,
        registered: l.registered === null ? null : l.registered ? 1 : 0,
        elevator: l.elevator === null ? null : l.elevator ? 1 : 0,
        lastFloor: l.lastFloor === null ? null : l.lastFloor ? 1 : 0,
        attic: l.attic === null ? null : l.attic ? 1 : 0,
        isNewBuild: l.isNewBuild === null ? null : l.isNewBuild ? 1 : 0,
        creditEligible: l.creditEligible === null ? null : l.creditEligible ? 1 : 0,
        fingerprint,
        now,
      });
    const id = Number(info.lastInsertRowid);
    this.db
      .prepare('INSERT INTO price_history (listing_id, price, seen_at) VALUES (?, ?, ?)')
      .run(id, l.price, now);
    return this.get(id)!;
  }

  /** Listing showed up again in search results: refresh last-seen date and price. */
  touch(id: number, price: number, now: string): void {
    const prev = this.get(id);
    this.db
      .prepare('UPDATE listings SET last_seen_at = ?, price = ?, previous_price = ? WHERE id = ?')
      .run(now, price, prev && prev.price !== price ? prev.price : prev?.previousPrice ?? null, id);
    if (prev && prev.price !== price) {
      this.db
        .prepare('INSERT INTO price_history (listing_id, price, seen_at) VALUES (?, ?, ?)')
        .run(id, price, now);
    }
  }

  /** Fixes links and photos stored by an older parser version. */
  refreshLinks(id: number, url: string, imageUrl: string | null): void {
    this.db
      .prepare('UPDATE listings SET url = ?, image_url = COALESCE(?, image_url) WHERE id = ?')
      .run(url, imageUrl, id);
  }

  /** Sources that already have listings stored. */
  knownSources(): Set<string> {
    const rows = this.db.prepare('SELECT DISTINCT source FROM listings').all() as { source: string }[];
    return new Set(rows.map((r) => r.source));
  }

  findDuplicates(fingerprint: string, excludeId: number): StoredListing[] {
    const rows = this.db
      .prepare('SELECT * FROM listings WHERE fingerprint = ? AND id != ?')
      .all(fingerprint, excludeId) as Row[];
    return rows.map(rowToListing);
  }

  setStatus(id: number, status: ListingStatus): void {
    this.db.prepare('UPDATE listings SET status = ? WHERE id = ?').run(status, id);
  }

  /** Records a later card about the listing (a price drop) without losing the main card's id. */
  addExtraMessage(id: number, messageId: number): void {
    const l = this.get(id);
    if (!l) return;
    this.db
      .prepare('UPDATE listings SET extra_message_ids = ? WHERE id = ?')
      .run(JSON.stringify([...l.extraMessageIds, messageId]), id);
  }

  /** Marks listings as shown in an overview (no card of their own). */
  markShown(ids: number[], now: string): void {
    const stmt = this.db.prepare('UPDATE listings SET notified_at = ? WHERE id = ? AND notified_at IS NULL');
    this.db.transaction(() => ids.forEach((id) => stmt.run(now, id)))();
  }

  /** Listings never shown in the chat, not rated, and still seen on a site since `since`. */
  unshown(since: string): StoredListing[] {
    const rows = this.db
      .prepare("SELECT * FROM listings WHERE notified_at IS NULL AND status = 'new' AND last_seen_at >= ? ORDER BY id")
      .all(since) as Row[];
    return rows.map(rowToListing);
  }

  /** Unrated listings shown only in an overview (no card of their own), still seen on a site since `since`. */
  overviewOnly(since: string): StoredListing[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM listings WHERE notified_at IS NOT NULL AND tg_message_id IS NULL AND status = 'new' AND last_seen_at >= ? ORDER BY id",
      )
      .all(since) as Row[];
    return rows.map(rowToListing);
  }

  /** Records a card sent on request (/c<id>); a listing that already has a card keeps both. */
  attachCard(id: number, messageId: number): void {
    const l = this.get(id);
    if (!l) return;
    if (l.tgMessageId === null) this.db.prepare('UPDATE listings SET tg_message_id = ? WHERE id = ?').run(messageId, id);
    else this.addExtraMessage(id, messageId);
  }

  /** Some listing with this fingerprint has already been shown. */
  fingerprintShown(fingerprint: string): boolean {
    return this.db.prepare('SELECT 1 FROM listings WHERE fingerprint = ? AND notified_at IS NOT NULL LIMIT 1').get(fingerprint) !== undefined;
  }

  markNotified(id: number, tgMessageId: number | null, now: string): void {
    this.db
      .prepare('UPDATE listings SET notified_at = ?, tg_message_id = ? WHERE id = ?')
      .run(now, tgMessageId, id);
  }

  listByStatus(status: ListingStatus, limit = 50): StoredListing[] {
    const rows = this.db
      .prepare('SELECT * FROM listings WHERE status = ? ORDER BY first_seen_at DESC LIMIT ?')
      .all(status, limit) as Row[];
    return rows.map(rowToListing);
  }

  counts(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM listings GROUP BY status')
      .all() as { status: string; n: number }[];
    const out: Record<string, number> = { total: 0 };
    for (const r of rows) {
      out[r.status] = r.n;
      out.total += r.n;
    }
    return out;
  }

  /** Listings whose card reached the chat. */
  countNotified(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM listings WHERE notified_at IS NOT NULL').get() as { n: number }).n;
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }
}
