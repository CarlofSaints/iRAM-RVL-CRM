'use client';

import { useState, useEffect, useCallback } from 'react';
import Sidebar from '@/components/Sidebar';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';

// ── Types ────────────────────────────────────────────────────────────────────

interface LoadInfo {
  id: string;
  fileName: string;
  loadedAt: string;
  loadedByName: string;
  rowCount: number;
}

interface ClientInventory {
  id: string;
  name: string;
  vendorNumbers: string[];
  loads: LoadInfo[];
  pickSlipRunCount: number;
}

interface Inventory {
  clients: ClientInventory[];
  stickerBatchCount: number;
  auditMonthCount: number;
}

interface ClearResult {
  agedStockLoads: number;
  pickSlipRuns: number;
  stickerBatches: number;
  auditMonths: number;
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ClearDataPage() {
  const { session, loading: authLoading, logout } = useAuth('clear_data');
  const [toast, setToast] = useState<ToastData | null>(null);

  // Inventory
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [loadingInventory, setLoadingInventory] = useState(true);

  // Selection
  const [selectedClientId, setSelectedClientId] = useState('');
  const [selectedLoadIds, setSelectedLoadIds] = useState<Set<string>>(new Set());
  const [cascadePickSlips, setCascadePickSlips] = useState(false);
  const [cascadeStickers, setCascadeStickers] = useState(false);

  // Standalone bulk
  const [clearStickers, setClearStickers] = useState(false);
  const [clearAuditLog, setClearAuditLog] = useState(false);

  // Confirmation view
  const [showConfirm, setShowConfirm] = useState(false);
  const [deleteField, setDeleteField] = useState('');
  const [vendorField, setVendorField] = useState('');

  // Results
  const [clearing, setClearing] = useState(false);
  const [result, setResult] = useState<ClearResult | null>(null);

  const notify = (message: string, type: 'success' | 'error' = 'success') =>
    setToast({ message, type });

  // ── Fetch inventory ──────────────────────────────────────────────────────

  const fetchInventory = useCallback(async () => {
    setLoadingInventory(true);
    try {
      const res = await authFetch('/api/admin/clear-data/inventory', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load inventory');
      const data: Inventory = await res.json();
      setInventory(data);
    } catch {
      notify('Failed to load data inventory', 'error');
    } finally {
      setLoadingInventory(false);
    }
  }, []);

  useEffect(() => {
    if (!authLoading && session) fetchInventory();
  }, [authLoading, session, fetchInventory]);

  // ── Derived ──────────────────────────────────────────────────────────────

  const selectedClient = inventory?.clients.find(c => c.id === selectedClientId) ?? null;
  const vendorLabel = selectedClient
    ? `${selectedClient.name} - ${selectedClient.vendorNumbers.join(', ')}`
    : '';

  const hasLoadsSelected = selectedLoadIds.size > 0;
  const anythingSelected = hasLoadsSelected || clearStickers || clearAuditLog;

  // ── Handlers ─────────────────────────────────────────────────────────────

  function handleClientChange(clientId: string) {
    setSelectedClientId(clientId);
    setSelectedLoadIds(new Set());
    setCascadePickSlips(false);
    setCascadeStickers(false);
    setResult(null);
  }

  function toggleLoad(loadId: string) {
    setSelectedLoadIds(prev => {
      const next = new Set(prev);
      if (next.has(loadId)) next.delete(loadId);
      else next.add(loadId);
      return next;
    });
  }

  function toggleAllLoads() {
    if (!selectedClient) return;
    if (selectedLoadIds.size === selectedClient.loads.length) {
      setSelectedLoadIds(new Set());
    } else {
      setSelectedLoadIds(new Set(selectedClient.loads.map(l => l.id)));
    }
  }

  function handleClearClick() {
    if (!anythingSelected) return;
    setDeleteField('');
    setVendorField('');
    setShowConfirm(true);
  }

  function handleGoBack() {
    setShowConfirm(false);
    setDeleteField('');
    setVendorField('');
  }

  // Confirmation validation
  const deleteFieldValid = deleteField === 'DELETE';
  // Vendor field only required when loads are selected (vendor-scoped operation)
  const vendorFieldRequired = hasLoadsSelected;
  const vendorFieldValid = !vendorFieldRequired || vendorField === vendorLabel;
  const confirmEnabled = deleteFieldValid && vendorFieldValid;

  async function handleConfirm() {
    if (!confirmEnabled) return;
    setShowConfirm(false);
    setClearing(true);
    setResult(null);
    try {
      const res = await authFetch('/api/admin/clear-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: hasLoadsSelected ? selectedClientId : undefined,
          selectedLoadIds: hasLoadsSelected ? Array.from(selectedLoadIds) : undefined,
          modules: {
            agedStock: hasLoadsSelected,
            pickSlips: false,
            stickers: clearStickers,
            auditLog: clearAuditLog,
          },
          cascade: {
            agedStockPickSlips: cascadePickSlips,
            pickSlipStickers: cascadeStickers,
          },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        notify(err.error || 'Clear failed', 'error');
        return;
      }
      const data: ClearResult = await res.json();
      setResult(data);
      notify('Data cleared successfully', 'success');
      // Reset selections
      setSelectedLoadIds(new Set());
      setCascadePickSlips(false);
      setCascadeStickers(false);
      setClearStickers(false);
      setClearAuditLog(false);
      // Refresh inventory
      await fetchInventory();
      // If the selected client no longer has data, deselect
      const freshClient = inventory?.clients.find(c => c.id === selectedClientId);
      if (!freshClient || freshClient.loads.length === 0) {
        setSelectedClientId('');
      }
    } catch {
      notify('Network error — please try again', 'error');
    } finally {
      setClearing(false);
    }
  }

  if (authLoading || !session) return null;

  // ── Confirmation View ────────────────────────────────────────────────────

  if (showConfirm) {
    // Build summary bullets
    const bullets: string[] = [];
    if (hasLoadsSelected) {
      const count = selectedLoadIds.size;
      bullets.push(`${count} aged stock load${count > 1 ? 's' : ''} from ${selectedClient?.name ?? 'unknown'}`);
      if (cascadePickSlips) bullets.push('Associated pick slips for those loads');
      if (cascadeStickers) bullets.push('Associated sticker batches (all)');
    }
    if (clearStickers && !cascadeStickers) bullets.push('All sticker batches');
    if (clearAuditLog) bullets.push('All audit log entries');

    return (
      <div className="min-h-screen bg-gray-50">
        <Sidebar session={session} onLogout={logout} />
        {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

        <main className="ml-64 px-8 py-8">
          <div className="max-w-lg mx-auto">
            {/* Header */}
            <div className="mb-6">
              <h1 className="text-2xl font-bold text-gray-900">Confirm Data Deletion</h1>
              <p className="text-sm text-gray-500 mt-1">This action cannot be undone.</p>
            </div>

            {/* Warning banner */}
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 flex items-start gap-3">
              <svg className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <p className="text-sm font-semibold text-red-800">You are about to permanently delete:</p>
                <ul className="text-sm text-red-700 mt-1 list-disc ml-5 space-y-0.5">
                  {bullets.map((b, i) => <li key={i}>{b}</li>)}
                </ul>
              </div>
            </div>

            {/* Field 1: type DELETE */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Type <span className="font-bold text-red-600">DELETE</span> to proceed
              </label>
              <input
                type="text"
                value={deleteField}
                onChange={e => setDeleteField(e.target.value)}
                placeholder="DELETE"
                autoFocus
                className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 ${
                  deleteFieldValid
                    ? 'border-green-400 focus:ring-green-500 focus:border-green-500'
                    : 'border-gray-300 focus:ring-red-500 focus:border-red-500'
                }`}
              />
            </div>

            {/* Field 2: type vendor name & number (only when loads are selected) */}
            {vendorFieldRequired && (
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Type the vendor name &amp; number exactly:
                </label>
                <p className="text-xs font-mono bg-gray-100 border border-gray-200 rounded px-2 py-1 mb-2 text-gray-800 select-all">
                  {vendorLabel}
                </p>
                <input
                  type="text"
                  value={vendorField}
                  onChange={e => setVendorField(e.target.value)}
                  placeholder={vendorLabel}
                  className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 ${
                    vendorFieldValid && vendorField.length > 0
                      ? 'border-green-400 focus:ring-green-500 focus:border-green-500'
                      : 'border-gray-300 focus:ring-red-500 focus:border-red-500'
                  }`}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && confirmEnabled) handleConfirm();
                  }}
                />
              </div>
            )}

            {/* Buttons */}
            <div className="flex gap-3">
              <button
                onClick={handleGoBack}
                className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
              >
                Go Back
              </button>
              <button
                onClick={handleConfirm}
                disabled={!confirmEnabled}
                className="flex-1 px-4 py-2.5 text-sm font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                CONFIRM — Delete Permanently
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // ── Selection View ───────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50">
      <Sidebar session={session} onLogout={logout} />
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <main className="ml-64 px-8 py-8">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900">Clear Data</h1>
          <p className="text-sm text-gray-600 mt-1">
            Select a vendor and choose specific loads to delete
          </p>
        </div>

        {/* Warning banner */}
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 flex items-start gap-3 max-w-2xl">
          <svg className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <p className="text-sm font-semibold text-red-800">Destructive Action</p>
            <p className="text-sm text-red-700 mt-0.5">
              This permanently deletes data from the system. This action cannot be undone.
              Make sure you have exported any data you need before proceeding.
            </p>
          </div>
        </div>

        {loadingInventory ? (
          <div className="text-sm text-gray-500">Loading inventory...</div>
        ) : !inventory || inventory.clients.length === 0 ? (
          <div className="text-sm text-gray-500 bg-white rounded-lg border border-gray-200 p-6 max-w-2xl">
            No vendors with aged stock data found. There is nothing to clear.
          </div>
        ) : (
          <div className="max-w-2xl space-y-6">
            {/* ── Vendor Dropdown ─────────────────────────────────────── */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Select a vendor
              </label>
              <select
                value={selectedClientId}
                onChange={e => handleClientChange(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#7CC042] focus:border-[#7CC042]"
              >
                <option value="">— Choose a vendor —</option>
                {inventory.clients.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.name} - {c.vendorNumbers.join(', ')} ({c.loads.length} load{c.loads.length !== 1 ? 's' : ''})
                  </option>
                ))}
              </select>
            </div>

            {/* ── Load Checklist ──────────────────────────────────────── */}
            {selectedClient && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-sm font-semibold text-gray-800">
                    Loads for {selectedClient.name}
                  </h2>
                  <button
                    onClick={toggleAllLoads}
                    className="text-xs text-[#7CC042] hover:underline font-medium"
                  >
                    {selectedLoadIds.size === selectedClient.loads.length
                      ? 'Deselect All'
                      : 'Select All'}
                  </button>
                </div>

                <div className="space-y-2">
                  {selectedClient.loads.map(load => {
                    const checked = selectedLoadIds.has(load.id);
                    return (
                      <label
                        key={load.id}
                        className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                          checked
                            ? 'border-red-300 bg-red-50 ring-1 ring-red-200'
                            : 'border-gray-200 bg-white hover:border-gray-300'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleLoad(load.id)}
                          className="w-4 h-4 mt-0.5 rounded border-gray-300 text-red-600 focus:ring-red-500"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">
                            {load.fileName}
                          </p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {new Date(load.loadedAt).toLocaleDateString('en-GB', {
                              day: '2-digit',
                              month: 'short',
                              year: 'numeric',
                            })}
                            {' · '}
                            {load.rowCount.toLocaleString()} row{load.rowCount !== 1 ? 's' : ''}
                            {' · '}
                            by {load.loadedByName}
                          </p>
                        </div>
                      </label>
                    );
                  })}
                </div>

                {/* Cascade options — only when loads are selected */}
                {hasLoadsSelected && (
                  <div className="mt-3 ml-1 space-y-2">
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={cascadePickSlips}
                        onChange={e => {
                          setCascadePickSlips(e.target.checked);
                          if (!e.target.checked) setCascadeStickers(false);
                        }}
                        className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                      />
                      <span className="text-sm text-gray-700">
                        Also delete pick slips for selected loads
                        {selectedClient.pickSlipRunCount > 0 && (
                          <span className="text-xs text-gray-400 ml-1">
                            ({selectedClient.pickSlipRunCount} run{selectedClient.pickSlipRunCount !== 1 ? 's' : ''} total for this vendor)
                          </span>
                        )}
                      </span>
                    </label>
                    {cascadePickSlips && (
                      <label className="flex items-center gap-3 cursor-pointer ml-7">
                        <input
                          type="checkbox"
                          checked={cascadeStickers}
                          onChange={e => setCascadeStickers(e.target.checked)}
                          className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                        />
                        <span className="text-sm text-gray-700">Also delete sticker batches (all — not limited to selected vendor)</span>
                      </label>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── Standalone Bulk Sections ─────────────────────────────── */}
            <div className="border-t border-gray-200 pt-5">
              <h2 className="text-sm font-semibold text-gray-800 mb-3">
                Standalone (not limited to selected vendor)
              </h2>

              <div className="space-y-3">
                {/* Sticker Batches */}
                <div className={`bg-white rounded-lg border p-4 ${clearStickers ? 'border-red-300 ring-1 ring-red-200' : 'border-gray-200'}`}>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={clearStickers || cascadeStickers}
                      disabled={cascadeStickers}
                      onChange={e => setClearStickers(e.target.checked)}
                      className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500 disabled:opacity-50"
                    />
                    <div>
                      <span className="font-medium text-gray-900 text-sm">Clear all sticker batches</span>
                      {cascadeStickers && (
                        <span className="ml-2 text-xs text-amber-600 font-medium">(included via cascade above)</span>
                      )}
                      <p className="text-xs text-gray-500 mt-0.5">
                        {inventory.stickerBatchCount} batch{inventory.stickerBatchCount !== 1 ? 'es' : ''} in the system
                      </p>
                    </div>
                  </label>
                </div>

                {/* Audit Log */}
                <div className={`bg-white rounded-lg border p-4 ${clearAuditLog ? 'border-red-300 ring-1 ring-red-200' : 'border-gray-200'}`}>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={clearAuditLog}
                      onChange={e => setClearAuditLog(e.target.checked)}
                      className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                    />
                    <div>
                      <span className="font-medium text-gray-900 text-sm">Clear all audit log entries</span>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {inventory.auditMonthCount} month{inventory.auditMonthCount !== 1 ? 's' : ''} with entries
                      </p>
                    </div>
                  </label>
                </div>
              </div>
            </div>

            {/* ── Action button ───────────────────────────────────────── */}
            <div>
              <button
                onClick={handleClearClick}
                disabled={!anythingSelected || clearing}
                className="px-6 py-2.5 bg-red-600 text-white font-semibold rounded-lg hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {clearing ? 'Clearing...' : 'Clear Selected Data'}
              </button>
            </div>

            {/* ── Results panel ───────────────────────────────────────── */}
            {result && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-5">
                <h3 className="font-semibold text-green-800 mb-2">Clear Complete</h3>
                <ul className="text-sm text-green-700 space-y-1">
                  {result.agedStockLoads > 0 && (
                    <li>Aged stock loads deleted: <strong>{result.agedStockLoads}</strong></li>
                  )}
                  {result.pickSlipRuns > 0 && (
                    <li>Pick slip runs deleted: <strong>{result.pickSlipRuns}</strong></li>
                  )}
                  {result.stickerBatches > 0 && (
                    <li>Sticker batches deleted: <strong>{result.stickerBatches}</strong></li>
                  )}
                  {result.auditMonths > 0 && (
                    <li>Audit log months cleared: <strong>{result.auditMonths}</strong></li>
                  )}
                  {result.agedStockLoads === 0 &&
                    result.pickSlipRuns === 0 &&
                    result.stickerBatches === 0 &&
                    result.auditMonths === 0 && (
                    <li>No data was found to clear.</li>
                  )}
                </ul>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
