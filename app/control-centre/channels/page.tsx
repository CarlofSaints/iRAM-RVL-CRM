'use client';

import { useEffect, useState } from 'react';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';

interface Channel {
  id: string;
  name: string;
  createdAt: string;
}

export default function ChannelsPage() {
  useAuth('manage_stores'); // channels gated under manage_stores
  const [items, setItems] = useState<Channel[]>([]);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<ToastData | null>(null);

  // Add form
  const [addName, setAddName] = useState('');
  const [addLoading, setAddLoading] = useState(false);

  // Edit modal
  const [editItem, setEditItem] = useState<Channel | null>(null);
  const [editName, setEditName] = useState('');
  const [editLoading, setEditLoading] = useState(false);

  // Store counts for "in use" badges
  const [storeCounts, setStoreCounts] = useState<Record<string, number>>({});

  const notify = (message: string, type: 'success' | 'error' = 'success') => setToast({ message, type });

  async function fetchAll() {
    const [cRes, sRes] = await Promise.all([
      authFetch('/api/control/channels', { cache: 'no-store' }),
      authFetch('/api/control/stores', { cache: 'no-store' }),
    ]);
    if (cRes.ok) setItems(await cRes.json());
    if (sRes.ok) {
      const stores: Array<{ channel: string }> = await sRes.json();
      const counts: Record<string, number> = {};
      for (const s of stores) {
        const key = s.channel?.toLowerCase() ?? '';
        if (key) counts[key] = (counts[key] || 0) + 1;
      }
      setStoreCounts(counts);
    }
  }

  useEffect(() => { fetchAll(); }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const name = addName.trim();
    if (!name) return;
    if (items.find(c => c.name.toLowerCase() === name.toLowerCase())) {
      notify('Channel already exists', 'error');
      return;
    }
    setAddLoading(true);
    try {
      const res = await authFetch('/api/control/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) { notify('Failed to add channel', 'error'); return; }
      notify('Channel added');
      setAddName('');
      fetchAll();
    } finally { setAddLoading(false); }
  }

  function openEdit(item: Channel) {
    setEditItem(item);
    setEditName(item.name);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editItem) return;
    const name = editName.trim();
    if (!name) { notify('Name cannot be empty', 'error'); return; }
    if (items.find(c => c.id !== editItem.id && c.name.toLowerCase() === name.toLowerCase())) {
      notify('Channel name already exists', 'error');
      return;
    }
    setEditLoading(true);
    try {
      const res = await authFetch('/api/control/channels', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editItem.id, name }),
      });
      if (!res.ok) { notify('Failed to update channel', 'error'); return; }
      const result = await res.json();
      const storeMsg = result.storesUpdated > 0 ? ` — ${result.storesUpdated} store${result.storesUpdated === 1 ? '' : 's'} updated` : '';
      notify(`Channel updated${storeMsg}`);
      setEditItem(null);
      fetchAll();
    } finally { setEditLoading(false); }
  }

  async function handleDelete(item: Channel) {
    const inUse = storeCounts[item.name.toLowerCase()] ?? 0;
    const msg = inUse > 0
      ? `Delete channel "${item.name}"? It is used by ${inUse} store${inUse === 1 ? '' : 's'}. Those stores will keep the channel name as plain text.`
      : `Delete channel "${item.name}"?`;
    if (!confirm(msg)) return;
    const res = await authFetch(`/api/control/channels?id=${item.id}`, { method: 'DELETE' });
    if (res.ok) { notify('Channel deleted'); fetchAll(); }
    else notify('Failed to delete', 'error');
  }

  const filtered = items
    .filter(i => i.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="flex flex-col gap-6">
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <div className="bg-white rounded-xl shadow-sm border-l-4 border-[var(--color-primary)] px-6 py-4 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Channels</h1>
          <p className="text-sm text-gray-500 mt-0.5">{items.length} channel{items.length === 1 ? '' : 's'} — used as dropdown source on stores</p>
        </div>
      </div>

      {/* Add Form */}
      <section className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-4">Add Channel</h2>
        <form onSubmit={handleAdd} className="flex gap-3 items-end">
          <div className="flex flex-col gap-1 flex-1 max-w-md">
            <label className="text-xs text-gray-500 font-medium">Channel Name</label>
            <input value={addName} onChange={e => setAddName(e.target.value)} required
              placeholder="e.g. MASSBUILD, GAME, BUILDERS"
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
          </div>
          <button type="submit" disabled={addLoading}
            className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white text-sm font-bold px-5 py-2 rounded-lg transition-colors">
            {addLoading ? 'Adding...' : 'Add Channel'}
          </button>
        </form>
      </section>

      {/* Table */}
      <section className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-6 pb-0">
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search channels..."
            className="w-full max-w-sm border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
        </div>
        <div className="overflow-x-auto mt-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Stores Using</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Created</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(item => {
                const inUse = storeCounts[item.name.toLowerCase()] ?? 0;
                return (
                  <tr key={item.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-3 font-medium text-gray-900">{item.name}</td>
                    <td className="px-6 py-3 text-gray-600">
                      {inUse > 0 ? (
                        <span className="inline-flex items-center gap-1 text-xs bg-green-50 text-green-700 px-2 py-0.5 rounded-full font-medium">
                          {inUse} store{inUse === 1 ? '' : 's'}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">Not in use</span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-gray-500 text-xs">
                      {item.createdAt ? new Date(item.createdAt).toLocaleDateString('en-GB') : '—'}
                    </td>
                    <td className="px-6 py-3">
                      <div className="flex gap-2 justify-end">
                        <button onClick={() => openEdit(item)} className="text-xs text-blue-600 hover:text-blue-800 font-medium">Edit</button>
                        <button onClick={() => handleDelete(item)} className="text-xs text-red-500 hover:text-red-700 font-medium">Delete</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={4} className="px-6 py-8 text-center text-gray-400 text-sm">No channels found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Edit Modal */}
      {editItem && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
            <h2 className="text-base font-bold text-gray-900 mb-5">Edit Channel</h2>
            <form onSubmit={handleEdit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Channel Name</label>
                <input value={editName} onChange={e => setEditName(e.target.value)} required autoFocus
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
