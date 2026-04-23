'use client';

import { useEffect, useState, useMemo } from 'react';
import { useAuth, authFetch } from '@/lib/useAuth';
import { Toast, ToastData } from '@/components/Toast';

interface ClientDto {
  id: string;
  name: string;
  vendorNumbers: string[];
}

interface ChannelDto {
  id: string;
  name: string;
}

interface StoreDto {
  id: string;
  name: string;
  siteCode: string;
  channel: string;
  linkedWarehouse: string;
}

export default function ManualCapturePage() {
  const { session } = useAuth('manage_pick_slips');

  const [toast, setToast] = useState<ToastData | null>(null);
  const notify = (message: string, type: 'success' | 'error' = 'success') =>
    setToast({ message, type });

  const [clients, setClients] = useState<ClientDto[]>([]);
  const [channels, setChannels] = useState<ChannelDto[]>([]);
  const [stores, setStores] = useState<StoreDto[]>([]);
  const [loading, setLoading] = useState(true);

  // Form state
  const [selectedClient, setSelectedClient] = useState('');
  const [selectedChannel, setSelectedChannel] = useState('');
  const [selectedStores, setSelectedStores] = useState<Set<string>>(new Set());
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<{ generated: number; uploaded: number } | null>(null);

  // Load control data
  useEffect(() => {
    if (!session) return;
    setLoading(true);
    Promise.all([
      authFetch('/api/control/clients', { cache: 'no-store' })
        .then(r => r.ok ? r.json() : [])
        .then(data => setClients(Array.isArray(data) ? data : []))
        .catch(() => {}),
      authFetch('/api/control/channels', { cache: 'no-store' })
        .then(r => r.ok ? r.json() : [])
        .then(data => setChannels(Array.isArray(data) ? data : []))
        .catch(() => {}),
      authFetch('/api/control/stores', { cache: 'no-store' })
        .then(r => r.ok ? r.json() : [])
        .then(data => setStores(Array.isArray(data) ? data : []))
        .catch(() => {}),
    ]).finally(() => setLoading(false));
  }, [session]);

  // Filter stores by selected channel
  const filteredStores = useMemo(() => {
    if (!selectedChannel) return [];
    return stores.filter(s => s.channel === selectedChannel);
  }, [stores, selectedChannel]);

  // Reset stores when channel changes
  useEffect(() => {
    setSelectedStores(new Set());
  }, [selectedChannel]);

  const allStoresSelected = filteredStores.length > 0 && selectedStores.size === filteredStores.length;

  function toggleSelectAll() {
    if (allStoresSelected) {
      setSelectedStores(new Set());
    } else {
      setSelectedStores(new Set(filteredStores.map(s => s.id)));
    }
  }

  function toggleStore(storeId: string) {
    setSelectedStores(prev => {
      const next = new Set(prev);
      if (next.has(storeId)) next.delete(storeId);
      else next.add(storeId);
      return next;
    });
  }

  async function handleGenerate() {
    if (!selectedClient || !selectedChannel || selectedStores.size === 0) {
      notify('Select a vendor, channel, and at least one store', 'error');
      return;
    }

    setGenerating(true);
    setResult(null);
    try {
      const res = await authFetch('/api/pick-slips/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: selectedClient,
          storeIds: [...selectedStores],
          channel: selectedChannel,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setResult({ generated: data.generated, uploaded: data.uploaded });
        notify(`Generated ${data.generated} manual pick slip${data.generated !== 1 ? 's' : ''}`);
        if (data.uploadErrors?.length > 0) {
          notify(`Some uploads failed: ${data.uploadErrors.join('; ')}`, 'error');
        }
      } else {
        notify(data.error || 'Generation failed', 'error');
      }
    } catch {
      notify('Network error generating pick slips', 'error');
    } finally {
      setGenerating(false);
    }
  }

  if (!session) return null;

  return (
    <>
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Manual Capture</h1>
        <p className="text-sm text-gray-600 mt-1">
          Generate manual pick slips when a rep collects aged stock directly from a store without a pre-loaded aged stock file.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 border-4 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="space-y-6">
          {/* Vendor selection */}
          <div className="bg-white border border-gray-200 rounded-lg p-5">
            <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">1. Select Vendor</h2>
            <select
              value={selectedClient}
              onChange={e => setSelectedClient(e.target.value)}
              className="w-full max-w-md px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">Select a vendor...</option>
              {clients.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.vendorNumbers?.length ? ` - ${c.vendorNumbers.join(', ')}` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Channel selection */}
          <div className="bg-white border border-gray-200 rounded-lg p-5">
            <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">2. Select Channel</h2>
            <select
              value={selectedChannel}
              onChange={e => setSelectedChannel(e.target.value)}
              className="w-full max-w-md px-3 py-2 border border-gray-300 rounded-lg text-sm"
              disabled={!selectedClient}
            >
              <option value="">Select a channel...</option>
              {channels.map(ch => (
                <option key={ch.id} value={ch.name}>{ch.name}</option>
              ))}
            </select>
            {!selectedClient && (
              <p className="text-xs text-gray-400 mt-1">Select a vendor first</p>
            )}
          </div>

          {/* Store selection */}
          <div className="bg-white border border-gray-200 rounded-lg p-5">
            <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">
              3. Select Stores
              {selectedChannel && filteredStores.length > 0 && (
                <span className="ml-2 text-xs font-normal text-gray-500 normal-case">
                  {filteredStores.length} store{filteredStores.length !== 1 ? 's' : ''} in {selectedChannel}
                </span>
              )}
            </h2>

            {!selectedChannel ? (
              <p className="text-sm text-gray-400">Select a channel first</p>
            ) : filteredStores.length === 0 ? (
              <p className="text-sm text-gray-400">No stores found for channel &ldquo;{selectedChannel}&rdquo;</p>
            ) : (
              <>
                <label className="flex items-center gap-2 mb-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allStoresSelected}
                    onChange={toggleSelectAll}
                    className="rounded border-gray-300 text-[var(--color-primary)] focus:ring-[var(--color-primary)]"
                  />
                  <span className="text-sm font-medium text-gray-700">Select All</span>
                </label>

                <div className="max-h-64 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-100">
                  {filteredStores.map(s => (
                    <label key={s.id} className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedStores.has(s.id)}
                        onChange={() => toggleStore(s.id)}
                        className="rounded border-gray-300 text-[var(--color-primary)] focus:ring-[var(--color-primary)]"
                      />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-gray-900">{s.name}</span>
                        <span className="text-xs text-gray-500 ml-2">({s.siteCode})</span>
                      </div>
                      <span className="text-xs text-gray-400">{s.linkedWarehouse || 'No warehouse'}</span>
                    </label>
                  ))}
                </div>

                <div className="mt-2 text-xs text-gray-500">
                  {selectedStores.size} store{selectedStores.size !== 1 ? 's' : ''} selected
                </div>
              </>
            )}
          </div>

          {/* Generate button */}
          <div className="flex items-center gap-4">
            <button
              onClick={handleGenerate}
              disabled={generating || !selectedClient || !selectedChannel || selectedStores.size === 0}
              className="px-6 py-2.5 bg-[var(--color-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {generating && <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
              Generate Manual Pick Slips
            </button>

            {result && (
              <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-2 text-sm text-green-700">
                Generated <strong>{result.generated}</strong> pick slip{result.generated !== 1 ? 's' : ''}
                {result.uploaded > 0 && <> ({result.uploaded} uploaded to SharePoint)</>}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
