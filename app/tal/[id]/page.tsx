'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth, authFetch } from '@/lib/useAuth';
import {
  TAL_STATUS_LABELS, TAL_STATUS_BADGE, TAL_IN_WAREHOUSE, TAL_REGIONS, NOT_FIXED_REASONS, statusCounts, daysSince, openSlots,
  unitLocation, regionOf, unitsToBillTal, type TalBooking, type TalStatus, type NotFixedReason,
} from '@/lib/talShared';

const fmtDateTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });

export default function TalBookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { session } = useAuth('view_aged_stock');
  const router = useRouter();
  const [b, setB] = useState<TalBooking | null>(null);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [reason, setReason] = useState<NotFixedReason | ''>('');
  const [ticket, setTicket] = useState('');
  const [busy, setBusy] = useState(false);
  const canManage = (session?.permissions ?? []).includes('manage_pick_slips');

  const load = useCallback(async () => {
    const res = await authFetch(`/api/tal/${id}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (res.ok) setB(data.booking); else setError(data.error || 'Could not load booking');
  }, [id]);
  useEffect(() => { if (session) load(); }, [session, load]);

  const markUnrepairable = async () => {
    if (!reason) return setError('Choose why BSC did not fix the unit(s)');
    if (!picked.size || !confirm(`Mark ${picked.size} unit(s) as Unrepairable? Use this only once BSC confirms they will not be released.`)) return;
    setBusy(true); setError('');
    const res = await authFetch(`/api/tal/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unrepairable: [...picked], reason, note }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(data.error || 'Update failed');
    setB(data.booking); setPicked(new Set()); setNote(''); setReason('');
  };

  const saveTicket = async () => {
    setBusy(true); setError('');
    const res = await authFetch(`/api/tal/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnTicket: ticket }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(data.error || 'Update failed');
    setB(data.booking); setTicket('');
  };

  const remove = async () => {
    if (!b || !confirm(`Delete booking ${b.brn}? This cannot be undone.`)) return;
    const res = await authFetch(`/api/tal/${id}`, { method: 'DELETE' });
    if (res.ok) router.push('/tal'); else setError((await res.json().catch(() => ({}))).error || 'Delete failed');
  };

  if (error && !b) return <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3">{error}</div>;
  if (!b) return <div className="text-gray-500">Loading…</div>;
  const counts = statusCounts(b);
  const toBill = unitsToBillTal(b);

  return (
    <div className="flex flex-col gap-5 max-w-6xl">
      <div className="flex items-start justify-between">
        <div>
          <Link href="/tal" className="text-sm text-gray-500 hover:underline">← Takealot Bookings</Link>
          <h1 className="text-2xl font-bold text-gray-900 font-mono">{b.brn}</h1>
          <p className="text-sm text-gray-500">
            {b.supplierName || 'Bosch'} · {TAL_REGIONS[regionOf(b)].tal} · Booking {b.bookingDate ? b.bookingDate.split('-').reverse().join('/') : '—'}{b.timeSlot ? ` ${b.timeSlot}` : ''}
            {b.sourceFileName && <> · {b.sourceFileName}</>}
          </p>
          <div className="flex flex-wrap gap-1 mt-2">
            {(Object.keys(counts) as TalStatus[]).map((s) => (
              <span key={s} className={`px-2 py-0.5 rounded-full text-xs font-medium ${TAL_STATUS_BADGE[s]}`}>{counts[s]} {TAL_STATUS_LABELS[s]}</span>
            ))}
            {toBill.length > 0 && (
              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-800">{toBill.length} to bill TAL</span>
            )}
          </div>
        </div>
        {canManage && b.units.length === 0 && (
          <button onClick={remove} className="px-4 py-2 rounded-lg text-sm font-medium border border-red-300 text-red-700 hover:bg-red-50">Delete booking</button>
        )}
      </div>

      {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3">{error}</div>}

      {(b.returnTicket || canManage) && (
        <div className="bg-white rounded-xl border border-gray-200 px-4 py-3 flex flex-wrap items-center gap-3 text-sm">
          <span className="font-medium text-gray-700">Takealot Zendesk ticket (return approval)</span>
          <span className="font-mono">{b.returnTicket || <span className="text-gray-400">not received yet</span>}</span>
          {canManage && (
            <>
              <div className="flex-1" />
              <input value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder={b.returnTicket ? 'Change ticket number' : 'Ticket number'}
                aria-label="Zendesk ticket number" className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-48" />
              <button onClick={saveTicket} disabled={busy || !ticket.trim()} className="px-4 py-2 rounded-lg text-sm font-medium bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-50">
                Save ticket
              </button>
            </>
          )}
        </div>
      )}

      {b.instructions.map((ins) => {
        const units = b.units.filter((u) => u.instructionNo === ins.instructionNo);
        const open = Math.max(0, openSlots(b, ins.instructionNo));
        return (
          <div key={ins.instructionNo} className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3 text-sm">
              <span className="font-semibold font-mono">Instruction {ins.instructionNo}</span>
              <span className="text-gray-500">Qty {ins.qty}</span>
              {open > 0 && (
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${TAL_STATUS_BADGE[counts.missing_tal ? 'missing_tal' : 'booking_received']}`}>
                  {open} {TAL_STATUS_LABELS[counts.missing_tal ? 'missing_tal' : 'booking_received']}
                </span>
              )}
            </div>
            {units.length > 0 && (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-gray-600">
                  <tr>
                    {canManage && <th className="px-4 py-2 w-8" />}
                    <th className="px-4 py-2">RRN</th>
                    <th className="px-4 py-2">Serial</th>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2">Since</th>
                    <th className="px-4 py-2">Location</th>
                    <th className="px-4 py-2 text-right">Days in WH</th>
                  </tr>
                </thead>
                <tbody>
                  {units.map((u) => (
                    <tr key={u.rrn} className="border-t border-gray-100">
                      {canManage && (
                        <td className="px-4 py-2">
                          {u.status === 'receipted_bsc' && (
                            <input type="checkbox" checked={picked.has(u.rrn)} aria-label={`Select ${u.rrn}`}
                              onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(u.rrn)) n.delete(u.rrn); else n.add(u.rrn); return n; })} />
                          )}
                        </td>
                      )}
                      <td className="px-4 py-2 font-mono">{u.rrn}</td>
                      <td className="px-4 py-2 font-mono">{u.serial || '—'}</td>
                      <td className="px-4 py-2"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${TAL_STATUS_BADGE[u.status]}`}>{TAL_STATUS_LABELS[u.status]}</span>
                        {u.notFixedReason && <div className="text-xs text-gray-500 mt-0.5">{NOT_FIXED_REASONS[u.notFixedReason].label}</div>}
                      </td>
                      <td className="px-4 py-2">{fmtDateTime(u.statusAt)}</td>
                      <td className="px-4 py-2">{unitLocation(u, b)}</td>
                      <td className="px-4 py-2 text-right">{TAL_IN_WAREHOUSE.includes(u.status) ? daysSince(u.statusAt) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}

      {picked.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
          <span className="text-sm font-medium text-gray-700">{picked.size} unit(s) at BSC selected</span>
          <select value={reason} onChange={(e) => setReason(e.target.value as NotFixedReason)} aria-label="Why BSC did not fix it"
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
            <option value="">Why not fixed?</option>
            {(Object.keys(NOT_FIXED_REASONS) as NotFixedReason[]).map((r) => <option key={r} value={r}>{NOT_FIXED_REASONS[r].label}</option>)}
          </select>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)"
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm flex-1 min-w-48" />
          <button onClick={markUnrepairable} disabled={busy} className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">
            Mark Unrepairable
          </button>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="text-sm font-semibold text-gray-700 mb-2">History</div>
        <ul className="text-sm text-gray-600 flex flex-col gap-1">
          {[...b.history].reverse().map((h, i) => (
            <li key={i}>
              <span className="text-gray-400">{fmtDateTime(h.at)}</span> · {h.byName ?? '—'} · {h.note ?? (h.status && TAL_STATUS_LABELS[h.status])}
              {h.repName && <> · Rep {h.repName}</>}{h.warehouseName && <> · {h.warehouseName}</>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
