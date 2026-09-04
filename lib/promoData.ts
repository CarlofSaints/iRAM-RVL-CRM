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
 * Every line carries a quantity, whichever source it came from, and those
 * quantities are PER COPY.
 *
 * A kit record is a kit TYPE plus how many identical copies exist
 * (`totalQuantity`). Five copies of the same roadshow kit are ONE record with
 * totalQuantity 5, so five people can each hold one at the same time.
 *
 * A kit therefore has NO STORED STATUS. Booking copies out and back in writes
 * append-only BOOKING records, and how many copies are out is derived from the
 * open ones every time (`outCopiesByKit`). Storing "out" on the kit as well
 * would be one concept in two places, and the two drift the first time a write
 * half-fails. The log is the truth.
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
import type { PromoLineSource, PromoLineStock } from './promoShared';
import { kitTotal, availabilityOf, lineStock, lineMissing, linePool } from './promoShared';

// The pure helpers live in promoShared.ts so the client pages can import them
// without dragging `fs` into the browser bundle. Re-exported here so server
// code has one import for the module.
export {
  kitTotal,
  availabilityOf,
  availabilityLabel,
  availabilityBadge,
  copiesLabel,
  kitUnits,
  normArticle,
  lineKey,
  linePool,
  lineMissing,
  linePresent,
  lineStock,
  kitShortUnits,
  kitShortLines,
  itemsLabel,
  unitsLabel,
} from './promoShared';
export type { PromoLineSource, KitAvailability, PromoLineStock } from './promoShared';

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
  /**
   * Physical units of this line that are GONE — lost, broken, or never returned
   * — counted across the whole pool of copies, not per copy.
   *
   * Deliberately separate from `quantity`: the quantity is the SPEC ("a full
   * copy holds 1 soccer ball") and must survive the ball going missing,
   * otherwise the kit forgets what it is supposed to contain and can never be
   * checked again. ABSENT MEANS 0 — always read it through lineMissing(), which
   * also clamps it to the pool so shrinking totalQuantity cannot leave a line
   * reading more missing than the kit has room for.
   */
  missingQuantity?: number;
  /** Why the last shortfall was recorded. Replaced each time — the audit log is the history. */
  missingNote?: string;
  /** When the shortfall was last changed, in either direction. */
  missingAt?: string;
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
  /**
   * How many identical copies of this kit exist. A record is a kit TYPE, not a
   * single box: five copies of the same roadshow kit are one record with
   * totalQuantity 5, so five people can hold one each.
   *
   * ABSENT MEANS 1 — kits created before quantities existed. Always read it
   * through kitTotal(), never `kit.totalQuantity` directly.
   */
  totalQuantity?: number;
  /** Line quantities are PER COPY. Booking N copies takes N x quantity of each. */
  lines: PromoKitLine[];
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

/**
 * The store a kit was dropped at, snapshotted onto the booking.
 *
 * Stores are a GLOBAL masterfile (control/stores.json), not client-scoped, so
 * the fields are copied here rather than referenced: a store renamed, or a
 * manager who moves on, must not rewrite a delivery note already signed.
 */
export interface PromoBookingStore {
  id: string;
  name: string;
  siteCode?: string;
  channel?: string;
  region?: string;
  managerName?: string;
  managerEmail?: string;
  managerPhone?: string;
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
  /**
   * Where the kit is physically sitting while it is out. OPTIONAL: most kits go
   * to a store and are left there for the weekend, but a rep taking one to a
   * roadshow has no store, and forcing one would make people invent it. The
   * holder above is still the person accountable for getting it back.
   */
  store?: PromoBookingStore;
  /** The promoter working the kit at that store. Free text — usually not an app user. */
  promoterName?: string;
  /** Explicit "I have counted every item in this kit" tick from the book-out screen. */
  contentsConfirmed: boolean;
  /**
   * How many copies of the kit went out on THIS booking. Absent means 1 (every
   * booking taken before kits had quantities). Read through bookingCopies().
   */
  copies?: number;
  /**
   * The PHYSICAL count that left, i.e. the kit's per-copy quantity multiplied
   * by `copies`. Deliberately not per-copy: the return tick-list is a count of
   * real objects on a real table, and nobody wants to do the multiplication
   * while holding a box.
   */
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
  const kits = await readJson<PromoKit[]>(KITS_KEY, 'kits.json', []);
  // Drop the pre-quantity `status` / `currentBookingId` fields on read so they
  // are never written back. Leaving a dead field in the blob that nothing reads
  // is how the next person ends up trusting it. Availability is derived from
  // the bookings; there is no stored status.
  for (const k of kits as Array<PromoKit & { status?: unknown; currentBookingId?: unknown }>) {
    delete k.status;
    delete k.currentBookingId;
  }
  return kits;
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


// ── Derived state: how many copies of a kit are out ──────────────────────────

/**
 * Copies on a booking. Absent means 1 — bookings taken before kits had
 * quantities. Never read `booking.copies` directly.
 */
export function bookingCopies(b: Pick<PromoBooking, 'copies'>): number {
  const n = Number(b.copies);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** A booking that has not come back yet. */
export function isOpenBooking(b: PromoBooking): boolean {
  return !b.returnedAt;
}

/**
 * How many copies of each kit are out, derived from the OPEN bookings.
 *
 * A kit has no stored status on purpose. Storing "out" alongside a booking log
 * that already says who has what is one concept in two places, and the two
 * drift the first time a write half-fails. The log is the truth; this reads it.
 */
export function outCopiesByKit(bookings: PromoBooking[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of bookings) {
    if (!isOpenBooking(b)) continue;
    m.set(b.kitId, (m.get(b.kitId) ?? 0) + bookingCopies(b));
  }
  return m;
}

/** Total / out / available for one kit, given the out-count map above. */
export function kitAvailability(kit: PromoKit, outByKit: Map<string, number>) {
  return availabilityOf(kitTotal(kit), outByKit.get(kit.id) ?? 0);
}

// ── Derived state: how many UNITS of each line are out ───────────────────────

/**
 * Units of each kit line currently out on open bookings, keyed by line id.
 *
 * Booking lines carry the PHYSICAL count that left (per-copy x copies), so this
 * is already in the same units as the pool. A booking line whose kit line has
 * since been removed simply has nothing to add to.
 */
export function outUnitsByLine(bookings: PromoBooking[], kitId: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of bookings) {
    if (b.kitId !== kitId || !isOpenBooking(b)) continue;
    for (const l of b.lines) m.set(l.lineId, (m.get(l.lineId) ?? 0) + (Number(l.quantity) || 0));
  }
  return m;
}

/** Per-line stock for one kit, keyed by line id. Used by the API responses. */
export function kitLineStock(kit: PromoKit, bookings: PromoBooking[]): Map<string, PromoLineStock> {
  const copies = kitTotal(kit);
  const out = outUnitsByLine(bookings, kit.id);
  const m = new Map<string, PromoLineStock>();
  for (const l of kit.lines) m.set(l.id, lineStock(l, copies, out.get(l.id) ?? 0));
  return m;
}

/**
 * Record `units` of a line as gone, or give them back with a negative number.
 *
 * ONE function for both legs on purpose: an item can be found missing when the
 * kit goes out (it was never in the box) or when it comes back (it did not
 * return), and those must not drift into two slightly different rules. Returns
 * how many units were actually applied after clamping — the caller reports
 * that, never what it asked for.
 */
export function applyLineShortfall(
  kit: PromoKit,
  lineId: string,
  units: number,
  note: string | undefined,
  at: string,
): number {
  const line = kit.lines.find(l => l.id === lineId);
  if (!line) return 0;
  const copies = kitTotal(kit);
  const before = lineMissing(line, copies);
  const after = Math.max(0, Math.min(linePool(line, copies), before + Math.floor(units)));
  if (after === before) return 0;
  line.missingQuantity = after || undefined;
  line.missingNote = after === 0 ? undefined : (note?.trim() || line.missingNote);
  line.missingAt = at;
  return after - before;
}
