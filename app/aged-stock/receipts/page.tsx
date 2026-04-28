'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';
import StatusBadge from '@/components/StatusBadge';

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
  generatedAt: string;
  status: string;
  receiptedAt?: string;
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return iso; }
}

function fmtCurrency(v: number): string {
  return `R ${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function ReceiptsListPage() {
  const { session } = useAuth('receipt_stock');
  const router = useRouter();
  const searchParams = useSearchParams();
  const mode = searchParams.get('mode') ?? 'capture'; // default to capture

  const [toast, setToast] = useState<ToastData | null>(null);
  const notify = (message: string, type: 'success' | 'error' = 'success') =>
    setToast({ message, type });

  const [slips, setSlips] = useState<SlipDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortCol, setSortCol] = useState<string>('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    authFetch('/api/pick-slips', { cache: 'no-store' })
      .then(async res => {
        if (res.ok) {
          const data = await res.json();
          setSlips(data.slips ?? []);
        } else {
          notify('Failed to load pick slips', 'error');
        }
      })
      .catch(() => notify('Network error', 'error'))
      .finally(() => setLoading(false));
  }, [session]);

  function toggleSort(col: string) {
    if (sortCol === col) {
      setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  }

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = slips.filter(s => {
      // Mode-based filtering
      if (mode === 'capture') {
        if (s.status !== 'booked') return false;
      } else if (mode === 'release') {
        if (s.status !== 'captured' && s.status !== 'failed-release') return false;
      }
      if (!q) return true;
      const hay = `${s.vendorNumber} ${s.siteName} ${s.siteCode} ${s.id} ${s.clientName}`.toLowerCase();
      return hay.includes(q);
    });

    if (!sortCol) return list;

    const sorted = [...list].sort((a, b) => {
      let av: string | number = '';
      let bv: string | number = '';
      switch (sortCol) {
        case 'id': av = a.id; bv = b.id; break;
        case 'client': av = a.clientName; bv = b.clientName; break;
        case 'vendor': av = a.vendorNumber; bv = b.vendorNumber; break;
        case 'store': av = a.siteName; bv = b.siteName; break;
        case 'warehouse': av = a.warehouse; bv = b.warehouse; break;
        case 'qty': av = a.totalQty; bv = b.totalQty; break;
        case 'value': av = a.totalVal; bv = b.totalVal; break;
        case 'date': av = a.generatedAt; bv = b.generatedAt; break;
        case 'status': av = a.status; bv = b.status; break;
        default: return 0;
      }
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      const cmp = String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [slips, searchQuery, sortCol, sortDir, mode]);

  if (!session) return null;

  const isCapture = mode === 'capture';
  const heading = isCapture ? 'Capture' : 'Release Stock';
  const subtitle = isCapture
    ? 'Capture unreturned stock details for booked pick slips'
    : 'Release captured stock from warehouse for transit';

  return (
    <>
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">{heading}</h1>
          <p className="text-sm text-gray-600 mt-1">{subtitle}</p>
        </div>
      </div>

      {/* Search */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
        <label className="block text-xs text-gray-600 mb-1">Search</label>
        <input
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Vendor number, store name/code, pick slip ID, or client name..."
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
        />
      </div>

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="max-h-[70vh] overflow-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 sticky top-0 z-10">
              <tr className="text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
                {([
                  { key: 'id', label: 'Pick Slip ID', right: false },
                  { key: 'client', label: 'Client', right: false },
                  { key: 'vendor', label: 'Vendor #', right: false },
                  { key: 'store', label: 'Store', right: false },
                  { key: 'warehouse', label: 'Warehouse', right: false },
                  { key: 'qty', label: 'Total Qty', right: true },
                  { key: 'value', label: 'Total Value', right: true },
                  { key: 'date', label: 'Date', right: false },
                  { key: 'status', label: 'Status', right: false },
                ] as const).map(col => (
                  <th
                    key={col.key}
                    className={`px-3 py-2 cursor-pointer select-none hover:text-[var(--color-primary)] transition-colors ${col.right ? 'text-right' : ''}`}
                    onClick={() => toggleSort(col.key)}
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.label}
                      {sortCol === col.key && (
                        <svg className={`w-3 h-3 transition-transform ${sortDir === 'desc' ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
                        </svg>
                      )}
                    </span>
                  </th>
                ))}
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={10} className="px-3 py-6 text-center text-gray-500">Loading...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={10} className="px-3 py-6 text-center text-gray-500">
                  {isCapture ? 'No booked pick slips awaiting capture.' : 'No captured pick slips awaiting release.'}
                </td></tr>
              ) : filtered.map(s => (
                <tr key={s.id} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-1.5 whitespace-nowrap font-mono text-xs">{s.id}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{s.clientName}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{s.vendorNumber}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{s.siteName} ({s.siteCode})</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{s.warehouse}</td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">{s.totalQty.toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">{fmtCurrency(s.totalVal)}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap text-xs text-gray-500">{fmtDate(s.generatedAt)}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    <button
                      onClick={() => router.push(`/aged-stock/receipts/capture?slipId=${encodeURIComponent(s.id)}&clientId=${encodeURIComponent(s.clientId)}&loadId=${encodeURIComponent(s.loadId)}`)}
                      className={`px-2.5 py-1 text-xs font-medium rounded border ${
                        isCapture
                          ? 'text-teal-600 border-teal-200 bg-teal-50 hover:bg-teal-100'
                          : s.status === 'failed-release'
                          ? 'text-amber-700 border-amber-300 bg-amber-50 hover:bg-amber-100'
                          : 'text-purple-600 border-purple-200 bg-purple-50 hover:bg-purple-100'
                      }`}
                    >
                      {isCapture ? 'Capture' : s.status === 'failed-release' ? 'Retry Release' : 'Release'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
