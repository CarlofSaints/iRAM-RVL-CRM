'use client';

import { useEffect, useState } from 'react';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';

interface Warehouse {
  id: string;
  name: string;
  code: string;
  region: string;
  createdAt: string;
}

export default function WarehousesPage() {
  useAuth('manage_warehouses');
  const [items, setItems] = useState<Warehouse[]>([]);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<ToastData | null>(null);

  const [addName, setAddName] = useState('');
  const [addCode, setAddCode] = useState('');
  const [addRegion, setAddRegion] = useState('');
  const [addLoading, setAddLoading] = useState(false);

  const [editItem, setEditItem] = useState<Warehouse | null>(null);
  const [editName, setEditName] = useState('');
  const [editCode, setEditCode] = useState('');
  const [editRegion, setEditRegion] = useState('');
  const [editLoading, setEditLoading] = useState(false);

  const notify = (message: string, type: 'success' | 'error' = 'success') => setToast({ message, type });

  async function fetchItems() {
    const res = await authFetch('/api/control/warehouses', { cache: 'no-store' });
    if (res.ok) setItems(await res.json());
  }

  useEffect(() => { fetchItems(); }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAddLoading(true);
    try {
      const res = await authFetch('/api/control/warehouses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: addName, code: addCode, region: addRegion }),
      });
      if (!res.ok) { notify('Failed to add warehouse', 'error'); return; }
      notify('Warehouse added');
      setAddName(''); setAddCode(''); setAddRegion('');
      fetchItems();
    } finally { setAddLoading(false); }
  }

  function openEdit(item: Warehouse) {
    setEditItem(item);
    setEditName(item.name);
    setEditCode(item.code);
    setEditRegion(item.region);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editItem) return;
    setEditLoading(true);
    try {
      const res = await authFetch('/api/control/warehouses', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editItem.id, name: editName, code: editCode, region: editRegion }),
      });
      if (!res.ok) { notify('Failed to update', 'error'); return; }
      notify('Warehouse updated');
      setEditItem(null);
      fetchItems();
    } finally { setEditLoading(false); }
  }

  async function handleDelete(item: Warehouse) {
    if (!confirm(`Delete warehouse ${item.name} (${item.code})?`)) return;
    const res = await authFetch(`/api/control/warehouses?id=${item.id}`, { method: 'DELETE' });
    if (res.ok) { notify('Warehouse deleted'); fetchItems(); }
    else notify('Failed to delete', 'error');
  }

  const filtered = items.filter(i =>
    i.name.toLowerCase().includes(search.toLowerCase()) ||
    i.code.toLowerCase().includes(search.toLowerCase()) ||
    i.region.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex flex-col gap-6">
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <div className="bg-white rounded-xl shadow-sm border-l-4 border-[var(--color-primary)] px-6 py-4">
        <h1 className="text-xl font-bold text-gray-900">Warehouses</h1>
        <p className="text-sm text-gray-500 mt-0.5">{items.length} records</p>
      </div>

      {/* Add Form */}
      <section className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-4">Add Warehouse</h2>
        <form onSubmit={handleAdd} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Name</label>
            <input value={addName} onChange={e => setAddName(e.target.value)} required
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
              placeholder="e.g. Gauteng" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Code</label>
            <input value={addCode} onChange={e => setAddCode(e.target.value)} required
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
              placeholder="e.g. GAU" />
          </div>
          <div className="flex items-end gap-3">
            <div className="flex flex-col gap-1 flex-1">
              <label className="text-xs text-gray-500 font-medium">Region</label>
              <input value={addRegion} onChange={e => setAddRegion(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                placeholder="e.g. Gauteng" />
            </div>
            <button type="submit" disabled={addLoading}
              className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white text-sm font-bold px-5 py-2 rounded-lg transition-colors whitespace-nowrap">
              {addLoading ? 'Adding...' : 'Add'}
            </button>
          </div>
        </form>
      </section>

      {/* Table */}
      <section className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-6 pb-0">
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search..."
            className="w-full max-w-sm border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
        </div>
        <div className="overflow-x-auto mt-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Code</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Region</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(item => (
                <tr key={item.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-3 font-medium text-gray-900">{item.name}</td>
                  <td className="px-6 py-3">
                    <span className="bg-[var(--color-primary-light)] text-[var(--color-primary-dark)] text-xs font-bold px-2 py-0.5 rounded">
                      {item.code}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-gray-600">{item.region}</td>
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
            <h2 className="text-base font-bold text-gray-900 mb-5">Edit Warehouse</h2>
            <form onSubmit={handleEdit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Name</label>
                <input value={editName} onChange={e => setEditName(e.target.value)} required
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Code</label>
                <input value={editCode} onChange={e => setEditCode(e.target.value)} required
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Region</label>
                <input value={editRegion} onChange={e => setEditRegion(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
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
