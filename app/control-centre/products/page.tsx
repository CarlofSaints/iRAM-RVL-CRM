'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';

interface Client {
  id: string;
  name: string;
  vendorNumbers: string[];
  type: 'ASL' | 'NSL';
}

interface SpLink {
  id: string;
  channel: string;
  vendorNumber: string;
  fileName: string;
  folderUrl: string;
  lastRefreshedAt?: string;
}

interface Product {
  id: string;
  articleNumber: string;
  description: string;
  barcode: string;
  vendorProductCode: string;
  uom?: string;
  caseBarcode?: string;
  rowIndex?: number;
  updatedAt: string;
}

interface ValidationModal {
  errors: string[];
  warnings: string[];
  summary?: string;
}

function fmtDate(iso?: string | null) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

function ProductsPageInner() {
  useAuth('manage_products');
  const router = useRouter();
  const search = useSearchParams();
  const initialClientId = search.get('clientId') ?? '';
  const initialLinkId = search.get('linkId') ?? '';

  const [clients, setClients] = useState<Client[]>([]);
  const [links, setLinks] = useState<SpLink[]>([]);
  const [clientId, setClientId] = useState(initialClientId);
  const [linkId, setLinkId] = useState(initialLinkId);
  const [products, setProducts] = useState<Product[]>([]);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [validation, setValidation] = useState<ValidationModal | null>(null);
  const [staleSession, setStaleSession] = useState(false);

  // Add form
  const [addArticle, setAddArticle] = useState('');
  const [addDescription, setAddDescription] = useState('');
  const [addBarcode, setAddBarcode] = useState('');
  const [addVendorProductCode, setAddVendorProductCode] = useState('');
  const [addUom, setAddUom] = useState('');
  const [addCaseBarcode, setAddCaseBarcode] = useState('');
  const [addLoading, setAddLoading] = useState(false);

  // Edit modal
  const [editItem, setEditItem] = useState<Product | null>(null);
  const [editArticle, setEditArticle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editBarcode, setEditBarcode] = useState('');
  const [editVendorProductCode, setEditVendorProductCode] = useState('');
  const [editUom, setEditUom] = useState('');
  const [editCaseBarcode, setEditCaseBarcode] = useState('');
  const [editLoading, setEditLoading] = useState(false);

  const notify = (message: string, type: 'success' | 'error' = 'success') => setToast({ message, type });

  const selectedClient = useMemo(() => clients.find(c => c.id === clientId) ?? null, [clients, clientId]);
  const selectedLink = useMemo(() => links.find(l => l.id === linkId) ?? null, [links, linkId]);

  const refreshGated = !lastRefreshedAt || staleSession;

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const res = await authFetch('/api/control/clients', { cache: 'no-store' });
      if (res.ok) setClients(await res.json());
    })();
  }, []);

  // Whenever clientId changes, reload links
  useEffect(() => {
    setLinks([]);
    setProducts([]);
    setLastRefreshedAt(null);
    setStaleSession(false);
    if (!clientId) return;
    (async () => {
      const res = await authFetch(`/api/clients/${clientId}/sp-links`, { cache: 'no-store' });
      if (res.ok) {
        const linksData: SpLink[] = await res.json();
        setLinks(linksData);
        // Auto-pick the link from the URL or the first one if just-loaded
        if (initialLinkId && linksData.some(l => l.id === initialLinkId)) {
          setLinkId(initialLinkId);
        } else if (!linkId && linksData.length === 1) {
          setLinkId(linksData[0].id);
        } else if (linkId && !linksData.some(l => l.id === linkId)) {
          setLinkId('');
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  // Whenever linkId changes, load products
  useEffect(() => {
    setProducts([]);
    setLastRefreshedAt(null);
    setStaleSession(false);
    if (!clientId || !linkId) return;
    (async () => {
      const res = await authFetch(`/api/clients/${clientId}/sp-links/${linkId}/products`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setProducts(data.products ?? []);
        setLastRefreshedAt(data.lastRefreshedAt ?? null);
      }
    })();
    // Sync URL
    const sp = new URLSearchParams();
    sp.set('clientId', clientId);
    sp.set('linkId', linkId);
    router.replace(`/control-centre/products?${sp.toString()}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkId]);

  // ── Refresh ───────────────────────────────────────────────────────────────
  async function handleRefresh() {
    if (!clientId || !linkId) return;
    setRefreshing(true);
    try {
      const res = await authFetch(`/api/clients/${clientId}/sp-links/${linkId}/refresh`, {
        method: 'POST',
      });
      const data = await res.json();
      const errors: string[] = data.errors ?? (data.error ? [data.error] : []);
      const warnings: string[] = data.warnings ?? [];
      if (!res.ok && errors.length === 0) errors.push(data.error ?? 'Refresh failed');

      // Reload products after refresh (server already wrote the blob unless errors)
      const res2 = await authFetch(`/api/clients/${clientId}/sp-links/${linkId}/products`, { cache: 'no-store' });
      if (res2.ok) {
        const d2 = await res2.json();
        setProducts(d2.products ?? []);
        setLastRefreshedAt(d2.lastRefreshedAt ?? null);
        setStaleSession(false);
      }

      if (errors.length > 0 || warnings.length > 0) {
        setValidation({
          errors,
          warnings,
          summary: res.ok
            ? `Refreshed: +${data.added ?? 0} added, ${data.updated ?? 0} updated, ${data.removed ?? 0} removed (${data.total ?? 0} total)`
            : undefined,
        });
      }
      if (res.ok && errors.length === 0) {
        notify(`Refreshed: +${data.added} added, ${data.updated} updated, ${data.removed} removed`);
      } else if (errors.length > 0) {
        notify(`Refresh failed — ${errors.length} error${errors.length === 1 ? '' : 's'}`, 'error');
      }
    } finally {
      setRefreshing(false);
    }
  }

  // ── Mutations ─────────────────────────────────────────────────────────────
  async function reloadAfterMutation() {
    const res = await authFetch(`/api/clients/${clientId}/sp-links/${linkId}/products`, { cache: 'no-store' });
    if (res.ok) {
      const d = await res.json();
      setProducts(d.products ?? []);
      setLastRefreshedAt(d.lastRefreshedAt ?? null);
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (refreshGated) { notify('Refresh first to enable editing', 'error'); return; }
    setAddLoading(true);
    try {
      const res = await authFetch(`/api/clients/${clientId}/sp-links/${linkId}/products`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'If-Last-Refreshed': lastRefreshedAt ?? '',
        },
        body: JSON.stringify({
          articleNumber: addArticle, description: addDescription, barcode: addBarcode,
          vendorProductCode: addVendorProductCode, uom: addUom, caseBarcode: addCaseBarcode,
        }),
      });
      const data = await res.json();
      if (res.status === 409) {
        setStaleSession(true);
        notify(data.error ?? 'Refresh required', 'error');
        return;
      }
      if (!res.ok) { notify(data.error ?? 'Failed to add', 'error'); return; }
      notify('Product added — written back to SharePoint');
      setAddArticle(''); setAddDescription(''); setAddBarcode('');
      setAddVendorProductCode(''); setAddUom(''); setAddCaseBarcode('');
      await reloadAfterMutation();
    } finally {
      setAddLoading(false);
    }
  }

  function openEdit(p: Product) {
    if (refreshGated) { notify('Refresh first to enable editing', 'error'); return; }
    setEditItem(p);
    setEditArticle(p.articleNumber);
    setEditDescription(p.description);
    setEditBarcode(p.barcode);
    setEditVendorProductCode(p.vendorProductCode);
    setEditUom(p.uom ?? '');
    setEditCaseBarcode(p.caseBarcode ?? '');
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editItem) return;
    setEditLoading(true);
    try {
      const res = await authFetch(`/api/clients/${clientId}/sp-links/${linkId}/products`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'If-Last-Refreshed': lastRefreshedAt ?? '',
        },
        body: JSON.stringify({
          id: editItem.id,
          matchArticleNumber: editItem.articleNumber,
          articleNumber: editArticle, description: editDescription, barcode: editBarcode,
          vendorProductCode: editVendorProductCode, uom: editUom, caseBarcode: editCaseBarcode,
        }),
      });
      const data = await res.json();
      if (res.status === 409) {
        setStaleSession(true);
        notify(data.error ?? 'Refresh required', 'error');
        setEditItem(null);
        return;
      }
      if (!res.ok) { notify(data.error ?? 'Failed to update', 'error'); return; }
      notify('Product updated — written back to SharePoint');
      setEditItem(null);
      await reloadAfterMutation();
    } finally {
      setEditLoading(false);
    }
  }

  async function handleDelete(p: Product) {
    if (refreshGated) { notify('Refresh first to enable editing', 'error'); return; }
    if (!confirm(`Delete "${p.description}" from the SharePoint file?`)) return;
    const res = await authFetch(
      `/api/clients/${clientId}/sp-links/${linkId}/products?id=${encodeURIComponent(p.id)}&articleNumber=${encodeURIComponent(p.articleNumber)}`,
      {
        method: 'DELETE',
        headers: { 'If-Last-Refreshed': lastRefreshedAt ?? '' },
      },
    );
    const data = await res.json();
    if (res.status === 409) {
      setStaleSession(true);
      notify(data.error ?? 'Refresh required', 'error');
      return;
    }
    if (res.ok) { notify('Product deleted'); await reloadAfterMutation(); }
    else notify(data.error ?? 'Failed to delete', 'error');
  }

  // ── View ──────────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    if (!q) return products;
    return products.filter(p =>
      p.description.toLowerCase().includes(q) ||
      p.articleNumber.toLowerCase().includes(q) ||
      p.barcode.toLowerCase().includes(q) ||
      p.vendorProductCode.toLowerCase().includes(q)
    );
  }, [products, searchText]);

  return (
    <div className="flex flex-col gap-6">
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      {/* Header */}
      <div className="bg-white rounded-xl shadow-sm border-l-4 border-[var(--color-primary)] px-6 py-4">
        <h1 className="text-xl font-bold text-gray-900">Products</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Per-client product control files synced from iRam SharePoint.
        </p>
      </div>

      {/* Selectors + Refresh */}
      <section className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Client</label>
            <select value={clientId} onChange={e => { setClientId(e.target.value); setLinkId(''); }}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]">
              <option value="">— Select a client —</option>
              {clients.sort((a, b) => a.name.localeCompare(b.name)).map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">SharePoint Link</label>
            <select value={linkId} onChange={e => setLinkId(e.target.value)} disabled={!clientId || links.length === 0}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] disabled:bg-gray-100 disabled:text-gray-400">
              <option value="">{links.length === 0 ? '— No links yet —' : '— Select a link —'}</option>
              {links.map(l => (
                <option key={l.id} value={l.id}>{l.channel} — {l.vendorNumber} ({l.fileName})</option>
              ))}
            </select>
            {clientId && links.length === 0 && (
              <Link href={`/control-centre/clients/${clientId}`} className="text-xs text-blue-600 hover:underline mt-1">
                Add a SharePoint link →
              </Link>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <button onClick={handleRefresh} disabled={!linkId || refreshing}
              className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white text-sm font-bold px-5 py-2 rounded-lg">
              {refreshing ? 'Refreshing…' : 'Refresh from SharePoint'}
            </button>
            <p className="text-xs text-gray-500 mt-1">
              Last refreshed: <span className="font-medium text-gray-700">{fmtDate(lastRefreshedAt)}</span>
            </p>
          </div>
        </div>
        {staleSession && (
          <div className="mt-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm">
            ⚠ The SharePoint file was refreshed in another session. Click <b>Refresh from SharePoint</b> before editing.
          </div>
        )}
      </section>

      {/* Empty state */}
      {!clientId && (
        <section className="bg-white rounded-xl shadow-sm border border-gray-100 p-10 text-center">
          <p className="text-sm text-gray-500">Select a client above to view their products.</p>
        </section>
      )}

      {clientId && !linkId && (
        <section className="bg-white rounded-xl shadow-sm border border-gray-100 p-10 text-center">
          <p className="text-sm text-gray-500">
            Select a SharePoint link to view products{selectedClient ? ` for ${selectedClient.name}` : ''}.
          </p>
        </section>
      )}

      {/* Add Product */}
      {linkId && (
        <section className={`bg-white rounded-xl shadow-sm border border-gray-100 p-6 ${refreshGated ? 'opacity-90' : ''}`}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">Add Product</h2>
            {refreshGated && (
              <span className="text-xs text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">Refresh first to enable editing</span>
            )}
          </div>
          <form onSubmit={handleAdd} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500 font-medium">Article Number *</label>
              <input value={addArticle} onChange={e => setAddArticle(e.target.value)} required disabled={refreshGated}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] disabled:bg-gray-100" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500 font-medium">Product Description *</label>
              <input value={addDescription} onChange={e => setAddDescription(e.target.value)} required disabled={refreshGated}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] disabled:bg-gray-100" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500 font-medium">Barcode *</label>
              <input value={addBarcode} onChange={e => setAddBarcode(e.target.value)} required disabled={refreshGated}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] disabled:bg-gray-100" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500 font-medium">Vendor Product Code *</label>
              <input value={addVendorProductCode} onChange={e => setAddVendorProductCode(e.target.value)} required disabled={refreshGated}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] disabled:bg-gray-100" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500 font-medium">UoM</label>
              <input value={addUom} onChange={e => setAddUom(e.target.value)} disabled={refreshGated}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] disabled:bg-gray-100" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500 font-medium">Case Barcode</label>
              <input value={addCaseBarcode} onChange={e => setAddCaseBarcode(e.target.value)} disabled={refreshGated}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] disabled:bg-gray-100" />
            </div>
            <div className="flex items-end">
              <button type="submit" disabled={addLoading || refreshGated}
                className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white text-sm font-bold px-5 py-2 rounded-lg">
                {addLoading ? 'Adding…' : 'Add Product'}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Table */}
      {linkId && (
        <section className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="p-6 pb-0 flex items-center justify-between gap-3">
            <input value={searchText} onChange={e => setSearchText(e.target.value)}
              placeholder="Search by description, article #, barcode or vendor code…"
              className="w-full max-w-md border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
            <span className="text-xs text-gray-500">{products.length} record{products.length === 1 ? '' : 's'}</span>
          </div>
          <div className="overflow-x-auto mt-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Article #</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Product Description</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Barcode</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Vendor Product Code</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">UoM</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Case Barcode</th>
                  <th className="px-6 py-3" />
                </tr>
              </thead>
              <tbody>
                {filtered.map(p => (
                  <tr key={p.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-3 text-gray-700 font-mono text-xs">{p.articleNumber}</td>
                    <td className="px-6 py-3 font-medium text-gray-900">{p.description}</td>
                    <td className="px-6 py-3 text-gray-700 font-mono text-xs">{p.barcode}</td>
                    <td className="px-6 py-3 text-gray-700 font-mono text-xs">{p.vendorProductCode}</td>
                    <td className="px-6 py-3 text-gray-600">{p.uom ?? ''}</td>
                    <td className="px-6 py-3 text-gray-700 font-mono text-xs">{p.caseBarcode ?? ''}</td>
                    <td className="px-6 py-3">
                      <div className="flex gap-2 justify-end">
                        <button onClick={() => openEdit(p)} disabled={refreshGated}
                          className="text-xs text-blue-600 hover:text-blue-800 font-medium disabled:opacity-40 disabled:cursor-not-allowed">Edit</button>
                        <button onClick={() => handleDelete(p)} disabled={refreshGated}
                          className="text-xs text-red-500 hover:text-red-700 font-medium disabled:opacity-40 disabled:cursor-not-allowed">Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={7} className="px-6 py-8 text-center text-gray-400 text-sm">
                    {products.length === 0
                      ? 'No products synced yet — click Refresh to pull from SharePoint.'
                      : 'No records match your search.'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          {selectedLink && (
            <div className="px-6 py-3 border-t border-gray-100 text-xs text-gray-500">
              Source: <span className="font-medium text-gray-700">{selectedLink.fileName}</span>
              {selectedClient && <> · Client: <span className="font-medium text-gray-700">{selectedClient.name}</span></>}
            </div>
          )}
        </section>
      )}

      {/* Edit Modal */}
      {editItem && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl p-6">
            <h2 className="text-base font-bold text-gray-900 mb-5">Edit Product</h2>
            <form onSubmit={handleEdit} className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Article Number *</label>
                <input value={editArticle} onChange={e => setEditArticle(e.target.value)} required
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Product Description *</label>
                <input value={editDescription} onChange={e => setEditDescription(e.target.value)} required
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Barcode *</label>
                <input value={editBarcode} onChange={e => setEditBarcode(e.target.value)} required
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Vendor Product Code *</label>
                <input value={editVendorProductCode} onChange={e => setEditVendorProductCode(e.target.value)} required
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">UoM</label>
                <input value={editUom} onChange={e => setEditUom(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Case Barcode</label>
                <input value={editCaseBarcode} onChange={e => setEditCaseBarcode(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="col-span-2 flex gap-3 pt-2">
                <button type="submit" disabled={editLoading}
                  className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white text-sm font-bold px-5 py-2 rounded-lg">
                  {editLoading ? 'Saving…' : 'Save'}
                </button>
                <button type="button" onClick={() => setEditItem(null)}
                  className="text-sm text-gray-600 hover:text-gray-900 px-4 py-2 rounded-lg border border-gray-200 hover:bg-gray-50">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Validation modal */}
      {validation && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl p-6">
            <h2 className="text-base font-bold text-gray-900 mb-3">
              {validation.errors.length > 0 ? 'Refresh Errors' : 'Refresh Warnings'}
            </h2>
            {validation.summary && <p className="text-sm text-gray-700 mb-3">{validation.summary}</p>}
            {validation.errors.length > 0 && (
              <div className="mb-4">
                <h3 className="text-xs font-semibold text-red-700 uppercase mb-1">Errors</h3>
                <ul className="text-sm text-red-700 space-y-1 list-disc pl-5 max-h-40 overflow-auto">
                  {validation.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}
            {validation.warnings.length > 0 && (
              <div className="mb-4">
                <h3 className="text-xs font-semibold text-amber-700 uppercase mb-1">Warnings</h3>
                <ul className="text-sm text-amber-700 space-y-1 list-disc pl-5 max-h-60 overflow-auto">
                  {validation.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}
            <div className="flex justify-end">
              <button onClick={() => setValidation(null)}
                className="text-sm text-gray-700 px-4 py-2 rounded-lg border border-gray-300 hover:bg-gray-50">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ProductsPage() {
  return (
    <Suspense fallback={null}>
      <ProductsPageInner />
    </Suspense>
  );
}
