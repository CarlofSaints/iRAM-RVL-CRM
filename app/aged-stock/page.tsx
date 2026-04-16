'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import * as XLSX from 'xlsx';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';

interface RowDto {
  id: string;
  loadId: string;
  loadedAt: string;
  clientId: string;
  clientName: string;
  vendorNumbers: string[];
  fileName: string;
  siteCode: string;
  siteName: string;
  articleCode: string;
  description: string;
  barcode: string;
  vendorProductCode: string;
  qty: number;
  val: number;
}

interface LoadDto {
  id: string;
  fileName: string;
  loadedAt: string;
  loadedByName: string;
  rowCount: number;
  selectedPeriodKeys: string[];
}

/** Render DD/MM/YYYY HH:mm from ISO. */
function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function AgedStockDashboardPage() {
  const { session } = useAuth('view_aged_stock');
  const [toast, setToast] = useState<ToastData | null>(null);
  const [rows, setRows] = useState<RowDto[]>([]);
  const [loadsByClient, setLoadsByClient] = useState<Record<string, LoadDto[]>>({});
  const [loading, setLoading] = useState(true);

  // Filters
  const [clientFilter, setClientFilter] = useState('');
  const [storeQuery, setStoreQuery] = useState('');
  const [articleQuery, setArticleQuery] = useState('');
  const [barcodeQuery, setBarcodeQuery] = useState('');
  const [vendorCodeQuery, setVendorCodeQuery] = useState('');
  const [loadFilter, setLoadFilter] = useState(''); // "" = all loads

  const notify = (message: string, type: 'success' | 'error' = 'success') =>
    setToast({ message, type });

  useEffect(() => {
    if (!session) return;
    (async () => {
      setLoading(true);
      try {
        const res = await authFetch('/api/aged-stock', { cache: 'no-store' });
        if (!res.ok) {
          notify('Failed to load aged stock data', 'error');
          return;
        }
        const json = await res.json();
        setRows(json.rows ?? []);
        setLoadsByClient(json.loadsByClient ?? {});
      } finally {
        setLoading(false);
      }
    })();
  }, [session]);

  const clientOptions = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; vendorNumbers: string[] }>();
    for (const r of rows) {
      if (!byId.has(r.clientId)) byId.set(r.clientId, { id: r.clientId, name: r.clientName, vendorNumbers: r.vendorNumbers });
    }
    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  // Reset load filter when client filter changes (loads are per-client)
  useEffect(() => { setLoadFilter(''); }, [clientFilter]);

  const loadOptions: LoadDto[] = clientFilter
    ? (loadsByClient[clientFilter] ?? [])
    : [];

  const filtered = useMemo(() => {
    const sq = storeQuery.trim().toLowerCase();
    const aq = articleQuery.trim().toLowerCase();
    const bq = barcodeQuery.trim().toLowerCase();
    const vq = vendorCodeQuery.trim().toLowerCase();

    return rows.filter(r => {
      if (clientFilter && r.clientId !== clientFilter) return false;
      if (loadFilter && r.loadId !== loadFilter) return false;
      if (sq) {
        const hay = `${r.siteCode} ${r.siteName}`.toLowerCase();
        if (!hay.includes(sq)) return false;
      }
      if (aq) {
        const hay = `${r.articleCode} ${r.description}`.toLowerCase();
        if (!hay.includes(aq)) return false;
      }
      if (bq && !(r.barcode ?? '').toLowerCase().includes(bq)) return false;
      if (vq && !(r.vendorProductCode ?? '').toLowerCase().includes(vq)) return false;
      return true;
    });
  }, [rows, clientFilter, loadFilter, storeQuery, articleQuery, barcodeQuery, vendorCodeQuery]);

  const totals = useMemo(() => {
    let qty = 0, val = 0;
    for (const r of filtered) { qty += r.qty; val += r.val; }
    return { qty, val, count: filtered.length };
  }, [filtered]);

  function exportToExcel() {
    if (filtered.length === 0) {
      notify('Nothing to export', 'error');
      return;
    }
    const data = filtered.map(r => ({
      'Client Name': r.clientName,
      'Vendor Number': r.vendorNumbers.join(', '),
      'Site Code': r.siteCode,
      'Site Name': r.siteName,
      'Article Number': r.articleCode,
      'Product Description': r.description,
      'Barcode': r.barcode,
      'Vendor Product Code': r.vendorProductCode,
      'Qty': r.qty,
      'Value': r.val,
      'Load Date': fmtDate(r.loadedAt),
      'Source File': r.fileName,
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Aged Stock');

    const date = new Date().toISOString().slice(0, 10);
    const suffix = clientFilter
      ? ` - ${clientOptions.find(c => c.id === clientFilter)?.name ?? 'client'}`
      : '';
    XLSX.writeFile(wb, `Aged Stock${suffix} - ${date}.xlsx`);
  }

  if (!session) return null;

  return (
    <>
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Aged Stock</h1>
          <p className="text-sm text-gray-600 mt-1">
            Data across {clientOptions.length} client{clientOptions.length === 1 ? '' : 's'}
            &nbsp;·&nbsp;{rows.length.toLocaleString()} rows total
          </p>
        </div>
        <div className="flex gap-2">
          {(session.permissions ?? []).includes('load_aged_stock') && (
            <Link
              href="/aged-stock/load"
              className="px-4 py-2 bg-[var(--color-primary)] text-white rounded-md text-sm font-medium hover:opacity-90"
            >
              Load Aged Stock
            </Link>
          )}
          <button
            onClick={exportToExcel}
            disabled={filtered.length === 0}
            className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Export to Excel
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4 grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <div>
          <label className="block text-xs text-gray-600 mb-1">Client</label>
          <select
            value={clientFilter}
            onChange={e => setClientFilter(e.target.value)}
            className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm"
          >
            <option value="">All clients</option>
            {clientOptions.map(c => (
              <option key={c.id} value={c.id}>
                {c.vendorNumbers.length ? `${c.name} - ${c.vendorNumbers.join(', ')}` : c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Load (date)</label>
          <select
            value={loadFilter}
            onChange={e => setLoadFilter(e.target.value)}
            disabled={!clientFilter}
            className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm disabled:bg-gray-50 disabled:text-gray-400"
          >
            <option value="">All loads</option>
            {loadOptions.map(l => (
              <option key={l.id} value={l.id}>
                {fmtDate(l.loadedAt)} — {l.fileName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Store</label>
          <input
            value={storeQuery}
            onChange={e => setStoreQuery(e.target.value)}
            placeholder="Code or name"
            className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Article</label>
          <input
            value={articleQuery}
            onChange={e => setArticleQuery(e.target.value)}
            placeholder="Code or description"
            className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Barcode</label>
          <input
            value={barcodeQuery}
            onChange={e => setBarcodeQuery(e.target.value)}
            className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Vendor Product Code</label>
          <input
            value={vendorCodeQuery}
            onChange={e => setVendorCodeQuery(e.target.value)}
            className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm"
          />
        </div>
      </div>

      {/* Summary */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4 flex flex-wrap gap-6 text-sm">
        <div>
          <div className="text-xs text-gray-500">Rows</div>
          <div className="font-semibold">{totals.count.toLocaleString()}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Total Qty</div>
          <div className="font-semibold">{totals.qty.toLocaleString()}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Total Value</div>
          <div className="font-semibold">R{totals.val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="max-h-[70vh] overflow-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 sticky top-0 z-10">
              <tr className="text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
                <th className="px-3 py-2 whitespace-nowrap">Client</th>
                <th className="px-3 py-2 whitespace-nowrap">Vendor #</th>
                <th className="px-3 py-2 whitespace-nowrap">Store Code</th>
                <th className="px-3 py-2 whitespace-nowrap">Store Name</th>
                <th className="px-3 py-2 whitespace-nowrap">Article</th>
                <th className="px-3 py-2">Description</th>
                <th className="px-3 py-2 whitespace-nowrap">Barcode</th>
                <th className="px-3 py-2 whitespace-nowrap">Vendor Code</th>
                <th className="px-3 py-2 text-right whitespace-nowrap">Qty</th>
                <th className="px-3 py-2 text-right whitespace-nowrap">Value</th>
                <th className="px-3 py-2 whitespace-nowrap">Loaded</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={11} className="px-3 py-6 text-center text-gray-500">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={11} className="px-3 py-6 text-center text-gray-500">No rows match the current filters.</td></tr>
              ) : filtered.slice(0, 1000).map(r => (
                <tr key={r.id} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-1.5 whitespace-nowrap">{r.clientName}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{r.vendorNumbers.join(', ')}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{r.siteCode}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{r.siteName}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{r.articleCode}</td>
                  <td className="px-3 py-1.5">{r.description}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{r.barcode}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{r.vendorProductCode}</td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">{r.qty.toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                    {r.val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap text-xs text-gray-500">{fmtDate(r.loadedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length > 1000 && (
          <div className="px-3 py-2 text-xs text-gray-500 border-t border-gray-100">
            Showing first 1,000 of {filtered.length.toLocaleString()}. Refine filters or Export to Excel to see everything.
          </div>
        )}
      </div>
    </>
  );
}
