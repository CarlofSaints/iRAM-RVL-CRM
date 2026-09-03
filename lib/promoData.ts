/**
 * Promotional Material module data layer. Runs SEPARATE to aged stock and swap-outs.
 *
 * A PROMO KIT belongs to one client and holds a list of items. An item line is
 * either:
 *   - source 'sku'   → a product from the client's existing product control file
 *                      (lib/spLinkData.ts → products/{clientId}/{linkId}.json),
 *                      referenced by article number. NOT copied by reference:
 *                      the code/description are snapshotted onto the line so a
 *                      SharePoint refresh that drops a SKU cannot silently empty
 *                      a kit that has already been booked out.
 *   - source 'promo' → an entry in the module's OWN catalogue (t-shirts, balloons,
 *                      banners, giveaways) which does not exist as a retail SKU.
 * Every line carries a quantity, whichever source it came from.
 *
 * A kit is at 'home' or 'out'. Booking it out and back in writes an append-only
 * BOOKING record; the kit itself only ever holds its current status + the id of
 * the booking it is out on. The booking log is the history — a kit's status is
 * derived from it and never edited by hand.
 *
 * Blobs (all private, same store as everything else):
 *   promo/items.json     — the manual promo-material catalogue
 *   promo/kits.json      — the kits
 *   promo/bookings.json  — the append-only out/in log
 *   promo/contacts.json  — people who may take a kit but are not app users
 *   promo/sequence.json  — kit reference high-water mark (never reused)
 *
 * No module-level cache — multi-container serverless safety.
 */

import fs from 'fs';
import path from 'path';
import { put, get } from '@vercel/blob';
import type { PromoKitStatus, PromoLineSource } from './promoShared';

// The pure helpers live in promoShared.ts so the client pages can import them
// without dragging `fs` into the browser bundle. Re-exported here so server
// code has one import for the module.
export {
  PROMO_KIT_STATUS_LABELS,
  PROMO_KIT_STATUS_BADGE,
  kitUnits,
  normArticle,
  lineKey,
} from './promoShared';
export type { PromoKitStatus, PromoLineSource } from './promoShared';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PromoKitLine {
  id: string;
  source: PromoLineSource;
  /** Article number for 'sku', promo item id for 'promo'. */
  ref: string;
  /** Snapshot of the item code at the time it was added to the kit. */
  code: string;
  /** Snapshot of the description at the time it was added to the kit. */
  description: string;
  quantity: number;
  addedAt: string;
  addedByName?: string;
}

export interface PromoKit {
  id: string;
  /** Human reference, e.g. PK-0007. Minted from promo/sequence.json, never reused. */
  reference: string;
  clientId: string;
  name: string;
  notes?: string;
  lines: PromoKitLine[];
  status: PromoKitStatus;
  /** Set while status === 'out' — the booking the kit is currently out on. */
  currentBookingId?: string;
  createdAt: string;
  createdByName?: string;
  updatedAt: string;
}

/** The manual catalogue — giveaways, banners, uniforms: things with no SKU. */
export interface PromoItem {
  id: string;
  code: string;
  description: string;
  category?: string;
  notes?: string;
  createdAt: string;
  createdByName?: string;
  updatedAt: string;
}

/**
 * Someone who may take a kit but is not a loaded app user. Created on the fly
 * from the book-out screen when the name is not in the list. Deliberately NOT a
 * login — they receive the emails and appear in the picker, nothing more.
 */
export interface PromoContact {
  id: string;
  name: string;
  email: string;
  phone?: string;
  createdAt: string;
  createdByName?: string;
}

/** Who is holding a kit. Snapshotted onto the booking so a later rename can't rewrite history. */
export interface PromoHolder {
  /** 'user' = app user, 'rep' = reps masterfile, 'contact' = promo contact. */
  type: 'user' | 'rep' | 'contact';
  id: string;
  name: string;
  email: string;
}

/** One line as it stood when the kit went out, and whether it came back. */
export interface PromoBookingLine {
  lineId: string;
  source: PromoLineSource;
  code: string;
  description: string;
  quantity: number;
  /** Set on return: how many of `quantity` came back. Absent until returned. */
  returnedQuantity?: number;
}

export interface PromoBooking {
  id: string;
  kitId: string;
  /** Snapshots so the log still reads correctly after a rename or a kit delete. */
  kitReference: string;
  kitName: string;
  clientId: string;
  clientName: string;

  // ── Out leg ──
  bookedOutAt: string;
  bookedOutByUserId: string;
  bookedOutByName: string;
  bookedOutByEmail: string;
  holder: PromoHolder;
  /** Explicit "I have counted every item in this kit" tick from the book-out screen. */
  contentsConfirmed: boolean;
  lines: PromoBookingLine[];
  outNote?: string;
  outEmailTo?: string[];
  outEmailAt?: string;
  /** Set when the out email failed, so a silent failure is impossible. */
  outEmailError?: string;

  // ── Return leg ──
  returnedAt?: string;
  returnedByUserId?: string;
  returnedByName?: string;
  returnedByEmail?: string;
  /** True when every line came back in full. */
  returnedComplete?: boolean;
  returnNote?: string;
  returnEmailTo?: string[];
  returnEmailAt?: string;
  returnEmailError?: string;
}

// ── Blob plumbing ────────────────────────────────────────────────────────────

const ITEMS_KEY = 'promo/items.json';
const KITS_KEY = 'promo/kits.json';
const BOOKINGS_KEY = 'promo/bookings.json';
const CONTACTS_KEY = 'promo/contacts.json';

/**
 * Kit reference high-water mark. A SEPARATE blob from the kit index, on purpose
 * — see the sticker sequence in lib/stickerData.ts for what happens when a
 * counter is derived from records that can be deleted. A kit reference ends up
 * on emails sitting in people's inboxes, so a number is spent the moment it is
 * issued and must never be handed out twice.
 */
const SEQUENCE_KEY = 'promo/sequence.json';

const localPath = (name: string) => path.join(process.cwd(), 'data', 'promo', name);

async function readJson<T>(key: string, localName: string, fallback: T): Promise<T> {
  if (!process.env.VERCEL) {
    try {
      const f = localPath(localName);
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8')) as T;
    } catch { /* empty */ }
    return fallback;
  }
  try {
    const result = await get(key, { access: 'private', useCache: false });
    if (result && result.statusCode === 200) {
      const text = await new Response(result.stream).text();
      return JSON.parse(text) as T;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/not.?found|404/i.test(msg)) {
      console.error(`[promoData] Blob read failed for ${key}:`, msg);
    }
  }
  return fallback;
}

async function writeJson(key: string, localName: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data, null, 2);

  // Off Vercel the local file IS the store — a missing blob token must not make
  // the module unwritable in local dev (the bug swapOutData.ts had).
  if (!process.env.VERCEL) {
    const f = localPath(localName);
    const dir = path.dirname(f);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(f, json, 'utf-8');
    return;
  }

  try {
    await put(key, json, {
      access: 'private',
      contentType: 'application/json',
      allowOverwrite: true,
      addRandomSuffix: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to persist ${key} to Vercel Blob: ${msg}`);
  }

  // Local mirror for dev snapshots — read-only FS on Vercel, so ignore failures.
  try {
    const f = localPath(localName);
    const dir = path.dirname(f);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(f, json, 'utf-8');
  } catch { /* expected on Vercel */ }
}

// ── Promo item catalogue ─────────────────────────────────────────────────────

export async function listPromoItems(): Promise<PromoItem[]> {
  return readJson<PromoItem[]>(ITEMS_KEY, 'items.json', []);
}

export async function savePromoItems(items: PromoItem[]): Promise<void> {
  return writeJson(ITEMS_KEY, 'items.json', items);
}

// ── Kits ─────────────────────────────────────────────────────────────────────

export async function listPromoKits(): Promise<PromoKit[]> {
  return readJson<PromoKit[]>(KITS_KEY, 'kits.json', []);
}

export async function savePromoKits(kits: PromoKit[]): Promise<void> {
  return writeJson(KITS_KEY, 'kits.json', kits);
}

// ── Bookings ─────────────────────────────────────────────────────────────────

export async function listPromoBookings(): Promise<PromoBooking[]> {
  return readJson<PromoBooking[]>(BOOKINGS_KEY, 'bookings.json', []);
}

export async function savePromoBookings(bookings: PromoBooking[]): Promise<void> {
  return writeJson(BOOKINGS_KEY, 'bookings.json', bookings);
}

// ── Contacts ─────────────────────────────────────────────────────────────────

export async function listPromoContacts(): Promise<PromoContact[]> {
  return readJson<PromoContact[]>(CONTACTS_KEY, 'contacts.json', []);
}

export async function savePromoContacts(contacts: PromoContact[]): Promise<void> {
  return writeJson(CONTACTS_KEY, 'contacts.json', contacts);
}

// ── Kit reference sequence ───────────────────────────────────────────────────

interface PromoSequenceState {
  /** Highest kit number ever issued. The next kit is this + 1. */
  lastKitNumber: number;
  updatedAt: string;
}

function refToNumber(reference: string): number {
  const m = /^PK-(\d+)$/.exec(reference.trim());
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Floor derived from records that still exist. Kept only so that if the
 * sequence blob is ever lost the counter cannot drop below what the surviving
 * kits and bookings prove was already issued. It can raise the number, never
 * lower it.
 */
async function sequenceFloor(): Promise<number> {
  const [kits, bookings] = await Promise.all([listPromoKits(), listPromoBookings()]);
  let max = 0;
  for (const k of kits) max = Math.max(max, refToNumber(k.reference));
  for (const b of bookings) max = Math.max(max, refToNumber(b.kitReference));
  return max;
}

/** Mint the next kit reference (PK-0001, PK-0002, …). Never reissues a number. */
export async function nextKitReference(): Promise<string> {
  const state = await readJson<PromoSequenceState>(SEQUENCE_KEY, 'sequence.json', {
    lastKitNumber: 0,
    updatedAt: '',
  });
  const floor = await sequenceFloor();
  const next = Math.max(state.lastKitNumber, floor) + 1;
  await writeJson(SEQUENCE_KEY, 'sequence.json', {
    lastKitNumber: next,
    updatedAt: new Date().toISOString(),
  } satisfies PromoSequenceState);
  return `PK-${String(next).padStart(4, '0')}`;
}

