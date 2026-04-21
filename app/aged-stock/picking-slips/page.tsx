'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PdfRow {
  barcode: string;
  articleCode: string;
  vendorProductCode: string;
  description: string;
  qty: number;
  val: number;
}

type SlipStatus = 'generated' | 'sent' | 'picked' | 'receipted' | 'in-transit' | 'returned-to-vendor';

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
  rowCount: number;
  fileName: string;
  spWebUrl?: string;
  generatedAt: string;
  status: SlipStatus;
  rows: PdfRow[];
  sentAt?: string;
  editedAt?: string;
  spWebUrlEdited?: string;
  spDriveId?: string;
  spFileId?: string;
}

interface RepDto {
  id: string;
  name: string;
  surname: string;
  email: string;
}

interface StoreDto {
  id: string;
  siteCode: string;
  channel: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return iso; }
}

function fmtCurrency(v: number): string {
  return `R ${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const STATUS_LABELS: Record<SlipStatus, string> = {
  'generated': 'Generated',
  'sent': 'Sent',
  'picked': 'Picked',
  'receipted': 'Receipted',
  'in-transit': 'In Transit',
  'returned-to-vendor': 'Returned to Vendor',
};

const STATUS_COLORS: Record<SlipStatus, string> = {
  'generated': 'bg-gray-100 text-gray-700',
  'sent': 'bg-blue-100 text-blue-700',
  'picked': 'bg-amber-100 text-amber-700',
  'receipted': 'bg-green-100 text-green-700',
  'in-transit': 'bg-purple-100 text-purple-700',
  'returned-to-vendor': 'bg-red-100 text-red-700',
};

type SortCol = 'id' | 'clientName' | 'vendorNumber' | 'store' | 'products' | 'totalQty' | 'totalVal' | 'generatedAt' | 'status';
type SortDir = 'asc' | 'desc';

// ── Component ─────────────────────────────────────────────────────────────────

export default function PickingSlipsPage() {
  const { session } = useAuth('view_aged_stock');
  const router = useRouter();
  const perms = session?.permissions ?? [];
  const canManage = perms.includes('manage_pick_slips');
  const canReceipt = perms.includes('receipt_stock');

  const [toast, setToast] = useState<ToastData | null>(null);
  const notify = (message: string, type: 'success' | 'error' = 'success') =>
    setToast({ message, type });

  const [slips, setSlips] = useState<SlipDto[]>([]);
  const [reps, setReps] = useState<RepDto[]>([]);
  const [stores, setStores] = useState<StoreDto[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [clientFilter, setClientFilter] = useState('');
  const [storeQuery, setStoreQuery] = useState('');
  const [refQuery, setRefQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [vendorFilter, setVendorFilter] = useState('');
  const [channelFilter, setChannelFilter] = useState('');

  // Sort
  const [sortCol, setSortCol] = useState<SortCol>('generatedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  function toggleSort(col: SortCol) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  }

  // Selection
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Modals
  const [editSlip, setEditSlip] = useState<SlipDto | null>(null);
  const [editRows, setEditRows] = useState<PdfRow[]>([]);
  const [editSaving, setEditSaving] = useState(false);

  const [sendSlips, setSendSlips] = useState<SlipDto[]>([]);
  const [sendTo, setSendTo] = useState('');
  const [sendCc, setSendCc] = useState('');
  const [sendBcc, setSendBcc] = useState('');
  const [sendMode, setSendMode] = useState<'combined' | 'individual'>('combined');
  const [sendRep, setSendRep] = useState('');
  const [sendSending, setSendSending] = useState(false);

  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteDeleting, setDeleteDeleting] = useState(false);

  // ── Fetch data ──

  const fetchSlips = useCallback(async () => {
    try {
      const res = await authFetch('/api/pick-slips', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setSlips(data.slips ?? []);
      } else {
        notify('Failed to load pick slips', 'error');
      }
    } catch {
      notify('Network error loading pick slips', 'error');
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    Promise.all([
      fetchSlips(),
      authFetch('/api/control/reps', { cache: 'no-store' })
        .then(r => r.ok ? r.json() : [])
        .then(data => setReps(Array.isArray(data) ? data : []))
        .catch(() => {}),
      authFetch('/api/control/stores', { cache: 'no-store' })
        .then(r => r.ok ? r.json() : [])
        .then(data => setStores(Array.isArray(data) ? data : []))
        .catch(() => {}),
    ]).finally(() => setLoading(false));
  }, [session, fetchSlips]);

  // ── Derived ──

  const clientOptions = useMemo(() => {
    const map = new Map<string, { id: string; name: string; vendorNumber: string }>();
    for (const s of slips) {
      if (!map.has(s.clientId)) {
        map.set(s.clientId, { id: s.clientId, name: s.clientName, vendorNumber: s.vendorNumber });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [slips]);

  const vendorOptions = useMemo(() => {
    const set = new Set<string>();
    for (const s of slips) { if (s.vendorNumber) set.add(s.vendorNumber); }
    return Array.from(set).sort();
  }, [slips]);

  // siteCode → channel lookup from stores control data
  const channelBySiteCode = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of stores) {
      if (s.siteCode && s.channel) map.set(s.siteCode.trim().toLowerCase(), s.channel);
    }
    return map;
  }, [stores]);

  const channelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const s of slips) {
      const ch = channelBySiteCode.get(s.siteCode.trim().toLowerCase());
      if (ch) set.add(ch);
    }
    return Array.from(set).sort();
  }, [slips, channelBySiteCode]);

  const filtered = useMemo(() => {
    const sq = storeQuery.trim().toLowerCase();
    const rq = refQuery.trim().toLowerCase();
    return slips.filter(s => {
      if (clientFilter && s.clientId !== clientFilter) return false;
      if (vendorFilter && s.vendorNumber !== vendorFilter) return false;
      if (channelFilter) {
        const ch = channelBySiteCode.get(s.siteCode.trim().toLowerCase());
        if (ch !== channelFilter) return false;
      }
      if (sq) {
        const hay = `${s.siteName} ${s.siteCode}`.toLowerCase();
        if (!hay.includes(sq)) return false;
      }
      if (rq && !s.id.toLowerCase().includes(rq)) return false;
      if (statusFilter && s.status !== statusFilter) return false;
      return true;
    });
  }, [slips, clientFilter, vendorFilter, channelFilter, channelBySiteCode, storeQuery, refQuery, statusFilter]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    const dir = sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      let av: string | number, bv: string | number;
      switch (sortCol) {
        case 'id':           av = a.id; bv = b.id; break;
        case 'clientName':   av = a.clientName; bv = b.clientName; break;
        case 'vendorNumber': av = a.vendorNumber; bv = b.vendorNumber; break;
        case 'store':        av = `${a.siteName} ${a.siteCode}`; bv = `${b.siteName} ${b.siteCode}`; break;
        case 'products':     av = new Set(a.rows.map(r => r.articleCode || r.barcode)).size; bv = new Set(b.rows.map(r => r.articleCode || r.barcode)).size; break;
        case 'totalQty':     av = a.totalQty; bv = b.totalQty; break;
        case 'totalVal':     av = a.totalVal; bv = b.totalVal; break;
        case 'generatedAt':  av = a.generatedAt; bv = b.generatedAt; break;
        case 'status':       av = a.status; bv = b.status; break;
        default: return 0;
      }
      if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir;
      return ((av as number) - (bv as number)) * dir;
    });
    return list;
  }, [filtered, sortCol, sortDir]);

  // Keep selection valid — remove IDs that no longer appear in filtered
  useEffect(() => {
    const ids = new Set(filtered.map(s => s.id));
    setSelected(prev => {
      const next = new Set<string>();
      for (const id of prev) { if (ids.has(id)) next.add(id); }
      return next.size !== prev.size ? next : prev;
    });
  }, [filtered]);

  const allSelected = sorted.length > 0 && selected.size === sorted.length;

  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(sorted.map(s => s.id)));
  }

  function toggleOne(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // ── Edit modal ──

  function openEdit(slip: SlipDto) {
    setEditSlip(slip);
    setEditRows(slip.rows.map(r => ({ ...r })));
  }

  function updateEditRow(idx: number, field: 'qty' | 'val', value: number) {
    setEditRows(prev => prev.map((r, i) => i === idx ? { ...r, [field]: value } : r));
  }

  function deleteEditRow(idx: number) {
    setEditRows(prev => prev.filter((_, i) => i !== idx));
  }

  async function saveEdit() {
    if (!editSlip) return;
    setEditSaving(true);
    try {
      const res = await authFetch(`/api/pick-slips/${editSlip.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: editSlip.clientId,
          loadId: editSlip.loadId,
          rows: editRows,
        }),
      });
      if (res.ok) {
        notify('Pick slip updated');
        setEditSlip(null);
        await fetchSlips();
      } else {
        const data = await res.json().catch(() => ({}));
        notify(data.error || 'Failed to save', 'error');
      }
    } catch {
      notify('Network error saving', 'error');
    } finally {
      setEditSaving(false);
    }
  }

  // ── Send modal ──

  function openSend(slipsToSend: SlipDto[]) {
    setSendSlips(slipsToSend);
    setSendTo('');
    setSendCc('');
    setSendBcc('');
    setSendMode('combined');
    setSendRep('');
  }

  function onRepChange(repId: string) {
    setSendRep(repId);
    const rep = reps.find(r => r.id === repId);
    if (rep?.email) setSendTo(rep.email);
  }

  async function doSend() {
    if (sendSlips.length === 0) return;
    const toList = sendTo.split(/[,;]\s*/).map(s => s.trim()).filter(Boolean);
    if (toList.length === 0) {
      notify('Enter at least one TO email', 'error');
      return;
    }
    setSendSending(true);
    try {
      const res = await authFetch('/api/pick-slips/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slipIds: sendSlips.map(s => s.id),
          to: toList,
          cc: sendCc.split(/[,;]\s*/).map(s => s.trim()).filter(Boolean),
          bcc: sendBcc.split(/[,;]\s*/).map(s => s.trim()).filter(Boolean),
          sendMode,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        notify(`Sent ${data.sent ?? 0} pick slip${(data.sent ?? 0) !== 1 ? 's' : ''}`);
        setSendSlips([]);
        await fetchSlips();
      } else {
        notify(data.error || 'Send failed', 'error');
      }
    } catch {
      notify('Network error sending', 'error');
    } finally {
      setSendSending(false);
    }
  }

  // ── Delete ──

  async function doDelete() {
    const items = sorted
      .filter(s => selected.has(s.id))
      .map(s => ({ clientId: s.clientId, loadId: s.loadId, slipId: s.id }));
    if (items.length === 0) return;
    setDeleteDeleting(true);
    try {
      const res = await authFetch('/api/pick-slips/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        notify(`Deleted ${data.deleted ?? 0} pick slip${(data.deleted ?? 0) !== 1 ? 's' : ''}`);
        setSelected(new Set());
        setDeleteConfirm(false);
        await fetchSlips();
      } else {
        notify(data.error || 'Delete failed', 'error');
      }
    } catch {
      notify('Network error deleting', 'error');
    } finally {
      setDeleteDeleting(false);
    }
  }

  if (!session) return null;

  return (
    <>
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Picking Slips</h1>
          <p className="text-sm text-gray-600 mt-1">
            {slips.length.toLocaleString()} pick slip{slips.length !== 1 ? 's' : ''} total
          </p>
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
                {c.vendorNumber ? `${c.name} - ${c.vendorNumber}` : c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Channel</label>
          <select
            value={channelFilter}
            onChange={e => setChannelFilter(e.target.value)}
            className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm"
          >
            <option value="">All channels</option>
            {channelOptions.map(ch => (
              <option key={ch} value={ch}>{ch}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Store</label>
          <input
            value={storeQuery}
            onChange={e => setStoreQuery(e.target.value)}
            placeholder="Name or code"
            className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Reference</label>
          <input
            value={refQuery}
            onChange={e => setRefQuery(e.target.value)}
            placeholder="Pick slip ID"
            className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Vendor #</label>
          <select
            value={vendorFilter}
            onChange={e => setVendorFilter(e.target.value)}
            className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm"
          >
            <option value="">All vendors</option>
            {vendorOptions.map(v => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Status</label>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm"
          >
            <option value="">All statuses</option>
            {(Object.keys(STATUS_LABELS) as SlipStatus[]).map(k => (
              <option key={k} value={k}>{STATUS_LABELS[k]}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && canManage && (
        <div className="bg-[var(--color-primary)]/10 border border-[var(--color-primary)]/20 rounded-lg px-4 py-3 mb-4 flex items-center gap-3">
          <span className="text-sm font-medium text-gray-900">
            {selected.size} selected
          </span>
          <button
            onClick={() => openSend(sorted.filter(s => selected.has(s.id)))}
            className="px-3 py-1.5 bg-[var(--color-primary)] text-white rounded-md text-sm font-medium hover:opacity-90"
          >
            Send Selected
          </button>
          <button
            onClick={() => setDeleteConfirm(true)}
            className="px-3 py-1.5 bg-red-600 text-white rounded-md text-sm font-medium hover:bg-red-700"
          >
            Delete Selected
          </button>
        </div>
      )}

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="max-h-[70vh] overflow-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 sticky top-0 z-10">
              <tr className="text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
                {canManage && (
                  <th className="px-3 py-2 w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      className="rounded border-gray-300"
                    />
                  </th>
                )}
                {([
                  ['id', 'Pick Slip ID', ''],
                  ['clientName', 'Client', ''],
                  ['vendorNumber', 'Vendor #', ''],
                  ['store', 'Store', ''],
                  ['products', 'Products', 'text-right'],
                  ['totalQty', 'Total Qty', 'text-right'],
                  ['totalVal', 'Total Value', 'text-right'],
                  ['generatedAt', 'Date Loaded', ''],
                  ['status', 'Status', ''],
                ] as [SortCol, string, string][]).map(([col, label, align]) => (
                  <th
                    key={col}
                    className={`px-3 py-2 whitespace-nowrap cursor-pointer select-none hover:text-gray-900 ${align}`}
                    onClick={() => toggleSort(col)}
                  >
                    {label}
                    {sortCol === col && (
                      <span className="ml-1 text-[var(--color-primary)]">{sortDir === 'asc' ? '▲' : '▼'}</span>
                    )}
                  </th>
                ))}
                {canManage && <th className="px-3 py-2 whitespace-nowrap">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={canManage ? 11 : 9} className="px-3 py-6 text-center text-gray-500">Loading...</td></tr>
              ) : sorted.length === 0 ? (
                <tr><td colSpan={canManage ? 11 : 9} className="px-3 py-6 text-center text-gray-500">No pick slips match the current filters.</td></tr>
              ) : sorted.map(s => (
                <tr key={s.id} className="border-t border-gray-100 hover:bg-gray-50">
                  {canManage && (
                    <td className="px-3 py-1.5">
                      <input
                        type="checkbox"
                        checked={selected.has(s.id)}
                        onChange={() => toggleOne(s.id)}
                        className="rounded border-gray-300"
                      />
                    </td>
                  )}
                  <td className="px-3 py-1.5 whitespace-nowrap font-mono text-xs">
                    {s.spWebUrl ? (
                      <a href={s.spWebUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--color-primary)] hover:underline">{s.id}</a>
                    ) : s.id}
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{s.clientName}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{s.vendorNumber}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{s.siteName} ({s.siteCode})</td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">{new Set(s.rows.map(r => r.articleCode || r.barcode)).size}</td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">{s.totalQty.toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">{fmtCurrency(s.totalVal)}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap text-xs text-gray-500">{fmtDate(s.generatedAt)}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[s.status] || 'bg-gray-100 text-gray-700'}`}>
                      {STATUS_LABELS[s.status] || s.status}
                    </span>
                  </td>
                  {canManage && (
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <div className="flex gap-1">
                        <button
                          onClick={() => openEdit(s)}
                          className="px-2 py-1 text-xs font-medium text-[var(--color-primary)] border border-[var(--color-primary)]/30 rounded hover:bg-[var(--color-primary)]/5"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => openSend([s])}
                          className="px-2 py-1 text-xs font-medium text-blue-600 border border-blue-200 rounded hover:bg-blue-50"
                        >
                          Send
                        </button>
                        {canReceipt && (
                          <button
                            onClick={() => router.push(`/aged-stock/receipts/capture?slipId=${encodeURIComponent(s.id)}&clientId=${encodeURIComponent(s.clientId)}&loadId=${encodeURIComponent(s.loadId)}`)}
                            className="px-2 py-1 text-xs font-medium text-teal-600 border border-teal-200 rounded hover:bg-teal-50"
                          >
                            Capture
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Edit Modal ─────────────────────────────────────────────────────── */}
      {editSlip && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h2 className="text-lg font-bold text-gray-900">Edit Pick Slip</h2>
              <button onClick={() => setEditSlip(null)} className="text-gray-400 hover:text-gray-600">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Header info */}
            <div className="px-6 py-3 bg-gray-50 text-sm grid grid-cols-2 gap-x-6 gap-y-1">
              <div><span className="text-gray-500">Client:</span> {editSlip.clientName}</div>
              <div><span className="text-gray-500">Store:</span> {editSlip.siteName} ({editSlip.siteCode})</div>
              <div><span className="text-gray-500">Vendor #:</span> {editSlip.vendorNumber}</div>
              <div><span className="text-gray-500">Warehouse:</span> {editSlip.warehouse}</div>
              <div><span className="text-gray-500">Reference:</span> {editSlip.id}</div>
            </div>

            {/* Line items table */}
            <div className="flex-1 overflow-auto px-6 py-4">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-xs font-semibold text-gray-600 uppercase tracking-wide border-b border-gray-200">
                    <th className="pb-2">Barcode</th>
                    <th className="pb-2">Article Code</th>
                    <th className="pb-2">Description</th>
                    <th className="pb-2">Vendor Code</th>
                    <th className="pb-2 text-right">Qty</th>
                    <th className="pb-2 text-right">Value</th>
                    <th className="pb-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {editRows.map((r, i) => (
                    <tr key={i} className="border-t border-gray-100">
                      <td className="py-1.5 text-xs">{r.barcode}</td>
                      <td className="py-1.5 text-xs">{r.articleCode}</td>
                      <td className="py-1.5 text-xs">{r.description}</td>
                      <td className="py-1.5 text-xs">{r.vendorProductCode}</td>
                      <td className="py-1.5 text-right">
                        <input
                          type="number"
                          value={r.qty}
                          onChange={e => updateEditRow(i, 'qty', Number(e.target.value) || 0)}
                          className="w-16 px-1.5 py-0.5 border border-gray-300 rounded text-right text-xs"
                        />
                      </td>
                      <td className="py-1.5 text-right">
                        <input
                          type="number"
                          step="0.01"
                          value={r.val}
                          onChange={e => updateEditRow(i, 'val', Number(e.target.value) || 0)}
                          className="w-20 px-1.5 py-0.5 border border-gray-300 rounded text-right text-xs"
                        />
                      </td>
                      <td className="py-1.5 text-center">
                        <button
                          onClick={() => deleteEditRow(i)}
                          title="Remove line"
                          className="text-red-400 hover:text-red-600"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {editRows.length === 0 && (
                <p className="text-center text-gray-500 text-sm py-4">No line items remaining.</p>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
              <div className="text-sm text-gray-600">
                {editRows.filter(r => r.qty > 0 || r.val > 0).length} lines
                &nbsp;·&nbsp;Qty: {editRows.reduce((s, r) => s + r.qty, 0).toLocaleString()}
                &nbsp;·&nbsp;Value: {fmtCurrency(editRows.reduce((s, r) => s + r.val, 0))}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setEditSlip(null)}
                  className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={saveEdit}
                  disabled={editSaving || editRows.filter(r => r.qty > 0 || r.val > 0).length === 0}
                  className="px-4 py-2 bg-[var(--color-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {editSaving && <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Send Modal ─────────────────────────────────────────────────────── */}
      {sendSlips.length > 0 && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-bold text-gray-900 mb-4">
              Send Pick Slip{sendSlips.length > 1 ? 's' : ''}
            </h2>

            {sendSending ? (
              <div className="flex flex-col items-center py-8 gap-3">
                <div className="h-8 w-8 border-4 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin" />
                <p className="text-sm text-gray-600">Sending...</p>
              </div>
            ) : (
              <>
                <div className="space-y-3 mb-4">
                  {/* Selected slips summary */}
                  <div className="bg-gray-50 rounded-lg p-3 text-xs text-gray-600 max-h-24 overflow-auto">
                    {sendSlips.map(s => (
                      <div key={s.id}>{s.id} — {s.siteName} ({s.siteCode})</div>
                    ))}
                  </div>

                  {/* Rep dropdown */}
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Rep</label>
                    <select
                      value={sendRep}
                      onChange={e => onRepChange(e.target.value)}
                      className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm"
                    >
                      <option value="">{reps.length === 0 ? 'No reps configured' : 'Select a rep...'}</option>
                      {reps.map(r => (
                        <option key={r.id} value={r.id}>
                          {r.name} {r.surname}{r.email ? ` (${r.email})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs text-gray-600 mb-1">TO</label>
                    <input
                      value={sendTo}
                      onChange={e => setSendTo(e.target.value)}
                      placeholder="email@example.com"
                      className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">CC</label>
                    <input
                      value={sendCc}
                      onChange={e => setSendCc(e.target.value)}
                      placeholder="Optional"
                      className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">BCC</label>
                    <input
                      value={sendBcc}
                      onChange={e => setSendBcc(e.target.value)}
                      placeholder="Optional"
                      className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm"
                    />
                  </div>

                  {sendSlips.length > 1 && (
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Send mode</label>
                      <div className="flex flex-col gap-1.5">
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            type="radio"
                            name="sendMode"
                            value="combined"
                            checked={sendMode === 'combined'}
                            onChange={() => setSendMode('combined')}
                          />
                          Send all pick slips in one email
                        </label>
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            type="radio"
                            name="sendMode"
                            value="individual"
                            checked={sendMode === 'individual'}
                            onChange={() => setSendMode('individual')}
                          />
                          Send each pick slip in a separate email
                        </label>
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={doSend}
                    disabled={!sendTo.trim()}
                    className="px-4 py-2 bg-[var(--color-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Send
                  </button>
                  <button
                    onClick={() => setSendSlips([])}
                    className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Delete Confirm Modal ───────────────────────────────────────────── */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
            <h2 className="text-lg font-bold text-gray-900 mb-2">Delete Pick Slips</h2>
            <p className="text-sm text-gray-600 mb-4">
              Are you sure you want to delete {selected.size} pick slip{selected.size !== 1 ? 's' : ''}?
              This will also remove the PDFs from SharePoint if possible.
            </p>
            <div className="flex gap-3">
              <button
                onClick={doDelete}
                disabled={deleteDeleting}
                className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {deleteDeleting && <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                Delete
              </button>
              <button
                onClick={() => setDeleteConfirm(false)}
                disabled={deleteDeleting}
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
