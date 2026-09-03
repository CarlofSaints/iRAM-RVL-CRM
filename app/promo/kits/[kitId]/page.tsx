'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';
import {
  PROMO_KIT_STATUS_BADGE,
  PROMO_KIT_STATUS_LABELS,
  fmtPromoDateTime,
  kitUnits,
  type PromoKitStatus,
} from '@/lib/promoShared';

interface KitLineDto {
  id: string;
  source: 'sku' | 'promo';
  ref: string;
  code: string;
  description: string;
  quantity: number;
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
  lines: KitLineDto[];
  status: PromoKitStatus;
  currentBookingId?: string;
  createdAt: string;
  createdByName?: string;
}
interface BookingDto {
  id: string;
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

  // Add-item panel
  const [addTab, setAddTab] = useState<'sku' | 'promo'>('sku');
  const [products, setProducts] = useState<ClientProductDto[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [promoItems, setPromoItems] = useState<PromoItemDto[]>([]);
  const [itemSearch, setItemSearch] = useState('');
  const [pendingRef, setPendingRef] = useState('');
  const [pendingQty, setPendingQty] = useState(1);
  const [addBusy, setAddBusy] = useState(false);

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

  const isOut = kit?.status === 'out';

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
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${PROMO_KIT_STATUS_BADGE[kit.status]}`}>
              {PROMO_KIT_STATUS_LABELS[kit.status]}
            </span>
          </div>
          <p className="text-sm text-gray-500">
            <span className="font-mono">{kit.reference}</span>
            {' · '}
            {kit.clientName}
            {' · '}
            {kit.lines.length} line{kit.lines.length === 1 ? '' : 's'}, {kitUnits(kit)} unit{kitUnits(kit) === 1 ? '' : 's'}
          </p>
          {kit.notes && <p className="text-sm text-gray-600 mt-1">{kit.notes}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/promo" className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50">
            Back to Kits
          </Link>
          {canManage && !editingHeader && (
            <button
              onClick={() => { setEditingHeader(true); setEditName(kit.name); setEditNotes(kit.notes ?? ''); }}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              Rename
            </button>
          )}
          {canManage && !isOut && (
            <button onClick={handleDeleteKit} className="px-4 py-2 rounded-lg text-sm font-medium border border-red-300 text-red-700 hover:bg-red-50">
              Delete Kit
            </button>
          )}
        </div>
      </div>

      {editingHeader && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 flex flex-col gap-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-600 mb-1">Kit name</label>
              <input autoComplete="off" value={editName} onChange={e => setEditName(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Notes</label>
              <input autoComplete="off" value={editNotes} onChange={e => setEditNotes(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={async () => { if (await patchKit({ name: editName, notes: editNotes }, 'Kit saved')) setEditingHeader(false); }}
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

      {isOut && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900">
          This kit is out with someone. Its contents are locked until it is booked back in, because the return
          tick-list is built from the list both people agreed to at hand-over.
        </div>
      )}

      {/* Contents */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-600 uppercase">
          Kit contents
        </div>
        <table className="w-full text-sm">
          <thead className="bg-white text-xs text-gray-500 uppercase">
            <tr className="border-b border-gray-100">
              <th className="px-4 py-2 text-left font-medium">Item</th>
              <th className="px-4 py-2 text-left font-medium">Description</th>
              <th className="px-4 py-2 text-left font-medium">Source</th>
              <th className="px-4 py-2 text-right font-medium">Qty</th>
              <th className="px-4 py-2 text-left font-medium">Added</th>
              <th className="px-4 py-2 text-right font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {kit.lines.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">Nothing in this kit yet. Add items below.</td></tr>
            )}
            {kit.lines.map(l => (
              <tr key={l.id} className="border-b border-gray-100 last:border-0">
                <td className="px-4 py-2 font-mono text-xs">{l.code}</td>
                <td className="px-4 py-2">{l.description}</td>
                <td className="px-4 py-2 text-xs text-gray-500">{l.source === 'sku' ? 'Client SKU' : 'Promo material'}</td>
                <td className="px-4 py-2 text-right w-28">
                  {canManage && !isOut ? (
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
                <td className="px-4 py-2 text-xs text-gray-500">
                  {fmtPromoDateTime(l.addedAt)}
                  {l.addedByName ? ` by ${l.addedByName}` : ''}
                </td>
                <td className="px-4 py-2 text-right">
                  {canManage && !isOut && (
                    <button
                      onClick={() => void patchKit({ removeLineIds: [l.id] }, `${l.code} removed`)}
                      className="text-xs text-red-600 hover:underline"
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add items */}
      {canManage && !isOut && (
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
              <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-500">This kit has never been booked out.</td></tr>
            )}
            {bookings.map(b => {
              const missing = b.returnedAt ? b.lines.filter(l => (l.returnedQuantity ?? 0) < l.quantity) : [];
              return (
                <tr key={b.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-2 text-xs">{fmtPromoDateTime(b.bookedOutAt)}</td>
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
    </div>
  );
}
