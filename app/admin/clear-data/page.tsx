'use client';

import { useState } from 'react';
import Sidebar from '@/components/Sidebar';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';

interface ClearResult {
  agedStockLoads: number;
  pickSlipRuns: number;
  stickerBatches: number;
  auditMonths: number;
}

export default function ClearDataPage() {
  const { session, loading: authLoading, logout } = useAuth('manage_users');
  const [toast, setToast] = useState<ToastData | null>(null);

  // Module toggles
  const [agedStock, setAgedStock] = useState(false);
  const [pickSlips, setPickSlips] = useState(false);
  const [stickers, setStickers] = useState(false);
  const [auditLog, setAuditLog] = useState(false);

  // Cascade toggles
  const [cascadeAgedStockPickSlips, setCascadeAgedStockPickSlips] = useState(false);
  const [cascadePickSlipStickers, setCascadePickSlipStickers] = useState(false);

  // Confirmation modal
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  // Results
  const [clearing, setClearing] = useState(false);
  const [result, setResult] = useState<ClearResult | null>(null);

  const notify = (message: string, type: 'success' | 'error' = 'success') =>
    setToast({ message, type });

  // Derived: is pick slips already covered by aged stock cascade?
  const pickSlipsCoveredByCascade = agedStock && cascadeAgedStockPickSlips;
  // Derived: is stickers already covered by cascade?
  const stickersCoveredByCascade =
    (pickSlipsCoveredByCascade || pickSlips) && cascadePickSlipStickers;

  const anythingSelected = agedStock || pickSlips || stickers || auditLog;

  function handleClearClick() {
    if (!anythingSelected) return;
    setConfirmText('');
    setShowConfirm(true);
  }

  async function handleConfirm() {
    if (confirmText !== 'CLEAR') return;
    setShowConfirm(false);
    setClearing(true);
    setResult(null);
    try {
      const res = await authFetch('/api/admin/clear-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modules: {
            agedStock,
            pickSlips: pickSlips && !pickSlipsCoveredByCascade,
            stickers: stickers && !stickersCoveredByCascade,
            auditLog,
          },
          cascade: {
            agedStockPickSlips: cascadeAgedStockPickSlips,
            pickSlipStickers: cascadePickSlipStickers,
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
      // Reset checkboxes
      setAgedStock(false);
      setPickSlips(false);
      setStickers(false);
      setAuditLog(false);
      setCascadeAgedStockPickSlips(false);
      setCascadePickSlipStickers(false);
    } catch {
      notify('Network error — please try again', 'error');
    } finally {
      setClearing(false);
    }
  }

  if (authLoading || !session) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      <Sidebar session={session} onLogout={logout} />
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <main className="ml-64 px-8 py-8">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900">Clear Data</h1>
          <p className="text-sm text-gray-600 mt-1">
            Selectively clear operational data from the system
          </p>
        </div>

        {/* Warning banner */}
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 flex items-start gap-3">
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

        <div className="grid gap-4 max-w-2xl">
          {/* Card 1: Aged Stock Loads */}
          <div className={`bg-white rounded-lg border p-5 ${agedStock ? 'border-red-300 ring-1 ring-red-200' : 'border-gray-200'}`}>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={agedStock}
                onChange={e => {
                  setAgedStock(e.target.checked);
                  if (!e.target.checked) {
                    setCascadeAgedStockPickSlips(false);
                  }
                }}
                className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
              />
              <div>
                <span className="font-semibold text-gray-900">Clear all aged stock loads</span>
                <p className="text-xs text-gray-500 mt-0.5">Removes all uploaded aged stock data for every client</p>
              </div>
            </label>
            {agedStock && (
              <div className="ml-7 mt-3 flex flex-col gap-2">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={cascadeAgedStockPickSlips}
                    onChange={e => {
                      setCascadeAgedStockPickSlips(e.target.checked);
                      if (!e.target.checked) {
                        setCascadePickSlipStickers(false);
                      }
                    }}
                    className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                  />
                  <span className="text-sm text-gray-700">Also delete associated pick slips</span>
                </label>
                {cascadeAgedStockPickSlips && (
                  <label className="flex items-center gap-3 cursor-pointer ml-7">
                    <input
                      type="checkbox"
                      checked={cascadePickSlipStickers}
                      onChange={e => setCascadePickSlipStickers(e.target.checked)}
                      className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                    />
                    <span className="text-sm text-gray-700">Also delete associated sticker batches</span>
                  </label>
                )}
              </div>
            )}
          </div>

          {/* Card 2: Pick Slips */}
          <div className={`bg-white rounded-lg border p-5 ${pickSlipsCoveredByCascade ? 'opacity-50' : ''} ${pickSlips && !pickSlipsCoveredByCascade ? 'border-red-300 ring-1 ring-red-200' : 'border-gray-200'}`}>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={pickSlips || pickSlipsCoveredByCascade}
                disabled={pickSlipsCoveredByCascade}
                onChange={e => {
                  setPickSlips(e.target.checked);
                  if (!e.target.checked) {
                    setCascadePickSlipStickers(false);
                  }
                }}
                className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500 disabled:opacity-50"
              />
              <div>
                <span className="font-semibold text-gray-900">Clear all pick slip runs</span>
                {pickSlipsCoveredByCascade && (
                  <span className="ml-2 text-xs text-amber-600 font-medium">(included via cascade above)</span>
                )}
                <p className="text-xs text-gray-500 mt-0.5">Removes all pick slip data including manual captures</p>
              </div>
            </label>
            {(pickSlips && !pickSlipsCoveredByCascade) && (
              <div className="ml-7 mt-3">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={cascadePickSlipStickers}
                    onChange={e => setCascadePickSlipStickers(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                  />
                  <span className="text-sm text-gray-700">Also delete associated sticker batches</span>
                </label>
              </div>
            )}
          </div>

          {/* Card 3: Sticker Batches */}
          <div className={`bg-white rounded-lg border p-5 ${stickersCoveredByCascade ? 'opacity-50' : ''} ${stickers && !stickersCoveredByCascade ? 'border-red-300 ring-1 ring-red-200' : 'border-gray-200'}`}>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={stickers || stickersCoveredByCascade}
                disabled={stickersCoveredByCascade}
                onChange={e => setStickers(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500 disabled:opacity-50"
              />
              <div>
                <span className="font-semibold text-gray-900">Clear all sticker batches</span>
                {stickersCoveredByCascade && (
                  <span className="ml-2 text-xs text-amber-600 font-medium">(included via cascade above)</span>
                )}
                <p className="text-xs text-gray-500 mt-0.5">Removes all generated sticker labels and their link data</p>
              </div>
            </label>
          </div>

          {/* Card 4: Audit Log */}
          <div className={`bg-white rounded-lg border p-5 ${auditLog ? 'border-red-300 ring-1 ring-red-200' : 'border-gray-200'}`}>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={auditLog}
                onChange={e => setAuditLog(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
              />
              <div>
                <span className="font-semibold text-gray-900">Clear all audit log entries</span>
                <p className="text-xs text-gray-500 mt-0.5">Removes audit log data for the last 24 months</p>
              </div>
            </label>
          </div>
        </div>

        {/* Action button */}
        <div className="mt-6 max-w-2xl">
          <button
            onClick={handleClearClick}
            disabled={!anythingSelected || clearing}
            className="px-6 py-2.5 bg-red-600 text-white font-semibold rounded-lg hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {clearing ? 'Clearing...' : 'Clear Selected Data'}
          </button>
        </div>

        {/* Results panel */}
        {result && (
          <div className="mt-6 max-w-2xl bg-green-50 border border-green-200 rounded-lg p-5">
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
      </main>

      {/* Confirmation modal */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md mx-4">
            <h2 className="text-lg font-bold text-gray-900 mb-2">Confirm Data Deletion</h2>
            <p className="text-sm text-gray-600 mb-1">
              You are about to permanently delete:
            </p>
            <ul className="text-sm text-gray-700 mb-4 list-disc ml-5 space-y-0.5">
              {agedStock && <li>All aged stock loads</li>}
              {(pickSlipsCoveredByCascade || pickSlips) && <li>All pick slip runs</li>}
              {(stickersCoveredByCascade || stickers) && <li>All sticker batches</li>}
              {auditLog && <li>All audit log entries</li>}
            </ul>
            <p className="text-sm text-gray-600 mb-3">
              Type <strong className="text-red-600">CLEAR</strong> to confirm:
            </p>
            <input
              type="text"
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              placeholder="Type CLEAR"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500"
              autoFocus
              onKeyDown={e => {
                if (e.key === 'Enter' && confirmText === 'CLEAR') handleConfirm();
              }}
            />
            <div className="flex justify-end gap-3 mt-4">
              <button
                onClick={() => setShowConfirm(false)}
                className="px-4 py-2 text-sm text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                disabled={confirmText !== 'CLEAR'}
                className="px-4 py-2 text-sm text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Delete Permanently
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
