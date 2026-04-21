'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';

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

const STATUS_LABELS: Record<string, string> = {
  'generated': 'Generated',
  'sent': 'Sent',
  'picked': 'Picked',
  'receipted': 'Receipted',
  'in-transit': 'In Transit',
  'returned-to-vendor': 'Returned to Vendor',
};

const STATUS_COLORS: Record<string, string> = {
  'generated': 'bg-gray-100 text-gray-700',
  'sent': 'bg-blue-100 text-blue-700',
  'picked': 'bg-amber-100 text-amber-700',
  'receipted': 'bg-green-100 text-green-700',
  'in-transit': 'bg-purple-100 text-purple-700',
  'returned-to-vendor': 'bg-red-100 text-red-700',
};

export default function ReceiptsListPage() {
  const { session } = useAuth('receipt_stock');
  const router = useRouter();

  const [toast, setToast] = useState<ToastData | null>(null);
  const notify = (message: string, type: 'success' | 'error' = 'success') =>
    setToast({ message, type });

  const [slips, setSlips] = useState<SlipDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

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

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return slips.filter(s => {
      // Only show actionable statuses (not already receipted or returned)
      if (s.status === 'returned-to-vendor') return false;
      if (!q) return true;
      const hay = `${s.vendorNumber} ${s.siteName} ${s.siteCode} ${s.id} ${s.clientName}`.toLowerCase();
      return hay.includes(q);
    });
  }, [slips, searchQuery]);

  if (!session) return null;

  return (
    <>
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Box Receipts</h1>
          <p className="text-sm text-gray-600 mt-1">
            Receipt aged stock into warehouses by scanning sticker barcodes
          </p>
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
                <th className="px-3 py-2">Pick Slip ID</th>
                <th className="px-3 py-2">Client</th>
                <th className="px-3 py-2">Vendor #</th>
                <th className="px-3 py-2">Store</th>
                <th className="px-3 py-2">Warehouse</th>
                <th className="px-3 py-2 text-right">Total Qty</th>
                <th className="px-3 py-2 text-right">Total Value</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={10} className="px-3 py-6 text-center text-gray-500">Loading...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={10} className="px-3 py-6 text-center text-gray-500">No pick slips match your search.</td></tr>
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
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[s.status] || 'bg-gray-100 text-gray-700'}`}>
                      {STATUS_LABELS[s.status] || s.status}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    <button
                      onClick={() => router.push(`/aged-stock/receipts/capture?slipId=${encodeURIComponent(s.id)}&clientId=${encodeURIComponent(s.clientId)}&loadId=${encodeURIComponent(s.loadId)}`)}
                      className={`px-2.5 py-1 text-xs font-medium rounded border ${
                        s.status === 'receipted'
                          ? 'text-green-600 border-green-200 bg-green-50'
                          : 'text-[var(--color-primary)] border-[var(--color-primary)]/30 hover:bg-[var(--color-primary)]/5'
                      }`}
                    >
                      {s.status === 'receipted' ? 'View' : 'Capture'}
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
