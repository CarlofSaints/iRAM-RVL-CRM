'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import * as XLSX from 'xlsx';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';
import { useTableSort } from '@/lib/useTableSort';
import { useColumnResize, RESIZE_HANDLE_CLASS } from '@/lib/useColumnResize';
import SortableTh from '@/components/SortableTh';
import {
  PROMO_KIT_STATUS_BADGE,
  PROMO_KIT_STATUS_LABELS,
  fmtPromoDateTime,
  kitUnits,
  type PromoKitStatus,
} from '@/lib/promoShared';

// ── DTOs (mirror lib/promoData.ts, plus the clientName the API joins on) ─────

interface KitLineDto {
  id: string;
  source: 'sku' | 'promo';
  ref: string;
  code: string;
  description: string;
  quantity: number;
}
interface KitDto {
  id: string;
  reference: string;
  clientId: string;
  clientName: string;
  name: string;
  notes?: string;
  lines: KitLineDto[];
  status: PromoKitStatus;
  currentBookingId?: string;
  createdAt: string;
  createdByName?: string;
  updatedAt: string;
}
interface BookingLineDto {
  lineId: string;
  source: 'sku' | 'promo';
  code: string;
  description: string;
  quantity: number;
  returnedQuantity?: number;
}
interface BookingDto {
  id: string;
  kitId: string;
  kitReference: string;
  kitName: string;
  clientId: string;
  clientName: string;
  bookedOutAt: string;
  bookedOutByName: string;
  bookedOutByEmail: string;
  holder: { type: string; id: string; name: string; email: string };
  lines: BookingLineDto[];
  outNote?: string;
  outEmailTo?: string[];
  outEmailError?: string;
  returnedAt?: string;
  returnedByName?: string;
  returnedComplete?: boolean;
  returnNote?: string;
  returnEmailTo?: string[];
  returnEmailError?: string;
}
interface ClientDto { id: string; name: string; vendorNumbers?: string[] }
interface HolderDto { type: 'user' | 'rep' | 'contact'; id: string; name: string; email: string; subtitle?: string }

function clientLabel(c: ClientDto): string {
  const nums = (c.vendorNumbers ?? []).filter(Boolean);
  return nums.length ? `${c.name} (${nums.join(', ')})` : c.name;
}

const KIT_COLS = ['Ref', 'Kit Name', 'Client', 'Lines', 'Units', 'Status', 'With', 'Since', 'Created'];
const LOG_COLS = [
  'Ref', 'Kit Name', 'Client', 'Booked Out', 'Booked Out By', 'Taken By', 'Email',
  'Lines', 'Units', 'Returned', 'Received By', 'Result', 'Note',
];

export default function PromoKitsPage() {
  const { session } = useAuth('view_promo_kits');
  const perms = session?.permissions ?? [];
  const canManage = perms.includes('manage_promo_kits');
  const canBook = perms.includes('book_promo_kits');

  const [kits, setKits] = useState<KitDto[]>([]);
  const [bookings, setBookings] = useState<BookingDto[]>([]);
  const [clients, setClients] = useState<ClientDto[]>([]);
  const [holders, setHolders] = useState<HolderDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [tab, setTab] = useState<'kits' | 'log'>('kits');

  // Filters
  const [kitNameFilter, setKitNameFilter] = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | PromoKitStatus>('');

  // Create-kit modal
  const [createOpen, setCreateOpen] = useState(false);
  const [newClientId, setNewClientId] = useState('');
  const [newKitName, setNewKitName] = useState('');
  const [newKitNotes, setNewKitNotes] = useState('');
  const [creating, setCreating] = useState(false);

  // Book-out modal
  const [outKit, setOutKit] = useState<KitDto | null>(null);
  const [outConfirmed, setOutConfirmed] = useState(false);
  const [outHolder, setOutHolder] = useState<HolderDto | null>(null);
  const [holderSearch, setHolderSearch] = useState('');
  const [newPersonOpen, setNewPersonOpen] = useState(false);
  const [newPersonName, setNewPersonName] = useState('');
  const [newPersonEmail, setNewPersonEmail] = useState('');
  const [outNote, setOutNote] = useState('');
  const [outBusy, setOutBusy] = useState(false);

  // Book-in modal
  const [inKit, setInKit] = useState<KitDto | null>(null);
  const [inBooking, setInBooking] = useState<BookingDto | null>(null);
  const [inReturned, setInReturned] = useState<Record<string, number>>({});
  const [inNote, setInNote] = useState('');
  const [inBusy, setInBusy] = useState(false);

  const notify = (message: string, type: 'success' | 'error' = 'success') => setToast({ message, type });

  const fetchAll = useCallback(async () => {
    const [kRes, bRes, cRes, hRes] = await Promise.all([
      authFetch('/api/promo/kits', { cache: 'no-store' }),
      authFetch('/api/promo/bookings', { cache: 'no-store' }),
      authFetch('/api/aged-stock/clients', { cache: 'no-store' }),
      authFetch('/api/promo/holders', { cache: 'no-store' }),
    ]);
    if (kRes.ok) setKits(((await kRes.json()).kits ?? []) as KitDto[]);
    if (bRes.ok) setBookings(((await bRes.json()).bookings ?? []) as BookingDto[]);
    if (cRes.ok) setClients(((await cRes.json()).clients ?? []) as ClientDto[]);
    if (hRes.ok) setHolders(((await hRes.json()).holders ?? []) as HolderDto[]);
    setLoading(false);
  }, []);

  useEffect(() => { if (session) void fetchAll(); }, [session, fetchAll]);

  // ── Cards ──────────────────────────────────────────────────────────────────
  const stats = useMemo(() => ({
    clients: new Set(kits.map(k => k.clientId)).size,
    kits: kits.length,
    home: kits.filter(k => k.status === 'home').length,
    out: kits.filter(k => k.status === 'out').length,
  }), [kits]);

  /** Booking a kit is currently out on, for the "With" column. */
  const openBookingByKit = useMemo(() => {
    const m = new Map<string, BookingDto>();
    for (const b of bookings) if (!b.returnedAt) m.set(b.kitId, b);
    return m;
  }, [bookings]);

  // ── Kits grid ──────────────────────────────────────────────────────────────
  const filteredKits = useMemo(() => {
    const q = kitNameFilter.trim().toLowerCase();
    return kits.filter(k => {
      if (q && !k.name.toLowerCase().includes(q) && !k.reference.toLowerCase().includes(q)) return false;
      if (clientFilter && k.clientId !== clientFilter) return false;
      if (statusFilter && k.status !== statusFilter) return false;
      return true;
    });
  }, [kits, kitNameFilter, clientFilter, statusFilter]);

  const kitSort = useTableSort<KitDto>(filteredKits, {
    reference: k => k.reference,
    name: k => k.name,
    client: k => k.clientName,
    lines: k => k.lines.length,
    units: k => kitUnits(k),
    status: k => PROMO_KIT_STATUS_LABELS[k.status],
    with: k => openBookingByKit.get(k.id)?.holder.name ?? '',
    since: k => openBookingByKit.get(k.id)?.bookedOutAt ?? '',
    created: k => k.createdAt,
  }, 'reference', 'desc');

  const kitResize = useColumnResize(KIT_COLS.length + 1);

  // ── Booking log grid ───────────────────────────────────────────────────────
  const filteredBookings = useMemo(() => {
    const q = kitNameFilter.trim().toLowerCase();
    return bookings.filter(b => {
      if (q && !b.kitName.toLowerCase().includes(q) && !b.kitReference.toLowerCase().includes(q)) return false;
      if (clientFilter && b.clientId !== clientFilter) return false;
      if (statusFilter === 'out' && b.returnedAt) return false;
      if (statusFilter === 'home' && !b.returnedAt) return false;
      return true;
    });
  }, [bookings, kitNameFilter, clientFilter, statusFilter]);

  const logSort = useTableSort<BookingDto>(filteredBookings, {
    reference: b => b.kitReference,
    kitName: b => b.kitName,
    client: b => b.clientName,
    out: b => b.bookedOutAt,
    outBy: b => b.bookedOutByName,
    takenBy: b => b.holder.name,
    email: b => b.holder.email,
    lines: b => b.lines.length,
    units: b => b.lines.reduce((t, l) => t + l.quantity, 0),
    returned: b => b.returnedAt ?? '',
    receivedBy: b => b.returnedByName ?? '',
    result: b => (!b.returnedAt ? 'Out' : b.returnedComplete ? 'Complete' : 'Short'),
    note: b => b.returnNote ?? b.outNote ?? '',
  }, 'out', 'desc');

  const logResize = useColumnResize(LOG_COLS.length);

  // ── Excel export ───────────────────────────────────────────────────────────
  function exportKits() {
    const rows = kitSort.sorted.map(k => {
      const open = openBookingByKit.get(k.id);
      return {
        Ref: k.reference,
        'Kit Name': k.name,
        Client: k.clientName,
        Lines: k.lines.length,
        Units: kitUnits(k),
        Status: PROMO_KIT_STATUS_LABELS[k.status],
        With: open?.holder.name ?? '',
        'With Email': open?.holder.email ?? '',
        Since: fmtPromoDateTime(open?.bookedOutAt),
        Created: fmtPromoDateTime(k.createdAt),
        'Created By': k.createdByName ?? '',
        Notes: k.notes ?? '',
        Contents: k.lines.map(l => `${l.code} x${l.quantity}`).join('; '),
      };
    });
    writeSheet(rows, 'Promo Kits', 'iRamFlow_Promo_Kits');
  }

  function exportLog() {
    const rows = logSort.sorted.map(b => ({
      Ref: b.kitReference,
      'Kit Name': b.kitName,
      Client: b.clientName,
      'Booked Out': fmtPromoDateTime(b.bookedOutAt),
      'Booked Out By': b.bookedOutByName,
      'Taken By': b.holder.name,
      'Taken By Email': b.holder.email,
      'Taken By Type': b.holder.type,
      Lines: b.lines.length,
      'Units Out': b.lines.reduce((t, l) => t + l.quantity, 0),
      'Units Back': b.returnedAt ? b.lines.reduce((t, l) => t + (l.returnedQuantity ?? 0), 0) : '',
      Returned: fmtPromoDateTime(b.returnedAt),
      'Received By': b.returnedByName ?? '',
      Result: !b.returnedAt ? 'Still out' : b.returnedComplete ? 'Complete' : 'Short',
      Missing: !b.returnedAt
        ? ''
        : b.lines.filter(l => (l.returnedQuantity ?? 0) < l.quantity)
            .map(l => `${l.code} ${l.returnedQuantity ?? 0} of ${l.quantity}`).join('; '),
      'Out Note': b.outNote ?? '',
      'Return Note': b.returnNote ?? '',
      'Emailed Out': (b.outEmailTo ?? []).join(', '),
      'Email Error (Out)': b.outEmailError ?? '',
      'Emailed Return': (b.returnEmailTo ?? []).join(', '),
      'Email Error (Return)': b.returnEmailError ?? '',
      Contents: b.lines.map(l => `${l.code} x${l.quantity}`).join('; '),
    }));
    writeSheet(rows, 'Booking Log', 'iRamFlow_Promo_Booking_Log');
  }

  function writeSheet(rows: Record<string, string | number>[], sheet: string, fileBase: string) {
    if (rows.length === 0) { notify('Nothing to export with the current filters', 'error'); return; }
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = Object.keys(rows[0]).map(h => ({ wch: Math.max(12, Math.min(45, h.length + 6)) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheet);
    const stamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `${fileBase}_${stamp}.xlsx`);
  }

  // ── Create kit ─────────────────────────────────────────────────────────────
  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await authFetch('/api/promo/kits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: newClientId, name: newKitName, notes: newKitNotes }),
      });
      const data = await res.json();
      if (!res.ok) { notify(data.error ?? 'Could not create the kit', 'error'); return; }
      notify(`${data.kit.reference} created. Add items to it next.`);
      setCreateOpen(false);
      setNewKitName('');
      setNewKitNotes('');
      await fetchAll();
    } finally {
      setCreating(false);
    }
  }

  // ── Book out ───────────────────────────────────────────────────────────────
  function openBookOut(kit: KitDto) {
    setOutKit(kit);
    setOutConfirmed(false);
    setOutHolder(null);
    setHolderSearch('');
    setNewPersonOpen(false);
    setNewPersonName('');
    setNewPersonEmail('');
    setOutNote('');
  }

  const holderMatches = useMemo(() => {
    const q = holderSearch.trim().toLowerCase();
    if (!q) return holders.slice(0, 40);
    return holders
      .filter(h => h.name.toLowerCase().includes(q) || h.email.toLowerCase().includes(q))
      .slice(0, 40);
  }, [holders, holderSearch]);

  async function handleCreatePerson() {
    if (!newPersonEmail.trim()) { notify('Type their email address', 'error'); return; }
    const res = await authFetch('/api/promo/holders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newPersonName, email: newPersonEmail }),
    });
    const data = await res.json();
    if (!res.ok) { notify(data.error ?? 'Could not add that person', 'error'); return; }
    const holder: HolderDto = {
      type: 'contact', id: data.contact.id, name: data.contact.name,
      email: data.contact.email, subtitle: 'Promo contact',
    };
    setHolders(prev => (prev.some(h => h.id === holder.id) ? prev : [...prev, holder]));
    setOutHolder(holder);
    setNewPersonOpen(false);
    setHolderSearch('');
    notify(data.existed ? `${holder.name} was already on file and is now selected` : `${holder.name} added and selected`);
  }

  async function handleBookOut() {
    if (!outKit || !outHolder) return;
    setOutBusy(true);
    try {
      const res = await authFetch(`/api/promo/kits/${outKit.id}/book-out`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          holder: { type: outHolder.type, id: outHolder.id },
          contentsConfirmed: outConfirmed,
          note: outNote,
        }),
      });
      const data = await res.json();
      if (!res.ok) { notify(data.error ?? 'Could not book the kit out', 'error'); return; }
      notify(
        data.emailError
          ? `${outKit.reference} booked out to ${outHolder.name}, but the email FAILED: ${data.emailError}`
          : `${outKit.reference} booked out to ${outHolder.name}. Emailed ${(data.emailed ?? []).join(' and ')}.`,
        data.emailError ? 'error' : 'success',
      );
      setOutKit(null);
      await fetchAll();
    } finally {
      setOutBusy(false);
    }
  }

  // ── Book in ────────────────────────────────────────────────────────────────
  function openBookIn(kit: KitDto) {
    const booking = openBookingByKit.get(kit.id);
    if (!booking) { notify('No open booking found for that kit', 'error'); return; }
    setInKit(kit);
    setInBooking(booking);
    // Default every line to fully returned — the common case is everything came
    // back, and an admin unticking what is missing is faster than ticking 20 rows.
    setInReturned(Object.fromEntries(booking.lines.map(l => [l.lineId, l.quantity])));
    setInNote('');
  }

  const inMissing = useMemo(() => {
    if (!inBooking) return [];
    return inBooking.lines.filter(l => (inReturned[l.lineId] ?? 0) < l.quantity);
  }, [inBooking, inReturned]);

  async function handleBookIn() {
    if (!inKit || !inBooking) return;
    setInBusy(true);
    try {
      const res = await authFetch(`/api/promo/kits/${inKit.id}/book-in`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          returned: inBooking.lines.map(l => ({ lineId: l.lineId, quantity: inReturned[l.lineId] ?? 0 })),
          note: inNote,
        }),
      });
      const data = await res.json();
      if (!res.ok) { notify(data.error ?? 'Could not book the kit in', 'error'); return; }
      notify(
        data.emailError
          ? `${inKit.reference} returned, but the email FAILED: ${data.emailError}`
          : data.complete
            ? `${inKit.reference} returned in full and is back in stock.`
            : `${inKit.reference} returned SHORT (${data.missing.length} item(s)) and is back in stock, flagged.`,
        data.emailError ? 'error' : 'success',
      );
      setInKit(null);
      setInBooking(null);
      await fetchAll();
    } finally {
      setInBusy(false);
    }
  }

  if (!session) return null;

  const cards: Array<{ label: string; value: number; color: string; onClick?: () => void }> = [
    { label: 'Clients with kits', value: stats.clients, color: 'bg-blue-500' },
    { label: 'Promo kits', value: stats.kits, color: 'bg-gray-400', onClick: () => setStatusFilter('') },
    { label: 'At home', value: stats.home, color: 'bg-emerald-500', onClick: () => setStatusFilter('home') },
    { label: 'Out', value: stats.out, color: 'bg-amber-500', onClick: () => setStatusFilter('out') },
  ];

  return (
    <div className="flex flex-col gap-5">
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Promotional Material</h1>
          <p className="text-sm text-gray-500">Promo kits per client, booked out to a person and checked back in.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/promo/add-to-kits"
            className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            Add an Item to Several Kits
          </Link>
          <Link
            href="/promo/items"
            className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            Promo Material List
          </Link>
          {canManage && (
            <button
              onClick={() => { setNewClientId(clientFilter || ''); setCreateOpen(true); }}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-[var(--color-primary)] text-white hover:opacity-90"
            >
              Create Promo Kit
            </button>
          )}
        </div>
      </div>

      {/* Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map(c => (
          <button
            key={c.label}
            type="button"
            onClick={c.onClick}
            disabled={!c.onClick}
            className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 text-left hover:shadow-md transition-all disabled:cursor-default"
          >
            <div className="flex items-center gap-3">
              <div className={`w-3 h-3 rounded-full ${c.color}`} />
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{c.label}</span>
            </div>
            <div className="text-3xl font-bold text-gray-900 mt-2">{c.value}</div>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 grid grid-cols-1 md:grid-cols-4 gap-3">
        <div>
          <label className="block text-xs text-gray-600 mb-1">Kit name or reference</label>
          <input
            value={kitNameFilter}
            onChange={e => setKitNameFilter(e.target.value)}
            placeholder="Search kit name"
            className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Client</label>
          <select
            value={clientFilter}
            onChange={e => setClientFilter(e.target.value)}
            className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm bg-white"
          >
            <option value="">All clients</option>
            {clients.map(c => <option key={c.id} value={c.id}>{clientLabel(c)}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Status</label>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as '' | PromoKitStatus)}
            className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm bg-white"
          >
            <option value="">All</option>
            <option value="home">At Home</option>
            <option value="out">Out</option>
          </select>
        </div>
        <div className="flex items-end gap-2">
          <button
            onClick={() => { setKitNameFilter(''); setClientFilter(''); setStatusFilter(''); }}
            className="px-3 py-1.5 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50"
          >
            Clear filters
          </button>
          <button
            onClick={tab === 'kits' ? exportKits : exportLog}
            className="px-3 py-1.5 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50"
          >
            Export to Excel
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        {([['kits', `Kits (${filteredKits.length})`], ['log', `Booking Log (${filteredBookings.length})`]] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === key
                ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Kits grid ─────────────────────────────────────────────────────── */}
      {tab === 'kits' && (
        <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
          <table className="w-full text-sm" style={kitResize.tableStyle}>
            <thead className="bg-gray-50 text-xs text-gray-600 uppercase">
              <tr>
                {KIT_COLS.map((label, ci) => (
                  <th key={label} className="relative p-0" style={kitResize.widthStyle(ci)}>
                    <div className="flex items-center">
                      <SortableTh
                        col={['reference', 'name', 'client', 'lines', 'units', 'status', 'with', 'since', 'created'][ci]}
                        label={label}
                        sortCol={kitSort.sortCol}
                        sortDir={kitSort.sortDir}
                        onSort={kitSort.toggleSort}
                        className="px-3 py-2 text-left w-full font-medium"
                      />
                    </div>
                    <span onMouseDown={e => kitResize.startResize(ci, e)} className={RESIZE_HANDLE_CLASS} />
                  </th>
                ))}
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={KIT_COLS.length + 1} className="px-3 py-8 text-center text-gray-400">Loading…</td></tr>
              )}
              {!loading && kitSort.sorted.length === 0 && (
                <tr>
                  <td colSpan={KIT_COLS.length + 1} className="px-3 py-8 text-center text-gray-500">
                    {kits.length === 0
                      ? 'No promo kits yet. Create one to get started.'
                      : 'No kits match the current filters.'}
                  </td>
                </tr>
              )}
              {kitSort.sorted.map(k => {
                const open = openBookingByKit.get(k.id);
                return (
                  <tr key={k.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono text-xs">{k.reference}</td>
                    <td className="px-3 py-2">
                      <Link href={`/promo/kits/${k.id}`} className="text-[var(--color-primary)] hover:underline font-medium">
                        {k.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{k.clientName}</td>
                    <td className="px-3 py-2">{k.lines.length}</td>
                    <td className="px-3 py-2">{kitUnits(k)}</td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${PROMO_KIT_STATUS_BADGE[k.status]}`}>
                        {PROMO_KIT_STATUS_LABELS[k.status]}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {open ? <span title={open.holder.email}>{open.holder.name}</span> : <span className="text-gray-400">-</span>}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600">{open ? fmtPromoDateTime(open.bookedOutAt) : '-'}</td>
                    <td className="px-3 py-2 text-xs text-gray-600">{fmtPromoDateTime(k.createdAt)}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <Link href={`/promo/kits/${k.id}`} className="text-xs text-gray-600 hover:text-gray-900 mr-3">Open</Link>
                      {canBook && k.status === 'home' && (
                        <button
                          onClick={() => openBookOut(k)}
                          disabled={k.lines.length === 0}
                          title={k.lines.length === 0 ? 'Add items to the kit first' : 'Book this kit out'}
                          className="px-2.5 py-1 rounded-md text-xs font-medium bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Book Out
                        </button>
                      )}
                      {canBook && k.status === 'out' && (
                        <button
                          onClick={() => openBookIn(k)}
                          className="px-2.5 py-1 rounded-md text-xs font-medium bg-amber-600 text-white hover:opacity-90"
                        >
                          Book In
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Booking log grid ──────────────────────────────────────────────── */}
      {tab === 'log' && (
        <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
          <table className="w-full text-sm" style={logResize.tableStyle}>
            <thead className="bg-gray-50 text-xs text-gray-600 uppercase">
              <tr>
                {LOG_COLS.map((label, ci) => (
                  <th key={label} className="relative p-0" style={logResize.widthStyle(ci)}>
                    <div className="flex items-center">
                      <SortableTh
                        col={['reference', 'kitName', 'client', 'out', 'outBy', 'takenBy', 'email', 'lines', 'units', 'returned', 'receivedBy', 'result', 'note'][ci]}
                        label={label}
                        sortCol={logSort.sortCol}
                        sortDir={logSort.sortDir}
                        onSort={logSort.toggleSort}
                        className="px-3 py-2 text-left w-full font-medium"
                      />
                    </div>
                    <span onMouseDown={e => logResize.startResize(ci, e)} className={RESIZE_HANDLE_CLASS} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {!loading && logSort.sorted.length === 0 && (
                <tr>
                  <td colSpan={LOG_COLS.length} className="px-3 py-8 text-center text-gray-500">
                    Nothing has been booked out yet.
                  </td>
                </tr>
              )}
              {logSort.sorted.map(b => {
                const missing = b.returnedAt ? b.lines.filter(l => (l.returnedQuantity ?? 0) < l.quantity) : [];
                return (
                  <tr key={b.id} className="border-t border-gray-100 hover:bg-gray-50 align-top">
                    <td className="px-3 py-2 font-mono text-xs">{b.kitReference}</td>
                    <td className="px-3 py-2">{b.kitName}</td>
                    <td className="px-3 py-2">{b.clientName}</td>
                    <td className="px-3 py-2 text-xs">{fmtPromoDateTime(b.bookedOutAt)}</td>
                    <td className="px-3 py-2">{b.bookedOutByName}</td>
                    <td className="px-3 py-2">{b.holder.name}</td>
                    <td className="px-3 py-2 text-xs text-gray-600">{b.holder.email}</td>
                    <td className="px-3 py-2">{b.lines.length}</td>
                    <td className="px-3 py-2">{b.lines.reduce((t, l) => t + l.quantity, 0)}</td>
                    <td className="px-3 py-2 text-xs">{fmtPromoDateTime(b.returnedAt)}</td>
                    <td className="px-3 py-2">{b.returnedByName ?? '-'}</td>
                    <td className="px-3 py-2">
                      {!b.returnedAt ? (
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">Still out</span>
                      ) : b.returnedComplete ? (
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">Complete</span>
                      ) : (
                        <span
                          className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700"
                          title={missing.map(l => `${l.code}: ${l.returnedQuantity ?? 0} of ${l.quantity} back`).join('\n')}
                        >
                          Short ({missing.length})
                        </span>
                      )}
                      {(b.outEmailError || b.returnEmailError) && (
                        <span className="ml-1 text-xs text-red-600" title={b.outEmailError || b.returnEmailError}>
                          email failed
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600 max-w-xs">{b.returnNote ?? b.outNote ?? ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Create kit modal ──────────────────────────────────────────────── */}
      {createOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-40 p-4">
          <form onSubmit={handleCreate} className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 flex flex-col gap-4">
            <h2 className="text-lg font-semibold text-gray-900">Create Promo Kit</h2>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Client</label>
              <select
                required
                value={newClientId}
                onChange={e => setNewClientId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
              >
                <option value="">Select a client</option>
                {clients.map(c => <option key={c.id} value={c.id}>{clientLabel(c)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Kit name</label>
              <input
                required
                autoComplete="off"
                value={newKitName}
                onChange={e => setNewKitName(e.target.value)}
                placeholder="e.g. Gauteng Roadshow Kit A"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Notes (optional)</label>
              <textarea
                rows={2}
                value={newKitNotes}
                onChange={e => setNewKitNotes(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setCreateOpen(false)} className="px-4 py-2 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50">
                Cancel
              </button>
              <button type="submit" disabled={creating} className="px-4 py-2 rounded-md text-sm font-medium bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-50">
                {creating ? 'Creating…' : 'Create Kit'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Book out modal ────────────────────────────────────────────────── */}
      {outKit && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">
                Book Out {outKit.reference} {outKit.name}
              </h2>
              <p className="text-sm text-gray-500">{outKit.clientName}</p>
            </div>

            {/* 1. Confirm the contents */}
            <div className="border border-gray-200 rounded-lg">
              <div className="px-4 py-2 bg-gray-50 text-xs font-semibold text-gray-600 uppercase border-b border-gray-200">
                1. Confirm the kit contents
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {outKit.lines.map(l => (
                    <tr key={l.id} className="border-b border-gray-100 last:border-0">
                      <td className="px-4 py-1.5 font-mono text-xs w-32">{l.code}</td>
                      <td className="px-4 py-1.5">{l.description}</td>
                      <td className="px-4 py-1.5 text-right w-16 font-medium">x{l.quantity}</td>
                      <td className="px-4 py-1.5 text-xs text-gray-400 w-24">
                        {l.source === 'sku' ? 'Client SKU' : 'Promo'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <label className="flex items-center gap-2 px-4 py-3 bg-gray-50 border-t border-gray-200 cursor-pointer">
                <input type="checkbox" checked={outConfirmed} onChange={e => setOutConfirmed(e.target.checked)} className="w-4 h-4" />
                <span className="text-sm font-medium text-gray-800">
                  I have checked all {outKit.lines.length} item{outKit.lines.length === 1 ? '' : 's'}{' '}
                  ({kitUnits(outKit)} unit{kitUnits(outKit) === 1 ? '' : 's'}) are in the kit
                </span>
              </label>
            </div>

            {/* 2. Who is taking it */}
            <div className="border border-gray-200 rounded-lg">
              <div className="px-4 py-2 bg-gray-50 text-xs font-semibold text-gray-600 uppercase border-b border-gray-200">
                2. Who is taking the kit
              </div>
              <div className="p-4 flex flex-col gap-2">
                {outHolder ? (
                  <div className="flex items-center justify-between gap-3 px-3 py-2 border border-[var(--color-primary)] bg-green-50 rounded-md">
                    <div>
                      <div className="text-sm font-medium text-gray-900">{outHolder.name}</div>
                      <div className="text-xs text-gray-600">
                        {outHolder.email}
                        {outHolder.subtitle ? ` - ${outHolder.subtitle}` : ''}
                      </div>
                    </div>
                    <button onClick={() => setOutHolder(null)} className="text-xs text-gray-600 hover:text-gray-900">Change</button>
                  </div>
                ) : (
                  <>
                    <input
                      autoComplete="off"
                      value={holderSearch}
                      onChange={e => setHolderSearch(e.target.value)}
                      placeholder="Search by name or email"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                    />
                    <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-md divide-y divide-gray-100">
                      {holderMatches.map(h => (
                        <button
                          key={`${h.type}-${h.id}`}
                          onClick={() => setOutHolder(h)}
                          className="w-full text-left px-3 py-2 hover:bg-gray-50"
                        >
                          <div className="text-sm text-gray-900">{h.name}</div>
                          <div className="text-xs text-gray-500">
                            {h.email}
                            {h.subtitle ? ` - ${h.subtitle}` : ''}
                          </div>
                        </button>
                      ))}
                      {holderMatches.length === 0 && (
                        <div className="px-3 py-3 text-sm text-gray-500">Nobody matches that search.</div>
                      )}
                    </div>
                    {!newPersonOpen ? (
                      <button
                        onClick={() => { setNewPersonOpen(true); setNewPersonName(holderSearch); }}
                        className="self-start text-sm text-[var(--color-primary)] hover:underline"
                      >
                        The person is not in the list
                      </button>
                    ) : (
                      <div className="border border-gray-200 rounded-md p-3 flex flex-col gap-2 bg-gray-50">
                        <p className="text-xs text-gray-600">
                          They will receive the booking emails. This does not create a login.
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            autoComplete="off"
                            value={newPersonName}
                            onChange={e => setNewPersonName(e.target.value)}
                            placeholder="Name"
                            className="px-3 py-2 border border-gray-300 rounded-md text-sm"
                          />
                          <input
                            autoComplete="off"
                            type="email"
                            value={newPersonEmail}
                            onChange={e => setNewPersonEmail(e.target.value)}
                            placeholder="Email address"
                            className="px-3 py-2 border border-gray-300 rounded-md text-sm"
                          />
                        </div>
                        <div className="flex gap-2">
                          <button onClick={handleCreatePerson} className="px-3 py-1.5 rounded-md text-sm font-medium bg-[var(--color-primary)] text-white hover:opacity-90">
                            Add and select
                          </button>
                          <button onClick={() => setNewPersonOpen(false)} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900">
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            <div>
              <label className="block text-xs text-gray-600 mb-1">Note (optional)</label>
              <textarea
                rows={2}
                value={outNote}
                onChange={e => setOutNote(e.target.value)}
                placeholder="e.g. Due back Friday after the Boksburg activation"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
            </div>

            <p className="text-xs text-gray-500">
              Booking out emails you and {outHolder ? outHolder.name : 'the person taking the kit'} the date, time, kit name and both names.
            </p>

            <div className="flex justify-end gap-2">
              <button onClick={() => setOutKit(null)} className="px-4 py-2 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50">
                Cancel
              </button>
              <button
                onClick={handleBookOut}
                disabled={!outConfirmed || !outHolder || outBusy}
                title={!outConfirmed ? 'Tick the contents confirmation' : !outHolder ? 'Select who is taking the kit' : ''}
                className="px-4 py-2 rounded-md text-sm font-medium bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {outBusy ? 'Booking out…' : 'Book Out and Email'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Book in modal ─────────────────────────────────────────────────── */}
      {inKit && inBooking && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">
                Book In {inKit.reference} {inKit.name}
              </h2>
              <p className="text-sm text-gray-500">
                Out with {inBooking.holder.name} since {fmtPromoDateTime(inBooking.bookedOutAt)}
              </p>
            </div>

            <div className="border border-gray-200 rounded-lg">
              <div className="px-4 py-2 bg-gray-50 text-xs font-semibold text-gray-600 uppercase border-b border-gray-200 flex items-center justify-between">
                <span>Tick every item that came back</span>
                <button
                  onClick={() => setInReturned(Object.fromEntries(inBooking.lines.map(l => [l.lineId, l.quantity])))}
                  className="text-xs font-medium text-[var(--color-primary)] hover:underline normal-case"
                >
                  Tick all
                </button>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {inBooking.lines.map(l => {
                    const back = inReturned[l.lineId] ?? 0;
                    const full = back >= l.quantity;
                    return (
                      <tr key={l.lineId} className={`border-b border-gray-100 last:border-0 ${full ? '' : 'bg-red-50'}`}>
                        <td className="px-4 py-2 w-10">
                          <input
                            type="checkbox"
                            checked={full}
                            onChange={e => setInReturned(prev => ({ ...prev, [l.lineId]: e.target.checked ? l.quantity : 0 }))}
                            className="w-4 h-4"
                          />
                        </td>
                        <td className="px-2 py-2 font-mono text-xs w-32">{l.code}</td>
                        <td className="px-2 py-2">{l.description}</td>
                        <td className="px-2 py-2 text-right text-xs text-gray-500 w-20">out: {l.quantity}</td>
                        <td className="px-4 py-2 w-28">
                          <input
                            type="number"
                            min={0}
                            max={l.quantity}
                            value={back}
                            onChange={e => {
                              const v = Math.max(0, Math.min(l.quantity, Math.floor(Number(e.target.value) || 0)));
                              setInReturned(prev => ({ ...prev, [l.lineId]: v }));
                            }}
                            className="w-full px-2 py-1 border border-gray-300 rounded-md text-sm text-right"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {inMissing.length > 0 && (
              <div className="border border-red-200 bg-red-50 rounded-lg p-3">
                <div className="text-sm font-semibold text-red-800">
                  {inMissing.length} item{inMissing.length === 1 ? '' : 's'} did not come back
                </div>
                <ul className="mt-1 text-xs text-red-700 list-disc pl-5">
                  {inMissing.map(l => (
                    <li key={l.lineId}>
                      {l.code} {l.description}: {inReturned[l.lineId] ?? 0} of {l.quantity} returned
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-red-700">
                  The kit still goes back into stock, flagged short. A note is required.
                </p>
              </div>
            )}

            <div>
              <label className="block text-xs text-gray-600 mb-1">
                Note{inMissing.length > 0 ? ' (required)' : ' (optional)'}
              </label>
              <textarea
                rows={2}
                value={inNote}
                onChange={e => setInNote(e.target.value)}
                placeholder={inMissing.length > 0 ? 'What happened to the missing items?' : ''}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
            </div>

            <p className="text-xs text-gray-500">
              Booking in emails you, {inBooking.holder.name} and {inBooking.bookedOutByName} to confirm the return.
            </p>

            <div className="flex justify-end gap-2">
              <button onClick={() => { setInKit(null); setInBooking(null); }} className="px-4 py-2 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50">
                Cancel
              </button>
              <button
                onClick={handleBookIn}
                disabled={inBusy || (inMissing.length > 0 && !inNote.trim())}
                className={`px-4 py-2 rounded-md text-sm font-medium text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed ${
                  inMissing.length > 0 ? 'bg-red-600' : 'bg-[var(--color-primary)]'
                }`}
              >
                {inBusy ? 'Booking in…' : inMissing.length > 0 ? 'Return Short and Email' : 'Return to Stock and Email'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
