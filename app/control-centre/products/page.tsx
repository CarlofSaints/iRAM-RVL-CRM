'use client';

import { useEffect, useState, useRef } from 'react';
import { Toast, ToastData } from '@/components/Toast';
import * as XLSX from 'xlsx';

interface Product {
  id: string;
  vendorId: string;
  productCode: string;
  articleNumber: string;
  barcode: string;
  description: string;
  createdAt: string;
}

export default function ProductsPage() {
  const [items, setItems] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<ToastData | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [addVendorId, setAddVendorId] = useState('');
  const [addProductCode, setAddProductCode] = useState('');
  const [addArticleNumber, setAddArticleNumber] = useState('');
  const [addBarcode, setAddBarcode] = useState('');
  const [addDescription, setAddDescription] = useState('');
  const [addLoading, setAddLoading] = useState(false);

  const [editItem, setEditItem] = useState<Product | null>(null);
  const [editVendorId, setEditVendorId] = useState('');
  const [editProductCode, setEditProductCode] = useState('');
  const [editArticleNumber, setEditArticleNumber] = useState('');
  const [editBarcode, setEditBarcode] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editLoading, setEditLoading] = useState(false);

  const notify = (message: string, type: 'success' | 'error' = 'success') => setToast({ message, type });

  async function fetchItems() {
    const res = await fetch('/api/control/products', { cache: 'no-store' });
    if (res.ok) setItems(await res.json());
  }

  useEffect(() => { fetchItems(); }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAddLoading(true);
    try {
      const res = await fetch('/api/control/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendorId: addVendorId, productCode: addProductCode,
          articleNumber: addArticleNumber, barcode: addBarcode, description: addDescription,
        }),
      });
      if (!res.ok) { notify('Failed to add product', 'error'); return; }
      notify('Product added');
      setAddVendorId(''); setAddProductCode(''); setAddArticleNumber('');
      setAddBarcode(''); setAddDescription('');
      fetchItems();
    } finally { setAddLoading(false); }
  }

  function openEdit(item: Product) {
    setEditItem(item);
    setEditVendorId(item.vendorId);
    setEditProductCode(item.productCode);
    setEditArticleNumber(item.articleNumber);
    setEditBarcode(item.barcode);
    setEditDescription(item.description);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editItem) return;
    setEditLoading(true);
    try {
      const res = await fetch('/api/control/products', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editItem.id, vendorId: editVendorId, productCode: editProductCode,
          articleNumber: editArticleNumber, barcode: editBarcode, description: editDescription,
        }),
      });
      if (!res.ok) { notify('Failed to update', 'error'); return; }
      notify('Product updated');
      setEditItem(null);
      fetchItems();
    } finally { setEditLoading(false); }
  }

  async function handleDelete(item: Product) {
    if (!confirm(`Delete ${item.description}?`)) return;
    const res = await fetch(`/api/control/products?id=${item.id}`, { method: 'DELETE' });
    if (res.ok) { notify('Product deleted'); fetchItems(); }
    else notify('Failed to delete', 'error');
  }

  async function handleExcelUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws);

      const records = rows.map(row => ({
        vendorId: (row['Vendor ID'] || row['vendorId'] || row['Vendor Number'] || '').toString(),
        productCode: (row['Product Code'] || row['productCode'] || '').toString(),
        articleNumber: (row['Article Number'] || row['articleNumber'] || row['Article'] || '').toString(),
        barcode: (row['Barcode'] || row['barcode'] || row['EAN'] || '').toString(),
        description: row['Description'] || row['description'] || row['Product Name'] || '',
      })).filter(r => r.description || r.productCode);

      if (!records.length) { notify('No valid rows found', 'error'); return; }

      const res = await fetch('/api/control/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(records),
      });
      const result = await res.json();
      if (res.ok) notify(`Imported ${result.added} products`);
      else notify('Import failed', 'error');
      fetchItems();
    } catch { notify('Failed to parse file', 'error'); }
    if (fileRef.current) fileRef.current.value = '';
  }

  const filtered = items.filter(i =>
    i.description.toLowerCase().includes(search.toLowerCase()) ||
    i.productCode.toLowerCase().includes(search.toLowerCase()) ||
    i.barcode.includes(search) ||
    i.vendorId.includes(search)
  );

  return (
    <div className="flex flex-col gap-6">
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <div className="bg-white rounded-xl shadow-sm border-l-4 border-[var(--color-primary)] px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Products</h1>
          <p className="text-sm text-gray-500 mt-0.5">{items.length} records</p>
        </div>
        <div>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleExcelUpload} className="hidden" />
          <button onClick={() => fileRef.current?.click()}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            Excel Upload
          </button>
        </div>
      </div>

      {/* Add Form */}
      <section className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-4">Add Product</h2>
        <form onSubmit={handleAdd} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Vendor ID</label>
            <input value={addVendorId} onChange={e => setAddVendorId(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Product Code</label>
            <input value={addProductCode} onChange={e => setAddProductCode(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Article Number</label>
            <input value={addArticleNumber} onChange={e => setAddArticleNumber(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Barcode</label>
            <input value={addBarcode} onChange={e => setAddBarcode(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
          </div>
          <div className="flex flex-col gap-1 sm:col-span-2 lg:col-span-1">
            <label className="text-xs text-gray-500 font-medium">Description</label>
            <input value={addDescription} onChange={e => setAddDescription(e.target.value)} required
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
          </div>
          <div className="flex items-end">
            <button type="submit" disabled={addLoading}
              className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white text-sm font-bold px-5 py-2 rounded-lg transition-colors">
              {addLoading ? 'Adding...' : 'Add Product'}
            </button>
          </div>
        </form>
      </section>

      {/* Table */}
      <section className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-6 pb-0">
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by description, code, or barcode..."
            className="w-full max-w-sm border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
        </div>
        <div className="overflow-x-auto mt-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Description</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Vendor ID</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Product Code</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Article #</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Barcode</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(item => (
                <tr key={item.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-3 font-medium text-gray-900">{item.description}</td>
                  <td className="px-6 py-3 text-gray-600 font-mono text-xs">{item.vendorId}</td>
                  <td className="px-6 py-3 text-gray-600 font-mono text-xs">{item.productCode}</td>
                  <td className="px-6 py-3 text-gray-600 font-mono text-xs">{item.articleNumber}</td>
                  <td className="px-6 py-3 text-gray-600 font-mono text-xs">{item.barcode}</td>
                  <td className="px-6 py-3">
                    <div className="flex gap-2 justify-end">
                      <button onClick={() => openEdit(item)} className="text-xs text-blue-600 hover:text-blue-800 font-medium">Edit</button>
                      <button onClick={() => handleDelete(item)} className="text-xs text-red-500 hover:text-red-700 font-medium">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={6} className="px-6 py-8 text-center text-gray-400 text-sm">No records found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Edit Modal */}
      {editItem && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6">
            <h2 className="text-base font-bold text-gray-900 mb-5">Edit Product</h2>
            <form onSubmit={handleEdit} className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Vendor ID</label>
                <input value={editVendorId} onChange={e => setEditVendorId(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Product Code</label>
                <input value={editProductCode} onChange={e => setEditProductCode(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Article Number</label>
                <input value={editArticleNumber} onChange={e => setEditArticleNumber(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Barcode</label>
                <input value={editBarcode} onChange={e => setEditBarcode(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1 col-span-2">
                <label className="text-xs text-gray-500 font-medium">Description</label>
                <input value={editDescription} onChange={e => setEditDescription(e.target.value)} required
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="col-span-2 flex gap-3 pt-2">
                <button type="submit" disabled={editLoading}
                  className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white text-sm font-bold px-5 py-2 rounded-lg transition-colors">
                  {editLoading ? 'Saving...' : 'Save'}
                </button>
                <button type="button" onClick={() => setEditItem(null)}
                  className="text-sm text-gray-600 hover:text-gray-900 px-4 py-2 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
