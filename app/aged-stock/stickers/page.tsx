'use client';

import { useEffect, useState, useCallback } from 'react';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';
import { useTableSort } from '@/lib/useTableSort';
import SortableTh from '@/components/SortableTh';

// ── Types ─────────────────────────────────────────────────────────────────────

type StickerLayout = 'roll' | 'a4sheet';

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

/** One sticker as the registry holds it, plus its batch context. */
interface StickerHit {
  id: string;
  barcodeValue: string;
  batchId: string;
  warehouseCode: string;
  warehouseName: string;
  batchCreatedAt: string;
  batchCreatedByName: string;
  batchQuantity: number;
  linkedPickSlipIds: string[];
  linkedAt?: string;
  exact: boolean;
}

/** A pick slip that carries this label — the store it is on. */
interface SlipRef {
  id: string;
  clientId: string;
  clientName: string;
  loadId: string;
  siteCode: string;
  siteName: string;
  warehouse: string;
  warehouseCode?: string;
  status: string;
  totalQty: number;
  totalVal: number;
  generatedAt: string;
  releasableBoxCount: number;
  receiptBoxCount: number;
  registryLinked: boolean;
  onReceipt: boolean;
  onOutstanding: boolean;
  onRelease: boolean;
  onDelivered: boolean;
  retired: boolean;
  replacedBy?: string;
  scannedAt?: string;
  live: boolean;
}

interface SearchResult {
  /** The number as resolved. Present even when nothing is in the register. */
  barcode: string;
  /** Null when no sticker record exists but a pick slip still carries the number. */
  sticker: StickerHit | null;
  slips: SlipRef[];
  contested: boolean;
  /** The caller only sees some clients, so an empty slip list proves nothing. */
  scopeNarrowed: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return iso; }
}

function fmtMoney(v: number): string {
  return `R${(v ?? 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Where this label sits on the slip. Said in the warehouse's words, not the
 * schema's — "on a delivery note" is what the person holding the box needs.
 */
function placementBadges(s: SlipRef): Array<{ text: string; cls: string }> {
  const out: Array<{ text: string; cls: string }> = [];
  if (s.retired) {
    out.push({
      text: s.replacedBy ? `Retired — replaced by ${s.replacedBy}` : 'Retired',
      cls: 'bg-gray-200 text-gray-700',
    });
  }
  // Once it has been signed for, "booked into WH" is history, not where it sits.
  if (s.onReceipt && !s.onDelivered) out.push({ text: 'Booked into WH', cls: 'bg-blue-100 text-blue-700' });
  if (s.onOutstanding) out.push({ text: 'Still owed', cls: 'bg-amber-100 text-amber-800' });
  if (s.onRelease) out.push({ text: 'On a delivery note', cls: 'bg-purple-100 text-purple-700' });
  if (s.onDelivered) out.push({ text: 'Delivered', cls: 'bg-green-100 text-green-700' });
  if (out.length === 0 && s.registryLinked) {
    out.push({ text: 'Registry link only — no box carries it', cls: 'bg-red-100 text-red-700' });
  }
  return out;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function StickerLabelsPage() {
  const { session } = useAuth('view_aged_stock');
  const perms = session?.permissions ?? [];
  const canGenerate = perms.includes('load_aged_stock');
  // Editing or deleting a label is the same gate as minting one — RVL Manager
  // and up. A Rep can look a label up but not change it.
  const canManageStickers = canGenerate;

  const [toast, setToast] = useState<ToastData | null>(null);
  const notify = (message: string, type: 'success' | 'error' = 'success') =>
    setToast({ message, type });

  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [batches, setBatches] = useState<BatchMeta[]>([]);
  const [loading, setLoading] = useState(true);

  // Generate form state
  const [warehouseId, setWarehouseId] = useState('');
  const [quantity, setQuantity] = useState(50);
  const [genFormat, setGenFormat] = useState<StickerLayout>('a4sheet');
  const [generating, setGenerating] = useState(false);

  // Downloading tracker (`${batchId}:${format}` → true while downloading)
  const [downloading, setDownloading] = useState<Record<string, boolean>>({});

  // ── Find a sticker ──
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [matches, setMatches] = useState<StickerHit[]>([]);
  const [searchError, setSearchError] = useState('');

  // Edit modal
  const [editOpen, setEditOpen] = useState(false);
  const [editBarcode, setEditBarcode] = useState('');
  const [editLinks, setEditLinks] = useState<string[]>([]);
  const [editNewLink, setEditNewLink] = useState('');
  const [editReason, setEditReason] = useState('');
  const [saving, setSaving] = useState(false);

  // Delete modal
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [delReason, setDelReason] = useState('');
  const [delCode, setDelCode] = useState('');
  const [delAck, setDelAck] = useState(false);
  const [deleting, setDeleting] = useState(false);

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

      // Auto-download the newly created batch PDF in the selected format
      if (data.batchId) {
        downloadBatch(data.batchId, genFormat);
      }
    } catch {
      notify('Network error generating stickers', 'error');
    } finally {
      setGenerating(false);
    }
  }

  // ── Download PDF ──

  async function downloadBatch(batchId: string, format: StickerLayout) {
    const key = `${batchId}:${format}`;
    setDownloading(prev => ({ ...prev, [key]: true }));
    try {
      const res = await authFetch(`/api/stickers/${batchId}?format=${format}`, { cache: 'no-store' });
      if (!res.ok) {
        notify('Failed to download PDF', 'error');
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const fileMatch = disposition.match(/filename="(.+?)"/);
      const fileName = fileMatch ? fileMatch[1] : `stickers-${batchId}-${format}.pdf`;

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
      setDownloading(prev => ({ ...prev, [key]: false }));
    }
  }

  // ── Find / edit / delete one sticker ──

  async function runSearch(term: string) {
    const q = term.trim();
    if (!q) {
      setSearchError('Enter or scan a sticker number');
      setSearched(true);
      return;
    }
    setSearching(true);
    setSearchError('');
    setMatches([]);
    setResult(null);
    try {
      const res = await authFetch(`/api/stickers/search?q=${encodeURIComponent(q)}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        setSearchError(data.error || 'Search failed');
        return;
      }
      if (data.found) {
        setResult({
          barcode: data.barcode ?? q.toUpperCase(),
          sticker: data.sticker ?? null,
          slips: data.slips ?? [],
          contested: !!data.contested,
          scopeNarrowed: !!data.scopeNarrowed,
        });
      } else {
        setMatches(data.matches ?? []);
        if (data.error) setSearchError(data.error);
      }
    } catch {
      setSearchError('Network error searching for that sticker');
    } finally {
      setSearching(false);
      setSearched(true);
    }
  }

  function clearSearch() {
    setQuery('');
    setResult(null);
    setMatches([]);
    setSearchError('');
    setSearched(false);
  }

  function openEdit() {
    if (!result?.sticker) return;
    setEditBarcode(result.sticker.barcodeValue);
    setEditLinks([...result.sticker.linkedPickSlipIds]);
    setEditNewLink('');
    setEditReason('');
    setEditOpen(true);
  }

  async function saveEdit() {
    if (!result?.sticker) return;
    const barcode = editBarcode.toUpperCase().replace(/\s+/g, '').trim();
    if (!barcode) { notify('Sticker number cannot be blank', 'error'); return; }
    if (!editReason.trim()) { notify('A reason is required', 'error'); return; }

    setSaving(true);
    try {
      const { batchId, id } = result.sticker;
      const res = await authFetch(
        `/api/stickers/${encodeURIComponent(batchId)}/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            barcodeValue: barcode,
            linkedPickSlipIds: editLinks,
            reason: editReason.trim(),
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        notify(data.error || 'Failed to save sticker', 'error');
        return;
      }
      const cascaded = (data.cascadedSlipIds ?? []) as string[];
      notify(
        `Saved ${barcode}` +
        (cascaded.length ? ` — box list updated on ${cascaded.length} pick slip${cascaded.length === 1 ? '' : 's'}` : ''),
      );
      setEditOpen(false);
      setQuery(barcode);
      await runSearch(barcode);
      await fetchBatches();
    } catch {
      notify('Network error saving sticker', 'error');
    } finally {
      setSaving(false);
    }
  }

  function openDelete() {
    setDelReason('');
    setDelCode('');
    setDelAck(false);
    setDeleteOpen(true);
  }

  async function doDelete() {
    if (!result?.sticker) return;
    if (!delReason.trim()) { notify('A reason is required', 'error'); return; }
    if (delCode.trim().length !== 4) { notify('Enter your 4-character security code', 'error'); return; }
    if (result.slips.length > 0 && !delAck) {
      notify('Tick the acknowledgement — a slip still carries this label', 'error');
      return;
    }

    setDeleting(true);
    try {
      const { batchId, id, barcodeValue } = result.sticker;
      const res = await authFetch(
        `/api/stickers/${encodeURIComponent(batchId)}/${encodeURIComponent(id)}`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: delCode.trim(),
            reason: delReason.trim(),
            acknowledgeLinked: delAck,
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        notify(data.error || 'Failed to delete sticker', 'error');
        return;
      }
      notify(`Deleted ${barcodeValue}`);
      setDeleteOpen(false);
      setResult(null);
      setMatches([]);
      setSearched(true);
      setSearchError(`${barcodeValue} was removed from the sticker register.`);
      await fetchBatches();
    } catch {
      notify('Network error deleting sticker', 'error');
    } finally {
      setDeleting(false);
    }
  }

  // Sortable grid — defaults to newest batch first.
  const { sorted, sortCol, sortDir, toggleSort } = useTableSort(batches, {
    warehouse: (b) => b.warehouseName,
    quantity: (b) => b.quantity,
    createdAt: (b) => b.createdAt,
    createdByName: (b) => b.createdByName,
  }, 'createdAt', 'desc');

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

      {/* ── Find a sticker ─────────────────────────────────────────────── */}
      <div className="bg-white border border-gray-200 rounded-lg p-5 mb-6">
        <h2 className="text-base font-semibold text-gray-900 mb-1">Find a Sticker</h2>
        <p className="text-xs text-gray-500 mb-4">
          Scan a box label or type its number to see which store it belongs to.
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[260px]">
            <label className="block text-xs text-gray-600 mb-1">Sticker number</label>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); runSearch(query); } }}
              placeholder="STK-GAU-0148  (or just 148)"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono tracking-wide"
            />
          </div>
          <button
            onClick={() => runSearch(query)}
            disabled={searching}
            className="px-5 py-2 bg-[var(--color-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
          >
            {searching && <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            {searching ? 'Searching...' : 'Search'}
          </button>
          {(result || matches.length > 0 || searchError) && (
            <button
              onClick={clearSearch}
              className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
            >
              Clear
            </button>
          )}
        </div>

        {searchError && (
          <p className="mt-3 text-sm text-red-600">{searchError}</p>
        )}

        {/* Several partial matches — the operator picks */}
        {matches.length > 0 && (
          <div className="mt-4 border border-gray-200 rounded-lg overflow-hidden">
            <div className="px-4 py-2 bg-gray-50 text-xs font-semibold text-gray-600 uppercase tracking-wide">
              {matches.length}{' '}matching sticker{matches.length === 1 ? '' : 's'}{' '}&mdash; pick one
            </div>
            <ul className="divide-y divide-gray-100 max-h-64 overflow-auto">
              {matches.map(m => (
                <li key={m.id}>
                  <button
                    onClick={() => { setQuery(m.barcodeValue); runSearch(m.barcodeValue); }}
                    className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center justify-between gap-3"
                  >
                    <span className="font-mono">{m.barcodeValue}</span>
                    <span className="text-xs text-gray-500">
                      {m.warehouseName} ({m.warehouseCode}) &middot; {fmtDate(m.batchCreatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {searched && !searching && !result && matches.length === 0 && !searchError && (
          <p className="mt-3 text-sm text-gray-500">
            No sticker with that number. It may pre-date the sticker register, or belong to another warehouse.
          </p>
        )}

        {/* ── The result ── */}
        {result && (
          <div className="mt-5 border border-gray-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-lg font-mono font-bold text-gray-900">{result.barcode}</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {result.sticker ? (
                    <>
                      {result.sticker.warehouseName} ({result.sticker.warehouseCode})
                      {' '}&middot;{' '}batch of {result.sticker.batchQuantity}{' '}generated {fmtDate(result.sticker.batchCreatedAt)}
                      {' '}by {result.sticker.batchCreatedByName}
                    </>
                  ) : (
                    'Not in the sticker register'
                  )}
                </div>
              </div>
              {canManageStickers && result.sticker && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={openEdit}
                    className="px-4 py-1.5 text-sm font-medium text-[var(--color-primary)] border border-[var(--color-primary)]/30 rounded-lg hover:bg-[var(--color-primary)]/5"
                  >
                    Edit
                  </button>
                  <button
                    onClick={openDelete}
                    className="px-4 py-1.5 text-sm font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50"
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>

            {!result.sticker && (
              <div className="px-4 py-3 bg-amber-50 border-b border-amber-200 text-sm text-amber-800">
                <strong>No register record for this number</strong>{' '}&mdash; but the pick slip below still
                carries it. Labels printed before the 7 Aug 2026 sticker clear have no record, and a
                Replace label retires the old number out of the register while it is still stuck to the
                box. There is nothing here to edit or delete; work from the slip.
              </div>
            )}

            {result.contested && (
              <div className="px-4 py-3 bg-red-50 border-b border-red-200 text-sm text-red-700">
                <strong>Duplicate label.</strong>{' '}
                {result.slips.filter(s => s.live).length}{' '}pick slips still claim this number, so a scan
                cannot tell the boxes apart. Read the reference number printed on the physical label
                &mdash; that names the slip it really belongs to. Then open the OTHER slip, and use
                Picking Slips &rarr; Adjust Boxes &rarr; Replace to give its box a fresh number.
              </div>
            )}

            {!result.contested && result.slips.length > 1 && (
              <div className="px-4 py-3 bg-amber-50 border-b border-amber-200 text-sm text-amber-800">
                This number has been on {result.slips.length}{' '}pick slips. Only one is still live, so a
                scan resolves cleanly &mdash; but check the reference printed on the label before acting
                on it.
              </div>
            )}

            <div className="p-4">
              {result.slips.length === 0 ? (
                <p className="text-sm text-gray-500">
                  {result.scopeNarrowed
                    ? 'Not on any pick slip you have access to. You only see your assigned clients, so it may still be on a store someone else can see — ask an RVL Manager to look it up.'
                    : 'Not on any pick slip — this is a blank label, printed and waiting to be scanned.'}
                </p>
              ) : (
                <>
                  <div className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">
                    Linked to
                  </div>
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                          <th className="px-3 py-2">Store</th>
                          <th className="px-3 py-2">Client</th>
                          <th className="px-3 py-2">Pick Slip</th>
                          <th className="px-3 py-2">Status</th>
                          <th className="px-3 py-2">Where this label sits</th>
                          <th className="px-3 py-2 text-right">Boxes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.slips.map(s => (
                          <tr
                            key={`${s.id}:${s.loadId}`}
                            className={`border-t border-gray-100 ${s.live ? '' : 'text-gray-500'}`}
                          >
                            <td className="px-3 py-2">
                              <div className="font-semibold text-gray-900">{s.siteName || '(no store name)'}</div>
                              <div className="text-xs text-gray-500">{s.siteCode}</div>
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap">{s.clientName}</td>
                            <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">{s.id}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{s.status}</td>
                            <td className="px-3 py-2">
                              <div className="flex flex-wrap gap-1">
                                {placementBadges(s).map(b => (
                                  <span
                                    key={b.text}
                                    className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${b.cls}`}
                                  >
                                    {b.text}
                                  </span>
                                ))}
                              </div>
                              {s.scannedAt && (
                                <div className="text-[11px] text-gray-400 mt-0.5">
                                  scanned {fmtDate(s.scannedAt)}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right whitespace-nowrap">
                              <div>{s.releasableBoxCount}{' '}of {s.receiptBoxCount}</div>
                              <div className="text-xs text-gray-400">{fmtMoney(s.totalVal)}</div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
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
            <div className="w-40">
              <label className="block text-xs text-gray-600 mb-1">Format</label>
              <select
                value={genFormat}
                onChange={e => setGenFormat(e.target.value as StickerLayout)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              >
                <option value="a4sheet">A4 Sheet</option>
                <option value="roll">Roll</option>
              </select>
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
                <SortableTh col="warehouse" label="Warehouse" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} className="px-4 py-2" />
                <SortableTh col="quantity" label="Qty" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} className="px-4 py-2 text-right" />
                <SortableTh col="createdAt" label="Date" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} className="px-4 py-2" />
                <SortableTh col="createdByName" label="Generated By" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} className="px-4 py-2" />
                <th className="px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">Loading...</td></tr>
              ) : batches.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">No sticker batches yet.</td></tr>
              ) : sorted.map(b => (
                <tr key={b.id} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-2 whitespace-nowrap">
                    {b.warehouseName} ({b.warehouseCode})
                  </td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">{b.quantity}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-gray-500">{fmtDate(b.createdAt)}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{b.createdByName}</td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-gray-400 uppercase tracking-wide mr-0.5">PDF:</span>
                      <button
                        onClick={() => downloadBatch(b.id, 'a4sheet')}
                        disabled={downloading[`${b.id}:a4sheet`]}
                        className="px-3 py-1 text-xs font-medium text-[var(--color-primary)] border border-[var(--color-primary)]/30 rounded hover:bg-[var(--color-primary)]/5 disabled:opacity-50 flex items-center gap-1.5"
                      >
                        {downloading[`${b.id}:a4sheet`] && (
                          <div className="h-3 w-3 border-2 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin" />
                        )}
                        A4
                      </button>
                      <button
                        onClick={() => downloadBatch(b.id, 'roll')}
                        disabled={downloading[`${b.id}:roll`]}
                        className="px-3 py-1 text-xs font-medium text-gray-600 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1.5"
                      >
                        {downloading[`${b.id}:roll`] && (
                          <div className="h-3 w-3 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
                        )}
                        Roll
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Edit sticker ───────────────────────────────────────────────── */}
      {editOpen && result?.sticker && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-auto">
            <h2 className="text-lg font-bold text-gray-900 mb-1">Edit Sticker</h2>
            <p className="text-sm text-gray-500 mb-4">
              {result.sticker.warehouseName} ({result.sticker.warehouseCode}) &middot;
              {' '}generated {fmtDate(result.sticker.batchCreatedAt)} by {result.sticker.batchCreatedByName}
            </p>

            <div className="mb-4">
              <label className="block text-xs text-gray-600 mb-1">Sticker number</label>
              <input
                value={editBarcode}
                onChange={e => setEditBarcode(e.target.value.toUpperCase().replace(/\s+/g, ''))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono tracking-wide"
              />
              <p className="text-xs text-gray-500 mt-1">
                Changing the number also rewrites it on every pick slip box that carries it, so the
                register and the slip cannot disagree. A number already printed on a delivery note is
                refused &mdash; cancel or reverse that release first.
              </p>
            </div>

            <div className="mb-4">
              <label className="block text-xs text-gray-600 mb-1">Linked pick slips</label>
              {editLinks.length === 0 ? (
                <p className="text-sm text-gray-400 mb-2">Not linked to any pick slip.</p>
              ) : (
                <ul className="mb-2 space-y-1">
                  {editLinks.map(id => (
                    <li key={id} className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-gray-50 rounded-md">
                      <span className="font-mono text-xs">{id}</span>
                      <button
                        onClick={() => setEditLinks(prev => prev.filter(x => x !== id))}
                        className="text-xs text-red-600 hover:text-red-700"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex gap-2">
                <input
                  value={editNewLink}
                  onChange={e => setEditNewLink(e.target.value.toUpperCase())}
                  onKeyDown={e => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    const id = editNewLink.trim().toUpperCase();
                    if (id && !editLinks.includes(id)) setEditLinks(prev => [...prev, id]);
                    setEditNewLink('');
                  }}
                  placeholder="PS-1234-20260601-001"
                  className="flex-1 px-2.5 py-1.5 border border-gray-300 rounded-md text-sm font-mono"
                />
                <button
                  onClick={() => {
                    const id = editNewLink.trim().toUpperCase();
                    if (id && !editLinks.includes(id)) setEditLinks(prev => [...prev, id]);
                    setEditNewLink('');
                  }}
                  className="px-3 py-1.5 border border-gray-200 rounded-md text-sm text-gray-600 hover:bg-gray-50"
                >
                  Add
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                The pick slip must exist and be within your access, or the save is refused.
              </p>
            </div>

            <div className="mb-4">
              <label className="block text-xs text-gray-600 mb-1">Reason (recorded in the audit log)</label>
              <input
                value={editReason}
                onChange={e => setEditReason(e.target.value)}
                placeholder="e.g. label misprinted, relinked to the correct store"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
            </div>

            <div className="flex gap-3">
              <button
                onClick={saveEdit}
                disabled={saving || !editBarcode.trim() || !editReason.trim()}
                className="px-4 py-2 bg-[var(--color-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
              >
                {saving && <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                Save Changes
              </button>
              <button
                onClick={() => setEditOpen(false)}
                className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete sticker ─────────────────────────────────────────────── */}
      {deleteOpen && result?.sticker && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-auto">
            <h2 className="text-lg font-bold text-red-700 mb-2">Delete Sticker</h2>
            <p className="text-sm text-gray-600 mb-1">
              <span className="font-mono font-semibold">{result.sticker.barcodeValue}</span>
              {' '}&mdash; {result.sticker.warehouseName} ({result.sticker.warehouseCode})
            </p>
            <p className="text-sm text-gray-600 mb-4">
              This removes the record only. The number stays spent forever and is never reissued, and
              the printed label stays on the box.
            </p>

            {result.slips.length > 0 && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                <p className="text-sm text-red-700 font-semibold mb-1">
                  {result.slips.length}{' '}pick slip{result.slips.length === 1 ? '' : 's'}{' '}still carr
                  {result.slips.length === 1 ? 'ies' : 'y'} this label
                </p>
                <ul className="text-sm text-red-700 list-disc pl-5 mb-2">
                  {result.slips.map(s => (
                    <li key={s.id}>
                      {s.siteName || s.siteCode}{' '}&mdash; <span className="font-mono text-xs">{s.id}</span>{' '}({s.status})
                    </li>
                  ))}
                </ul>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={delAck}
                    onChange={e => setDelAck(e.target.checked)}
                    className="mt-0.5 w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                  />
                  <span className="text-sm text-red-700">
                    I understand the box is not removed &mdash; the slip keeps it, and a scan of this
                    label will no longer resolve to a store.
                  </span>
                </label>
              </div>
            )}

            <div className="mb-4">
              <label className="block text-xs text-gray-600 mb-1">Reason (recorded in the audit log)</label>
              <input
                value={delReason}
                onChange={e => setDelReason(e.target.value)}
                placeholder="e.g. label destroyed before use"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
            </div>

            <div className="mb-4">
              <label className="block text-xs text-gray-600 mb-1">Your security code</label>
              <input
                type="password"
                value={delCode}
                onChange={e => setDelCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
                maxLength={4}
                placeholder="4-char code"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono tracking-widest"
              />
              <p className="text-xs text-gray-500 mt-1">
                The same code you use to release stock. Set it under My Account if you have none.
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={doDelete}
                disabled={
                  deleting ||
                  delCode.length !== 4 ||
                  !delReason.trim() ||
                  (result.slips.length > 0 && !delAck)
                }
                className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
              >
                {deleting && <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                Delete Sticker
              </button>
              <button
                onClick={() => setDeleteOpen(false)}
                className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
