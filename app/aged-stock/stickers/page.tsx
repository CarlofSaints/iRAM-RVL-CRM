'use client';

import { useEffect, useState, useCallback } from 'react';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Warehouse {
  id: string;
  name: string;
  code: string;
  region: string;
}

interface BatchMeta {
  id: string;
  warehouseCode: string;
  warehouseName: string;
  quantity: number;
  createdAt: string;
  createdByName: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return iso; }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function StickerLabelsPage() {
  const { session } = useAuth('view_aged_stock');
  const perms = session?.permissions ?? [];
  const canGenerate = perms.includes('load_aged_stock');

  const [toast, setToast] = useState<ToastData | null>(null);
  const notify = (message: string, type: 'success' | 'error' = 'success') =>
    setToast({ message, type });

  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [batches, setBatches] = useState<BatchMeta[]>([]);
  const [loading, setLoading] = useState(true);

  // Generate form state
  const [warehouseId, setWarehouseId] = useState('');
  const [quantity, setQuantity] = useState(50);
  const [generating, setGenerating] = useState(false);

  // Downloading tracker (batchId → true while downloading)
  const [downloading, setDownloading] = useState<Record<string, boolean>>({});

  // ── Fetch data ──

  const fetchBatches = useCallback(async () => {
    try {
      const res = await authFetch('/api/stickers', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setBatches(data.batches ?? []);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    Promise.all([
      authFetch('/api/control/warehouses', { cache: 'no-store' })
        .then(r => r.ok ? r.json() : [])
        .then(data => setWarehouses(Array.isArray(data) ? data : []))
        .catch(() => {}),
      fetchBatches(),
    ]).finally(() => setLoading(false));
  }, [session, fetchBatches]);

  // ── Generate stickers ──

  async function handleGenerate() {
    if (!warehouseId) { notify('Select a warehouse', 'error'); return; }
    if (quantity < 1 || quantity > 500) { notify('Quantity must be 1–500', 'error'); return; }

    setGenerating(true);
    try {
      const res = await authFetch('/api/stickers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ warehouseId, quantity }),
      });
      const data = await res.json();
      if (!res.ok) {
        notify(data.error || 'Failed to generate stickers', 'error');
        return;
      }

      notify(`Generated ${data.quantity} stickers for ${data.warehouseCode}`);
      await fetchBatches();

      // Auto-download the newly created batch PDF
      if (data.batchId) {
        downloadBatch(data.batchId);
      }
    } catch {
      notify('Network error generating stickers', 'error');
    } finally {
      setGenerating(false);
    }
  }

  // ── Download PDF ──

  async function downloadBatch(batchId: string) {
    setDownloading(prev => ({ ...prev, [batchId]: true }));
    try {
      const res = await authFetch(`/api/stickers/${batchId}`, { cache: 'no-store' });
      if (!res.ok) {
        notify('Failed to download PDF', 'error');
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const fileMatch = disposition.match(/filename="(.+?)"/);
      const fileName = fileMatch ? fileMatch[1] : `stickers-${batchId}.pdf`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
    } catch {
      notify('Network error downloading PDF', 'error');
    } finally {
      setDownloading(prev => ({ ...prev, [batchId]: false }));
    }
  }

  if (!session) return null;

  return (
    <>
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Sticker Labels</h1>
        <p className="text-sm text-gray-600 mt-1">
          Generate barcode sticker labels for warehouse stock
        </p>
      </div>

      {/* Generate form */}
      {canGenerate && (
        <div className="bg-white border border-gray-200 rounded-lg p-5 mb-6">
          <h2 className="text-base font-semibold text-gray-900 mb-4">Generate New Stickers</h2>
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs text-gray-600 mb-1">Warehouse</label>
              <select
                value={warehouseId}
                onChange={e => setWarehouseId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              >
                <option value="">Select a warehouse...</option>
                {warehouses.map(w => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.code})
                  </option>
                ))}
              </select>
            </div>
            <div className="w-32">
              <label className="block text-xs text-gray-600 mb-1">Quantity</label>
              <input
                type="number"
                min={1}
                max={500}
                value={quantity}
                onChange={e => setQuantity(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
            </div>
            <button
              onClick={handleGenerate}
              disabled={generating || !warehouseId}
              className="px-5 py-2 bg-[var(--color-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {generating && (
                <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              )}
              {generating ? 'Generating...' : 'Generate Stickers'}
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Each sticker gets a unique barcode. The PDF downloads automatically after generation.
          </p>
        </div>
      )}

      {/* Previous batches table */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200">
          <h2 className="text-base font-semibold text-gray-900">Previous Batches</h2>
        </div>
        <div className="max-h-[60vh] overflow-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 sticky top-0 z-10">
              <tr className="text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
                <th className="px-4 py-2">Warehouse</th>
                <th className="px-4 py-2 text-right">Qty</th>
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2">Generated By</th>
                <th className="px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">Loading...</td></tr>
              ) : batches.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">No sticker batches yet.</td></tr>
              ) : batches.map(b => (
                <tr key={b.id} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-2 whitespace-nowrap">
                    {b.warehouseName} ({b.warehouseCode})
                  </td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">{b.quantity}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-gray-500">{fmtDate(b.createdAt)}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{b.createdByName}</td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    <button
                      onClick={() => downloadBatch(b.id)}
                      disabled={downloading[b.id]}
                      className="px-3 py-1 text-xs font-medium text-[var(--color-primary)] border border-[var(--color-primary)]/30 rounded hover:bg-[var(--color-primary)]/5 disabled:opacity-50 flex items-center gap-1.5"
                    >
                      {downloading[b.id] && (
                        <div className="h-3 w-3 border-2 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin" />
                      )}
                      Download
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
