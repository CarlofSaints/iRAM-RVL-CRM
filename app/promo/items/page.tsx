'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import * as XLSX from 'xlsx';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';
import { useTableSort } from '@/lib/useTableSort';
import { useColumnResize, RESIZE_HANDLE_CLASS } from '@/lib/useColumnResize';
import SortableTh from '@/components/SortableTh';
import { fmtPromoDateTime } from '@/lib/promoShared';

interface PromoItemDto {
  id: string;
  code: string;
  description: string;
  category?: string;
  notes?: string;
  createdAt: string;
  createdByName?: string;
  updatedAt: string;
}

const COLS = ['Item Code', 'Description', 'Category', 'Notes', 'Added', 'Added By'];
const SORT_KEYS = ['code', 'description', 'category', 'notes', 'created', 'createdBy'];
const TEMPLATE_HEADERS = ['ITEM CODE', 'DESCRIPTION', 'CATEGORY', 'NOTES'];

/** Match an uploaded sheet's headers loosely — column order is whatever they used. */
function pickHeader(row: Record<string, unknown>, aliases: string[]): string {
  for (const key of Object.keys(row)) {
    const norm = key.replace(/\s+/g, '').toLowerCase();
    if (aliases.some(a => a.replace(/\s+/g, '').toLowerCase() === norm)) {
      return String(row[key] ?? '').trim();
    }
  }
  return '';
}

export default function PromoItemsPage() {
  const { session } = useAuth('view_promo_kits');
  const canManage = (session?.permissions ?? []).includes('manage_promo_kits');

  const [items, setItems] = useState<PromoItemDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<ToastData | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Add form
  const [addCode, setAddCode] = useState('');
  const [addDescription, setAddDescription] = useState('');
  const [addCategory, setAddCategory] = useState('');
  const [addNotes, setAddNotes] = useState('');
  const [adding, setAdding] = useState(false);

  // Edit modal
  const [editItem, setEditItem] = useState<PromoItemDto | null>(null);
  const [editCode, setEditCode] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editBusy, setEditBusy] = useState(false);

  // Import preview
  const [importRows, setImportRows] = useState<Array<{ code: string; description: string; category: string; notes: string }>>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importBusy, setImportBusy] = useState(false);

  const notify = (message: string, type: 'success' | 'error' = 'success') => setToast({ message, type });

  const fetchItems = useCallback(async () => {
    const res = await authFetch('/api/promo/items', { cache: 'no-store' });
    if (res.ok) setItems(((await res.json()).items ?? []) as PromoItemDto[]);
    setLoading(false);
  }, []);

  useEffect(() => { if (session) void fetchItems(); }, [session, fetchItems]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(i =>
      i.code.toLowerCase().includes(q) ||
      i.description.toLowerCase().includes(q) ||
      (i.category ?? '').toLowerCase().includes(q));
  }, [items, search]);

  const sort = useTableSort<PromoItemDto>(filtered, {
    code: i => i.code,
    description: i => i.description,
    category: i => i.category ?? '',
    notes: i => i.notes ?? '',
    created: i => i.createdAt,
    createdBy: i => i.createdByName ?? '',
  }, 'description', 'asc');

  const resize = useColumnResize(COLS.length + 1);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    try {
      const res = await authFetch('/api/promo/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: addCode, description: addDescription, category: addCategory, notes: addNotes }),
      });
      const data = await res.json();
      if (!res.ok) { notify(data.error ?? 'Could not save the item', 'error'); return; }
      notify(data.added ? 'Item added' : 'Item updated (that code already existed)');
      setAddCode(''); setAddDescription(''); setAddCategory(''); setAddNotes('');
      await fetchItems();
    } finally {
      setAdding(false);
    }
  }

  function openEdit(item: PromoItemDto) {
    setEditItem(item);
    setEditCode(item.code);
    setEditDescription(item.description);
    setEditCategory(item.category ?? '');
    setEditNotes(item.notes ?? '');
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editItem) return;
    setEditBusy(true);
    try {
      const res = await authFetch(`/api/promo/items/${editItem.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: editCode, description: editDescription, category: editCategory, notes: editNotes }),
      });
      const data = await res.json();
      if (!res.ok) { notify(data.error ?? 'Could not save the item', 'error'); return; }
      notify('Item saved');
      setEditItem(null);
      await fetchItems();
    } finally {
      setEditBusy(false);
    }
  }

  async function handleDelete(item: PromoItemDto) {
    const res = await authFetch(`/api/promo/items/${item.id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) { notify(data.error ?? 'Could not delete the item', 'error'); return; }
    notify(`${item.description} deleted`);
    setEditItem(null);
    await fetchItems();
  }

  // ── Excel ──────────────────────────────────────────────────────────────────
  function downloadTemplate() {
    const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS]);
    ws['!cols'] = TEMPLATE_HEADERS.map(h => ({ wch: Math.max(16, h.length + 4) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Promo Material');
    XLSX.writeFile(wb, 'iRamFlow_Promo_Material_Template.xlsx');
  }

  function exportItems() {
    if (sort.sorted.length === 0) { notify('Nothing to export', 'error'); return; }
    const rows = sort.sorted.map(i => ({
      'Item Code': i.code,
      Description: i.description,
      Category: i.category ?? '',
      Notes: i.notes ?? '',
      Added: fmtPromoDateTime(i.createdAt),
      'Added By': i.createdByName ?? '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = Object.keys(rows[0]).map(h => ({ wch: Math.max(14, Math.min(45, h.length + 8)) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Promo Material');
    XLSX.writeFile(wb, `iRamFlow_Promo_Material_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const wb = XLSX.read(await file.arrayBuffer());
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });
      const rows = raw
        .map(r => ({
          code: pickHeader(r, ['ITEM CODE', 'CODE', 'ITEMCODE', 'SKU', 'REF']),
          description: pickHeader(r, ['DESCRIPTION', 'ITEM', 'NAME', 'PRODUCT DESCRIPTION']),
          category: pickHeader(r, ['CATEGORY', 'TYPE', 'GROUP']),
          notes: pickHeader(r, ['NOTES', 'NOTE', 'COMMENT']),
        }))
        .filter(r => r.code || r.description);
      if (rows.length === 0) {
        notify('No rows found. The sheet needs an ITEM CODE and a DESCRIPTION column.', 'error');
        return;
      }
      setImportRows(rows);
      setImportOpen(true);
    } catch (err) {
      notify(`Could not read that file: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function commitImport() {
    setImportBusy(true);
    try {
      const res = await authFetch('/api/promo/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: importRows }),
      });
      const data = await res.json();
      if (!res.ok) { notify(data.error ?? 'Import failed', 'error'); return; }
      notify(`${data.added} added, ${data.updated} updated`);
      setImportOpen(false);
      setImportRows([]);
      await fetchItems();
    } finally {
      setImportBusy(false);
    }
  }

  if (!session) return null;

  const blankCodes = importRows.filter(r => !r.code).length;

  return (
    <div className="flex flex-col gap-5">
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Promo Material</h1>
          <p className="text-sm text-gray-500">
            Giveaways, banners, uniforms and anything else that is not a client SKU. Client products come
            straight from their product control file and do not need to be listed here.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/promo" className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50">
            Back to Kits
          </Link>
          <button onClick={exportItems} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50">
            Export to Excel
          </button>
          {canManage && (
            <>
              <button onClick={downloadTemplate} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50">
                Template
              </button>
              <button onClick={() => fileRef.current?.click()} className="px-4 py-2 rounded-lg text-sm font-medium bg-[var(--color-primary)] text-white hover:opacity-90">
                Upload Excel
              </button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={handleFile} className="hidden" />
            </>
          )}
        </div>
      </div>

      {canManage && (
        <form onSubmit={handleAdd} className="bg-white border border-gray-200 rounded-lg p-4 grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
          <div>
            <label className="block text-xs text-gray-600 mb-1">Item code</label>
            <input required autoComplete="off" value={addCode} onChange={e => setAddCode(e.target.value)} placeholder="e.g. PM-TSHIRT-L" className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm" />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Description</label>
            <input required autoComplete="off" value={addDescription} onChange={e => setAddDescription(e.target.value)} placeholder="e.g. Branded T-shirt (Large)" className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm" />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Category</label>
            <input autoComplete="off" value={addCategory} onChange={e => setAddCategory(e.target.value)} placeholder="e.g. Giveaway" className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm" />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Notes</label>
            <input autoComplete="off" value={addNotes} onChange={e => setAddNotes(e.target.value)} className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm" />
          </div>
          <button type="submit" disabled={adding} className="px-4 py-2 rounded-md text-sm font-medium bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-50">
            {adding ? 'Adding…' : 'Add Item'}
          </button>
        </form>
      )}

      <div className="flex items-center gap-3">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search promo material"
          className="w-72 px-3 py-2 border border-gray-300 rounded-md text-sm"
        />
        <span className="text-sm text-gray-500">
          {filtered.length} of {items.length} item{items.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
        <table className="w-full text-sm" style={resize.tableStyle}>
          <thead className="bg-gray-50 text-xs text-gray-600 uppercase">
            <tr>
              {COLS.map((label, ci) => (
                <th key={label} className="relative p-0" style={resize.widthStyle(ci)}>
                  <div className="flex items-center">
                    <SortableTh
                      col={SORT_KEYS[ci]}
                      label={label}
                      sortCol={sort.sortCol}
                      sortDir={sort.sortDir}
                      onSort={sort.toggleSort}
                      className="px-3 py-2 text-left w-full font-medium"
                    />
                  </div>
                  <span onMouseDown={e => resize.startResize(ci, e)} className={RESIZE_HANDLE_CLASS} />
                </th>
              ))}
              <th className="px-3 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={COLS.length + 1} className="px-3 py-8 text-center text-gray-400">Loading…</td></tr>}
            {!loading && sort.sorted.length === 0 && (
              <tr>
                <td colSpan={COLS.length + 1} className="px-3 py-8 text-center text-gray-500">
                  {items.length === 0 ? 'No promo material yet. Add one above or upload a sheet.' : 'Nothing matches that search.'}
                </td>
              </tr>
            )}
            {sort.sorted.map(i => (
              <tr key={i.id} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="px-3 py-2 font-mono text-xs">{i.code}</td>
                <td className="px-3 py-2">{i.description}</td>
                <td className="px-3 py-2">{i.category ?? ''}</td>
                <td className="px-3 py-2 text-xs text-gray-600">{i.notes ?? ''}</td>
                <td className="px-3 py-2 text-xs text-gray-600">{fmtPromoDateTime(i.createdAt)}</td>
                <td className="px-3 py-2 text-xs text-gray-600">{i.createdByName ?? ''}</td>
                <td className="px-3 py-2 text-right">
                  {canManage && (
                    <button onClick={() => openEdit(i)} className="text-xs text-[var(--color-primary)] hover:underline">Edit</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Edit modal */}
      {editItem && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-40 p-4">
          <form onSubmit={handleEdit} className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 flex flex-col gap-4">
            <h2 className="text-lg font-semibold text-gray-900">Edit Promo Item</h2>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Item code</label>
              <input required autoComplete="off" value={editCode} onChange={e => setEditCode(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Description</label>
              <input required autoComplete="off" value={editDescription} onChange={e => setEditDescription(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Category</label>
              <input autoComplete="off" value={editCategory} onChange={e => setEditCategory(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Notes</label>
              <textarea rows={2} value={editNotes} onChange={e => setEditNotes(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
            </div>
            <div className="flex justify-between gap-2">
              <button type="button" onClick={() => handleDelete(editItem)} className="px-4 py-2 border border-red-300 text-red-700 rounded-md text-sm hover:bg-red-50">
                Delete
              </button>
              <div className="flex gap-2">
                <button type="button" onClick={() => setEditItem(null)} className="px-4 py-2 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50">
                  Cancel
                </button>
                <button type="submit" disabled={editBusy} className="px-4 py-2 rounded-md text-sm font-medium bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-50">
                  {editBusy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Import preview */}
      {importOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[85vh] overflow-y-auto p-6 flex flex-col gap-4">
            <h2 className="text-lg font-semibold text-gray-900">Import Promo Material</h2>
            <p className="text-sm text-gray-600">
              {importRows.length} row{importRows.length === 1 ? '' : 's'} read. An item code that already exists is
              updated rather than duplicated.
            </p>
            {blankCodes > 0 && (
              <div className="border border-red-200 bg-red-50 rounded-lg p-3 text-sm text-red-800">
                {blankCodes} row{blankCodes === 1 ? ' has' : 's have'} no item code. Every item needs one so it can be
                ticked off on return. Fix the sheet and upload it again.
              </div>
            )}
            <div className="border border-gray-200 rounded-lg overflow-y-auto max-h-72">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-600 uppercase sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Item Code</th>
                    <th className="px-3 py-2 text-left font-medium">Description</th>
                    <th className="px-3 py-2 text-left font-medium">Category</th>
                    <th className="px-3 py-2 text-left font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {importRows.map((r, idx) => (
                    <tr key={idx} className={`border-t border-gray-100 ${r.code ? '' : 'bg-red-50'}`}>
                      <td className="px-3 py-1.5 font-mono text-xs">{r.code || '(missing)'}</td>
                      <td className="px-3 py-1.5">{r.description}</td>
                      <td className="px-3 py-1.5">{r.category}</td>
                      <td className="px-3 py-1.5 text-xs text-gray-600">{r.notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => { setImportOpen(false); setImportRows([]); }} className="px-4 py-2 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50">
                Cancel
              </button>
              <button
                onClick={commitImport}
                disabled={importBusy || blankCodes > 0}
                className="px-4 py-2 rounded-md text-sm font-medium bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {importBusy ? 'Importing…' : `Import ${importRows.length} row${importRows.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
