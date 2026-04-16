'use client';

import { useEffect, useMemo, useState, use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';

interface SpLink {
  id: string;
  channel: string;
  vendorNumber: string;
  folderUrl: string;
  fileName: string;
  driveId?: string;
  fileId?: string;
  lastRefreshedAt?: string;
  lastRefreshError?: string;
  lastWriteAt?: string;
}

interface Client {
  id: string;
  name: string;
  vendorNumbers: string[];
  type: 'ASL' | 'NSL';
  createdAt: string;
  sharepointLinks?: SpLink[];
}

interface Channel { id: string; name: string }

function fmtDate(iso?: string) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

export default function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  useAuth(); // any logged-in user lands here; mutations are server-gated
  const router = useRouter();
  const [client, setClient] = useState<Client | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [links, setLinks] = useState<SpLink[]>([]);
  const [loadingPage, setLoadingPage] = useState(true);
  const [toast, setToast] = useState<ToastData | null>(null);

  // Add link form
  const [addChannel, setAddChannel] = useState('');
  const [addChannelOther, setAddChannelOther] = useState('');
  const [addVendor, setAddVendor] = useState('');
  const [addFolderUrl, setAddFolderUrl] = useState('');
  const [addFileName, setAddFileName] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [testLoading, setTestLoading] = useState(false);

  // Edit link
  const [editLink, setEditLink] = useState<SpLink | null>(null);
  const [editChannel, setEditChannel] = useState('');
  const [editVendor, setEditVendor] = useState('');
  const [editFolderUrl, setEditFolderUrl] = useState('');
  const [editFileName, setEditFileName] = useState('');
  const [editLoading, setEditLoading] = useState(false);

  // Per-row refreshing state
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({});

  const notify = (message: string, type: 'success' | 'error' = 'success') => setToast({ message, type });

  const channelOptions = useMemo(
    () => [...channels].sort((a, b) => a.name.localeCompare(b.name)),
    [channels]
  );

  async function fetchAll() {
    setLoadingPage(true);
    try {
      const [clientsRes, channelsRes, linksRes] = await Promise.all([
        authFetch('/api/control/clients', { cache: 'no-store' }),
        authFetch('/api/control/channels', { cache: 'no-store' }),
        authFetch(`/api/clients/${id}/sp-links`, { cache: 'no-store' }),
      ]);
      if (clientsRes.ok) {
        const all: Client[] = await clientsRes.json();
        setClient(all.find(c => c.id === id) ?? null);
      }
      if (channelsRes.ok) setChannels(await channelsRes.json());
      if (linksRes.ok) setLinks(await linksRes.json());
    } finally {
      setLoadingPage(false);
    }
  }

  useEffect(() => { fetchAll(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  // Default the vendor/channel pickers once data loads
  useEffect(() => {
    if (!addVendor && client?.vendorNumbers?.length) setAddVendor(client.vendorNumbers[0]);
  }, [client, addVendor]);
  useEffect(() => {
    if (!addChannel && channelOptions.length > 0) setAddChannel(channelOptions[0].name);
  }, [channelOptions, addChannel]);

  function resolvedChannelName(): string {
    return addChannel === '__other__' ? addChannelOther.trim() : addChannel.trim();
  }

  async function handleTestConnection() {
    const channel = resolvedChannelName();
    if (!channel || !addVendor.trim() || !addFolderUrl.trim() || !addFileName.trim()) {
      notify('Fill all fields to test', 'error');
      return;
    }
    setTestLoading(true);
    try {
      const res = await authFetch(`/api/clients/${id}/sp-links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel, vendorNumber: addVendor.trim(),
          folderUrl: addFolderUrl.trim(), fileName: addFileName.trim(),
          dryRun: true,
        }),
      });
      const data = await res.json();
      if (res.ok) notify('Connection OK — file found in SharePoint');
      else notify(data.error ?? 'Connection failed', 'error');
    } finally {
      setTestLoading(false);
    }
  }

  async function handleAddLink(e: React.FormEvent) {
    e.preventDefault();
    const channel = resolvedChannelName();
    if (!channel) { notify('Channel is required', 'error'); return; }
    setAddLoading(true);
    try {
      const res = await authFetch(`/api/clients/${id}/sp-links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel, vendorNumber: addVendor.trim(),
          folderUrl: addFolderUrl.trim(), fileName: addFileName.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) { notify(data.error ?? 'Failed to add link', 'error'); return; }
      notify('SP link added');
      setAddChannelOther(''); setAddFolderUrl(''); setAddFileName('');
      await fetchAll();
    } finally {
      setAddLoading(false);
    }
  }

  async function handleRefresh(link: SpLink) {
    setRefreshing(s => ({ ...s, [link.id]: true }));
    try {
      const res = await authFetch(`/api/clients/${id}/sp-links/${link.id}/refresh`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        const errs = (data.errors as string[] | undefined)?.join('; ') ?? data.error ?? 'Refresh failed';
        notify(errs, 'error');
      } else {
        const warn = data.warnings?.length ? ` (${data.warnings.length} warning${data.warnings.length === 1 ? '' : 's'})` : '';
        notify(`Refreshed: +${data.added} ${data.updated} updated, ${data.removed} removed${warn}`);
      }
      await fetchAll();
    } finally {
      setRefreshing(s => ({ ...s, [link.id]: false }));
    }
  }

  function openEdit(link: SpLink) {
    setEditLink(link);
    setEditChannel(link.channel);
    setEditVendor(link.vendorNumber);
    setEditFolderUrl(link.folderUrl);
    setEditFileName(link.fileName);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editLink) return;
    setEditLoading(true);
    try {
      const res = await authFetch(`/api/clients/${id}/sp-links/${editLink.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: editChannel.trim(),
          vendorNumber: editVendor.trim(),
          folderUrl: editFolderUrl.trim(),
          fileName: editFileName.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) { notify(data.error ?? 'Failed to update', 'error'); return; }
      notify('SP link updated');
      setEditLink(null);
      await fetchAll();
    } finally {
      setEditLoading(false);
    }
  }

  async function handleDelete(link: SpLink) {
    if (!confirm(`Delete the SharePoint link for "${link.fileName}"? Local product cache for this link will also be removed.`)) return;
    const res = await authFetch(`/api/clients/${id}/sp-links/${link.id}`, { method: 'DELETE' });
    if (res.ok) { notify('Link deleted'); await fetchAll(); }
    else notify('Failed to delete', 'error');
  }

  if (loadingPage) return <p className="text-sm text-gray-500">Loading client…</p>;
  if (!client) return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <p className="text-sm text-gray-700">Client not found.</p>
      <button onClick={() => router.push('/control-centre/clients')}
        className="mt-3 text-sm text-blue-600 hover:underline">← Back to clients</button>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <div className="bg-white rounded-xl shadow-sm border-l-4 border-[var(--color-primary)] px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <Link href="/control-centre/clients" className="text-xs text-gray-500 hover:text-gray-700">← All clients</Link>
            <h1 className="text-xl font-bold text-gray-900 mt-1">{client.name}</h1>
            <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
              <span className={`font-semibold px-2 py-0.5 rounded-full ${
                client.type === 'ASL' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'
              }`}>{client.type}</span>
              <span>•</span>
              <span>Vendor #s: {client.vendorNumbers.join(', ') || '—'}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Add link form */}
      <section className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-4">Add SharePoint Link</h2>
        <form onSubmit={handleAddLink} className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Channel</label>
            <select value={addChannel} onChange={e => setAddChannel(e.target.value)} required
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]">
              {channelOptions.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
              <option value="__other__">Other (type below)…</option>
            </select>
            {addChannel === '__other__' && (
              <input value={addChannelOther} onChange={e => setAddChannelOther(e.target.value)}
                placeholder="New channel name"
                className="mt-2 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
            )}
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Vendor #</label>
            {client.vendorNumbers.length > 0 ? (
              <select value={addVendor} onChange={e => setAddVendor(e.target.value)} required
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]">
                {client.vendorNumbers.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            ) : (
              <input value={addVendor} onChange={e => setAddVendor(e.target.value)} required
                placeholder="e.g. 42"
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
            )}
          </div>
          <div className="flex flex-col gap-1 md:col-span-2">
            <label className="text-xs text-gray-500 font-medium">SharePoint Folder URL</label>
            <input value={addFolderUrl} onChange={e => setAddFolderUrl(e.target.value)} required
              placeholder="https://iramsa.sharepoint.com/sites/.../Shared%20Documents/..."
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
            <p className="text-xs text-gray-400">Paste the URL of the folder that contains the product control file.</p>
          </div>
          <div className="flex flex-col gap-1 md:col-span-2">
            <label className="text-xs text-gray-500 font-medium">File Name</label>
            <input value={addFileName} onChange={e => setAddFileName(e.target.value)} required
              placeholder="e.g. GENKEM MASSBUILD - 42 - PRODUCT CONTROL FILE.xlsx"
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
          </div>
          <div className="md:col-span-2 flex gap-3">
            <button type="button" onClick={handleTestConnection} disabled={testLoading || addLoading}
              className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50">
              {testLoading ? 'Testing…' : 'Test Connection'}
            </button>
            <button type="submit" disabled={addLoading || testLoading}
              className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white text-sm font-bold px-5 py-2 rounded-lg">
              {addLoading ? 'Saving…' : 'Save Link'}
            </button>
          </div>
        </form>
      </section>

      {/* Links table */}
      <section className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">SharePoint Links</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Channel</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Vendor #</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">File</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Last Refreshed</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {links.map(l => (
                <tr key={l.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-3 font-medium text-gray-900">{l.channel}</td>
                  <td className="px-6 py-3 text-gray-600 font-mono text-xs">{l.vendorNumber}</td>
                  <td className="px-6 py-3 text-gray-700 text-xs max-w-md truncate" title={l.fileName}>{l.fileName}</td>
                  <td className="px-6 py-3 text-gray-600 text-xs">
                    <div>{fmtDate(l.lastRefreshedAt)}</div>
                    {l.lastRefreshError && (
                      <div className="text-red-600 mt-0.5 max-w-xs truncate" title={l.lastRefreshError}>⚠ {l.lastRefreshError}</div>
                    )}
                  </td>
                  <td className="px-6 py-3">
                    <div className="flex gap-3 justify-end">
                      <button onClick={() => handleRefresh(l)} disabled={!!refreshing[l.id]}
                        className="text-xs text-[var(--color-primary)] hover:underline font-medium disabled:opacity-50">
                        {refreshing[l.id] ? 'Refreshing…' : 'Refresh'}
                      </button>
                      <Link href={`/control-centre/products?clientId=${id}&linkId=${l.id}`}
                        className="text-xs text-blue-600 hover:underline font-medium">
                        View Products
                      </Link>
                      <button onClick={() => openEdit(l)} className="text-xs text-gray-700 hover:text-gray-900 font-medium">Edit</button>
                      <button onClick={() => handleDelete(l)} className="text-xs text-red-500 hover:text-red-700 font-medium">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
              {links.length === 0 && (
                <tr><td colSpan={5} className="px-6 py-8 text-center text-gray-400 text-sm">No SharePoint links yet — add one above.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Edit modal */}
      {editLink && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-xl p-6">
            <h2 className="text-base font-bold text-gray-900 mb-5">Edit SharePoint Link</h2>
            <form onSubmit={handleEdit} className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Channel</label>
                <input value={editChannel} onChange={e => setEditChannel(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Vendor #</label>
                <input value={editVendor} onChange={e => setEditVendor(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1 col-span-2">
                <label className="text-xs text-gray-500 font-medium">Folder URL</label>
                <input value={editFolderUrl} onChange={e => setEditFolderUrl(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1 col-span-2">
                <label className="text-xs text-gray-500 font-medium">File Name</label>
                <input value={editFileName} onChange={e => setEditFileName(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="col-span-2 flex gap-3 pt-2">
                <button type="submit" disabled={editLoading}
                  className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white text-sm font-bold px-5 py-2 rounded-lg">
                  {editLoading ? 'Saving…' : 'Save'}
                </button>
                <button type="button" onClick={() => setEditLink(null)}
                  className="text-sm text-gray-600 hover:text-gray-900 px-4 py-2 rounded-lg border border-gray-200 hover:bg-gray-50">
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
