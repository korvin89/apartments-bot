import type { ListingEvent, ListingStatus, StoredListing } from './types.js';
import { municipalityName, neighborhoodSlug } from './places.js';

const HEATING_LABEL: Record<string, string> = {
  central: 'central (building boiler)',
  district: 'district (city heating)',
  gas: 'gas',
  electricity: 'electric',
  storageHeater: 'storage heaters (TA)',
  tileStove: 'tile stove',
  heatPump: 'heat pump',
  floorHeating: 'underfloor',
  underfloor: 'underfloor',
  none: 'none',
  solid: 'wood/coal stove',
  norwegianRadiators: 'Norwegian radiators',
  airConditioning: 'air conditioning',
};

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** For values inside an HTML attribute, e.g. href="...". */
export function escAttr(s: string): string {
  return esc(s).replace(/"/g, '&quot;');
}

export function fmtMoney(n: number): string {
  return n.toLocaleString('en-US');
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "bezanijska-kosa-3-novi-beograd-beograd" -> "Bezanijska Kosa 3 Novi Beograd" */
export function prettyPlace(slug: string): string {
  return slug
    .replace(/-opstina-beograd$/, '')
    .replace(/-beograd$/, '')
    .split('-')
    .map(cap)
    .join(' ');
}

function roomsLabel(r: number | null): string | null {
  if (r === null) return null;
  return `${r} rooms`;
}

function floorLabel(l: StoredListing): string | null {
  if (l.type === 'house') return null;
  if (l.floor === null) return null;
  if (l.floor <= 0) {
    const names = { basement: 'basement', low_ground: 'low ground floor', ground: 'ground floor', high_ground: 'high ground floor' };
    const name = l.groundLevel ? names[l.groundLevel] : l.floor === 0 ? 'ground floor' : 'basement';
    return l.totalFloors !== null ? `${name} (of ${l.totalFloors})` : name;
  }
  const base = l.totalFloors !== null ? `floor ${l.floor}/${l.totalFloors}` : `floor ${l.floor}`;
  if (l.attic) return `${base}, attic`;
  return l.lastFloor && l.totalFloors === null ? `${base}, top` : base;
}

function joinParts(parts: Array<string | null | undefined>, sep = ' · '): string {
  return parts.filter((p): p is string => Boolean(p)).join(sep);
}

export function formatCard(ev: ListingEvent): string {
  const l = ev.listing;
  const typeLabel = l.type === 'house' ? 'House' : 'Apartment';
  const ppm = l.m2 ? Math.round(l.price / l.m2) : null;

  const lines = (...xs: Array<string | null>) => xs.filter(Boolean).join('\n');
  // Blocks are separated by a blank line; details stay compact inside one block.
  const blocks = [
    ev.kind === 'price_drop' ? `📉 Price drop: <s>${fmtMoney(ev.oldPrice)} €</s> → <b>${fmtMoney(l.price)} €</b>` : null,
    `<b>${esc(typeLabel)}, ${esc(l.title)}</b>`,
    `💰 <b>${fmtMoney(l.price)} €</b>${ppm ? ` · ${fmtMoney(ppm)} €/m²` : ''}`,
    lines(
      joinParts([l.m2 ? `📐 ${l.m2} m²` : null, roomsLabel(l.rooms), floorLabel(l)]) || null,
      l.isNewBuild ? '🏗 New build' : null,
      l.registered === null
        ? null
        : l.registered
          ? '✅ Registered (uknjižen)'
          : l.isNewBuild
            ? '📝 Not registered yet'
            : '⚠️ Not registered',
      l.creditEligible ? '🏦 Mortgage OK' : null,
      l.type === 'apartment' && l.elevator !== null ? (l.elevator ? '🛗 Elevator' : '🚶 No elevator') : null,
      l.heating ? `🔥 Heating: ${HEATING_LABEL[l.heating] ?? l.heating}` : null,
      `📍 ${esc(prettyPlace(l.placeSlug))}${l.address ? `, ${esc(l.address)}` : ''}`,
    ),
    `<a href="${escAttr(l.url)}">Open on ${esc(l.source)}</a>`,
  ];
  return blocks.filter(Boolean).join('\n\n');
}

export function statusLabel(status: ListingStatus): string {
  switch (status) {
    case 'liked':
      return '👍 Liked';
    case 'disliked':
      return '👎 Disliked';
    default:
      return '';
  }
}

export function formatShort(l: StoredListing): string {
  return `${fmtMoney(l.price)} € · ${l.m2 ?? '?'} m² · ${esc(prettyPlace(l.placeSlug))} — <a href="${escAttr(l.url)}">${esc(l.title)}</a>`;
}

/** "3 Oct, 18:28 (5 min ago)" in Belgrade time. */
export function fmtWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-GB', { timeZone: 'Europe/Belgrade', day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString('en-GB', { timeZone: 'Europe/Belgrade', hour: '2-digit', minute: '2-digit' });
  return `${date}, ${time} (${timeAgo(d, now)})`;
}

function timeAgo(d: Date, now: Date): string {
  const min = Math.round((now.getTime() - d.getTime()) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} min ago`;
  const days = Math.floor(h / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Telegram's limit is 4096 characters; keep headroom for tags. */
const DIGEST_MESSAGE_LIMIT = 3800;

function digestLine(l: StoredListing): string {
  // The block is already titled with the municipality, so show the neighborhood only
  const hood = neighborhoodSlug(l.placeSlug);
  const place = hood ? prettyPlace(hood) : null;
  const parts = [
    `<a href="${escAttr(l.url)}">${fmtMoney(l.price)} €</a>`,
    l.m2 ? `${l.m2} m²` : null,
    roomsLabel(l.rooms),
    l.type === 'house' ? '🏡' : null,
    l.isNewBuild ? '🏗' : null,
    place ? esc(place) : null,
  ];
  // Telegram makes the command tappable: it asks the bot for the listing's card
  return `${joinParts(parts)} /c${l.id}`;
}

/**
 * An overview of many listings at once (e.g. what matches on the first run):
 * one collapsed block per municipality, cheapest first, links only.
 * Returns one or more HTML messages, each under Telegram's size limit.
 */
export function formatDigest(title: string, listings: StoredListing[]): string[] {
  const groups = new Map<string, StoredListing[]>();
  for (const l of listings) {
    const key = municipalityName(l.placeSlug) ?? 'Other';
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const sections = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .flatMap(([name, items]) => {
      const lines = items.sort((a, b) => a.price - b.price).map(digestLine);
      // A very long group is split so every block fits in one message
      const chunks: string[][] = [[]];
      for (const line of lines) {
        const cur = chunks[chunks.length - 1];
        if (cur.join('\n').length + line.length > DIGEST_MESSAGE_LIMIT - 200) chunks.push([line]);
        else cur.push(line);
      }
      return chunks.map((c, i) => `<b>${esc(name)}</b> (${i === 0 ? items.length : 'cont.'})\n<blockquote expandable>${c.join('\n')}</blockquote>`);
    });

  const header = `${title}\n<i>Tap a block to expand it, and <code>/c…</code> next to a listing for its card with Like / Dislike. New listings will keep coming as separate cards.</i>`;
  const messages: string[] = [header];
  for (const section of sections) {
    const cur = messages[messages.length - 1];
    if (cur.length + section.length + 2 > DIGEST_MESSAGE_LIMIT) messages.push(`📋 <i>continued</i>\n\n${section}`);
    else messages[messages.length - 1] = `${cur}\n\n${section}`;
  }
  return messages;
}
