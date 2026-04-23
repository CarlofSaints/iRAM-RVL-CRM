'use client';

import { useEffect, useState, useRef, useMemo } from 'react';
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
  managerEmail: string;
  linkedWarehouse: string;
  createdAt: string;
}

interface Channel {
  id: string;
  name: string;
  createdAt: string;
}

/** Excel template column order — used by Download Template AND parser hints. */
const TEMPLATE_HEADERS = [
  'STORE NAME',
  'SITE CODE',
  'REGION',
  'CHANNEL',
  'MANAGER NAME',
  'MANAGER PHONE',
  'EMAIL',
  'LINKED WAREHOUSE',
] as const;

/**
 * Map a raw Excel row to a store record. Header lookup is case-insensitive
 * and tolerates the common variations seen in the wild (MANAGERPHONE without
 * space, "Store Name" vs "STORE NAME", etc).
 */
function rowToStore(row: Record<string, unknown>) {
  const norm: Record<string, unknown> = {};
  for (const k of Object.keys(row)) {
    norm[k.replace(/\s+/g, '').toLowerCase()] = row[k];
  }
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = norm[k.replace(/\s+/g, '').toLowerCase()];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  };
  return {
    name: pick('STORE NAME', 'Name', 'Store Name'),
    siteCode: pick('SITE CODE', 'Site Code', 'Store Code'),
    region: pick('REGION'),
    channel: pick('CHANNEL'),
    managerName: pick('MANAGER NAME', 'Manager Name', 'Manager'),
    // Excel will load phone as a number — we coerce above via String(v) so
    // leading zeros are still lost, but any string column survives intact.
    managerPhone: pick('MANAGER PHONE', 'MANAGERPHONE', 'Phone'),
    managerEmail: pick('EMAIL', 'Manager Email', 'MANAGEREMAIL'),
    linkedWarehouse: pick('LINKED WAREHOUSE', 'Warehouse'),
  };
}

export default function StoresPage() {
  useAuth('manage_stores');
  const [items, setItems] = useState<Store[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<ToastData | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Add form
  const [addName, setAddName] = useState('');
  const [addSiteCode, setAddSiteCode] = useState('');
  const [addRegion, setAddRegion] = useState('');
  const [addChannel, setAddChannel] = useState('');
  const [addManager, setAddManager] = useState('');
  const [addPhone, setAddPhone] = useState('');
  const [addEmail, setAddEmail] = useState('');
  const [addWarehouse, setAddWarehouse] = useState('');
  const [addLoading, setAddLoading] = useState(false);

  // Edit modal
  const [editItem, setEditItem] = useState<Store | null>(null);
  const [editName, setEditName] = useState('');
  const [editSiteCode, setEditSiteCode] = useState('');
  const [editRegion, setEditRegion] = useState('');
  const [editChannel, setEditChannel] = useState('');
  const [editManager, setEditManager] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editWarehouse, setEditWarehouse] = useState('');
  const [editLoading, setEditLoading] = useState(false);

  // Import modal
  type ImportMode = 'append' | 'update' | 'overwrite';
  const [importRecords, setImportRecords] = useState<ReturnType<typeof rowToStore>[]>([]);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [importStats, setImportStats] = useState({ newCount: 0, existingCount: 0, totalFile: 0, totalCurrent: 0 });

  // Channels manager
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [newChannel, setNewChannel] = useState('');
  const [channelEditingId, setChannelEditingId] = useState<string | null>(null);
  const [channelEditValue, setChannelEditValue] = useState('');

  const notify = (message: string, type: 'success' | 'error' = 'success') => setToast({ message, type });

  const channelOptions = useMemo(
    () => [...channels].sort((a, b) => a.name.localeCompare(b.name)),
    [channels],
  );

  async function fetchAll() {
    const [sRes, cRes] = await Promise.all([
      authFetch('/api/control/stores', { cache: 'no-store' }),
      authFetch('/api/control/channels', { cache: 'no-store' }),
    ]);
    if (sRes.ok) setItems(await sRes.json());
    if (cRes.ok) setChannels(await cRes.json());
  }

  useEffect(() => { fetchAll(); }, []);

  // Default the Add Channel dropdown to the first option once channels load
  useEffect(() => {
    if (!addChannel && channelOptions.length > 0) setAddChannel(channelOptions[0].name);
  }, [channelOptions, addChannel]);

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
          managerEmail: addEmail, linkedWarehouse: addWarehouse,
        }),
      });
      if (!res.ok) { notify('Failed to add store', 'error'); return; }
      notify('Store added');
      setAddName(''); setAddSiteCode(''); setAddRegion('');
      setAddManager(''); setAddPhone(''); setAddEmail(''); setAddWarehouse('');
      fetchAll();
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
    setEditEmail(item.managerEmail || '');
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
          managerEmail: editEmail, linkedWarehouse: editWarehouse,
        }),
      });
      if (!res.ok) { notify('Failed to update', 'error'); return; }
      notify('Store updated');
      setEditItem(null);
      fetchAll();
    } finally { setEditLoading(false); }
  }

  async function handleDelete(item: Store) {
    if (!confirm(`Delete ${item.name}?`)) return;
    const res = await authFetch(`/api/control/stores?id=${item.id}`, { method: 'DELETE' });
    if (res.ok) { notify('Store deleted'); fetchAll(); }
    else notify('Failed to delete', 'error');
  }

  /** Auto-add any channel names from an upload that don't already exist. */
  async function ensureChannelsExist(names: string[]) {
    const existing = new Set(channels.map(c => c.name.toLowerCase()));
    const toAdd = Array.from(new Set(names.filter(n => n && !existing.has(n.toLowerCase()))));
    if (toAdd.length === 0) return 0;
    const records = toAdd.map(name => ({ name }));
    const res = await authFetch('/api/control/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(records),
    });
    if (res.ok) return toAdd.length;
    return 0;
  }

  /** Step A: Parse the file and open the import mode modal. */
  async function handleExcelUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });

      const records = rows.map(rowToStore).filter(r => r.name);
      if (!records.length) { notify('No valid rows found', 'error'); return; }

      // Diff against current items by siteCode (case-insensitive)
      const existingCodes = new Set(items.map(s => s.siteCode.toLowerCase()).filter(Boolean));
      let newCount = 0;
      let existingCount = 0;
      for (const r of records) {
        if (r.siteCode && existingCodes.has(r.siteCode.toLowerCase())) existingCount++;
        else newCount++;
      }

      setImportRecords(records);
      setImportStats({ newCount, existingCount, totalFile: records.length, totalCurrent: items.length });
      setImportModalOpen(true);
    } catch (err) {
      console.error('[stores import]', err);
      notify('Failed to parse file', 'error');
    }
    if (fileRef.current) fileRef.current.value = '';
  }

  /** Step B: Execute the chosen import mode. */
  async function executeImport(mode: ImportMode) {
    setImportLoading(true);
    try {
      const records = importRecords;

      // Auto-create any new channel values
      const newChannelsAdded = await ensureChannelsExist(records.map(r => r.channel));
      const channelExtra = newChannelsAdded ? ` (+${newChannelsAdded} new channel${newChannelsAdded === 1 ? '' : 's'})` : '';

      if (mode === 'append') {
        // POST only records whose siteCode doesn't exist yet
        const existingCodes = new Set(items.map(s => s.siteCode.toLowerCase()).filter(Boolean));
        const toAdd = records.filter(r => !r.siteCode || !existingCodes.has(r.siteCode.toLowerCase()));
        if (toAdd.length === 0) {
          notify('No new stores to add — all site codes already exist');
          setImportModalOpen(false);
          return;
        }
        const res = await authFetch('/api/control/stores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(toAdd),
        });
        if (res.ok) {
          const result = await res.json();
          notify(`Appended ${result.added} new stores (${importStats.existingCount} duplicates skipped)${channelExtra}`);
        } else {
          notify('Import failed', 'error');
        }
      } else if (mode === 'update') {
        // Merge: for matched siteCode, spread file data over existing (keep id + createdAt); add unmatched as new
        const codeMap = new Map<string, Store>();
        for (const s of items) {
          if (s.siteCode) codeMap.set(s.siteCode.toLowerCase(), s);
        }
        const merged: (Store | Record<string, unknown>)[] = [...items]; // start with all existing
        const updatedIds = new Set<string>();
        let addedCount = 0;
        for (const r of records) {
          const key = r.siteCode?.toLowerCase();
          const existing = key ? codeMap.get(key) : undefined;
          if (existing) {
            // Update in place
            const idx = merged.findIndex((m) => (m as Store).id === existing.id);
            if (idx !== -1) {
              merged[idx] = { ...existing, ...r, id: existing.id, createdAt: existing.createdAt };
              updatedIds.add(existing.id);
            }
          } else {
            // New record
            merged.push({ ...r, id: crypto.randomUUID(), createdAt: new Date().toISOString() });
            addedCount++;
          }
        }
        const res = await authFetch('/api/control/stores', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(merged),
        });
        if (res.ok) {
          notify(`Updated ${updatedIds.size} stores, added ${addedCount} new${channelExtra}`);
        } else {
          notify('Import failed', 'error');
        }
      } else {
        // Overwrite — replace everything with file contents
        const now = new Date().toISOString();
        const fresh = records.map(r => ({ ...r, id: crypto.randomUUID(), createdAt: now }));
        const res = await authFetch('/api/control/stores', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fresh),
        });
        if (res.ok) {
          notify(`Replaced all stores with ${fresh.length} from file${channelExtra}`);
        } else {
          notify('Import failed', 'error');
        }
      }

      setImportModalOpen(false);
      setImportRecords([]);
      fetchAll();
    } catch (err) {
      console.error('[stores import]', err);
      notify('Import failed', 'error');
    } finally {
      setImportLoading(false);
    }
  }

  function handleDownloadTemplate() {
    // Headers-only worksheet
    const ws = XLSX.utils.aoa_to_sheet([[...TEMPLATE_HEADERS]]);
    // Reasonable column widths so headers are readable when opened
    ws['!cols'] = TEMPLATE_HEADERS.map(h => ({ wch: Math.max(14, h.length + 2) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Stores');
    XLSX.writeFile(wb, 'iRamFlow_Store_List_Template.xlsx');
  }

  // === Channels CRUD ===
  async function handleAddChannel(e: React.FormEvent) {
    e.preventDefault();
    const name = newChannel.trim();
    if (!name) return;
    if (channels.find(c => c.name.toLowerCase() === name.toLowerCase())) {
      notify('Channel already exists', 'error');
      return;
    }
    const res = await authFetch('/api/control/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) { notify('Failed to add channel', 'error'); return; }
    setNewChannel('');
    notify('Channel added');
    fetchAll();
  }

  function startChannelEdit(c: Channel) {
    setChannelEditingId(c.id);
    setChannelEditValue(c.name);
  }

  async function saveChannelEdit() {
    if (!channelEditingId) return;
    const name = channelEditValue.trim();
    if (!name) { notify('Name cannot be empty', 'error'); return; }
    const res = await authFetch('/api/control/channels', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: channelEditingId, name }),
    });
    if (!res.ok) { notify('Failed to update channel', 'error'); return; }
    const result = await res.json();
    setChannelEditingId(null);
    setChannelEditValue('');
    const storeMsg = result.storesUpdated > 0 ? ` — ${result.storesUpdated} store${result.storesUpdated === 1 ? '' : 's'} updated` : '';
    notify(`Channel updated${storeMsg}`);
    fetchAll();
  }

  async function handleDeleteChannel(c: Channel) {
    const inUseCount = items.filter(s => s.channel.toLowerCase() === c.name.toLowerCase()).length;
    const msg = inUseCount > 0
      ? `Delete channel "${c.name}"? It is currently used by ${inUseCount} store${inUseCount === 1 ? '' : 's'}. Their channel field will keep the name as plain text.`
      : `Delete channel "${c.name}"?`;
    if (!confirm(msg)) return;
    const res = await authFetch(`/api/control/channels?id=${c.id}`, { method: 'DELETE' });
    if (res.ok) { notify('Channel deleted'); fetchAll(); }
    else notify('Failed to delete', 'error');
  }

  const filtered = items.filter(i =>
    i.name.toLowerCase().includes(search.toLowerCase()) ||
    i.siteCode.toLowerCase().includes(search.toLowerCase()) ||
    i.channel.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex flex-col gap-6">
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <div className="bg-white rounded-xl shadow-sm border-l-4 border-[var(--color-primary)] px-6 py-4 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Stores</h1>
          <p className="text-sm text-gray-500 mt-0.5">{items.length} records</p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleDownloadTemplate}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            Download Template
          </button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleExcelUpload} className="hidden" />
          <button onClick={() => fileRef.current?.click()}
            className="px-4 py-2 text-sm bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white font-semibold rounded-lg transition-colors">
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
            <select value={addChannel} onChange={e => setAddChannel(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] bg-white">
              {channelOptions.length === 0 && <option value="">— Add a channel below —</option>}
              {channelOptions.map(c => (
                <option key={c.id} value={c.name}>{c.name}</option>
              ))}
            </select>
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
            <label className="text-xs text-gray-500 font-medium">Manager Email</label>
            <input type="email" value={addEmail} onChange={e => setAddEmail(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
              placeholder="manager@store.co.za" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Linked Warehouse</label>
            <input value={addWarehouse} onChange={e => setAddWarehouse(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
              placeholder="GAU, KZN, WC, PE" />
          </div>
          <div className="flex items-end sm:col-span-2 lg:col-span-4">
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
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Manager</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Email</th>
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
                  <td className="px-6 py-3 text-gray-600">{item.managerName}</td>
                  <td className="px-6 py-3 text-gray-600 text-xs">{item.managerEmail}</td>
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
                <tr><td colSpan={8} className="px-6 py-8 text-center text-gray-400 text-sm">No records found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Channels manager */}
      <section className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <button
          type="button"
          onClick={() => setChannelsOpen(v => !v)}
          className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-gray-50 transition-colors">
          <div>
            <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">Channels</h2>
            <p className="text-xs text-gray-500 mt-0.5">{channels.length} channel{channels.length === 1 ? '' : 's'} — used as the dropdown source on stores</p>
          </div>
          <svg className={`w-4 h-4 text-gray-400 transition-transform ${channelsOpen ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {channelsOpen && (
          <div className="px-6 pb-6 flex flex-col gap-4">
            <form onSubmit={handleAddChannel} className="flex gap-2">
              <input value={newChannel} onChange={e => setNewChannel(e.target.value)}
                placeholder="New channel name (e.g. MASSBUILD)"
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              <button type="submit"
                className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white text-sm font-bold px-4 py-2 rounded-lg transition-colors">
                Add Channel
              </button>
            </form>

            {channelOptions.length === 0 ? (
              <p className="text-sm text-gray-400 italic">No channels yet. Add your first channel above, or upload a store list — channels found in the upload will be added automatically.</p>
            ) : (
              <ul className="divide-y divide-gray-100 border border-gray-100 rounded-lg">
                {channelOptions.map(c => {
                  const inUseCount = items.filter(s => s.channel.toLowerCase() === c.name.toLowerCase()).length;
                  const isEditing = channelEditingId === c.id;
                  return (
                    <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      {isEditing ? (
                        <input
                          autoFocus
                          value={channelEditValue}
                          onChange={e => setChannelEditValue(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') saveChannelEdit(); if (e.key === 'Escape') setChannelEditingId(null); }}
                          className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
                      ) : (
                        <div className="flex items-center gap-3 flex-1">
                          <span className="text-sm font-medium text-gray-900">{c.name}</span>
                          <span className="text-xs text-gray-400">{inUseCount} store{inUseCount === 1 ? '' : 's'}</span>
                        </div>
                      )}
                      <div className="flex gap-3">
                        {isEditing ? (
                          <>
                            <button onClick={saveChannelEdit} className="text-xs text-[var(--color-primary)] hover:underline font-semibold">Save</button>
                            <button onClick={() => setChannelEditingId(null)} className="text-xs text-gray-500 hover:text-gray-700">Cancel</button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => startChannelEdit(c)} className="text-xs text-blue-600 hover:text-blue-800 font-medium">Edit</button>
                            <button onClick={() => handleDeleteChannel(c)} className="text-xs text-red-500 hover:text-red-700 font-medium">Delete</button>
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* Edit Modal */}
      {editItem && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
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
                <select value={editChannel} onChange={e => setEditChannel(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] bg-white">
                  {/* Allow keeping a value not in the channels list (legacy data) */}
                  {editChannel && !channelOptions.find(c => c.name === editChannel) && (
                    <option value={editChannel}>{editChannel} (legacy)</option>
                  )}
                  {channelOptions.map(c => (
                    <option key={c.id} value={c.name}>{c.name}</option>
                  ))}
                </select>
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
                <label className="text-xs text-gray-500 font-medium">Manager Email</label>
                <input type="email" value={editEmail} onChange={e => setEditEmail(e.target.value)}
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

      {/* Import Mode Modal */}
      {importModalOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-base font-bold text-gray-900 mb-1">Import Stores</h2>
            <p className="text-sm text-gray-500 mb-5">
              {importStats.totalFile} rows parsed from file — {importStats.existingCount} match existing site codes, {importStats.newCount} are new.
            </p>

            <div className="flex flex-col gap-3">
              {/* Append */}
              <button
                disabled={importLoading}
                onClick={() => executeImport('append')}
                className="text-left border border-gray-200 rounded-lg p-4 hover:border-[var(--color-primary)] hover:bg-green-50/30 transition-colors disabled:opacity-50">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-bold text-gray-900">Append</span>
                  <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">Safe</span>
                </div>
                <p className="text-xs text-gray-500">
                  Add only new stores, skip existing. <strong>{importStats.newCount} new</strong> will be added, {importStats.existingCount} duplicates skipped.
                </p>
              </button>

              {/* Update */}
              <button
                disabled={importLoading}
                onClick={() => executeImport('update')}
                className="text-left border border-gray-200 rounded-lg p-4 hover:border-[var(--color-primary)] hover:bg-blue-50/30 transition-colors disabled:opacity-50">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-bold text-gray-900">Update</span>
                  <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">Merge</span>
                </div>
                <p className="text-xs text-gray-500">
                  Update existing stores + add new ones. <strong>{importStats.existingCount} updated</strong>, {importStats.newCount} new added.
                </p>
              </button>

              {/* Overwrite */}
              <button
                disabled={importLoading}
                onClick={() => executeImport('overwrite')}
                className="text-left border border-red-200 rounded-lg p-4 hover:border-red-400 hover:bg-red-50/30 transition-colors disabled:opacity-50">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-bold text-gray-900">Overwrite</span>
                  <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">Destructive</span>
                </div>
                <p className="text-xs text-gray-500">
                  Replace ALL {importStats.totalCurrent} current stores with {importStats.totalFile} from file. Existing data will be lost.
                </p>
              </button>
            </div>

            <div className="flex justify-end mt-5">
              <button
                onClick={() => { setImportModalOpen(false); setImportRecords([]); }}
                disabled={importLoading}
                className="text-sm text-gray-600 hover:text-gray-900 px-4 py-2 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors disabled:opacity-50">
                Cancel
              </button>
            </div>
            {importLoading && (
              <p className="text-xs text-gray-400 mt-3 text-center">Importing...</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
