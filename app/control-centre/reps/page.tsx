'use client';

import { useEffect, useState, useRef } from 'react';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';
import * as XLSX from 'xlsx';

interface Rep {
  id: string;
  name: string;
  surname: string;
  phone: string;
  email: string;
  region: string;
  releaseCode?: string;
  createdAt: string;
}

export default function RepsPage() {
  useAuth('manage_reps');
  const [items, setItems] = useState<Rep[]>([]);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<ToastData | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [addName, setAddName] = useState('');
  const [addSurname, setAddSurname] = useState('');
  const [addPhone, setAddPhone] = useState('');
  const [addEmail, setAddEmail] = useState('');
  const [addRegion, setAddRegion] = useState('');
  const [addReleaseCode, setAddReleaseCode] = useState('');
  const [addAsUser, setAddAsUser] = useState(false);
  const [addLoading, setAddLoading] = useState(false);

  const DEFAULT_REP_PASSWORD = 'rvl2026';

  const [editItem, setEditItem] = useState<Rep | null>(null);
  const [editName, setEditName] = useState('');
  const [editSurname, setEditSurname] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editRegion, setEditRegion] = useState('');
  const [editReleaseCode, setEditReleaseCode] = useState('');
  const [editLoading, setEditLoading] = useState(false);

  const notify = (message: string, type: 'success' | 'error' = 'success') => setToast({ message, type });

  async function fetchItems() {
    const res = await authFetch('/api/control/reps', { cache: 'no-store' });
    if (res.ok) setItems(await res.json());
  }

  useEffect(() => { fetchItems(); }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (addAsUser && !addEmail.trim()) {
      notify('Email is required when adding as a user', 'error');
      return;
    }
    setAddLoading(true);
    try {
      const res = await authFetch('/api/control/reps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: addName, surname: addSurname, phone: addPhone, email: addEmail, region: addRegion, releaseCode: addReleaseCode.toUpperCase() || undefined }),
      });
      if (!res.ok) { notify('Failed to add rep', 'error'); return; }

      if (addAsUser) {
        const userRes = await authFetch('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: addName,
            surname: addSurname,
            email: addEmail,
            password: DEFAULT_REP_PASSWORD,
            role: 'rep',
            forcePasswordChange: true,
            sendWelcome: true,
          }),
        });
        if (userRes.ok) {
          notify('Rep added and user account created — welcome email sent');
        } else {
          const err = await userRes.json().catch(() => ({}));
          notify(`Rep added, but user creation failed: ${err.error || 'unknown error'}`, 'error');
        }
      } else {
        notify('Rep added');
      }

      setAddName(''); setAddSurname(''); setAddPhone(''); setAddEmail(''); setAddRegion('');
      setAddReleaseCode(''); setAddAsUser(false);
      fetchItems();
    } finally { setAddLoading(false); }
  }

  function openEdit(item: Rep) {
    setEditItem(item);
    setEditName(item.name);
    setEditSurname(item.surname);
    setEditPhone(item.phone);
    setEditEmail(item.email);
    setEditRegion(item.region);
    setEditReleaseCode(item.releaseCode ?? '');
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editItem) return;
    setEditLoading(true);
    try {
      const res = await authFetch('/api/control/reps', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editItem.id, name: editName, surname: editSurname, phone: editPhone, email: editEmail, region: editRegion, releaseCode: editReleaseCode.toUpperCase() || undefined }),
      });
      if (!res.ok) { notify('Failed to update', 'error'); return; }
      notify('Rep updated');
      setEditItem(null);
      fetchItems();
    } finally { setEditLoading(false); }
  }

  async function handleDelete(item: Rep) {
    if (!confirm(`Delete ${item.name} ${item.surname}?`)) return;
    const res = await authFetch(`/api/control/reps?id=${item.id}`, { method: 'DELETE' });
    if (res.ok) { notify('Rep deleted'); fetchItems(); }
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
        name: row['Name'] || row['First Name'] || row['name'] || '',
        surname: row['Surname'] || row['Last Name'] || row['surname'] || '',
        phone: row['Phone'] || row['phone'] || row['Cell'] || '',
        email: row['Email'] || row['email'] || '',
        region: row['Region'] || row['region'] || '',
      })).filter(r => r.name);

      if (!records.length) { notify('No valid rows found', 'error'); return; }

      const res = await authFetch('/api/control/reps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(records),
      });
      const result = await res.json();
      if (res.ok) notify(`Imported ${result.added} reps`);
      else notify('Import failed', 'error');
      fetchItems();
    } catch { notify('Failed to parse file', 'error'); }
    if (fileRef.current) fileRef.current.value = '';
  }

  const filtered = items.filter(i =>
    `${i.name} ${i.surname}`.toLowerCase().includes(search.toLowerCase()) ||
    i.email.toLowerCase().includes(search.toLowerCase()) ||
    i.region.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex flex-col gap-6">
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <div className="bg-white rounded-xl shadow-sm border-l-4 border-[var(--color-primary)] px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Reps</h1>
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
        <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-4">Add Rep</h2>
        <form onSubmit={handleAdd} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">First Name</label>
            <input value={addName} onChange={e => setAddName(e.target.value)} required
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Surname</label>
            <input value={addSurname} onChange={e => setAddSurname(e.target.value)} required
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Phone</label>
            <input value={addPhone} onChange={e => setAddPhone(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Email{addAsUser && <span className="text-red-500"> *</span>}</label>
            <input type="email" value={addEmail} onChange={e => setAddEmail(e.target.value)} required={addAsUser}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Region</label>
            <input value={addRegion} onChange={e => setAddRegion(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Release Code</label>
            <input value={addReleaseCode} onChange={e => setAddReleaseCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
              maxLength={4} placeholder="e.g. AB12" pattern="[A-Z0-9]{4}"
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
            <span className="text-[10px] text-gray-400">4 chars, letters + digits. Used to verify stock release.</span>
          </div>
          <div className="sm:col-span-2 lg:col-span-3 flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-gray-100 mt-2">
            <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={addAsUser}
                onChange={e => setAddAsUser(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-[var(--color-primary)] focus:ring-[var(--color-primary)]"
              />
              <span>
                <span className="font-medium">Add as a user</span>
                <span className="block text-xs text-gray-500 mt-0.5">
                  Creates a portal user with the <strong>Rep</strong> role and emails them a welcome message with login details.
                </span>
              </span>
            </label>
            <button type="submit" disabled={addLoading}
              className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white text-sm font-bold px-5 py-2 rounded-lg transition-colors">
              {addLoading ? 'Adding...' : 'Add Rep'}
            </button>
          </div>
        </form>
      </section>

      {/* Table */}
      <section className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-6 pb-0">
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, email, or region..."
            className="w-full max-w-sm border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
        </div>
        <div className="overflow-x-auto mt-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Phone</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Email</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Region</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Release Code</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(item => (
                <tr key={item.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-3 font-medium text-gray-900">{item.name} {item.surname}</td>
                  <td className="px-6 py-3 text-gray-600">{item.phone}</td>
                  <td className="px-6 py-3 text-gray-600">{item.email}</td>
                  <td className="px-6 py-3 text-gray-600">{item.region}</td>
                  <td className="px-6 py-3 font-mono tracking-widest text-gray-600">{item.releaseCode || '—'}</td>
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
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-base font-bold text-gray-900 mb-5">Edit Rep</h2>
            <form onSubmit={handleEdit} className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">First Name</label>
                <input value={editName} onChange={e => setEditName(e.target.value)} required
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Surname</label>
                <input value={editSurname} onChange={e => setEditSurname(e.target.value)} required
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Phone</label>
                <input value={editPhone} onChange={e => setEditPhone(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Email</label>
                <input type="email" value={editEmail} onChange={e => setEditEmail(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Region</label>
                <input value={editRegion} onChange={e => setEditRegion(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Release Code</label>
                <input value={editReleaseCode} onChange={e => setEditReleaseCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
                  maxLength={4} placeholder="e.g. AB12" pattern="[A-Z0-9]{4}"
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
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
