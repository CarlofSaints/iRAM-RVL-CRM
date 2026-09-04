/**
 * Pure, I/O-free helpers for the Promotional Material module.
 *
 * Split out of lib/promoData.ts so the client pages can import them: promoData
 * pulls in `fs` and `@vercel/blob`, which cannot go into a browser bundle. Keep
 * this file free of imports for the same reason.
 */

export type PromoLineSource = 'sku' | 'promo';

/**
 * A kit record describes a kit TYPE and how many identical copies of it exist.
 * There is no stored status: a kit is not "out", some number of its copies are.
 * That number is derived from the open bookings every time, so it can never
 * drift out of step with the log. See [derived state] in promoData.ts.
 */
export interface KitAvailability {
  /** Copies that exist. */
  total: number;
  /** Copies currently with someone. */
  out: number;
  /** Copies on the shelf. */
  available: number;
}

/** How many copies of a kit exist. Absent means 1 — kits created before quantities. */
export function kitTotal(kit: { totalQuantity?: number }): number {
  const n = Number(kit.totalQuantity);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

export function availabilityOf(total: number, out: number): KitAvailability {
  return { total, out, available: Math.max(0, total - out) };
}

/** "3 of 5 at home" / "All 5 at home" / "All 5 out". Never just "Out". */
export function availabilityLabel(a: KitAvailability): string {
  if (a.total === 1) return a.out > 0 ? 'Out' : 'At Home';
  if (a.out === 0) return `All ${a.total} at home`;
  if (a.available === 0) return `All ${a.total} out`;
  return `${a.available} of ${a.total} at home`;
}

export function availabilityBadge(a: KitAvailability): string {
  if (a.out === 0) return 'bg-emerald-100 text-emerald-700';
  if (a.available === 0) return 'bg-amber-100 text-amber-700';
  return 'bg-blue-100 text-blue-700';
}

/**
 * Units inside ONE copy of a kit — the sum of every line quantity, not the line
 * count. Multiply by the number of copies for the physical count that leaves
 * the building.
 */
export function kitUnits(kit: { lines: Array<{ quantity: number }> }): number {
  return kit.lines.reduce((t, l) => t + (Number(l.quantity) || 0), 0);
}

/** Normalise an article number the same way /api/clients/[id]/products does. */
export function normArticle(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, '').replace(/^0+/, '').toLowerCase();
}

/**
 * The key a kit line is deduplicated on. Two lines for the same item merge
 * their quantities rather than sitting side by side — otherwise "add this item
 * to 5 kits" run twice leaves doubles nobody can tell apart on the return
 * tick-list.
 */
export function lineKey(source: PromoLineSource, ref: string): string {
  return source === 'sku' ? `sku:${normArticle(ref)}` : `promo:${ref.trim().toLowerCase()}`;
}

/** dd/mm/yyyy hh:mm in SAST, or a placeholder when absent. */
export function fmtPromoDateTime(iso?: string | null): string {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return iso;
  }
}

/** "2 copies" / "1 copy". Used wherever a booking's size is shown. */
export function copiesLabel(n: number): string {
  return `${n} ${n === 1 ? 'copy' : 'copies'}`;
}

// ── Line stock: what a kit ACTUALLY holds, versus what it should ─────────────
//
// A line's `quantity` is the SPEC — "a full copy of this kit contains 1 soccer
// ball". It is deliberately NOT reduced when a ball goes missing, because a kit
// that has forgotten what it is supposed to contain can never be checked again,
// and with 5 copies one per-copy number cannot say "4 of the 5 still have one".
//
// So a shortfall lives beside the spec as `missingQuantity`, counted in PHYSICAL
// UNITS across the whole pool of copies (not per copy). One lost ball out of
// five copies is missingQuantity 1, and the kit reads "4 of 5 present".

/** Physical units of a line the kit should hold across every copy. */
export function linePool(line: { quantity: number }, copies: number): number {
  return Math.max(0, (Number(line.quantity) || 0) * Math.max(0, copies));
}

/**
 * Units of a line that are gone. Clamped to the pool on READ so shrinking
 * `totalQuantity` after a loss can never leave a line reading more missing than
 * the kit has room for. Never read `line.missingQuantity` directly.
 */
export function lineMissing(line: { quantity: number; missingQuantity?: number }, copies: number): number {
  const n = Number(line.missingQuantity);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), linePool(line, copies));
}

/** Units of a line that physically exist — on the shelf or out with someone. */
export function linePresent(line: { quantity: number; missingQuantity?: number }, copies: number): number {
  return linePool(line, copies) - lineMissing(line, copies);
}

/** What the UI and the book-out screen need to know about one line's stock. */
export interface PromoLineStock {
  /** quantity x copies — what a complete kit set would hold. */
  pool: number;
  /** Units lost, broken or never returned. */
  missing: number;
  /** pool - missing: units that still exist. */
  present: number;
  /** Units already out on open bookings. */
  out: number;
  /** present - out: units on the shelf, available to send with the next copy. */
  free: number;
}

export function lineStock(
  line: { quantity: number; missingQuantity?: number },
  copies: number,
  unitsOut: number,
): PromoLineStock {
  const pool = linePool(line, copies);
  const missing = lineMissing(line, copies);
  const present = pool - missing;
  const out = Math.max(0, Math.min(unitsOut, present));
  return { pool, missing, present, out, free: Math.max(0, present - out) };
}

/** Total units missing across every line of a kit. 0 when the kit is complete. */
export function kitShortUnits(
  kit: { totalQuantity?: number; lines: Array<{ quantity: number; missingQuantity?: number }> },
): number {
  const copies = kitTotal(kit);
  return kit.lines.reduce((t, l) => t + lineMissing(l, copies), 0);
}

/** How many LINES of a kit are short. Reads better than a unit count on a badge. */
export function kitShortLines(
  kit: { totalQuantity?: number; lines: Array<{ quantity: number; missingQuantity?: number }> },
): number {
  const copies = kitTotal(kit);
  return kit.lines.filter(l => lineMissing(l, copies) > 0).length;
}

/**
 * "1 item" / "3 items". Singular and plural on a derived count needs its own
 * branch — a spliced `item${n===1?'':'s'}` is how "All 1 copy are out" shipped.
 */
export function itemsLabel(n: number): string {
  return `${n} ${n === 1 ? 'item' : 'items'}`;
}

/** "1 unit" / "4 units". */
export function unitsLabel(n: number): string {
  return `${n} ${n === 1 ? 'unit' : 'units'}`;
}
