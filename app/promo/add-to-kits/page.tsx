'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';
import { PROMO_KIT_STATUS_LABELS, kitUnits, type PromoKitStatus } from '@/lib/promoShared';

/**
 * Item-first version of "add an item to a kit".
 *
 * The kit page adds many items to one kit. This page adds ONE item to many
 * kits, because putting the same pull-up banner into five kits one kit at a
 * time is the thing this module exists to avoid. Both post to the same endpoint
 * (/api/promo/kits/add-item) so there is one code path into a kit.
 */

interface KitDto {
  id: string;
  reference: string;
  clientId: string;
  clientName: string;
  name: string;
  lines: Array<{ id: string; source: 'sku' | 'promo'; ref: string; code: string; quantity: number }>;
  status: PromoKitStatus;
}
interface ClientDto { id: string; name: string; vendorNumbers?: string[] }
interface ClientProductDto { articleNumber: string; description: string }
interface PromoItemDto { id: string; code: string; description: string; category?: string }

function clientLabel(c: ClientDto): string {
  const nums = (c.vendorNumbers ?? []).filter(Boolean);
  return nums.length ? `${c.name} (${nums.join(', ')})` : c.name;
}

/** Same normalisation the server uses, so "already in this kit" agrees with it. */
function normArticle(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, '').replace(/^0+/, '').toLowerCase();
}

export default function AddToKitsPage() {
  const { session } = useAuth('manage_promo_kits');

  const [kits, setKits] = useState<KitDto[]>([]);
  const [clients, setClients] = useState<ClientDto[]>([]);
  const [promoItems, setPromoItems] = useState<PromoItemDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<ToastData | null>(null);

  // Step 1 — the item
  const [source, setSource] = useState<'sku' | 'promo'>('promo');
  const [skuClientId, setSkuClientId] = useState('');
  const [products, setProducts] = useState<ClientProductDto[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [itemSearch, setItemSearch] = useState('');
  const [chosen, setChosen] = useState<{ ref: string; code: string; description: string } | null>(null);
  const [quantity, setQuantity] = useState(1);

  // Step 2 — the kits
  const [kitClientFilter, setKitClientFilter] = useState('');
  const [kitSearch, setKitSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const notify = (message: string, type: 'success' | 'error' = 'success') => setToast({ message, type });

  const fetchAll = useCallback(async () => {
    const [kRes, cRes, iRes] = await Promise.all([
      authFetch('/api/promo/kits', { cache: 'no-store' }),
      authFetch('/api/aged-stock/clients', { cache: 'no-store' }),
      authFetch('/api/promo/items', { cache: 'no-store' }),
    ]);
    if (kRes.ok) setKits(((await kRes.json()).kits ?? []) as KitDto[]);
    if (cRes.ok) setClients(((await cRes.json()).clients ?? []) as ClientDto[]);
    if (iRes.ok) setPromoItems(((await iRes.json()).items ?? []) as PromoItemDto[]);
    setLoading(false);
  }, []);

  useEffect(() => { if (session) void fetchAll(); }, [session, fetchAll]);

  // Load the chosen client's SKU list for the product search.
  useEffect(() => {
    if (source !== 'sku' || !skuClientId) { setProducts([]); return; }
    let cancelled = false;
    setProductsLoading(true);
    void (async () => {
      const res = await authFetch(`/api/clients/${skuClientId}/products`, { cache: 'no-store' });
      if (cancelled) return;
      if (res.ok) setProducts(((await res.json()).products ?? []) as ClientProductDto[]);
      else setProducts([]);
      setProductsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [source, skuClientId]);

  const itemMatches = useMemo(() => {
    const q = itemSearch.trim().toLowerCase();
    if (source === 'sku') {
      const list = q
        ? products.filter(p => p.articleNumber.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q))
        : products;
      return list.slice(0, 60).map(p => ({ ref: p.articleNumber, code: p.articleNumber, description: p.description || '' }));
    }
    const list = q
      ? promoItems.filter(i => i.code.toLowerCase().includes(q) || i.description.toLowerCase().includes(q))
      : promoItems;
    return list.slice(0, 60).map(i => ({ ref: i.id, code: i.code, description: i.description }));
  }, [source, itemSearch, products, promoItems]);

  const visibleKits = useMemo(() => {
    const q = kitSearch.trim().toLowerCase();
    return kits
      .filter(k => (!kitClientFilter || k.clientId === kitClientFilter))
      .filter(k => !q || k.name.toLowerCase().includes(q) || k.reference.toLowerCase().includes(q))
      .sort((a, b) => a.clientName.localeCompare(b.clientName) || a.name.localeCompare(b.name));
  }, [kits, kitClientFilter, kitSearch]);

  /** How many of the chosen item a kit already holds, so the screen says so before adding more. */
  const alreadyIn = useCallback((kit: KitDto): number => {
    if (!chosen) return 0;
    const line = kit.lines.find(l =>
      l.source === source &&
      (source === 'sku' ? normArticle(l.ref) === normArticle(chosen.ref) : l.ref === chosen.ref));
    return line?.quantity ?? 0;
  }, [chosen, source]);

  function toggleKit(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const selectableIds = useMemo(
    () => visibleKits.filter(k => k.status === 'home').map(k => k.id),
    [visibleKits],
  );
  const allShownSelected = selectableIds.length > 0 && selectableIds.every(id => selected.has(id));

  async function handleAdd() {
    if (!chosen || selected.size === 0) return;
    setBusy(true);
    try {
      const res = await authFetch('/api/promo/kits/add-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, ref: chosen.ref, quantity, kitIds: [...selected] }),
      });
      const data = await res.json();
      if (!res.ok) { notify(data.error ?? 'Could not add the item', 'error'); return; }

      const warnings = (data.warnings ?? []) as string[];
      const parts: string[] = [];
      if (data.addedTo?.length) parts.push(`added to ${data.addedTo.length} kit(s)`);
      if (data.mergedIn?.length) parts.push(`quantity increased on ${data.mergedIn.length} kit(s)`);
      notify(
        `${data.code} x${quantity}: ${parts.join(', ')}.${warnings.length ? ` ${warnings.join(' ')}` : ''}`,
        warnings.length ? 'error' : 'success',
      );
      setSelected(new Set());
      await fetchAll();
    } finally {
      setBusy(false);
    }
  }

  if (!session) return null;

  return (
    <div className="flex flex-col gap-5">
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Add an Item to Several Kits</h1>
          <p className="text-sm text-gray-500">
            Find one item, set the quantity, then tick every kit it goes into. Nothing is written until you press Add.
          </p>
        </div>
        <Link href="/promo" className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50">
          Back to Kits
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        {/* ── Step 1: the item ──────────────────────────────────────────── */}
        <div className="bg-white border border-gray-200 rounded-lg">
          <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-600 uppercase">
            1. Find the item
          </div>
          <div className="p-4 flex flex-col gap-3">
            <div className="flex gap-1 border-b border-gray-200">
              {([['promo', 'Promo material'], ['sku', 'Client products']] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => { setSource(key); setChosen(null); setItemSearch(''); }}
                  className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
                    source === key
                      ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {source === 'sku' && (
              <div>
                <label className="block text-xs text-gray-600 mb-1">Search products from</label>
                <select
                  value={skuClientId}
                  onChange={e => { setSkuClientId(e.target.value); setChosen(null); }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
                >
                  <option value="">Select a client</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{clientLabel(c)}</option>)}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  This only picks which product list to search. You can still add the item to another client&apos;s kit,
                  and you will be told if it is not on that client&apos;s file.
                </p>
              </div>
            )}

            <input
              autoComplete="off"
              value={itemSearch}
              onChange={e => { setItemSearch(e.target.value); setChosen(null); }}
              placeholder={source === 'sku' ? 'Search article number or description' : 'Search promo material'}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />

            <div className="max-h-64 overflow-y-auto border border-gray-200 rounded-md divide-y divide-gray-100">
              {source === 'sku' && !skuClientId && (
                <div className="px-3 py-3 text-sm text-gray-600">Pick a client above to search their product list.</div>
              )}
              {source === 'sku' && skuClientId && productsLoading && (
                <div className="px-3 py-3 text-sm text-gray-400">Loading the product list…</div>
              )}
              {source === 'sku' && skuClientId && !productsLoading && products.length === 0 && (
                <div className="px-3 py-3 text-sm text-gray-600">
                  That client has no product control file loaded, so there is nothing to search.
                </div>
              )}
              {source === 'promo' && promoItems.length === 0 && (
                <div className="px-3 py-3 text-sm text-gray-600">
                  No promo material on file yet.{' '}
                  <Link href="/promo/items" className="text-[var(--color-primary)] hover:underline">Add some</Link>.
                </div>
              )}
              {itemMatches.map(m => (
                <button
                  key={m.ref}
                  onClick={() => setChosen(m)}
                  className={`w-full text-left px-3 py-2 hover:bg-gray-50 ${chosen?.ref === m.ref ? 'bg-green-50' : ''}`}
                >
                  <span className="font-mono text-xs text-gray-700">{m.code}</span>
                  <span className="text-sm text-gray-900 ml-2">{m.description}</span>
                </button>
              ))}
            </div>

            <div>
              <label className="block text-xs text-gray-600 mb-1">Quantity per kit</label>
              <input
                type="number"
                min={1}
                value={quantity}
                onChange={e => setQuantity(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                className="w-28 px-3 py-2 border border-gray-300 rounded-md text-sm text-right"
              />
            </div>
          </div>
        </div>

        {/* ── Step 2: the kits ──────────────────────────────────────────── */}
        <div className="bg-white border border-gray-200 rounded-lg">
          <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-600 uppercase flex items-center justify-between">
            <span>2. Pick the kits</span>
            <span className="normal-case font-normal text-gray-500">{selected.size} selected</span>
          </div>
          <div className="p-4 flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <select
                value={kitClientFilter}
                onChange={e => setKitClientFilter(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
              >
                <option value="">All clients</option>
                {clients.map(c => <option key={c.id} value={c.id}>{clientLabel(c)}</option>)}
              </select>
              <input
                autoComplete="off"
                value={kitSearch}
                onChange={e => setKitSearch(e.target.value)}
                placeholder="Search kit name"
                className="px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
            </div>

            <button
              onClick={() => setSelected(prev => {
                const next = new Set(prev);
                if (allShownSelected) selectableIds.forEach(id => next.delete(id));
                else selectableIds.forEach(id => next.add(id));
                return next;
              })}
              disabled={selectableIds.length === 0}
              className="self-start text-sm text-[var(--color-primary)] hover:underline disabled:text-gray-400 disabled:no-underline"
            >
              {allShownSelected ? 'Clear the kits shown' : `Select all ${selectableIds.length} kit(s) shown`}
            </button>

            <div className="max-h-80 overflow-y-auto border border-gray-200 rounded-md divide-y divide-gray-100">
              {loading && <div className="px-3 py-3 text-sm text-gray-400">Loading…</div>}
              {!loading && visibleKits.length === 0 && (
                <div className="px-3 py-3 text-sm text-gray-600">
                  {kits.length === 0 ? 'No promo kits exist yet.' : 'No kits match those filters.'}
                </div>
              )}
              {visibleKits.map(k => {
                const out = k.status === 'out';
                const have = alreadyIn(k);
                return (
                  <label
                    key={k.id}
                    className={`flex items-start gap-3 px-3 py-2 ${out ? 'bg-gray-50 cursor-not-allowed' : 'hover:bg-gray-50 cursor-pointer'}`}
                    title={out ? `${k.reference} is out with someone, so its contents are locked` : ''}
                  >
                    <input
                      type="checkbox"
                      disabled={out}
                      checked={selected.has(k.id)}
                      onChange={() => toggleKit(k.id)}
                      className="w-4 h-4 mt-0.5"
                    />
                    <span className="flex-1">
                      <span className="text-sm text-gray-900 font-medium">{k.name}</span>
                      <span className="font-mono text-xs text-gray-500 ml-2">{k.reference}</span>
                      <span className="block text-xs text-gray-500">
                        {k.clientName}
                        {' · '}
                        {k.lines.length} line{k.lines.length === 1 ? '' : 's'}, {kitUnits(k)} unit{kitUnits(k) === 1 ? '' : 's'}
                        {out ? ` · ${PROMO_KIT_STATUS_LABELS.out}` : ''}
                        {have > 0 ? ` · already has ${have}` : ''}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Commit bar */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-gray-700">
          {chosen ? (
            <>
              <span className="font-mono text-xs text-gray-600">{chosen.code}</span>
              <span className="ml-2">{chosen.description}</span>
              <span className="ml-2 text-gray-500">
                x{quantity} into {selected.size} kit{selected.size === 1 ? '' : 's'}
              </span>
            </>
          ) : (
            <span className="text-gray-500">Pick an item on the left, then tick the kits on the right.</span>
          )}
        </div>
        <button
          onClick={handleAdd}
          disabled={!chosen || selected.size === 0 || busy}
          className="px-5 py-2 rounded-md text-sm font-medium bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? 'Adding…' : `Add to ${selected.size} Kit${selected.size === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
}
