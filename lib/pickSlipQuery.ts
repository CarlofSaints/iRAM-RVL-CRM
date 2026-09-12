/**
 * The query contract for GET /api/pick-slips.
 *
 * Both the Picking Slips grid and the Reports page used to pull EVERY pick slip
 * for every client the user can see — 959 slips with all their product rows —
 * and then filter in the browser. That is why those two pages were slow: the
 * cost was paid on page load, before the user had told us what they wanted.
 *
 * The shape here is deliberately shared by the client and the route so the two
 * cannot drift. Keeping the parser in one place also means a filter added to
 * the UI is a filter the server actually honours, rather than one that silently
 * does nothing.
 */

export type PickSlipQueryMode =
  /** Filter option lists only — no pick-slip run blobs are read at all. */
  | 'facets'
  /** Slips without `rows` / `unreturnedStock`. What a grid needs. */
  | 'summary'
  /** Everything, including product rows. What a report needs. */
  | 'full';

export interface PickSlipQuery {
  mode: PickSlipQueryMode;
  /**
   * Specific slips by id. Does not reduce how many run blobs are read — there
   * is no slip → run index — but it is the difference between a detail screen
   * receiving one slip and receiving all of them.
   */
  slipIds: string[];
  clientIds: string[];
  vendorNumbers: string[];
  loadIds: string[];
  statuses: string[];
  /** Canonical province names (see lib/region.ts), not raw region codes. */
  provinces: string[];
  siteCodes: string[];
  warehouseCodes: string[];
  /**
   * Which date `from`/`to` are measured against.
   *
   *   'generated'  the day the slip was issued. What the Picking Slips grid's
   *                "Last N days" window means — the work in front of you.
   *   'signoff'    the day the delivery note was signed at the store
   *                (`deliveredAt`). A slip nobody has signed for has no such
   *                day and falls outside every window, which is the truth
   *                about it — there is no fallback here, because "not signed
   *                yet" is not a date.
   *   'uplift'     the day the stock was actually collected
   *                (`receiptGrnDate || receiptedAt`), falling back to the
   *                generated date for a slip not yet uplifted, so outstanding
   *                work still appears in the window it was issued in.
   *
   * These are different questions, and one slip answers them with dates months
   * apart: Vermont Sales' and Safe Top's entire books were issued on a single
   * day in June and uplifted through to September. A report headed "Uplifted
   * from…" but measured on the generated date returned nothing at all for them.
   */
  dateBasis: 'generated' | 'uplift' | 'signoff';
  /** Inclusive ISO dates (yyyy-mm-dd), measured against `dateBasis`. */
  from: string;
  to: string;
  /**
   * Free-text match against a slip's GRN/GRV and Return Order numbers.
   *
   * Server-side on purpose: someone holding a piece of paper knows the number
   * and usually not the client, so this has to be answerable without first
   * narrowing to a vendor — and narrowing in the browser would mean shipping
   * every slip there to do it.
   */
  refSearch: string;
}

export const EMPTY_QUERY: PickSlipQuery = {
  mode: 'summary',
  slipIds: [],
  clientIds: [],
  vendorNumbers: [],
  loadIds: [],
  statuses: [],
  provinces: [],
  siteCodes: [],
  warehouseCodes: [],
  dateBasis: 'generated',
  from: '',
  to: '',
  refSearch: '',
};

const splitCsv = (v: string | null | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s, i, a) => a.indexOf(s) === i);

/** Unknown or absent basis ⇒ 'generated', which is what every old caller meant. */
function parseDateBasis(raw: string | null): PickSlipQuery['dateBasis'] {
  return raw === 'uplift' || raw === 'signoff' ? raw : 'generated';
}

/** Parse a query string into the canonical shape. Unknown mode ⇒ 'summary'. */
export function parsePickSlipQuery(sp: URLSearchParams): PickSlipQuery {
  const rawMode = (sp.get('mode') ?? '').toLowerCase();
  const mode: PickSlipQueryMode =
    rawMode === 'facets' ? 'facets' : rawMode === 'full' ? 'full' : 'summary';

  return {
    mode,
    slipIds: splitCsv(sp.get('slipIds')),
    clientIds: splitCsv(sp.get('clientIds')),
    vendorNumbers: splitCsv(sp.get('vendorNumbers')),
    loadIds: splitCsv(sp.get('loadIds')),
    statuses: splitCsv(sp.get('statuses')),
    provinces: splitCsv(sp.get('provinces')),
    siteCodes: splitCsv(sp.get('siteCodes')),
    warehouseCodes: splitCsv(sp.get('warehouseCodes')),
    dateBasis: parseDateBasis(sp.get('dateBasis')),
    from: (sp.get('from') ?? '').trim(),
    to: (sp.get('to') ?? '').trim(),
    refSearch: (sp.get('refSearch') ?? '').trim(),
  };
}

/** Serialise a query for fetch(). Empty values are omitted entirely. */
export function pickSlipQueryToParams(q: Partial<PickSlipQuery>): string {
  const sp = new URLSearchParams();
  if (q.mode) sp.set('mode', q.mode);
  const list = (k: string, v?: string[]) => {
    if (v && v.length) sp.set(k, v.join(','));
  };
  list('slipIds', q.slipIds);
  list('clientIds', q.clientIds);
  list('vendorNumbers', q.vendorNumbers);
  list('loadIds', q.loadIds);
  list('statuses', q.statuses);
  list('provinces', q.provinces);
  list('siteCodes', q.siteCodes);
  list('warehouseCodes', q.warehouseCodes);
  if (q.dateBasis && q.dateBasis !== 'generated') sp.set('dateBasis', q.dateBasis);
  if (q.from) sp.set('from', q.from);
  if (q.to) sp.set('to', q.to);
  if (q.refSearch) sp.set('refSearch', q.refSearch);
  return sp.toString();
}

/** The subset of a slip any of these date rules needs. */
export interface SlipDates {
  generatedAt?: string;
  receiptGrnDate?: string;
  receiptedAt?: string;
  /** When the store signed the delivery note. */
  deliveredAt?: string;
}

/**
 * When a slip was UPLIFTED: the GRN/GRV date the receiver typed, else the
 * moment the receipt was captured. '' when it has not been uplifted yet.
 *
 * One definition, because the reports page prints this in its "GRN/GRV Date"
 * and "Date Uplifted" columns and the date filter selects on it — a filter that
 * disagreed with the column beside it would be indefensible.
 */
export function upliftDateOf(slip: SlipDates): string {
  return String(slip.receiptGrnDate || slip.receiptedAt || '');
}

/**
 * The day a slip counts as under a given basis, as yyyy-mm-dd.
 *
 * On the uplift basis it falls back to the generated date when the slip has not
 * been uplifted yet. That fallback is what keeps outstanding work in the window
 * it was issued in, so a store summary run over a date range still shows its
 * amber "outstanding" rows and its Uplifted percentage still means something.
 * Returns '' when the slip carries no usable date at all.
 */
export function slipDayForBasis(slip: SlipDates, basis: PickSlipQuery['dateBasis']): string {
  // No fallback on the sign-off basis: an unsigned slip has no sign-off day and
  // must fall out of the window rather than borrow the day it was printed.
  if (basis === 'signoff') return String(slip.deliveredAt ?? '').slice(0, 10);
  const uplift = basis === 'uplift' ? upliftDateOf(slip).slice(0, 10) : '';
  return uplift || String(slip.generatedAt ?? '').slice(0, 10);
}

/**
 * Is this slip inside the query's date window?
 *
 * Inclusive on both ends, compared as yyyy-mm-dd prefixes so a timezone never
 * shifts a slip out of the day the user picked. No window ⇒ everything matches.
 */
export function withinDateWindow(
  slip: SlipDates,
  q: Pick<PickSlipQuery, 'dateBasis' | 'from' | 'to'>
): boolean {
  if (!q.from && !q.to) return true;
  const day = slipDayForBasis(slip, q.dateBasis);
  if (!day) return false;
  if (q.from && day < q.from) return false;
  if (q.to && day > q.to) return false;
  return true;
}

/**
 * True when the query narrows to something worth fetching. A page renders its
 * filters and waits for this rather than pulling the whole corpus on mount.
 *
 * A date range alone counts: "everything uplifted last week" is a legitimate
 * narrow query even with no client picked.
 */
export function isQueryNarrowed(q: PickSlipQuery): boolean {
  return Boolean(
    q.slipIds.length ||
      q.clientIds.length ||
      q.vendorNumbers.length ||
      q.loadIds.length ||
      q.siteCodes.length ||
      q.provinces.length ||
      q.warehouseCodes.length ||
      q.refSearch ||
      q.from ||
      q.to
  );
}
