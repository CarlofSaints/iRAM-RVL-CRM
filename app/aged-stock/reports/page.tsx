'use client';

import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';

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

interface BatchOption {
  loadId: string;
  clientId: string;
  clientName: string;
  generatedAt: string;
  slipCount: number;
}

interface ReportRow {
  pickSlipId: string;
  grnRef1: string;
  grnRef2: string;
  grnRef3: string;
  grnRef4: string;
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

type ReportId = 'uplift-detail';

interface ReportDef {
  id: ReportId;
  label: string;
  description: string;
}

const REPORTS: ReportDef[] = [
  {
    id: 'uplift-detail',
    label: 'Uplift Detail Report',
    description: 'Per-product breakdown of aged stock uplifts — found, display, refused, not found, damages — for export to clients.',
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return iso; }
}

function fmtDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    const tz = 'Africa/Johannesburg';
    const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: tz });
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
    return `${date} ${time}`;
  } catch { return iso; }
}

function fmtCurrency(v: number): string {
  return `R ${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const { session } = useAuth('view_aged_stock');

  const [toast, setToast] = useState<ToastData | null>(null);
  const notify = (message: string, type: 'success' | 'error' = 'success') =>
    setToast({ message, type });

  const [selectedReport, setSelectedReport] = useState<ReportId | null>(null);
  const [allSlips, setAllSlips] = useState<SlipDto[]>([]);
  const [loading, setLoading] = useState(false);

  // Batch filter state
  const [selectedBatches, setSelectedBatches] = useState<Set<string>>(new Set());
  const [batchDropOpen, setBatchDropOpen] = useState(false);
  const batchDropRef = useRef<HTMLDivElement>(null);

  // Close batch dropdown on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (batchDropRef.current && !batchDropRef.current.contains(e.target as Node)) {
        setBatchDropOpen(false);
      }
    }
    if (batchDropOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [batchDropOpen]);

  // ── Load pick slips when report is selected ──
  const loadSlips = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const res = await authFetch('/api/pick-slips', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setAllSlips(data.slips ?? []);
      } else {
        notify('Failed to load pick slips', 'error');
      }
    } catch {
      notify('Network error loading data', 'error');
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    if (selectedReport) loadSlips();
  }, [selectedReport, loadSlips]);

  // ── Derive batch options from slips ──
  const batchOptions = useMemo<BatchOption[]>(() => {
    const map = new Map<string, BatchOption>();
    for (const s of allSlips) {
      const key = `${s.clientId}|${s.loadId}`;
      if (!map.has(key)) {
        map.set(key, {
          loadId: s.loadId,
          clientId: s.clientId,
          clientName: s.clientName,
          generatedAt: s.generatedAt,
          slipCount: 0,
        });
      }
      map.get(key)!.slipCount++;
    }
    return [...map.values()].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  }, [allSlips]);

  // ── Build report rows ──
  const reportRows = useMemo<ReportRow[]>(() => {
    if (selectedBatches.size === 0) return [];

    const rows: ReportRow[] = [];
    const filteredSlips = allSlips.filter(s => {
      const key = `${s.clientId}|${s.loadId}`;
      return selectedBatches.has(key);
    });

    for (const slip of filteredSlips) {
      const refs = slip.receiptStoreRefs ?? [];
      const grnDate = slip.receiptGrnDate || slip.receiptedAt || '';

      for (const row of slip.rows) {
        // Find matching unreturned stock row
        const ur = (slip.unreturnedStock ?? []).find(
          u => u.articleCode === row.articleCode
        );

        const agedQty = row.qty;
        const displayQty = ur?.display ?? 0;
        const refusedQty = ur?.storeRefused ?? 0;
        const notFoundQty = ur?.notFound ?? 0;
        const damagedQty = ur?.damaged ?? 0;
        // Found = pickSlipQty - losses (or agedQty if no unreturned data)
        const foundQty = ur
          ? ur.pickSlipQty - (displayQty + refusedQty + notFoundQty + damagedQty)
          : 0;

        rows.push({
          pickSlipId: slip.id,
          grnRef1: refs[0] ?? '',
          grnRef2: refs[1] ?? '',
          grnRef3: refs[2] ?? '',
          grnRef4: refs[3] ?? '',
          storeName: slip.siteName,
          storeCode: slip.siteCode,
          grnDateTime: grnDate ? fmtDateTime(grnDate) : '',
          vendorProductCode: row.vendorProductCode || '',
          articleCode: row.articleCode,
          description: row.description,
          agedQty,
          agedVal: row.val,
          foundQty: Math.max(0, foundQty),
          displayQty,
          refusedQty,
          notFoundQty,
          damagedQty,
        });
      }
    }

    return rows;
  }, [allSlips, selectedBatches]);

  // ── Totals ──
  const totals = useMemo(() => {
    const t = { agedQty: 0, agedVal: 0, foundQty: 0, displayQty: 0, refusedQty: 0, notFoundQty: 0, damagedQty: 0 };
    for (const r of reportRows) {
      t.agedQty += r.agedQty;
      t.agedVal += r.agedVal;
      t.foundQty += r.foundQty;
      t.displayQty += r.displayQty;
      t.refusedQty += r.refusedQty;
      t.notFoundQty += r.notFoundQty;
      t.damagedQty += r.damagedQty;
    }
    return t;
  }, [reportRows]);

  // ── Excel export ──
  function exportToExcel() {
    if (reportRows.length === 0) {
      notify('No data to export', 'error');
      return;
    }
    const data = reportRows.map(r => ({
      'Picking Slip #': r.pickSlipId,
      'GRN/GRV #1': r.grnRef1,
      'GRN/GRV #2': r.grnRef2,
      'GRN/GRV #3': r.grnRef3,
      'GRN/GRV #4': r.grnRef4,
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
    }));

    // Add totals row
    data.push({
      'Picking Slip #': '',
      'GRN/GRV #1': '',
      'GRN/GRV #2': '',
      'GRN/GRV #3': '',
      'GRN/GRV #4': '',
      'Store Name': '',
      'Store Code': '',
      'GRN/GRV Date/Time': '',
      'Product Code': '',
      'Article Number': '',
      'Product Description': 'TOTAL',
      'Aged Qty': totals.agedQty,
      'Aged Stock Value': totals.agedVal,
      'Found Qty': totals.foundQty,
      'Display Qty': totals.displayQty,
      'Refused Qty': totals.refusedQty,
      'Not Found Qty': totals.notFoundQty,
      'Damages Qty': totals.damagedQty,
    });

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Uplift Detail');

    const date = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `Uplift Detail Report - ${date}.xlsx`);
    notify('Report exported to Excel');
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
          {REPORTS.map(r => (
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

      {/* Selected report */}
      {selectedReport === 'uplift-detail' && (
        <>
          {/* Report header */}
          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={() => { setSelectedReport(null); setSelectedBatches(new Set()); }}
              className="p-1.5 text-gray-400 hover:text-gray-700 rounded-md hover:bg-gray-100"
              title="Back to reports"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h2 className="text-lg font-bold text-gray-900">Uplift Detail Report</h2>
          </div>

          {/* Filters */}
          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4 flex flex-wrap items-end gap-4">
            {/* Batch selector */}
            <div className="relative min-w-[280px]" ref={batchDropRef}>
              <label className="block text-xs text-gray-600 mb-1">Aged Stock Batch</label>
              <button
                type="button"
                onClick={() => setBatchDropOpen(o => !o)}
                className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-sm text-left bg-white flex items-center justify-between"
              >
                <span className={selectedBatches.size > 0 ? 'text-gray-900' : 'text-gray-500'}>
                  {selectedBatches.size === 0
                    ? 'Select batch(es)...'
                    : `${selectedBatches.size} batch${selectedBatches.size > 1 ? 'es' : ''} selected`}
                </span>
                <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {batchDropOpen && (
                <div className="absolute z-30 mt-1 w-full bg-white border border-gray-200 rounded-md shadow-lg max-h-72 overflow-auto">
                  {selectedBatches.size > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelectedBatches(new Set())}
                      className="w-full text-left px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 border-b border-gray-100"
                    >
                      Clear all
                    </button>
                  )}
                  {loading ? (
                    <div className="px-3 py-4 text-center text-xs text-gray-400">Loading batches...</div>
                  ) : batchOptions.length === 0 ? (
                    <div className="px-3 py-4 text-center text-xs text-gray-400">No batches found</div>
                  ) : batchOptions.map(b => {
                    const key = `${b.clientId}|${b.loadId}`;
                    return (
                      <label key={key} className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer text-sm border-b border-gray-50">
                        <input
                          type="checkbox"
                          checked={selectedBatches.has(key)}
                          onChange={() => {
                            setSelectedBatches(prev => {
                              const next = new Set(prev);
                              if (next.has(key)) next.delete(key);
                              else next.add(key);
                              return next;
                            });
                          }}
                          className="rounded border-gray-300"
                        />
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-gray-900 truncate">{b.clientName}</div>
                          <div className="text-[10px] text-gray-500">
                            {fmtDate(b.generatedAt)} — {b.slipCount} slip{b.slipCount !== 1 ? 's' : ''}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Export button */}
            <button
              onClick={exportToExcel}
              disabled={reportRows.length === 0}
              className="px-4 py-1.5 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Export to Excel
            </button>

            {/* Row count */}
            {reportRows.length > 0 && (
              <span className="text-xs text-gray-500 ml-auto">
                {reportRows.length.toLocaleString()} row{reportRows.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          {/* Empty state */}
          {selectedBatches.size === 0 && (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-12 text-center">
              <svg className="w-10 h-10 text-gray-300 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
              </svg>
              <p className="text-sm text-gray-500">Select one or more aged stock batches to generate the report</p>
            </div>
          )}

          {/* Report grid */}
          {selectedBatches.size > 0 && (
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
                    {loading ? (
                      <tr><td colSpan={17} className="px-3 py-8 text-center text-gray-500 text-sm">Loading...</td></tr>
                    ) : reportRows.length === 0 ? (
                      <tr><td colSpan={17} className="px-3 py-8 text-center text-gray-500 text-sm">No data for the selected batch(es).</td></tr>
                    ) : (
                      <>
                        {reportRows.map((r, i) => (
                          <tr key={i} className="border-t border-gray-100 hover:bg-gray-50">
                            <td className="px-2 py-1.5 whitespace-nowrap font-mono text-[10px]">{r.pickSlipId}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap">{r.grnRef1}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap">{r.grnRef2}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap">{r.grnRef3}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap">{r.grnRef4}</td>
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
                        {/* Totals row */}
                        <tr className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                          <td colSpan={10} className="px-2 py-2 text-right text-xs text-gray-700">TOTAL</td>
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
