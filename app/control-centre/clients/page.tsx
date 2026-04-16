'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';
import * as XLSX from 'xlsx';

interface Client {
  id: string;
  name: string;
  vendorNumbers: string[];
  type: 'ASL' | 'NSL';
  createdAt: string;
}

export default function ClientsPage() {
  useAuth('manage_clients');
  const [items, setItems] = useState<Client[]>([]);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<ToastData | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Add form
  const [addName, setAddName] = useState('');
  const [addVendorNums, setAddVendorNums] = useState('');
  const [addType, setAddType] = useState<'ASL' | 'NSL'>('ASL');
  const [addLoading, setAddLoading] = useState(false);

  // Edit modal
  const [editItem, setEditItem] = useState<Client | null>(null);
  const [editName, setEditName] = useState('');
  const [editVendorNums, setEditVendorNums] = useState('');
  const [editType, setEditType] = useState<'ASL' | 'NSL'>('ASL');
  const [editLoading, setEditLoading] = useState(false);

  const notify = (message: string, type: 'success' | 'error' = 'success') => setToast({ message, type });

  async function fetchItems() {
    const res = await authFetch('/api/control/clients', { cache: 'no-store' });
    if (res.ok) setItems(await res.json());
  }

  useEffect(() => { fetchItems(); }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAddLoading(true);
    try {
      const vendorNumbers = addVendorNums.split(',').map(v => v.trim()).filter(Boolean);
      const res = await authFetch('/api/control/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: addName, vendorNumbers, type: addType }),
      });
      if (!res.ok) { notify('Failed to add client', 'error'); return; }
      notify('Client added');
      setAddName(''); setAddVendorNums(''); setAddType('ASL');
      fetchItems();
    } finally { setAddLoading(false); }
  }

  function openEdit(item: Client) {
    setEditItem(item);
    setEditName(item.name);
    setEditVendorNums(item.vendorNumbers.join(', '));
    setEditType(item.type);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editItem) return;
    setEditLoading(true);
    try {
      const vendorNumbers = editVendorNums.split(',').map(v => v.trim()).filter(Boolean);
      const res = await authFetch('/api/control/clients', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editItem.id, name: editName, vendorNumbers, type: editType }),
      });
      if (!res.ok) { notify('Failed to update', 'error'); return; }
      notify('Client updated');
      setEditItem(null);
      fetchItems();
    } finally { setEditLoading(false); }
  }

  async function handleDelete(item: Client) {
    if (!confirm(`Delete ${item.name}?`)) return;
    const res = await authFetch(`/api/control/clients?id=${item.id}`, { method: 'DELETE' });
    if (res.ok) { notify('Client deleted'); fetchItems(); }
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
        name: row['Name'] || row['name'] || row['Client'] || row['Supplier'] || '',
        vendorNumbers: (row['Vendor Numbers'] || row['vendorNumbers'] || row['Vendor Number'] || '')
          .toString().split(',').map((v: string) => v.trim()).filter(Boolean),
        type: (row['Type'] || row['type'] || 'ASL').toUpperCase() as 'ASL' | 'NSL',
      })).filter(r => r.name);

      if (!records.length) { notify('No valid rows found in file', 'error'); return; }

      const res = await authFetch('/api/control/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(records),
      });
      const result = await res.json();
      if (res.ok) notify(`Imported ${result.added} clients`);
      else notify('Import failed', 'error');
      fetchItems();
    } catch (err) {
      notify('Failed to parse Excel file', 'error');
      console.error(err);
    }
    if (fileRef.current) fileRef.current.value = '';
  }

  const filtered = items.filter(i =>
    i.name.toLowerCase().includes(search.toLowerCase()) ||
    i.vendorNumbers.some(v => v.includes(search))
  );

  return (
    <div className="flex flex-col gap-6">
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <div className="bg-white rounded-xl shadow-sm border-l-4 border-[var(--color-primary)] px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Clients / Suppliers</h1>
          <p className="text-sm text-gray-500 mt-0.5">{items.length} records</p>
        </div>
        <div className="flex gap-2">
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleExcelUpload} className="hidden" />
          <button onClick={() => fileRef.current?.click()}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            Excel Upload
          </button>
        </div>
      </div>

      {/* Add Form */}
      <section className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-4">Add Client / Supplier</h2>
        <form onSubmit={handleAdd} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Name</label>
            <input value={addName} onChange={e => setAddName(e.target.value)} required
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
              placeholder="e.g. Genkem" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Vendor Numbers <span className="text-gray-400">(comma-separated)</span></label>
            <input value={addVendorNums} onChange={e => setAddVendorNums(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
              placeholder="e.g. 42, 1130" />
          </div>
          <div className="flex items-end gap-3">
            <div className="flex flex-col gap-1 flex-1">
              <label className="text-xs text-gray-500 font-medium">Type</label>
              <select value={addType} onChange={e => setAddType(e.target.value as 'ASL' | 'NSL')}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]">
                <option value="ASL">ASL</option>
                <option value="NSL">NSL</option>
              </select>
            </div>
            <button type="submit" disabled={addLoading}
              className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white text-sm font-bold px-5 py-2 rounded-lg transition-colors whitespace-nowrap">
              {addLoading ? 'Adding...' : 'Add'}
            </button>
          </div>
        </form>
      </section>

      {/* Search + Table */}
      <section className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-6 pb-0">
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by name or vendor number..."
            className="w-full max-w-sm border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
        </div>
        <div className="overflow-x-auto mt-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Vendor Numbers</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Type</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(item => (
                <tr key={item.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-3 font-medium">
                    <Link href={`/control-centre/clients/${item.id}`} className="text-[var(--color-primary)] hover:underline">
                      {item.name}
                    </Link>
                  </td>
                  <td className="px-6 py-3 text-gray-600">
                    <div className="flex flex-wrap gap-1">
                      {item.vendorNumbers.map((v, i) => (
                        <span key={i} className="bg-gray-100 text-gray-700 text-xs px-2 py-0.5 rounded">{v}</span>
                      ))}
                    </div>
                  </td>
                  <td className="px-6 py-3">
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                      item.type === 'ASL' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'
                    }`}>{item.type}</span>
                  </td>
                  <td className="px-6 py-3">
                    <div className="flex gap-2 justify-end">
                      <button onClick={() => openEdit(item)} className="text-xs text-blue-600 hover:text-blue-800 font-medium">Edit</button>
                      <button onClick={() => handleDelete(item)} className="text-xs text-red-500 hover:text-red-700 font-medium">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={4} className="px-6 py-8 text-center text-gray-400 text-sm">No records found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Edit Modal */}
      {editItem && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-base font-bold text-gray-900 mb-5">Edit Client / Supplier</h2>
            <form onSubmit={handleEdit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Name</label>
                <input value={editName} onChange={e => setEditName(e.target.value)} required
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Vendor Numbers (comma-separated)</label>
                <input value={editVendorNums} onChange={e => setEditVendorNums(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Type</label>
                <select value={editType} onChange={e => setEditType(e.target.value as 'ASL' | 'NSL')}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]">
                  <option value="ASL">ASL</option>
                  <option value="NSL">NSL</option>
                </select>
              </div>
              <div className="flex gap-3 pt-2">
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
