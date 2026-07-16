'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useAuth, authFetch } from '@/lib/useAuth';
import { useTableSort } from '@/lib/useTableSort';
import SortableTh from '@/components/SortableTh';

interface SwapLine { product: string; description?: string; quantity: number }
interface SwapOutDto {
  id: string;
  clientId: string;
  pickingNumber: string;
  requestDate?: string;
  channel?: string;
  storeName: string;
  storeId?: string;
  region?: string;
  lines: SwapLine[];
  status: string;
  assignedRepName?: string;
  createdAt: string;
}
interface ClientDto { id: string; name: string; vendorNumbers?: string[]; swapOutEnabled?: boolean }

/** Label a client with its vendor number(s) so same-name records are distinguishable. */
function clientLabel(c: ClientDto): string {
  const nums = (c.vendorNumbers ?? []).filter(Boolean);
  return nums.length ? `${c.name} (${nums.join(', ')})` : c.name;
}

const STATUS_LABELS: Record<string, string> = {
  requested: 'Requested',
  picking_assigned: 'Picking # Assigned',
  received_wh: 'Received at WH',
  issued_rep: 'Issued to Rep',
  faulty_returned: 'Faulty Returned to WH',
  returned_client: 'Returned to Client',
  cancelled: 'Cancelled',
};
const STATUS_BADGE: Record<string, string> = {
  requested: 'bg-gray-100 text-gray-600',
  picking_assigned: 'bg-blue-100 text-blue-700',
  received_wh: 'bg-indigo-100 text-indigo-700',
  issued_rep: 'bg-amber-100 text-amber-700',
  faulty_returned: 'bg-purple-100 text-purple-700',
  returned_client: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-red-100 text-red-700',
};

const units = (s: SwapOutDto) => s.lines.reduce((t, l) => t + (l.quantity || 0), 0);
const fmtDate = (iso?: string) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('en-GB'); } catch { return iso; }
};

export default function SwapOutsListPage() {
  const { session } = useAuth('view_aged_stock');
  const [rows, setRows] = useState<SwapOutDto[]>([]);
  const [clients, setClients] = useState<ClientDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedClientIds, setSelectedClientIds] = useState<Set<string>>(new Set());
  const [clientDropOpen, setClientDropOpen] = useState(false);
  const clientDropRef = useRef<HTMLDivElement>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!session) return;
    (async () => {
      const [soRes, clRes] = await Promise.all([
        authFetch('/api/swap-outs', { cache: 'no-store' }),
        authFetch('/api/control/clients', { cache: 'no-store' }),
      ]);
      if (soRes.ok) setRows((await soRes.json()).swapOuts ?? []);
      if (clRes.ok) {
        const data = await clRes.json();
        setClients(Array.isArray(data) ? data : data.clients ?? []);
      }
      setLoading(false);
    })();
  }, [session]);

  const clientName = useMemo(() => {
    const m = new Map(clients.map((c) => [c.id, c.name]));
    return (id: string) => m.get(id) ?? '—';
  }, [clients]);

  const enabledClients = useMemo(
    () => clients.filter((c) => c.swapOutEnabled).sort((a, b) => clientLabel(a).localeCompare(clientLabel(b))),
    [clients],
  );

  // Close the client dropdown on outside click
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (clientDropRef.current && !clientDropRef.current.contains(e.target as Node)) {
        setClientDropOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const toggleClient = (id: string) =>
    setSelectedClientIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });

  const filtered = rows.filter((r) => {
    if (selectedClientIds.size > 0 && !selectedClientIds.has(r.clientId)) return false;
    if (statusFilter && r.status !== statusFilter) return false;
    if (search) {
      const q = search.trim().toLowerCase();
      const hay = `${r.pickingNumber} ${r.storeName} ${r.region ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Sortable grid — defaults to newest request date first.
  const { sorted, sortCol, sortDir, toggleSort } = useTableSort(filtered, {
    pickingNumber: (r) => r.pickingNumber,
    client: (r) => clientName(r.clientId),
    store: (r) => r.storeName,
    region: (r) => r.region,
    units: (r) => units(r),
    rep: (r) => r.assignedRepName,
    status: (r) => STATUS_LABELS[r.status] ?? r.status,
    date: (r) => r.requestDate || r.createdAt,
  }, 'date', 'desc');

  if (loading) return <div className="text-gray-500">Loading…</div>;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Swap-Outs</h1>
          <p className="text-sm text-gray-500">Chain of custody for supplier swap-out stock.</p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/swap-outs/import"
            className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            Import Sheet
          </Link>
        </div>
      </div>

      {enabledClients.length === 0 && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-3">
          No client has Swap-Out enabled yet. Turn it on from Control Centre →
          Clients / Suppliers → (a client) → Swap-Out.
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Scan / search picking #, store…"
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-64 focus:ring-2 focus:ring-[var(--color-primary)] outline-none"
          autoFocus
        />
        <div className="relative" ref={clientDropRef}>
          <button
            type="button"
            onClick={() => setClientDropOpen((o) => !o)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white flex items-center gap-2 min-w-[12rem] justify-between hover:bg-gray-50"
          >
            <span className="truncate">
              {(() => {
                if (selectedClientIds.size === 0) return 'All clients';
                if (selectedClientIds.size === 1) {
                  const c = enabledClients.find((x) => selectedClientIds.has(x.id));
                  return c ? clientLabel(c) : '1 client selected';
                }
                return `${selectedClientIds.size} clients selected`;
              })()}
            </span>
            <svg className={`w-4 h-4 text-gray-400 transition-transform ${clientDropOpen ? 'rotate-180' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {clientDropOpen && (
            <div className="absolute z-20 mt-1 w-72 max-h-80 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg py-1">
              <label className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 cursor-pointer border-b border-gray-100">
                <input
                  type="checkbox"
                  checked={selectedClientIds.size === 0}
                  onChange={() => setSelectedClientIds(new Set())}
                />
                <span className="font-medium">All clients</span>
              </label>
              {enabledClients.length === 0 ? (
                <p className="px-3 py-2 text-sm text-gray-400 italic">No swap-out clients enabled.</p>
              ) : (
                enabledClients.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedClientIds.has(c.id)}
                      onChange={() => toggleClient(c.id)}
                    />
                    <span className="truncate">{clientLabel(c)}</span>
                  </label>
                ))
              )}
            </div>
          )}
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
        >
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <span className="text-sm text-gray-400">{filtered.length} of {rows.length}</span>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-400 border-b border-gray-100">
              <SortableTh col="pickingNumber" label="Picking #" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} className="px-4 py-3 font-medium" />
              <SortableTh col="client" label="Client" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} className="px-4 py-3 font-medium" />
              <SortableTh col="store" label="Store" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} className="px-4 py-3 font-medium" />
              <SortableTh col="region" label="Region" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} className="px-4 py-3 font-medium" />
              <SortableTh col="units" label="Units" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} className="px-4 py-3 font-medium text-right" />
              <SortableTh col="rep" label="Rep" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} className="px-4 py-3 font-medium" />
              <SortableTh col="status" label="Status" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} className="px-4 py-3 font-medium" />
              <SortableTh col="date" label="Date" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} className="px-4 py-3 font-medium" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                <td className="px-4 py-3">
                  <Link href={`/swap-outs/${r.id}`} className="text-[var(--color-primary)] font-medium hover:underline">
                    {r.pickingNumber || <span className="text-gray-400 italic">no picking #</span>}
                  </Link>
                </td>
                <td className="px-4 py-3 text-gray-700">{clientName(r.clientId)}</td>
                <td className="px-4 py-3 text-gray-700">{r.storeName}</td>
                <td className="px-4 py-3 text-gray-500">{r.region ?? '—'}</td>
                <td className="px-4 py-3 text-right text-gray-700">{units(r)}</td>
                <td className="px-4 py-3 text-gray-500">{r.assignedRepName ?? '—'}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[r.status] ?? 'bg-gray-100 text-gray-600'}`}>
                    {STATUS_LABELS[r.status] ?? r.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500">{fmtDate(r.requestDate || r.createdAt)}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400">No swap-outs found.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
