/**
 * Consolidated store report — one row per store, in RANDS.
 *
 * Modelled on the hand-maintained "Vermont Sales Aged Stock Tracker": store,
 * site code, province, the GRN/GRV numbers and the Return Order numbers in a
 * column each, date uplifted, then value to be collected / collected / damages
 * / possible phantom stock.
 *
 * THE KEY DIFFERENCE TO THE UPLIFT DETAIL REPORT: that one counts UNITS, this
 * one reports VALUE. The aged-stock load gives a value per product line but the
 * uplift outcome is recorded per line in units (found, display, refused, not
 * found, damaged). So each bracket is valued at the line's own unit price:
 *
 *     unit price = aged value / aged qty        (that line, that slip)
 *     bracket value = bracket units x unit price
 *
 * A line with qty 0 has no derivable price; its value is carried on "to be
 * collected" and contributes nothing to the brackets, which is the honest
 * treatment — inventing a price would silently move money between columns.
 */

import type { StoreRef } from './storeRefs';

export interface UpliftLine {
  articleCode: string;
  description?: string;
  /** Units on the pick slip. */
  agedQty: number;
  /** Rand value of those units, from the aged-stock load. */
  agedVal: number;
  foundQty: number;
  displayQty: number;
  refusedQty: number;
  notFoundQty: number;
  damagedQty: number;
}

export interface StoreSummaryInput {
  storeName: string;
  storeCode: string;
  province: string;
  /**
   * GRN/GRV + Return Order pairs captured at receipt, across every slip for
   * this store. Pairs, not two lists: the tracker prints them in two columns
   * and the reader lines them up by row, so the order has to mean something.
   */
  refs: StoreRef[];
  /** ISO of the uplift (GRN/GRV date, else receipted date). */
  upliftedAt?: string;
  clientName: string;
  vendorNumber: string;
  lines: UpliftLine[];
  /** True once anything has actually been receipted for this store. */
  uplifted: boolean;
}

export interface StoreSummaryRow {
  storeName: string;
  storeCode: string;
  province: string;
  refs: StoreRef[];
  upliftedAt?: string;
  clientName: string;
  vendorNumber: string;
  /** Total aged value on the pick slip(s) — what should come back. */
  valueToBeCollected: number;
  valueCollected: number;
  damages: number;
  phantom: number;
  display: number;
  refused: number;
  uplifted: boolean;
  /**
   * STBC — Still to be Collected. To-be-collected minus everything already
   * bracketed (collected, damaged, phantom, display, refused).
   *
   * Deliberately NOT called "unaccounted": a store sitting here is almost
   * always one the team has not reached yet, not one that was neglected. It
   * covers stores with no uplift recorded at all, stores part-way through, and
   * lines whose value could not be priced. Carl chose the name.
   */
  stbc: number;
  /** Lines whose unit price could not be derived (qty 0 but value non-zero). */
  unpricedLines: number;
}

/** Unit price for a line, or null when it cannot be derived. */
export function unitPriceOf(line: Pick<UpliftLine, 'agedQty' | 'agedVal'>): number | null {
  if (!line.agedQty || line.agedQty <= 0) return null;
  return line.agedVal / line.agedQty;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Value one store's lines into the report's money columns. */
export function summariseStore(input: StoreSummaryInput): StoreSummaryRow {
  let valueToBeCollected = 0;
  let valueCollected = 0;
  let damages = 0;
  let phantom = 0;
  let display = 0;
  let refused = 0;
  let unpricedLines = 0;

  for (const l of input.lines) {
    valueToBeCollected += l.agedVal || 0;
    const price = unitPriceOf(l);
    if (price == null) {
      // No qty to divide by. Anything recorded against this line has no price,
      // so it stays in "to be collected" rather than being guessed at.
      if ((l.agedVal || 0) !== 0) unpricedLines++;
      continue;
    }
    valueCollected += (l.foundQty || 0) * price;
    damages += (l.damagedQty || 0) * price;
    phantom += (l.notFoundQty || 0) * price;
    display += (l.displayQty || 0) * price;
    refused += (l.refusedQty || 0) * price;
  }

  valueToBeCollected = round2(valueToBeCollected);
  valueCollected = round2(valueCollected);
  damages = round2(damages);
  phantom = round2(phantom);
  display = round2(display);
  refused = round2(refused);

  return {
    storeName: input.storeName,
    storeCode: input.storeCode,
    province: input.province,
    refs: input.refs,
    upliftedAt: input.upliftedAt,
    clientName: input.clientName,
    vendorNumber: input.vendorNumber,
    valueToBeCollected,
    valueCollected,
    damages,
    phantom,
    display,
    refused,
    uplifted: input.uplifted,
    stbc: round2(
      valueToBeCollected - (valueCollected + damages + phantom + display + refused)
    ),
    unpricedLines,
  };
}

/** The document-number cell: every GRN/GRV for the store, as the tracker writes it. */
/**
 * The GRN/GRV numbers for one store, as one cell: `5002563167 / 5002182924`.
 *
 * A pair whose GRN has not been issued yet holds its place with an em dash
 * rather than collapsing, so this column and the Return Order column beside it
 * still line up row for row — that alignment is the only thing saying which
 * 440 belongs to which 500.
 */
export function formatDocumentNumbers(refs: StoreRef[]): string {
  const out = dedupeRefs(refs).map((r) => r.grn || '—');
  return out.every((v) => v === '—') ? '' : out.join(' / ');
}

/** The Return Order numbers for one store, aligned with formatDocumentNumbers. */
export function formatReturnOrderNumbers(refs: StoreRef[]): string {
  const out = dedupeRefs(refs).map((r) => r.returnOrder || '—');
  return out.every((v) => v === '—') ? '' : out.join(' / ');
}

/** Same pair twice on two slips for one store is one piece of paperwork. */
function dedupeRefs(refs: StoreRef[]): StoreRef[] {
  const seen = new Set<string>();
  const out: StoreRef[] = [];
  for (const r of refs) {
    const key = `${r.grn}|${r.returnOrder}`;
    if (key === '|' || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export interface StoreSummaryTotals {
  valueToBeCollected: number;
  valueCollected: number;
  damages: number;
  phantom: number;
  display: number;
  refused: number;
  /** STBC — Still to be Collected. See StoreSummaryRow.stbc. */
  stbc: number;
  /** Stores that have a pick slip at all. */
  storesIssued: number;
  /** Stores where something has been receipted. */
  storesUplifted: number;
  storesOutstanding: number;
}

export function totalStoreSummary(rows: StoreSummaryRow[]): StoreSummaryTotals {
  const t: StoreSummaryTotals = {
    valueToBeCollected: 0, valueCollected: 0, damages: 0,
    phantom: 0, display: 0, refused: 0, stbc: 0,
    storesIssued: rows.length, storesUplifted: 0, storesOutstanding: 0,
  };
  for (const r of rows) {
    t.valueToBeCollected += r.valueToBeCollected;
    t.valueCollected += r.valueCollected;
    t.damages += r.damages;
    t.phantom += r.phantom;
    t.display += r.display;
    t.refused += r.refused;
    t.stbc += r.stbc;
    if (r.uplifted) t.storesUplifted++;
  }
  t.storesOutstanding = t.storesIssued - t.storesUplifted;
  t.valueToBeCollected = round2(t.valueToBeCollected);
  t.valueCollected = round2(t.valueCollected);
  t.damages = round2(t.damages);
  t.phantom = round2(t.phantom);
  t.display = round2(t.display);
  t.refused = round2(t.refused);
  t.stbc = round2(t.stbc);
  return t;
}
