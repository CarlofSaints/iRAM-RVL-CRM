'use client';

/**
 * Reports.
 *
 * Filter-first: the page renders instantly with its filter bar and fetches
 * NOTHING until the user says what they want. Previously it pulled every pick
 * slip for every client the user could see — with all product rows — on the
 * moment a report was opened, which is why it took so long to appear.
 *
 * The filter options come from `mode=facets`, which reads only control files
 * and the per-client load index; no pick-slip blob is touched. Running the
 * report then fetches `mode=full` narrowed to exactly what was ticked.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';
import { MultiSelect, type MultiSelectOption } from '@/components/MultiSelect';
import { pickSlipQueryToParams } from '@/lib/pickSlipQuery';
import {
  exportReport,
  EXCEL_VIEW_LABELS,
  type ExcelViewMode,
  type ReportGroup,
} from '@/lib/reportExport';
import {
  summariseStore,
  totalStoreSummary,
  formatDocumentNumbers,
  type StoreSummaryRow,
  type UpliftLine,
} from '@/lib/storeSummary';

// ── Types ────────────────────────────────────────────────────────────────────

interface PdfRow {
  barcode: string;
  articleCode: string;
  vendorProductCode: string;
  description: string;
  qty: number;
  val: number;
}

interface UnreturnedRow {
  articleCode: string;
  description: string;
  pickSlipQty: number;
  display: number;
  storeRefused: number;
  notFound: number;
  damaged: number;
}

interface SlipDto {
  id: string;
  loadId: string;
  clientId: string;
  clientName: string;
  vendorNumber: string;
  siteCode: string;
  siteName: string;
  /** Canonical province, resolved server-side from the store record. */
  province?: string;
  warehouse: string;
  totalQty: number;
  totalVal: number;
  status: string;
  generatedAt: string;
  receiptStoreRefs?: string[];
  receiptGrnDate?: string;
  receiptedAt?: string;
  manual?: boolean;
  rows: PdfRow[];
  unreturnedStock?: UnreturnedRow[];
  unreturnedSkipped?: boolean;
}

interface Facets {
  clients: Array<{ id: string; name: string; vendorNumbers: string[] }>;
  batches: Array<{
    loadId: string; clientId: string; clientName: string;
    vendorNumbers: string[]; fileName: string; loadedAt: string; rowCount: number;
  }>;
  provinces: string[];
  stores: Array<{ siteCode: string; name: string; province: string }>;
  statuses: string[];
  warehouses: Array<{ id: string; code: string; name: string }>;
}

interface ReportRow {
  pickSlipId: string;
  grnRef1: string;
  grnRef2: string;
  grnRef3: string;
  grnRef4: string;
  clientName: string;
  vendorNumber: string;
  storeName: string;
  storeCode: string;
  grnDateTime: string;
  vendorProductCode: string;
  articleCode: string;
  description: string;
  agedQty: number;
  agedVal: number;
  foundQty: number;
  displayQty: number;
  refusedQty: number;
  notFoundQty: number;
  damagedQty: number;
}

type ReportId = 'uplift-detail' | 'store-summary';

const REPORTS: Array<{ id: ReportId; label: string; description: string }> = [
  {
    id: 'uplift-detail',
    label: 'Uplift Detail Report',
    description: 'Per-product breakdown of aged stock uplifts — found, display, refused, not found, damages — for export to clients.',
  },
  {
    id: 'store-summary',
    label: 'Consolidated Store Report',
    description: 'One row per store in RANDS — value to be collected, collected, damages and possible phantom stock, with every GRN/GRV number in one cell.',
  },
];

const REPORT_TITLE: Record<ReportId, string> = {
  'uplift-detail': 'Uplift Detail Report',
  'store-summary': 'Consolidated Store Report',
};

/**
 * How a report is split when exporting to separate sheets or documents.
 * Only dimensions a report row actually carries — a split on something the row
 * cannot answer would quietly put everything in one group.
 */
type SplitBy = 'client' | 'vendor' | 'store';
const SPLIT_LABELS: Record<SplitBy, string> = {
  client: 'Client',
  vendor: 'Vendor number',
  store: 'Store',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const fmtDate = (iso: string) => {
  try { return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
  catch { return iso; }
};

const fmtDateTime = (iso: string) => {
  try {
    const d = new Date(iso);
    const tz = 'Africa/Johannesburg';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: tz })
      + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  } catch { return iso; }
};

const fmtCurrency = (v: number) =>
  `R ${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Keep only the ticked values that still exist in the visible options. */
function pruneToOptions(selected: Set<string>, options: MultiSelectOption[]): Set<string> {
  const allowed = new Set(options.map((o) => o.value));
  const next = new Set([...selected].filter((v) => allowed.has(v)));
  return next.size === selected.size ? selected : next;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const { session } = useAuth('view_aged_stock');

  const [toast, setToast] = useState<ToastData | null>(null);
  const notify = (message: string, type: 'success' | 'error' = 'success') => setToast({ message, type });

  const [selectedReport, setSelectedReport] = useState<ReportId | null>(null);

  // Filter options — cheap, no pick-slip blobs read.
  const [facets, setFacets] = useState<Facets | null>(null);
  const [facetsLoading, setFacetsLoading] = useState(false);

  // Filter state
  const [clientIds, setClientIds] = useState<Set<string>>(new Set());
  const [vendorNumbers, setVendorNumbers] = useState<Set<string>>(new Set());
  const [loadIds, setLoadIds] = useState<Set<string>>(new Set());
  const [provinces, setProvinces] = useState<Set<string>>(new Set());
  const [siteCodes, setSiteCodes] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Set<string>>(new Set());
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  // Results — only populated after Run report.
  const [slips, setSlips] = useState<SlipDto[] | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState('');
  const [ranWith, setRanWith] = useState('');

  // Export options
  const [excelMode, setExcelMode] = useState<ExcelViewMode>('combined');
  const [splitBy, setSplitBy] = useState<SplitBy>('vendor');
  const [exporting, setExporting] = useState(false);

  // ── Facets ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!session || !selectedReport || facets || facetsLoading) return;
    setFacetsLoading(true);
    (async () => {
      try {
        const res = await authFetch(`/api/pick-slips?${pickSlipQueryToParams({ mode: 'facets' })}`, { cache: 'no-store' });
        if (res.ok) setFacets(await res.json());
        else notify('Could not load the filter options', 'error');
      } catch {
        notify('Network error loading the filter options', 'error');
      } finally {
        setFacetsLoading(false);
      }
    })();
  }, [session, selectedReport, facets, facetsLoading]);

  // ── Filter options, each following the ones above it ──────────────────────
  const clientOptions = useMemo<MultiSelectOption[]>(
    () => (facets?.clients ?? []).map((c) => ({
      value: c.id,
      label: c.name,
      hint: (c.vendorNumbers ?? []).join(', '),
    })),
    [facets]
  );

  // Vendors of the chosen clients. Choosing a client must narrow this list, or
  // the user can tick a vendor that cannot appear in the result.
  const vendorOptions = useMemo<MultiSelectOption[]>(() => {
    const pool = (facets?.clients ?? []).filter((c) => clientIds.size === 0 || clientIds.has(c.id));
    const byVendor = new Map<string, string[]>();
    for (const c of pool) {
      for (const v of c.vendorNumbers ?? []) {
        if (!v) continue;
        const names = byVendor.get(v) ?? [];
        if (!names.includes(c.name)) names.push(c.name);
        byVendor.set(v, names);
      }
    }
    return [...byVendor.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([v, names]) => ({ value: v, label: v, hint: names.join(', ') }));
  }, [facets, clientIds]);

  const batchOptions = useMemo<MultiSelectOption[]>(() => {
    const pool = (facets?.batches ?? []).filter((b) => {
      if (clientIds.size && !clientIds.has(b.clientId)) return false;
      if (vendorNumbers.size && !(b.vendorNumbers ?? []).some((v) => vendorNumbers.has(v))) return false;
      return true;
    });
    return pool.map((b) => ({
      value: b.loadId,
      label: b.clientName,
      hint: `${fmtDate(b.loadedAt)} · ${b.rowCount.toLocaleString()} rows${b.fileName ? ` · ${b.fileName}` : ''}`,
    }));
  }, [facets, clientIds, vendorNumbers]);

  const provinceOptions = useMemo<MultiSelectOption[]>(
    () => (facets?.provinces ?? []).map((p) => ({ value: p, label: p })), [facets]
  );

  // Stores follow the province selection, so picking Gauteng does not leave 719
  // stores in the list to scroll through.
  const storeOptions = useMemo<MultiSelectOption[]>(
    () =>
      (facets?.stores ?? [])
        .filter((s) => provinces.size === 0 || provinces.has(s.province))
        .map((s) => ({
          value: s.siteCode,
          label: s.name || s.siteCode,
          hint: [s.siteCode, s.province].filter(Boolean).join(' · '),
        })),
    [facets, provinces]
  );
  const statusOptions = useMemo<MultiSelectOption[]>(
    () => (facets?.statuses ?? []).map((s) => ({ value: s, label: s })), [facets]
  );

  // A ticked option that is no longer visible still filters, silently. Drop it
  // whenever the list above it changes.
  useEffect(() => { setVendorNumbers((p) => pruneToOptions(p, vendorOptions)); }, [vendorOptions]);
  useEffect(() => { setLoadIds((p) => pruneToOptions(p, batchOptions)); }, [batchOptions]);
  useEffect(() => { setSiteCodes((p) => pruneToOptions(p, storeOptions)); }, [storeOptions]);

  const hasFilter =
    clientIds.size > 0 || vendorNumbers.size > 0 || loadIds.size > 0 ||
    provinces.size > 0 || siteCodes.size > 0 || Boolean(from) || Boolean(to);

  // ── Run ───────────────────────────────────────────────────────────────────
  const runReport = useCallback(async () => {
    setRunning(true);
    setRunError('');
    const qs = pickSlipQueryToParams({
      mode: 'full',
      clientIds: [...clientIds],
      vendorNumbers: [...vendorNumbers],
      loadIds: [...loadIds],
      provinces: [...provinces],
      siteCodes: [...siteCodes],
      statuses: [...statuses],
      from, to,
    });
    try {
      const res = await authFetch(`/api/pick-slips?${qs}`, { cache: 'no-store' });
      const data = await res.json();
      if (res.ok) {
        setSlips(data.slips ?? []);
        setRanWith(new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
      } else {
        setRunError(data.error || 'The report could not be run.');
      }
    } catch {
      setRunError('Network error running the report.');
    } finally {
      setRunning(false);
    }
  }, [clientIds, vendorNumbers, loadIds, provinces, siteCodes, statuses, from, to]);

  const resetFilters = () => {
    setClientIds(new Set()); setVendorNumbers(new Set()); setLoadIds(new Set());
    setProvinces(new Set()); setSiteCodes(new Set()); setStatuses(new Set()); setFrom(''); setTo('');
    setSlips(null); setRunError('');
  };

  // ── Rows ──────────────────────────────────────────────────────────────────
  const reportRows = useMemo<ReportRow[]>(() => {
    if (!slips) return [];
    const rows: ReportRow[] = [];
    for (const slip of slips) {
      const refs = slip.receiptStoreRefs ?? [];
      const grnDate = slip.receiptGrnDate || slip.receiptedAt || '';
      for (const row of slip.rows ?? []) {
        const ur = (slip.unreturnedStock ?? []).find((u) => u.articleCode === row.articleCode);
        const displayQty = ur?.display ?? 0;
        const refusedQty = ur?.storeRefused ?? 0;
        const notFoundQty = ur?.notFound ?? 0;
        const damagedQty = ur?.damaged ?? 0;
        const foundQty = ur ? ur.pickSlipQty - (displayQty + refusedQty + notFoundQty + damagedQty) : 0;
        rows.push({
          pickSlipId: slip.id,
          grnRef1: refs[0] ?? '', grnRef2: refs[1] ?? '', grnRef3: refs[2] ?? '', grnRef4: refs[3] ?? '',
          clientName: slip.clientName,
          vendorNumber: slip.vendorNumber,
          storeName: slip.siteName,
          storeCode: slip.siteCode,
          grnDateTime: grnDate ? fmtDateTime(grnDate) : '',
          vendorProductCode: row.vendorProductCode || '',
          articleCode: row.articleCode,
          description: row.description,
          agedQty: row.qty,
          agedVal: row.val,
          foundQty: Math.max(0, foundQty),
          displayQty, refusedQty, notFoundQty, damagedQty,
        });
      }
    }
    return rows;
  }, [slips]);

  const totals = useMemo(() => {
    const t = { agedQty: 0, agedVal: 0, foundQty: 0, displayQty: 0, refusedQty: 0, notFoundQty: 0, damagedQty: 0 };
    for (const r of reportRows) {
      t.agedQty += r.agedQty; t.agedVal += r.agedVal; t.foundQty += r.foundQty;
      t.displayQty += r.displayQty; t.refusedQty += r.refusedQty;
      t.notFoundQty += r.notFoundQty; t.damagedQty += r.damagedQty;
    }
    return t;
  }, [reportRows]);

  // ── Consolidated store report ─────────────────────────────────────────────
  // One row per store, consolidated across every slip for that store, in rands.
  const storeRows = useMemo<StoreSummaryRow[]>(() => {
    if (!slips) return [];
    interface Bucket {
      storeName: string; storeCode: string; province: string;
      clientName: string; vendorNumber: string;
      docs: string[]; upliftedAt?: string; uplifted: boolean;
      lines: UpliftLine[];
    }
    const byStore = new Map<string, Bucket>();

    for (const slip of slips) {
      // A store is only the same store within the same vendor account — the
      // same physical shop can be served under two vendor numbers and those
      // are different pieces of paper.
      const key = `${slip.vendorNumber}|${slip.siteCode}`;
      let b = byStore.get(key);
      if (!b) {
        b = {
          storeName: slip.siteName, storeCode: slip.siteCode,
          province: slip.province ?? '',
          clientName: slip.clientName, vendorNumber: slip.vendorNumber,
          docs: [], uplifted: false, lines: [],
        };
        byStore.set(key, b);
      }
      for (const ref of slip.receiptStoreRefs ?? []) if (ref) b.docs.push(ref);

      const when = slip.receiptGrnDate || slip.receiptedAt;
      if (when) {
        b.uplifted = true;
        // Earliest uplift date for the store — the tracker records when the
        // collection happened, and a later correction should not move it.
        if (!b.upliftedAt || when < b.upliftedAt) b.upliftedAt = when;
      }

      for (const row of slip.rows ?? []) {
        const ur = (slip.unreturnedStock ?? []).find((u) => u.articleCode === row.articleCode);
        const displayQty = ur?.display ?? 0;
        const refusedQty = ur?.storeRefused ?? 0;
        const notFoundQty = ur?.notFound ?? 0;
        const damagedQty = ur?.damaged ?? 0;
        const foundQty = ur
          ? Math.max(0, ur.pickSlipQty - (displayQty + refusedQty + notFoundQty + damagedQty))
          : 0;
        b.lines.push({
          articleCode: row.articleCode,
          description: row.description,
          agedQty: row.qty,
          agedVal: row.val,
          foundQty, displayQty, refusedQty, notFoundQty, damagedQty,
        });
      }
    }

    return [...byStore.values()]
      .map((b) =>
        summariseStore({
          storeName: b.storeName, storeCode: b.storeCode, province: b.province,
          documentNumbers: b.docs, upliftedAt: b.upliftedAt,
          clientName: b.clientName, vendorNumber: b.vendorNumber,
          lines: b.lines, uplifted: b.uplifted,
        })
      )
      // Highest value collected first, exactly how the tracker is sorted.
      .sort((a, b) => b.valueCollected - a.valueCollected || a.storeName.localeCompare(b.storeName));
  }, [slips]);

  const storeTotals = useMemo(() => totalStoreSummary(storeRows), [storeRows]);

  // ── Export ────────────────────────────────────────────────────────────────
  const excelRow = (r: ReportRow) => ({
    'Picking Slip #': r.pickSlipId,
    'GRN/GRV #1': r.grnRef1,
    'GRN/GRV #2': r.grnRef2,
    'GRN/GRV #3': r.grnRef3,
    'GRN/GRV #4': r.grnRef4,
    'Client': r.clientName,
    'Vendor #': r.vendorNumber,
    'Store Name': r.storeName,
    'Store Code': r.storeCode,
    'GRN/GRV Date/Time': r.grnDateTime,
    'Product Code': r.vendorProductCode,
    'Article Number': r.articleCode,
    'Product Description': r.description,
    'Aged Qty': r.agedQty,
    'Aged Stock Value': r.agedVal,
    'Found Qty': r.foundQty,
    'Display Qty': r.displayQty,
    'Refused Qty': r.refusedQty,
    'Not Found Qty': r.notFoundQty,
    'Damages Qty': r.damagedQty,
  });

  /** One consolidated-store row, laid out like the tracker. */
  const storeExcelRow = (r: StoreSummaryRow) => ({
    'Store Name': r.storeName,
    'Site Code': r.storeCode,
    'Province': r.province,
    'Document Number(s)': formatDocumentNumbers(r.documentNumbers),
    'Date Uplifted': r.upliftedAt ? fmtDate(r.upliftedAt) : '',
    'Value to be Collected': r.valueToBeCollected,
    'Value Collected': r.valueCollected,
    'Damages': r.damages,
    'Possible Phantom Stock': r.phantom,
    'Display': r.display,
    'Store Refused': r.refused,
    'STBC (Still to be Collected)': r.stbc,
    'Client': r.clientName,
    'Vendor #': r.vendorNumber,
  });

  const isStoreReport = selectedReport === 'store-summary';
  const outputRowCount = isStoreReport ? storeRows.length : reportRows.length;

  const groupKeyOf = (r: { clientName: string; vendorNumber: string; storeName: string; storeCode: string }): string => {
    switch (splitBy) {
      case 'client': return r.clientName || 'Unknown client';
      case 'vendor': return r.vendorNumber || 'No vendor';
      case 'store': return `${r.storeName}${r.storeCode ? ` ${r.storeCode}` : ''}`.trim() || 'Unknown store';
    }
  };

  async function doExport() {
    if (outputRowCount === 0) { notify('Run the report first', 'error'); return; }
    setExporting(true);
    try {
      const source: Array<{ clientName: string; vendorNumber: string; storeName: string; storeCode: string }> =
        isStoreReport ? storeRows : reportRows;
      const toExcel = (r: unknown) =>
        isStoreReport ? storeExcelRow(r as StoreSummaryRow) : excelRow(r as ReportRow);

      const byGroup = new Map<string, typeof source>();
      for (const r of source) {
        const k = groupKeyOf(r);
        const bucket = byGroup.get(k);
        if (bucket) bucket.push(r);
        else byGroup.set(k, [r]);
      }
      const groups: ReportGroup[] = [...byGroup.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, rs]) => ({ name, rows: rs.map(toExcel) }));

      // Combined mode ignores the split entirely unless it needs the label column.
      const res = await exportReport({
        mode: excelMode,
        groups: excelMode === 'combined'
          ? [{ name: 'Report', rows: source.map(toExcel) }]
          : groups,
        baseName: `${REPORT_TITLE[selectedReport!]} - ${new Date().toISOString().slice(0, 10)}`,
        splitColumn: SPLIT_LABELS[splitBy],
      });
      notify(
        res.files === 1
          ? `Exported ${res.rows.toLocaleString()} rows`
          : `Exported ${res.rows.toLocaleString()} rows across ${res.files} documents`
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Export failed', 'error');
    } finally {
      setExporting(false);
    }
  }

  if (!session) return null;

  return (
    <>
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Reports</h1>
          <p className="text-sm text-gray-600 mt-1">Generate and export reports</p>
        </div>
      </div>

      {/* Report menu */}
      {!selectedReport && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {REPORTS.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelectedReport(r.id)}
              className="bg-white border border-gray-200 rounded-lg p-5 text-left hover:border-[var(--color-primary)] hover:shadow-sm transition-all group"
            >
              <div className="flex items-center gap-3 mb-2">
                <div className="w-8 h-8 rounded-lg bg-[var(--color-primary)]/10 flex items-center justify-center shrink-0">
                  <svg className="w-4 h-4 text-[var(--color-primary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <h2 className="text-sm font-bold text-gray-900 group-hover:text-[var(--color-primary)]">{r.label}</h2>
              </div>
              <p className="text-xs text-gray-500 leading-relaxed">{r.description}</p>
            </button>
          ))}
        </div>
      )}

      {selectedReport && (
        <>
          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={() => { setSelectedReport(null); resetFilters(); }}
              className="p-1.5 text-gray-400 hover:text-gray-700 rounded-md hover:bg-gray-100"
              title="Back to reports"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h2 className="text-lg font-bold text-gray-900">{REPORT_TITLE[selectedReport]}</h2>
          </div>

          {/* Filters */}
          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
            <div className="flex flex-wrap items-end gap-3">
              <MultiSelect
                label="Client"
                options={clientOptions}
                selected={clientIds}
                onChange={setClientIds}
                placeholder={facetsLoading ? 'Loading…' : 'All clients'}
                disabled={facetsLoading}
                widthClass="min-w-[15rem]"
              />
              <MultiSelect
                label="Vendor number"
                options={vendorOptions}
                selected={vendorNumbers}
                onChange={setVendorNumbers}
                placeholder="All vendors"
                disabled={facetsLoading}
                widthClass="min-w-[12rem]"
              />
              <MultiSelect
                label="Aged stock batch"
                options={batchOptions}
                selected={loadIds}
                onChange={setLoadIds}
                placeholder="All batches"
                disabled={facetsLoading}
                widthClass="min-w-[16rem]"
              />
              <MultiSelect
                label="Province"
                options={provinceOptions}
                selected={provinces}
                onChange={setProvinces}
                placeholder="All provinces"
                disabled={facetsLoading}
                widthClass="min-w-[11rem]"
              />
              <MultiSelect
                label="Store"
                options={storeOptions}
                selected={siteCodes}
                onChange={setSiteCodes}
                placeholder="All stores"
                disabled={facetsLoading}
                widthClass="min-w-[14rem]"
              />
              <MultiSelect
                label="Status"
                options={statusOptions}
                selected={statuses}
                onChange={setStatuses}
                placeholder="All statuses"
                disabled={facetsLoading}
                widthClass="min-w-[11rem]"
              />
              <div>
                <label className="block text-xs text-gray-600 mb-1">Uplifted from</label>
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                  className="px-3 py-1.5 border border-gray-300 rounded-md text-sm" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">to</label>
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                  className="px-3 py-1.5 border border-gray-300 rounded-md text-sm" />
              </div>

              <button
                onClick={runReport}
                disabled={running || facetsLoading}
                className="px-5 py-1.5 rounded-md text-sm font-semibold bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-50"
              >
                {running ? 'Running…' : 'Run report'}
              </button>
              {(hasFilter || slips) && (
                <button onClick={resetFilters} className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700">
                  Reset
                </button>
              )}
            </div>

            {!hasFilter && (
              <p className="text-xs text-gray-500 mt-3">
                Running with no filters pulls every pick slip you can see, which is slow.
                Pick a client, a batch or a date range first.
              </p>
            )}
          </div>

          {/* Export bar — only once there is something to export */}
          {outputRowCount > 0 && (
            <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4 flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Excel view</label>
                <select
                  value={excelMode}
                  onChange={(e) => setExcelMode(e.target.value as ExcelViewMode)}
                  className="px-3 py-1.5 border border-gray-300 rounded-md text-sm bg-white min-w-[16rem]"
                >
                  {(Object.keys(EXCEL_VIEW_LABELS) as ExcelViewMode[]).map((m) => (
                    <option key={m} value={m}>{EXCEL_VIEW_LABELS[m]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">
                  {excelMode === 'combined' ? 'Label column' : 'Split by'}
                </label>
                <select
                  value={splitBy}
                  onChange={(e) => setSplitBy(e.target.value as SplitBy)}
                  className="px-3 py-1.5 border border-gray-300 rounded-md text-sm bg-white"
                >
                  {(Object.keys(SPLIT_LABELS) as SplitBy[])
                    .map((s) => <option key={s} value={s}>{SPLIT_LABELS[s]}</option>)}
                </select>
              </div>
              <button
                onClick={doExport}
                disabled={exporting}
                className="px-4 py-1.5 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1.5"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                {exporting ? 'Exporting…' : 'Export to Excel'}
              </button>
              <span className="text-xs text-gray-500 ml-auto">
                {outputRowCount.toLocaleString()} row{outputRowCount !== 1 ? 's' : ''}
                {slips ? ` from ${slips.length.toLocaleString()} slip${slips.length !== 1 ? 's' : ''}` : ''}
                {ranWith ? ` · run at ${ranWith}` : ''}
              </span>
            </div>
          )}

          {runError && (
            <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 mb-4 flex items-start gap-3">
              <span className="flex-1">{runError}</span>
              <button onClick={() => setRunError('')} className="text-red-500 hover:text-red-700">Dismiss</button>
            </div>
          )}

          {/* Empty state */}
          {!slips && !running && (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-12 text-center">
              <svg className="w-10 h-10 text-gray-300 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
              </svg>
              <p className="text-sm text-gray-500">Choose your filters and hit <span className="font-medium">Run report</span>.</p>
              <p className="text-xs text-gray-400 mt-1">Nothing is fetched until you do.</p>
            </div>
          )}

          {running && (
            <div className="bg-white border border-gray-200 rounded-lg p-12 text-center text-sm text-gray-500">
              Fetching the slips you asked for…
            </div>
          )}

          {/* Consolidated store report */}
          {slips && !running && isStoreReport && (
            <>
              {/* The tracker's footer stats, which are the first thing anyone reads. */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                {[
                  { n: storeTotals.storesIssued.toLocaleString(), l: 'Stores issued', c: 'text-gray-800' },
                  {
                    n: `${storeTotals.storesUplifted.toLocaleString()}${storeTotals.storesIssued ? ` · ${Math.round((storeTotals.storesUplifted / storeTotals.storesIssued) * 100)}%` : ''}`,
                    l: 'Uplifted', c: 'text-emerald-600',
                  },
                  {
                    n: `${storeTotals.storesOutstanding.toLocaleString()}${storeTotals.storesIssued ? ` · ${Math.round((storeTotals.storesOutstanding / storeTotals.storesIssued) * 100)}%` : ''}`,
                    l: 'Outstanding', c: 'text-amber-600',
                  },
                  { n: fmtCurrency(storeTotals.valueCollected), l: 'Value collected', c: 'text-gray-800' },
                ].map((s) => (
                  <div key={s.l} className="bg-white rounded-lg border border-gray-200 p-4 text-center">
                    <div className={`text-xl font-bold ${s.c}`}>{s.n}</div>
                    <div className="text-xs text-gray-500">{s.l}</div>
                  </div>
                ))}
              </div>

              {storeRows.some((r) => r.unpricedLines > 0) && (
                <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-3 mb-4">
                  {storeRows.reduce((t, r) => t + r.unpricedLines, 0)} product line
                  {storeRows.reduce((t, r) => t + r.unpricedLines, 0) === 1 ? ' has' : 's have'} a
                  value but no quantity, so no unit price could be derived. Their value stays under
                  &ldquo;to be collected&rdquo; and is not split across the brackets.
                </div>
              )}

              {/* The STBC column is abbreviated to keep it narrow, so the expansion
                  has to live next to the table — a reader should never have to
                  guess at a column heading. The Excel export spells it out in
                  the header itself, since that file leaves the app. */}
              <p className="text-xs text-gray-500 mb-2">
                <span className="font-semibold text-gray-700">STBC</span> = Still to be Collected —
                value on the pick slip that has not yet been bracketed as collected, damaged,
                phantom, display or refused.
              </p>

              <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <div className="max-h-[70vh] overflow-auto">
                  <table className="min-w-full text-xs">
                    <thead className="bg-gray-50 sticky top-0 z-10">
                      <tr className="text-left text-[10px] font-semibold text-gray-600 uppercase tracking-wide">
                        <th className="px-2 py-2 whitespace-nowrap">Store Name</th>
                        <th className="px-2 py-2 whitespace-nowrap">Site Code</th>
                        <th className="px-2 py-2 whitespace-nowrap">Province</th>
                        <th className="px-2 py-2">Document Number(s)</th>
                        <th className="px-2 py-2 whitespace-nowrap">Date Uplifted</th>
                        <th className="px-2 py-2 text-right whitespace-nowrap">Value to be Collected</th>
                        <th className="px-2 py-2 text-right whitespace-nowrap">Value Collected</th>
                        <th className="px-2 py-2 text-right whitespace-nowrap">Damages</th>
                        <th className="px-2 py-2 text-right whitespace-nowrap">Possible Phantom</th>
                        <th className="px-2 py-2 text-right whitespace-nowrap">Display</th>
                        <th className="px-2 py-2 text-right whitespace-nowrap">Refused</th>
                        <th className="px-2 py-2 text-right whitespace-nowrap" title="Still to be Collected">STBC</th>
                      </tr>
                    </thead>
                    <tbody>
                      {storeRows.length === 0 ? (
                        <tr><td colSpan={12} className="px-3 py-8 text-center text-gray-500 text-sm">
                          Nothing matched those filters.
                        </td></tr>
                      ) : (
                        <>
                          {storeRows.map((r) => (
                            <tr key={`${r.vendorNumber}|${r.storeCode}`} className="border-t border-gray-100 hover:bg-gray-50">
                              <td className="px-2 py-1.5 whitespace-nowrap font-medium text-gray-800">{r.storeName}</td>
                              <td className="px-2 py-1.5 whitespace-nowrap">{r.storeCode}</td>
                              <td className="px-2 py-1.5 whitespace-nowrap text-gray-500">{r.province || '—'}</td>
                              <td className="px-2 py-1.5 max-w-[260px] truncate" title={formatDocumentNumbers(r.documentNumbers)}>
                                {formatDocumentNumbers(r.documentNumbers) || <span className="text-gray-300">—</span>}
                              </td>
                              <td className="px-2 py-1.5 whitespace-nowrap text-gray-500">
                                {r.upliftedAt ? fmtDate(r.upliftedAt) : <span className="text-amber-600">outstanding</span>}
                              </td>
                              <td className="px-2 py-1.5 text-right whitespace-nowrap">{fmtCurrency(r.valueToBeCollected)}</td>
                              <td className={`px-2 py-1.5 text-right whitespace-nowrap ${r.valueCollected > 0 ? 'text-emerald-600 font-medium' : 'text-gray-300'}`}>{fmtCurrency(r.valueCollected)}</td>
                              <td className={`px-2 py-1.5 text-right whitespace-nowrap ${r.damages > 0 ? 'text-red-600' : 'text-gray-300'}`}>{fmtCurrency(r.damages)}</td>
                              <td className={`px-2 py-1.5 text-right whitespace-nowrap ${r.phantom > 0 ? 'text-orange-600' : 'text-gray-300'}`}>{fmtCurrency(r.phantom)}</td>
                              <td className={`px-2 py-1.5 text-right whitespace-nowrap ${r.display > 0 ? 'text-blue-600' : 'text-gray-300'}`}>{fmtCurrency(r.display)}</td>
                              <td className={`px-2 py-1.5 text-right whitespace-nowrap ${r.refused > 0 ? 'text-amber-600' : 'text-gray-300'}`}>{fmtCurrency(r.refused)}</td>
                              <td className={`px-2 py-1.5 text-right whitespace-nowrap ${Math.abs(r.stbc) > 0.01 ? 'text-gray-700' : 'text-gray-300'}`}>{fmtCurrency(r.stbc)}</td>
                            </tr>
                          ))}
                          <tr className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                            <td colSpan={5} className="px-2 py-2 text-right text-xs text-gray-700">TOTAL</td>
                            <td className="px-2 py-2 text-right whitespace-nowrap">{fmtCurrency(storeTotals.valueToBeCollected)}</td>
                            <td className="px-2 py-2 text-right whitespace-nowrap text-emerald-600">{fmtCurrency(storeTotals.valueCollected)}</td>
                            <td className="px-2 py-2 text-right whitespace-nowrap text-red-600">{fmtCurrency(storeTotals.damages)}</td>
                            <td className="px-2 py-2 text-right whitespace-nowrap text-orange-600">{fmtCurrency(storeTotals.phantom)}</td>
                            <td className="px-2 py-2 text-right whitespace-nowrap text-blue-600">{fmtCurrency(storeTotals.display)}</td>
                            <td className="px-2 py-2 text-right whitespace-nowrap text-amber-600">{fmtCurrency(storeTotals.refused)}</td>
                            <td className="px-2 py-2 text-right whitespace-nowrap">{fmtCurrency(storeTotals.stbc)}</td>
                          </tr>
                        </>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {/* Report grid */}
          {slips && !running && !isStoreReport && (
            <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <div className="max-h-[70vh] overflow-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-50 sticky top-0 z-10">
                    <tr className="text-left text-[10px] font-semibold text-gray-600 uppercase tracking-wide">
                      <th className="px-2 py-2 whitespace-nowrap">Pick Slip #</th>
                      <th className="px-2 py-2 whitespace-nowrap">GRN/GRV #1</th>
                      <th className="px-2 py-2 whitespace-nowrap">GRN/GRV #2</th>
                      <th className="px-2 py-2 whitespace-nowrap">GRN/GRV #3</th>
                      <th className="px-2 py-2 whitespace-nowrap">GRN/GRV #4</th>
                      <th className="px-2 py-2 whitespace-nowrap">Vendor</th>
                      <th className="px-2 py-2 whitespace-nowrap">Store</th>
                      <th className="px-2 py-2 whitespace-nowrap">GRN/GRV Date</th>
                      <th className="px-2 py-2 whitespace-nowrap">Product Code</th>
                      <th className="px-2 py-2 whitespace-nowrap">Article #</th>
                      <th className="px-2 py-2">Description</th>
                      <th className="px-2 py-2 text-right whitespace-nowrap">Aged Qty</th>
                      <th className="px-2 py-2 text-right whitespace-nowrap">Aged Value</th>
                      <th className="px-2 py-2 text-right whitespace-nowrap">Found Qty</th>
                      <th className="px-2 py-2 text-right whitespace-nowrap">Display Qty</th>
                      <th className="px-2 py-2 text-right whitespace-nowrap">Refused Qty</th>
                      <th className="px-2 py-2 text-right whitespace-nowrap">Not Found Qty</th>
                      <th className="px-2 py-2 text-right whitespace-nowrap">Damages Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportRows.length === 0 ? (
                      <tr><td colSpan={18} className="px-3 py-8 text-center text-gray-500 text-sm">
                        Nothing matched those filters.
                      </td></tr>
                    ) : (
                      <>
                        {reportRows.map((r, i) => (
                          <tr key={i} className="border-t border-gray-100 hover:bg-gray-50">
                            <td className="px-2 py-1.5 whitespace-nowrap font-mono text-[10px]">{r.pickSlipId}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap">{r.grnRef1}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap">{r.grnRef2}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap">{r.grnRef3}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap">{r.grnRef4}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap text-gray-500">{r.vendorNumber}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap">{r.storeName} ({r.storeCode})</td>
                            <td className="px-2 py-1.5 whitespace-nowrap text-gray-500">{r.grnDateTime}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap">{r.vendorProductCode}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap">{r.articleCode}</td>
                            <td className="px-2 py-1.5 max-w-[200px] truncate" title={r.description}>{r.description}</td>
                            <td className="px-2 py-1.5 text-right whitespace-nowrap">{r.agedQty.toLocaleString()}</td>
                            <td className="px-2 py-1.5 text-right whitespace-nowrap">{fmtCurrency(r.agedVal)}</td>
                            <td className={`px-2 py-1.5 text-right whitespace-nowrap ${r.foundQty > 0 ? 'text-emerald-600 font-medium' : ''}`}>{r.foundQty.toLocaleString()}</td>
                            <td className={`px-2 py-1.5 text-right whitespace-nowrap ${r.displayQty > 0 ? 'text-blue-600' : ''}`}>{r.displayQty.toLocaleString()}</td>
                            <td className={`px-2 py-1.5 text-right whitespace-nowrap ${r.refusedQty > 0 ? 'text-amber-600' : ''}`}>{r.refusedQty.toLocaleString()}</td>
                            <td className={`px-2 py-1.5 text-right whitespace-nowrap ${r.notFoundQty > 0 ? 'text-orange-600' : ''}`}>{r.notFoundQty.toLocaleString()}</td>
                            <td className={`px-2 py-1.5 text-right whitespace-nowrap ${r.damagedQty > 0 ? 'text-red-600' : ''}`}>{r.damagedQty.toLocaleString()}</td>
                          </tr>
                        ))}
                        <tr className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                          <td colSpan={11} className="px-2 py-2 text-right text-xs text-gray-700">TOTAL</td>
                          <td className="px-2 py-2 text-right whitespace-nowrap">{totals.agedQty.toLocaleString()}</td>
                          <td className="px-2 py-2 text-right whitespace-nowrap">{fmtCurrency(totals.agedVal)}</td>
                          <td className="px-2 py-2 text-right whitespace-nowrap text-emerald-600">{totals.foundQty.toLocaleString()}</td>
                          <td className="px-2 py-2 text-right whitespace-nowrap text-blue-600">{totals.displayQty.toLocaleString()}</td>
                          <td className="px-2 py-2 text-right whitespace-nowrap text-amber-600">{totals.refusedQty.toLocaleString()}</td>
                          <td className="px-2 py-2 text-right whitespace-nowrap text-orange-600">{totals.notFoundQty.toLocaleString()}</td>
                          <td className="px-2 py-2 text-right whitespace-nowrap text-red-600">{totals.damagedQty.toLocaleString()}</td>
                        </tr>
                      </>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
