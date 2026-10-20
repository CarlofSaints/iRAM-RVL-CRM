'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth, authFetch } from '@/lib/useAuth';
import { useTableSort } from '@/lib/useTableSort';
import SortableTh from '@/components/SortableTh';
import {
  TAL_STATUS_LABELS, TAL_STATUS_BADGE, TAL_IN_WAREHOUSE, TAL_REGIONS, statusCounts, daysSince, regionOf, unitsToBillTal,
  type TalBooking, type TalStatus,
} from '@/lib/talShared';

const fmtDate = (s?: string) => (s ? s.split('-').reverse().join('/') : '—');
const totalQty = (b: TalBooking) => b.instructions.reduce((t, i) => t + i.qty, 0);
/** Longest any unit of this booking has been sitting in an iRam warehouse. */
const maxDaysInWh = (b: TalBooking) =>
  Math.max(-1, ...b.units.filter((u) => TAL_IN_WAREHOUSE.includes(u.status)).map((u) => daysSince(u.statusAt)));

export default function TalBookingsPage() {
  const { session } = useAuth('view_aged_stock');
  const [rows, setRows] = useState<TalBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => {
    if (!session) return;
    authFetch('/api/tal', { cache: 'no-store' })
      .then(async (r) => (r.ok ? setRows((await r.json()).bookings ?? []) : setError('Could not load bookings')))
      .finally(() => setLoading(false));
  }, [session]);

  const filtered = rows.filter((b) => {
    if (statusFilter && !statusCounts(b)[statusFilter as TalStatus]) return false;
    if (search) {
      const q = search.trim().toUpperCase();
      const hay = [b.brn, b.returnTicket ?? '', ...b.instructions.map((i) => i.instructionNo), ...b.units.map((u) => u.rrn)].join(' ');
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const { sorted, sortCol, sortDir, toggleSort } = useTableSort(filtered, {
    brn: (b) => b.brn,
    date: (b) => b.bookingDate || b.createdAt,
    dc: (b) => regionOf(b),
    ins: (b) => b.instructions.length,
    qty: (b) => totalQty(b),
    days: (b) => maxDaysInWh(b),
  }, 'date', 'desc');

  if (loading) return <div className="text-gray-500">Loading…</div>;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Takealot Bookings</h1>
          <p className="text-sm text-gray-500">Bosch collections from Takealot, tracked unit by unit (RRN).</p>
        </div>
        <Link href="/tal/import" className="px-4 py-2 rounded-lg text-sm font-medium bg-[var(--color-primary)] text-white hover:opacity-90">
          Load Booking PDF
        </Link>
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Scan / search booking ref, instruction, RRN, ticket…"
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-80 focus:ring-2 focus:ring-[var(--color-primary)] outline-none"
          autoFocus
        />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
          <option value="">All statuses</option>
          {Object.entries(TAL_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <span className="text-sm text-gray-400">{filtered.length} of {rows.length}</span>
      </div>

      {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3">{error}</div>}

      <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-600">
            <tr>
              <SortableTh col="brn" label="Booking Ref" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} className="px-4 py-3" />
              <SortableTh col="date" label="Booking Date" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} className="px-4 py-3" />
              <SortableTh col="dc" label="DC" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} className="px-4 py-3" />
              <SortableTh col="ins" label="Instructions" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} className="px-4 py-3 text-right" />
              <SortableTh col="qty" label="Units" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} className="px-4 py-3 text-right" />
              <th className="px-4 py-3">Status</th>
              <SortableTh col="days" label="Days in WH" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} className="px-4 py-3 text-right" title="Longest any unit has been in an iRam warehouse" />
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">No bookings yet. Load a Booking Confirmation PDF to start.</td></tr>
            )}
            {sorted.map((b) => {
              const counts = statusCounts(b);
              const toBill = unitsToBillTal(b).length;
              const days = maxDaysInWh(b);
              return (
                <tr key={b.id} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono">
                    <Link href={`/tal/${b.id}`} className="text-[var(--color-primary)] hover:underline">{b.brn}</Link>
                  </td>
                  <td className="px-4 py-3">{fmtDate(b.bookingDate)}{b.timeSlot ? ` ${b.timeSlot}` : ''}</td>
                  <td className="px-4 py-3">{TAL_REGIONS[regionOf(b)].tal}</td>
                  <td className="px-4 py-3 text-right">{b.instructions.length}</td>
                  <td className="px-4 py-3 text-right">{totalQty(b)}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(Object.keys(counts) as TalStatus[]).map((s) => (
                        <span key={s} className={`px-2 py-0.5 rounded-full text-xs font-medium ${TAL_STATUS_BADGE[s]}`}>
                          {counts[s]} {TAL_STATUS_LABELS[s]}
                        </span>
                      ))}
                      {toBill > 0 && (
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-800">{toBill} to bill TAL</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">{days >= 0 ? days : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
