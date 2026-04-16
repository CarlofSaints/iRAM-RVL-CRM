'use client';

import { useEffect, useState, useRef } from 'react';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';
import * as XLSX from 'xlsx';

interface Store {
  id: string;
  name: string;
  siteCode: string;
  region: string;
  channel: string;
  managerName: string;
  managerPhone: string;
  linkedWarehouse: string;
  createdAt: string;
}

export default function StoresPage() {
  useAuth('manage_stores');
  const [items, setItems] = useState<Store[]>([]);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<ToastData | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [addName, setAddName] = useState('');
  const [addSiteCode, setAddSiteCode] = useState('');
  const [addRegion, setAddRegion] = useState('');
  const [addChannel, setAddChannel] = useState('Massbuild');
  const [addManager, setAddManager] = useState('');
  const [addPhone, setAddPhone] = useState('');
  const [addWarehouse, setAddWarehouse] = useState('');
  const [addLoading, setAddLoading] = useState(false);

  const [editItem, setEditItem] = useState<Store | null>(null);
  const [editName, setEditName] = useState('');
  const [editSiteCode, setEditSiteCode] = useState('');
  const [editRegion, setEditRegion] = useState('');
  const [editChannel, setEditChannel] = useState('');
  const [editManager, setEditManager] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editWarehouse, setEditWarehouse] = useState('');
  const [editLoading, setEditLoading] = useState(false);

  const notify = (message: string, type: 'success' | 'error' = 'success') => setToast({ message, type });

  async function fetchItems() {
    const res = await authFetch('/api/control/stores', { cache: 'no-store' });
    if (res.ok) setItems(await res.json());
  }

  useEffect(() => { fetchItems(); }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAddLoading(true);
    try {
      const res = await authFetch('/api/control/stores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: addName, siteCode: addSiteCode, region: addRegion,
          channel: addChannel, managerName: addManager, managerPhone: addPhone,
          linkedWarehouse: addWarehouse,
        }),
      });
      if (!res.ok) { notify('Failed to add store', 'error'); return; }
      notify('Store added');
      setAddName(''); setAddSiteCode(''); setAddRegion(''); setAddChannel('Massbuild');
      setAddManager(''); setAddPhone(''); setAddWarehouse('');
      fetchItems();
    } finally { setAddLoading(false); }
  }

  function openEdit(item: Store) {
    setEditItem(item);
    setEditName(item.name);
    setEditSiteCode(item.siteCode);
    setEditRegion(item.region);
    setEditChannel(item.channel);
    setEditManager(item.managerName);
    setEditPhone(item.managerPhone);
    setEditWarehouse(item.linkedWarehouse);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editItem) return;
    setEditLoading(true);
    try {
      const res = await authFetch('/api/control/stores', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editItem.id, name: editName, siteCode: editSiteCode, region: editRegion,
          channel: editChannel, managerName: editManager, managerPhone: editPhone,
          linkedWarehouse: editWarehouse,
        }),
      });
      if (!res.ok) { notify('Failed to update', 'error'); return; }
      notify('Store updated');
      setEditItem(null);
      fetchItems();
    } finally { setEditLoading(false); }
  }

  async function handleDelete(item: Store) {
    if (!confirm(`Delete ${item.name}?`)) return;
    const res = await authFetch(`/api/control/stores?id=${item.id}`, { method: 'DELETE' });
    if (res.ok) { notify('Store deleted'); fetchItems(); }
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
        name: row['Name'] || row['Store Name'] || row['name'] || '',
        siteCode: row['Site Code'] || row['siteCode'] || row['Store Code'] || '',
        region: row['Region'] || row['region'] || '',
        channel: row['Channel'] || row['channel'] || 'Massbuild',
        managerName: row['Manager'] || row['Manager Name'] || row['managerName'] || '',
        managerPhone: row['Phone'] || row['Manager Phone'] || row['managerPhone'] || '',
        linkedWarehouse: row['Warehouse'] || row['linkedWarehouse'] || '',
      })).filter(r => r.name);

      if (!records.length) { notify('No valid rows found', 'error'); return; }

      const res = await authFetch('/api/control/stores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(records),
      });
      const result = await res.json();
      if (res.ok) notify(`Imported ${result.added} stores`);
      else notify('Import failed', 'error');
      fetchItems();
    } catch { notify('Failed to parse file', 'error'); }
    if (fileRef.current) fileRef.current.value = '';
  }

  const filtered = items.filter(i =>
    i.name.toLowerCase().includes(search.toLowerCase()) ||
    i.siteCode.toLowerCase().includes(search.toLowerCase()) ||
    i.channel.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex flex-col gap-6">
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <div className="bg-white rounded-xl shadow-sm border-l-4 border-[var(--color-primary)] px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Stores</h1>
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
        <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-4">Add Store</h2>
        <form onSubmit={handleAdd} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Store Name</label>
            <input value={addName} onChange={e => setAddName(e.target.value)} required
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Site Code</label>
            <input value={addSiteCode} onChange={e => setAddSiteCode(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Region</label>
            <input value={addRegion} onChange={e => setAddRegion(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Channel</label>
            <input value={addChannel} onChange={e => setAddChannel(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
              placeholder="Massbuild, Makro..." />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Manager Name</label>
            <input value={addManager} onChange={e => setAddManager(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Manager Phone</label>
            <input value={addPhone} onChange={e => setAddPhone(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Linked Warehouse</label>
            <input value={addWarehouse} onChange={e => setAddWarehouse(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
              placeholder="GAU, KZN, WC, PE" />
          </div>
          <div className="flex items-end">
            <button type="submit" disabled={addLoading}
              className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white text-sm font-bold px-5 py-2 rounded-lg transition-colors">
              {addLoading ? 'Adding...' : 'Add Store'}
            </button>
          </div>
        </form>
      </section>

      {/* Table */}
      <section className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-6 pb-0">
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, code, or channel..."
            className="w-full max-w-sm border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
        </div>
        <div className="overflow-x-auto mt-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Site Code</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Channel</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Region</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Warehouse</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(item => (
                <tr key={item.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-3 font-medium text-gray-900">{item.name}</td>
                  <td className="px-6 py-3 text-gray-600 font-mono text-xs">{item.siteCode}</td>
                  <td className="px-6 py-3 text-gray-600">{item.channel}</td>
                  <td className="px-6 py-3 text-gray-600">{item.region}</td>
                  <td className="px-6 py-3 text-gray-600">{item.linkedWarehouse}</td>
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
            <h2 className="text-base font-bold text-gray-900 mb-5">Edit Store</h2>
            <form onSubmit={handleEdit} className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Store Name</label>
                <input value={editName} onChange={e => setEditName(e.target.value)} required
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Site Code</label>
                <input value={editSiteCode} onChange={e => setEditSiteCode(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Region</label>
                <input value={editRegion} onChange={e => setEditRegion(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Channel</label>
                <input value={editChannel} onChange={e => setEditChannel(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Manager Name</label>
                <input value={editManager} onChange={e => setEditManager(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Manager Phone</label>
                <input value={editPhone} onChange={e => setEditPhone(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1 col-span-2">
                <label className="text-xs text-gray-500 font-medium">Linked Warehouse</label>
                <input value={editWarehouse} onChange={e => setEditWarehouse(e.target.value)}
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
