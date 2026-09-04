'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';
import {
  availabilityBadge,
  availabilityLabel,
  copiesLabel,
  fmtPromoDateTime,
  itemsLabel,
  kitTotal,
  kitUnits,
  unitsLabel,
  type KitAvailability,
  type PromoLineStock,
} from '@/lib/promoShared';

interface KitLineDto {
  id: string;
  source: 'sku' | 'promo';
  ref: string;
  code: string;
  description: string;
  /** The SPEC — what a full copy of the kit should hold. Not reduced by a loss. */
  quantity: number;
  missingQuantity?: number;
  missingNote?: string;
  missingAt?: string;
  /** Derived server-side: pool / missing / present / out / free, in physical units. */
  stock?: PromoLineStock;
  addedAt: string;
  addedByName?: string;
}
interface KitDto {
  id: string;
  reference: string;
  clientId: string;
  clientName: string;
  name: string;
  notes?: string;
  totalQuantity?: number;
  lines: KitLineDto[];
  availability: KitAvailability;
  createdAt: string;
  createdByName?: string;
}
interface BookingDto {
  id: string;
  copies?: number;
  bookedOutAt: string;
  bookedOutByName: string;
  holder: { name: string; email: string };
  lines: Array<{ lineId: string; code: string; description: string; quantity: number; returnedQuantity?: number }>;
  outNote?: string;
  returnedAt?: string;
  returnedByName?: string;
  returnedComplete?: boolean;
  returnNote?: string;
}
interface ClientProductDto { articleNumber: string; description: string; barcode: string; vendorProductCode: string }
interface PromoItemDto { id: string; code: string; description: string; category?: string }

export default function PromoKitDetailPage() {
  const { session } = useAuth('view_promo_kits');
  const canManage = (session?.permissions ?? []).includes('manage_promo_kits');
  const params = useParams<{ kitId: string }>();
  const kitId = params?.kitId ?? '';
  const router = useRouter();

  const [kit, setKit] = useState<KitDto | null>(null);
  const [bookings, setBookings] = useState<BookingDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState('');
  const [toast, setToast] = useState<ToastData | null>(null);

  // Header edit
  const [editingHeader, setEditingHeader] = useState(false);
  const [editName, setEditName] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editQty, setEditQty] = useState(1);

  // Add-item panel
  const [addTab, setAddTab] = useState<'sku' | 'promo'>('sku');
  const [products, setProducts] = useState<ClientProductDto[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [promoItems, setPromoItems] = useState<PromoItemDto[]>([]);
  const [itemSearch, setItemSearch] = useState('');
  const [pendingRef, setPendingRef] = useState('');
  const [pendingQty, setPendingQty] = useState(1);
  const [addBusy, setAddBusy] = useState(false);

  // Restock modal — putting a lost item back into the kit.
  const [restockLine, setRestockLine] = useState<KitLineDto | null>(null);
  const [restockQty, setRestockQty] = useState(1);
  const [restockNote, setRestockNote] = useState('');
  const [restockBusy, setRestockBusy] = useState(false);

  const notify = (message: string, type: 'success' | 'error' = 'success') => setToast({ message, type });

  const fetchKit = useCallback(async () => {
    const res = await authFetch(`/api/promo/kits/${kitId}`, { cache: 'no-store' });
    if (!res.ok) {
      setNotFound((await res.json().catch(() => ({}))).error ?? 'Kit not found');
      setLoading(false);
      return;
    }
    const data = await res.json();
    setKit(data.kit as KitDto);
    setBookings((data.bookings ?? []) as BookingDto[]);
    setLoading(false);
  }, [kitId]);

  useEffect(() => { if (session && kitId) void fetchKit(); }, [session, kitId, fetchKit]);

  // The client's SKU list, and the promo catalogue, for the add-item picker.
  useEffect(() => {
    if (!kit) return;
    let cancelled = false;
    setProductsLoading(true);
    void (async () => {
      const [pRes, iRes] = await Promise.all([
        authFetch(`/api/clients/${kit.clientId}/products`, { cache: 'no-store' }),
        authFetch('/api/promo/items', { cache: 'no-store' }),
      ]);
      if (cancelled) return;
      if (pRes.ok) setProducts(((await pRes.json()).products ?? []) as ClientProductDto[]);
      if (iRes.ok) setPromoItems(((await iRes.json()).items ?? []) as PromoItemDto[]);
      setProductsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [kit]);

  const matches = useMemo(() => {
    const q = itemSearch.trim().toLowerCase();
    if (addTab === 'sku') {
      const list = q
        ? products.filter(p => p.articleNumber.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q))
        : products;
      return list.slice(0, 50).map(p => ({ ref: p.articleNumber, code: p.articleNumber, description: p.description || '' }));
    }
    const list = q
      ? promoItems.filter(i => i.code.toLowerCase().includes(q) || i.description.toLowerCase().includes(q))
      : promoItems;
    return list.slice(0, 50).map(i => ({ ref: i.id, code: i.code, description: i.description }));
  }, [addTab, itemSearch, products, promoItems]);

  /**
   * Copies out do NOT lock the kit. Each booking snapshots the list that left
   * with it, so the copies on the road come back against their own list. Only
   * DELETE is refused while anything is out.
   */
  const copiesOut = kit?.availability.out ?? 0;

  /**
   * Lines the kit is short. A line's `quantity` is what a full copy SHOULD hold
   * and never shrinks when something goes missing, so 'short' is read off the
   * derived stock rather than off the quantity.
   */
  const shortLines = useMemo(
    () => (kit?.lines ?? []).filter(l => (l.stock?.missing ?? 0) > 0),
    [kit],
  );
  const shortUnits = useMemo(
    () => shortLines.reduce((t, l) => t + (l.stock?.missing ?? 0), 0),
    [shortLines],
  );

  function openRestock(line: KitLineDto) {
    setRestockLine(line);
    setRestockQty(line.stock?.missing ?? 1);
    setRestockNote('');
  }

  async function handleRestock() {
    if (!restockLine) return;
    setRestockBusy(true);
    try {
      const res = await authFetch(`/api/promo/kits/${kitId}/restock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineId: restockLine.id, quantity: restockQty, note: restockNote }),
      });
      const data = await res.json();
      if (!res.ok) { notify(data.error ?? 'Could not put that back', 'error'); return; }
      notify(
        data.stillShort > 0
          ? `${restockLine.code}: ${unitsLabel(data.restocked)} put back. Still short ${unitsLabel(data.stillShort)}.`
          : `${restockLine.code}: ${unitsLabel(data.restocked)} put back. The kit is complete again.`,
      );
      setRestockLine(null);
      await fetchKit();
    } finally {
      setRestockBusy(false);
    }
  }

  async function handleAddItem() {
    if (!kit || !pendingRef) return;
    setAddBusy(true);
    try {
      const res = await authFetch('/api/promo/kits/add-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: addTab, ref: pendingRef, quantity: pendingQty, kitIds: [kit.id] }),
      });
      const data = await res.json();
      if (!res.ok) { notify(data.error ?? 'Could not add the item', 'error'); return; }
      const warned = (data.warnings ?? []) as string[];
      notify(
        warned.length
          ? warned.join(' ')
          : data.mergedIn?.length
            ? `${data.code} was already in this kit, quantity increased by ${pendingQty}`
            : `${data.code} added`,
        warned.length ? 'error' : 'success',
      );
      setPendingRef('');
      setPendingQty(1);
      setItemSearch('');
      await fetchKit();
    } finally {
      setAddBusy(false);
    }
  }

  async function patchKit(body: Record<string, unknown>, successMessage: string) {
    const res = await authFetch(`/api/promo/kits/${kitId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { notify(data.error ?? 'Could not save', 'error'); return false; }
    notify(successMessage);
    await fetchKit();
    return true;
  }

  async function handleDeleteKit() {
    if (!kit) return;
    const res = await authFetch(`/api/promo/kits/${kitId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) { notify(data.error ?? 'Could not delete the kit', 'error'); return; }
    router.push('/promo');
  }

  if (!session) return null;
  if (loading) return <div className="text-gray-400">Loading…</div>;
  if (notFound || !kit) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-gray-700">{notFound || 'Kit not found'}</p>
        <Link href="/promo" className="text-[var(--color-primary)] hover:underline">Back to Promo Kits</Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900">{kit.name}</h1>
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${availabilityBadge(kit.availability)}`}>
              {availabilityLabel(kit.availability)}
            </span>
          </div>
          <p className="text-sm text-gray-500">
            <span className="font-mono">{kit.reference}</span>
            {' · '}
            {kit.clientName}
            {' · '}
            {copiesLabel(kit.availability.total)}
            {' · '}
            {kit.lines.length} line{kit.lines.length === 1 ? '' : 's'}, {kitUnits(kit)} unit
            {kitUnits(kit) === 1 ? '' : 's'} per copy
          </p>
          {kit.notes && <p className="text-sm text-gray-600 mt-1">{kit.notes}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/promo" className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50">
            Back to Kits
          </Link>
          {canManage && !editingHeader && (
            <button
              onClick={() => {
                setEditingHeader(true);
                setEditName(kit.name);
                setEditNotes(kit.notes ?? '');
                setEditQty(kitTotal(kit));
              }}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              Edit Kit
            </button>
          )}
          {canManage && copiesOut === 0 && (
            <button onClick={handleDeleteKit} className="px-4 py-2 rounded-lg text-sm font-medium border border-red-300 text-red-700 hover:bg-red-50">
              Delete Kit
            </button>
          )}
        </div>
      </div>

      {editingHeader && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 flex flex-col gap-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-gray-600 mb-1">Kit name</label>
              <input autoComplete="off" value={editName} onChange={e => setEditName(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">How many of this kit do you have?</label>
              <input
                type="number"
                min={Math.max(1, copiesOut)}
                value={editQty}
                onChange={e => setEditQty(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm text-right"
              />
              {copiesOut > 0 && (
                <p className="text-xs text-gray-500 mt-1">
                  {copiesLabel(copiesOut)} out with people, so this cannot go below {copiesOut}.
                </p>
              )}
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Notes</label>
              <input autoComplete="off" value={editNotes} onChange={e => setEditNotes(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={async () => {
                if (await patchKit({ name: editName, notes: editNotes, totalQuantity: editQty }, 'Kit saved')) {
                  setEditingHeader(false);
                }
              }}
              className="px-4 py-2 rounded-md text-sm font-medium bg-[var(--color-primary)] text-white hover:opacity-90"
            >
              Save
            </button>
            <button onClick={() => setEditingHeader(false)} className="px-4 py-2 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50">
              Cancel
            </button>
          </div>
        </div>
      )}

      {copiesOut > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900">
          {copiesLabel(copiesOut)} of this kit {copiesOut === 1 ? 'is' : 'are'} out with someone. You can still edit
          the contents: each booking keeps the list that went out with it, so the copies on the road come back
          against their own list. The kit cannot be deleted until they are all back.
        </div>
      )}

      {shortLines.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-900">
          <span className="font-semibold">
            This kit is short {itemsLabel(shortLines.length)} ({unitsLabel(shortUnits)}).
          </span>{' '}
          {shortLines.map(l => `${l.code} ${l.description}`).join(', ')}. Booking it out will only send what is
          actually there. Once the {shortLines.length === 1 ? 'item has' : 'items have'} been replaced, click
          Restocked on the row so the kit counts {shortLines.length === 1 ? 'it' : 'them'} again.
        </div>
      )}

      {/* Contents */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-600 uppercase">Kit contents</span>
          <span className="text-xs text-gray-500">
            Quantities are per copy
            {kit.availability.total > 1
              ? `. Booking out all ${kit.availability.total} copies takes ${kitUnits(kit) * kit.availability.total} units`
              : ''}
          </span>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-white text-xs text-gray-500 uppercase">
            <tr className="border-b border-gray-100">
              <th className="px-4 py-2 text-left font-medium">Item</th>
              <th className="px-4 py-2 text-left font-medium">Description</th>
              <th className="px-4 py-2 text-left font-medium">Source</th>
              <th className="px-4 py-2 text-right font-medium">Qty per copy</th>
              <th className="px-4 py-2 text-right font-medium">In stock</th>
              <th className="px-4 py-2 text-left font-medium">Added</th>
              <th className="px-4 py-2 text-right font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {kit.lines.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-500">Nothing in this kit yet. Add items below.</td></tr>
            )}
            {kit.lines.map(l => {
              const st = l.stock;
              const short = st ? st.missing : 0;
              return (
              <tr key={l.id} className={`border-b border-gray-100 last:border-0 ${short > 0 ? 'bg-red-50' : ''}`}>
                <td className="px-4 py-2 font-mono text-xs">{l.code}</td>
                <td className="px-4 py-2">{l.description}</td>
                <td className="px-4 py-2 text-xs text-gray-500">{l.source === 'sku' ? 'Client SKU' : 'Promo material'}</td>
                <td className="px-4 py-2 text-right w-28">
                  {canManage ? (
                    <input
                      type="number"
                      min={1}
                      defaultValue={l.quantity}
                      onBlur={e => {
                        const v = Math.max(1, Math.floor(Number(e.target.value) || 1));
                        if (v !== l.quantity) void patchKit({ lines: [{ id: l.id, quantity: v }] }, `${l.code} set to ${v}`);
                      }}
                      className="w-20 px-2 py-1 border border-gray-300 rounded-md text-sm text-right"
                    />
                  ) : (
                    l.quantity
                  )}
                </td>
                {/* What the kit ACTUALLY holds, against what it should. The
                    quantity column beside this is the spec and never moves; a
                    loss lands here, so the kit still knows what belongs in it. */}
                <td className="px-4 py-2 text-right w-32">
                  {st ? (
                    short > 0 ? (
                      <span className="text-red-700 font-semibold" title={l.missingNote ? `Missing: ${l.missingNote}` : undefined}>
                        {st.present} of {st.pool}
                        <span className="block text-[11px] font-normal text-red-600">
                          {unitsLabel(short)} short
                        </span>
                      </span>
                    ) : (
                      <span className="text-gray-700">{st.present} of {st.pool}</span>
                    )
                  ) : (
                    <span className="text-gray-400">-</span>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-gray-500">
                  {fmtPromoDateTime(l.addedAt)}
                  {l.addedByName ? ` by ${l.addedByName}` : ''}
                </td>
                <td className="px-4 py-2 text-right whitespace-nowrap">
                  {canManage && short > 0 && (
                    <button
                      onClick={() => openRestock(l)}
                      className="text-xs font-medium text-[var(--color-primary)] hover:underline mr-3"
                    >
                      Restocked
                    </button>
                  )}
                  {canManage && (
                    <button
                      onClick={() => void patchKit({ removeLineIds: [l.id] }, `${l.code} removed`)}
                      className="text-xs text-red-600 hover:underline"
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Add items */}
      {canManage && (
        <div className="bg-white border border-gray-200 rounded-lg">
          <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-600 uppercase">Add items to this kit</span>
            <Link href="/promo/add-to-kits" className="text-xs text-[var(--color-primary)] hover:underline">
              Adding the same item to several kits? Use Add to Kits
            </Link>
          </div>
          <div className="p-4 flex flex-col gap-3">
            <div className="flex gap-1 border-b border-gray-200">
              {([['sku', `${kit.clientName} products`], ['promo', 'Promo material']] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => { setAddTab(key); setPendingRef(''); setItemSearch(''); }}
                  className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
                    addTab === key
                      ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <input
              autoComplete="off"
              value={itemSearch}
              onChange={e => { setItemSearch(e.target.value); setPendingRef(''); }}
              placeholder={addTab === 'sku' ? 'Search article number or description' : 'Search promo material'}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />

            <div className="max-h-56 overflow-y-auto border border-gray-200 rounded-md divide-y divide-gray-100">
              {addTab === 'sku' && productsLoading && (
                <div className="px-3 py-3 text-sm text-gray-400">Loading the client product list…</div>
              )}
              {addTab === 'sku' && !productsLoading && products.length === 0 && (
                <div className="px-3 py-3 text-sm text-gray-600">
                  {kit.clientName} has no product control file loaded, so there are no SKUs to pick from. Use the
                  Promo material tab, or load their product file in Control Centre.
                </div>
              )}
              {addTab === 'promo' && promoItems.length === 0 && (
                <div className="px-3 py-3 text-sm text-gray-600">
                  No promo material on file yet.{' '}
                  <Link href="/promo/items" className="text-[var(--color-primary)] hover:underline">Add some</Link>.
                </div>
              )}
              {matches.map(m => (
                <button
                  key={m.ref}
                  onClick={() => setPendingRef(m.ref)}
                  className={`w-full text-left px-3 py-2 hover:bg-gray-50 ${pendingRef === m.ref ? 'bg-green-50' : ''}`}
                >
                  <span className="font-mono text-xs text-gray-700">{m.code}</span>
                  <span className="text-sm text-gray-900 ml-2">{m.description}</span>
                </button>
              ))}
            </div>

            <div className="flex items-end gap-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Quantity</label>
                <input
                  type="number"
                  min={1}
                  value={pendingQty}
                  onChange={e => setPendingQty(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                  className="w-24 px-3 py-2 border border-gray-300 rounded-md text-sm text-right"
                />
              </div>
              <button
                onClick={handleAddItem}
                disabled={!pendingRef || addBusy}
                className="px-4 py-2 rounded-md text-sm font-medium bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {addBusy ? 'Adding…' : 'Add to Kit'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Booking history */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
        <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-600 uppercase">
          Booking history
        </div>
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 uppercase">
            <tr className="border-b border-gray-100">
              <th className="px-4 py-2 text-left font-medium">Booked out</th>
              <th className="px-4 py-2 text-right font-medium">Copies</th>
              <th className="px-4 py-2 text-left font-medium">By</th>
              <th className="px-4 py-2 text-left font-medium">Taken by</th>
              <th className="px-4 py-2 text-left font-medium">Returned</th>
              <th className="px-4 py-2 text-left font-medium">Received by</th>
              <th className="px-4 py-2 text-left font-medium">Result</th>
              <th className="px-4 py-2 text-left font-medium">Note</th>
            </tr>
          </thead>
          <tbody>
            {bookings.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-500">This kit has never been booked out.</td></tr>
            )}
            {bookings.map(b => {
              const missing = b.returnedAt ? b.lines.filter(l => (l.returnedQuantity ?? 0) < l.quantity) : [];
              return (
                <tr key={b.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-2 text-xs">{fmtPromoDateTime(b.bookedOutAt)}</td>
                  <td className="px-4 py-2 text-right font-medium">{b.copies ?? 1}</td>
                  <td className="px-4 py-2">{b.bookedOutByName}</td>
                  <td className="px-4 py-2" title={b.holder.email}>{b.holder.name}</td>
                  <td className="px-4 py-2 text-xs">{fmtPromoDateTime(b.returnedAt)}</td>
                  <td className="px-4 py-2">{b.returnedByName ?? '-'}</td>
                  <td className="px-4 py-2">
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
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-600">{b.returnNote ?? b.outNote ?? ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Restocked: put a lost item back into the kit ─────────────────── */}
      {restockLine && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Put {restockLine.code} back</h2>
              <p className="text-sm text-gray-500">
                {restockLine.description}
              </p>
            </div>

            <div className="bg-gray-50 border border-gray-200 rounded-md px-3 py-2 text-sm text-gray-700">
              The kit is short {unitsLabel(restockLine.stock?.missing ?? 0)} of this item.
              {restockLine.missingNote ? <span className="block text-xs text-gray-500 mt-1">Recorded as: {restockLine.missingNote}</span> : null}
            </div>

            <div>
              <label className="block text-xs text-gray-600 mb-1">How many are going back in?</label>
              <input
                type="number"
                min={1}
                max={restockLine.stock?.missing ?? 1}
                value={restockQty}
                onChange={e =>
                  setRestockQty(Math.max(1, Math.min(restockLine.stock?.missing ?? 1, Math.floor(Number(e.target.value) || 1))))
                }
                className="w-28 px-3 py-2 border border-gray-300 rounded-md text-sm text-right"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-600 mb-1">Note (optional)</label>
              <input
                autoComplete="off"
                value={restockNote}
                onChange={e => setRestockNote(e.target.value)}
                placeholder="e.g. New ball bought 4 Sep"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
            </div>

            <p className="text-xs text-gray-500">
              This only changes how many of this item the kit currently HAS. What a full kit should hold stays
              at {restockLine.quantity} per copy.
            </p>

            <div className="flex justify-end gap-2">
              <button onClick={() => setRestockLine(null)} className="px-4 py-2 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50">
                Cancel
              </button>
              <button
                onClick={handleRestock}
                disabled={restockBusy}
                className="px-4 py-2 rounded-md text-sm font-medium bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-40"
              >
                {restockBusy ? 'Saving…' : 'Put Back in the Kit'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
