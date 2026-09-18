/**
 * Store references on a receipt: the GRN/GRV document number and the Return
 * Order number that belongs with it.
 *
 * These two travel together on one piece of Massbuild paperwork — DOCUMENT
 * NUMBER 5002563167 / Return Order NO 4401657532 — and the app has to keep
 * them together. They are stored as PAIRS rather than as two parallel arrays
 * for one blunt reason: **the GRN half is allowed to be empty.** An Eastern
 * Cape store is given its Return Order number when it preps the stock and only
 * gets a GRN when the courier collects, so a capture legitimately carries a
 * Return Order with no GRN beside it. Two arrays indexed by position would be
 * torn apart by the first `.filter(Boolean)` — and the write path did exactly
 * that (`storeRefs.filter(r => r.trim())`), which would have silently slid
 * every Return Order onto the wrong GRN.
 *
 * `receiptStoreRefs: string[]` is the older field. It still exists and is still
 * written, derived from the pairs, so any reader not yet migrated keeps showing
 * the GRN numbers instead of showing nothing. See
 * [denormalised-mirror-vs-source-of-truth]: `receiptRefs` is the truth,
 * `receiptStoreRefs` is a mirror written in one place and never read back as
 * authority when `receiptRefs` is present.
 */

export interface StoreRef {
  /** GRN/GRV document number — the "500…" number. May be empty. */
  grn: string;
  /** Return Order number — the "440…" number. Required on a completed receipt. */
  returnOrder: string;
}

/** The fields any slip-shaped object needs before these helpers can read it. */
export interface StoreRefSource {
  receiptRefs?: StoreRef[];
  receiptStoreRefs?: string[];
  receiptStoreRef1?: string;
  receiptStoreRef2?: string;
  receiptStoreRef3?: string;
  receiptStoreRef4?: string;
}

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Is there anything at all on this pair? */
export const isEmptyRef = (r: StoreRef): boolean => !r.grn && !r.returnOrder;

/**
 * Every store reference on a slip, newest shape first.
 *
 * Three generations of the same field are in the live data, so read them in
 * order and never merge them: `receiptRefs` (pairs) → `receiptStoreRefs`
 * (array of GRN strings) → `receiptStoreRef1..4` (the original four columns).
 * A slip captured before Return Orders existed yields pairs with an empty
 * `returnOrder`, which is the truth about it — it was never asked for one.
 */
export function readStoreRefs(slip: StoreRefSource | null | undefined): StoreRef[] {
  if (!slip) return [];

  if (Array.isArray(slip.receiptRefs) && slip.receiptRefs.length > 0) {
    return slip.receiptRefs
      .map((r) => ({ grn: clean(r?.grn), returnOrder: clean(r?.returnOrder) }))
      .filter((r) => !isEmptyRef(r));
  }

  if (Array.isArray(slip.receiptStoreRefs) && slip.receiptStoreRefs.length > 0) {
    return slip.receiptStoreRefs
      .map((g) => ({ grn: clean(g), returnOrder: '' }))
      .filter((r) => !isEmptyRef(r));
  }

  return [slip.receiptStoreRef1, slip.receiptStoreRef2, slip.receiptStoreRef3, slip.receiptStoreRef4]
    .map((g) => ({ grn: clean(g), returnOrder: '' }))
    .filter((r) => !isEmptyRef(r));
}

/**
 * Parse whatever a client sent into clean pairs.
 *
 * Accepts the pair shape and, so an older client or an integration cannot be
 * broken by this change, a bare array of GRN strings. Empty pairs are dropped:
 * the capture screen always renders at least one blank row and the user is not
 * obliged to fill a row they added by accident.
 */
export function normaliseStoreRefs(input: unknown): StoreRef[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((r): StoreRef => {
      if (typeof r === 'string') return { grn: clean(r), returnOrder: '' };
      const o = r as Partial<StoreRef> | null;
      return { grn: clean(o?.grn), returnOrder: clean(o?.returnOrder) };
    })
    .filter((r) => !isEmptyRef(r));
}

/** Just the GRN numbers, blanks dropped. What the legacy mirror holds. */
export const grnNumbersOf = (refs: StoreRef[]): string[] =>
  refs.map((r) => r.grn).filter(Boolean);

/** Just the Return Order numbers, blanks dropped. */
export const returnOrderNumbersOf = (refs: StoreRef[]): string[] =>
  refs.map((r) => r.returnOrder).filter(Boolean);

/**
 * One pair as a line of text: `5002563167 (4401657532)`.
 *
 * A missing GRN prints as `— (4401657532)` rather than as a bare number in
 * brackets. On a signed delivery note the reader has to be able to tell "this
 * stock has no GRN yet" from "this is the GRN" at a glance, and an unlabelled
 * number in brackets cannot say which of the two it is.
 */
export function formatStoreRef(ref: StoreRef): string {
  if (ref.grn && ref.returnOrder) return `${ref.grn} (${ref.returnOrder})`;
  if (ref.grn) return ref.grn;
  if (ref.returnOrder) return `— (${ref.returnOrder})`;
  return '';
}

/** Every pair on one line, comma separated. '' when there are none. */
export const formatStoreRefs = (refs: StoreRef[]): string =>
  refs.map(formatStoreRef).filter(Boolean).join(', ');

/**
 * Does any reference on this slip match what someone typed into the search box?
 *
 * Substring, case-insensitive, trimmed on both sides: these numbers are read
 * off a printed slip and retyped, so a trailing space must not decide the
 * answer, and a partial number has to find the row — the person searching is
 * often reading a fax or a photo of the paperwork. An empty needle matches
 * everything, so "no search" means "no constraint".
 */
export function matchesRefSearch(refs: StoreRef[], search: string): boolean {
  const needle = clean(search).toLowerCase();
  if (!needle) return true;
  return refs.some(
    (r) =>
      r.grn.toLowerCase().includes(needle) ||
      r.returnOrder.toLowerCase().includes(needle)
  );
}

/**
 * Why a set of references cannot be completed, or '' when it can.
 *
 * The Return Order number is the compulsory half and the GRN is not: the
 * Return Order exists from the moment the store preps the stock, while the GRN
 * is only generated when the courier collects. Enforced on the server as well
 * as in the form, because a form gate is a convenience and not a rule.
 *
 * A slip booked as "Nothing to Return" is exempt: no stock went back, so the
 * store never raised a Return Order, and the rule made it impossible to
 * capture the uplift detail and close the slip (18 Sep 2026). Pass the slip's
 * STORED flag, never one the client sends.
 */
export function storeRefCompletionError(refs: StoreRef[], opts: { nothingToReturn?: boolean } = {}): string {
  if (opts.nothingToReturn) return '';
  if (refs.length === 0) {
    return 'Add at least one Return Order number before completing the receipt.';
  }
  const missing = refs.filter((r) => !r.returnOrder);
  if (missing.length > 0) {
    const which = missing.map((r) => r.grn || '(blank)').join(', ');
    return missing.length === refs.length
      ? 'A Return Order number is required on every store reference.'
      : `A Return Order number is required on every store reference — missing for ${which}.`;
  }
  return '';
}
