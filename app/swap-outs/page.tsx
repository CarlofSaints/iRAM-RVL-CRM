'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useAuth, authFetch } from '@/lib/useAuth';

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
interface ClientDto { id: string; name: string; swapOutEnabled?: boolean }

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
  const [clientFilter, setClientFilter] = useState('');
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

  const enabledClients = clients.filter((c) => c.swapOutEnabled);

  const filtered = rows.filter((r) => {
    if (clientFilter && r.clientId !== clientFilter) return false;
    if (statusFilter && r.status !== statusFilter) return false;
    if (search) {
      const q = search.trim().toLowerCase();
      const hay = `${r.pickingNumber} ${r.storeName} ${r.region ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

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
        <select
          value={clientFilter}
          onChange={(e) => setClientFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
        >
          <option value="">All clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
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
              <th className="px-4 py-3 font-medium">Picking #</th>
              <th className="px-4 py-3 font-medium">Client</th>
              <th className="px-4 py-3 font-medium">Store</th>
              <th className="px-4 py-3 font-medium">Region</th>
              <th className="px-4 py-3 font-medium text-right">Units</th>
              <th className="px-4 py-3 font-medium">Rep</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Date</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
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
