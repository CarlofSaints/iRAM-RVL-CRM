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
  /** Inclusive ISO dates (yyyy-mm-dd) against the slip's generated date. */
  from: string;
  to: string;
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
  from: '',
  to: '',
};

const splitCsv = (v: string | null | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s, i, a) => a.indexOf(s) === i);

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
    from: (sp.get('from') ?? '').trim(),
    to: (sp.get('to') ?? '').trim(),
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
  if (q.from) sp.set('from', q.from);
  if (q.to) sp.set('to', q.to);
  return sp.toString();
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
      q.from ||
      q.to
  );
}
