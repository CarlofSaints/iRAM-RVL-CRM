'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';

interface SlipDto {
  id: string;
  loadId: string;
  clientId: string;
  clientName: string;
  vendorNumber: string;
  siteCode: string;
  siteName: string;
  warehouse: string;
  totalQty: number;
  totalVal: number;
  status: string;
  receiptDate?: string;
  receiptValue?: string;
  receiptUpliftedById?: string;
  receiptUpliftedByName?: string;
  receiptStoreRef1?: string;
  receiptStoreRef2?: string;
  receiptStoreRef3?: string;
  receiptStoreRef4?: string;
  receiptBoxes?: ReceiptBox[];
  receiptedAt?: string;
  receiptedByName?: string;
}

interface ReceiptBox {
  id: string;
  stickerBarcode: string;
  numberOfBoxes: number;
  scannedAt: string;
}

interface RepDto {
  id: string;
  name: string;
  surname: string;
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return iso; }
}

function uuid(): string {
  return crypto.randomUUID();
}

export default function ReceiptCapturePage() {
  const { session } = useAuth('receipt_stock');
  const router = useRouter();
  const searchParams = useSearchParams();
  const scanInputRef = useRef<HTMLInputElement>(null);

  const slipId = searchParams.get('slipId') ?? '';
  const clientId = searchParams.get('clientId') ?? '';
  const loadId = searchParams.get('loadId') ?? '';

  const [toast, setToast] = useState<ToastData | null>(null);
  const notify = (message: string, type: 'success' | 'error' = 'success') =>
    setToast({ message, type });

  const [slip, setSlip] = useState<SlipDto | null>(null);
  const [reps, setReps] = useState<RepDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [completing, setCompleting] = useState(false);

  // Receipt form fields
  const [receiptDate, setReceiptDate] = useState('');
  const [receiptValue, setReceiptValue] = useState('');
  const [upliftedById, setUpliftedById] = useState('');
  const [upliftedByName, setUpliftedByName] = useState('');
  const [storeRef1, setStoreRef1] = useState('');
  const [storeRef2, setStoreRef2] = useState('');
  const [storeRef3, setStoreRef3] = useState('');
  const [storeRef4, setStoreRef4] = useState('');

  // Box scanning
  const [scanBarcode, setScanBarcode] = useState('');
  const [scanBoxCount, setScanBoxCount] = useState(1);
  const [scanLoading, setScanLoading] = useState(false);
  const [boxes, setBoxes] = useState<ReceiptBox[]>([]);

  const isReceipted = slip?.status === 'receipted';

  // ── Load slip + reps ──
  const loadData = useCallback(async () => {
    if (!session || !slipId) return;
    setLoading(true);
    try {
      const [slipsRes, repsRes] = await Promise.all([
        authFetch('/api/pick-slips', { cache: 'no-store' }),
        authFetch('/api/control/reps', { cache: 'no-store' }),
      ]);

      if (slipsRes.ok) {
        const data = await slipsRes.json();
        const found = (data.slips ?? []).find((s: SlipDto) => s.id === slipId);
        if (found) {
          setSlip(found);
          // Hydrate form from existing receipt data
          setReceiptDate(found.receiptDate ?? '');
          setReceiptValue(found.receiptValue ?? '');
          setUpliftedById(found.receiptUpliftedById ?? '');
          setUpliftedByName(found.receiptUpliftedByName ?? '');
          setStoreRef1(found.receiptStoreRef1 ?? '');
          setStoreRef2(found.receiptStoreRef2 ?? '');
          setStoreRef3(found.receiptStoreRef3 ?? '');
          setStoreRef4(found.receiptStoreRef4 ?? '');
          setBoxes(found.receiptBoxes ?? []);
        } else {
          notify('Pick slip not found', 'error');
        }
      }

      if (repsRes.ok) {
        const repsData = await repsRes.json();
        setReps(Array.isArray(repsData) ? repsData : []);
      }
    } catch {
      notify('Failed to load data', 'error');
    } finally {
      setLoading(false);
    }
  }, [session, slipId]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Rep dropdown change ──
  function onRepChange(repId: string) {
    setUpliftedById(repId);
    const rep = reps.find(r => r.id === repId);
    setUpliftedByName(rep ? `${rep.name} ${rep.surname}` : '');
  }

  // ── Save receipt data ──
  async function saveReceipt(currentBoxes?: ReceiptBox[]) {
    if (!slip) return;
    setSaving(true);
    try {
      const res = await authFetch('/api/receipts/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slipId: slip.id,
          clientId: slip.clientId,
          loadId: slip.loadId,
          date: receiptDate,
          value: receiptValue,
          upliftedById,
          upliftedByName,
          storeRef1,
          storeRef2,
          storeRef3,
          storeRef4,
          boxes: currentBoxes ?? boxes,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        if (data.linkErrors?.length > 0) {
          notify(`Saved with warnings: ${data.linkErrors.join('; ')}`, 'error');
        }
      } else {
        notify(data.error || 'Save failed', 'error');
      }
    } catch {
      notify('Network error saving', 'error');
    } finally {
      setSaving(false);
    }
  }

  // ── Scan barcode ──
  async function handleScan() {
    const barcode = scanBarcode.trim().toUpperCase();
    if (!barcode || !slip) return;

    // Check for duplicate
    if (boxes.some(b => b.stickerBarcode === barcode)) {
      notify('This barcode is already scanned on this slip', 'error');
      setScanBarcode('');
      scanInputRef.current?.focus();
      return;
    }

    setScanLoading(true);
    try {
      const res = await authFetch(`/api/receipts/lookup?barcode=${encodeURIComponent(barcode)}`, { cache: 'no-store' });
      const data = await res.json();

      if (!data.found) {
        notify(`Barcode "${barcode}" not found in the system`, 'error');
        setScanLoading(false);
        scanInputRef.current?.focus();
        return;
      }

      if (data.linkedPickSlipId && data.linkedPickSlipId !== slip.id) {
        notify(`Barcode is already linked to pick slip ${data.linkedPickSlipId}`, 'error');
        setScanLoading(false);
        scanInputRef.current?.focus();
        return;
      }

      const newBox: ReceiptBox = {
        id: uuid(),
        stickerBarcode: barcode,
        numberOfBoxes: scanBoxCount,
        scannedAt: new Date().toISOString(),
      };

      const updatedBoxes = [...boxes, newBox];
      setBoxes(updatedBoxes);
      setScanBarcode('');
      setScanBoxCount(1);

      // Auto-save after adding box
      await saveReceipt(updatedBoxes);
      notify(`Box ${barcode} added`);
    } catch {
      notify('Network error scanning barcode', 'error');
    } finally {
      setScanLoading(false);
      scanInputRef.current?.focus();
    }
  }

  // ── Delete box ──
  async function deleteBox(boxId: string) {
    const updatedBoxes = boxes.filter(b => b.id !== boxId);
    setBoxes(updatedBoxes);
    await saveReceipt(updatedBoxes);
  }

  // ── Complete receipt ──
  async function handleComplete() {
    if (!slip) return;
    if (boxes.length === 0) {
      notify('Scan at least one box before completing', 'error');
      return;
    }

    // Save first, then complete
    setCompleting(true);
    try {
      // Save current state
      await saveReceipt();

      // Then mark as receipted
      const res = await authFetch('/api/receipts/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slipId: slip.id,
          clientId: slip.clientId,
          loadId: slip.loadId,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        notify('Receipt completed successfully');
        router.push('/aged-stock/receipts');
      } else {
        notify(data.error || 'Failed to complete', 'error');
      }
    } catch {
      notify('Network error completing receipt', 'error');
    } finally {
      setCompleting(false);
    }
  }

  // Handle Enter key in scan input
  function onScanKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleScan();
    }
  }

  if (!session) return null;
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 border-4 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (!slip) {
    return (
      <div className="text-center py-20">
        <p className="text-gray-500 mb-4">Pick slip not found</p>
        <button onClick={() => router.push('/aged-stock/receipts')} className="text-[var(--color-primary)] hover:underline text-sm">
          Back to Box Receipts
        </button>
      </div>
    );
  }

  return (
    <>
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Warehouse Box Receipts</h1>
          <p className="text-sm text-gray-600 mt-1">
            {isReceipted
              ? `Receipted on ${fmtDate(slip.receiptedAt!)} by ${slip.receiptedByName}`
              : 'Scan sticker barcodes to receipt stock into the warehouse'}
          </p>
        </div>
        <button
          onClick={() => router.push('/aged-stock/receipts')}
          className="px-3 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
        >
          Back
        </button>
      </div>

      {/* Pre-filled pick slip info (read-only) */}
      <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
        <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Pick Slip Details</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-gray-500 text-xs block">Principal</span>
            <span className="font-medium">{slip.clientName}</span>
          </div>
          <div>
            <span className="text-gray-500 text-xs block">Vendor Number</span>
            <span className="font-medium">{slip.vendorNumber}</span>
          </div>
          <div>
            <span className="text-gray-500 text-xs block">Document No</span>
            <span className="font-mono font-medium">{slip.id}</span>
          </div>
          <div>
            <span className="text-gray-500 text-xs block">Store</span>
            <span className="font-medium">{slip.siteName} - {slip.siteCode}</span>
          </div>
          <div>
            <span className="text-gray-500 text-xs block">Warehouse</span>
            <span className="font-medium">{slip.warehouse}</span>
          </div>
          <div>
            <span className="text-gray-500 text-xs block">Total Qty</span>
            <span className="font-medium">{slip.totalQty.toLocaleString()}</span>
          </div>
          <div>
            <span className="text-gray-500 text-xs block">Total Value</span>
            <span className="font-medium">R {slip.totalVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </div>
          <div>
            <span className="text-gray-500 text-xs block">Status</span>
            <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
              slip.status === 'receipted' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'
            }`}>
              {slip.status.charAt(0).toUpperCase() + slip.status.slice(1)}
            </span>
          </div>
        </div>
      </div>

      {/* Receipt details form */}
      <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
        <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Receipt Details</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs text-gray-600 mb-1">Date</label>
            <input
              type="date"
              value={receiptDate}
              onChange={e => setReceiptDate(e.target.value)}
              disabled={isReceipted}
              className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm disabled:bg-gray-50 disabled:text-gray-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Value</label>
            <input
              type="text"
              value={receiptValue}
              onChange={e => setReceiptValue(e.target.value)}
              placeholder="e.g. R 1,500.00"
              disabled={isReceipted}
              className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm disabled:bg-gray-50 disabled:text-gray-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Uplifted By</label>
            <select
              value={upliftedById}
              onChange={e => onRepChange(e.target.value)}
              disabled={isReceipted}
              className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm disabled:bg-gray-50 disabled:text-gray-500"
            >
              <option value="">Select rep...</option>
              {reps.map(r => (
                <option key={r.id} value={r.id}>{r.name} {r.surname}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Store Reference 1</label>
            <input
              type="text"
              value={storeRef1}
              onChange={e => setStoreRef1(e.target.value)}
              disabled={isReceipted}
              className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm disabled:bg-gray-50 disabled:text-gray-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Store Reference 2</label>
            <input
              type="text"
              value={storeRef2}
              onChange={e => setStoreRef2(e.target.value)}
              disabled={isReceipted}
              className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm disabled:bg-gray-50 disabled:text-gray-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Store Reference 3</label>
            <input
              type="text"
              value={storeRef3}
              onChange={e => setStoreRef3(e.target.value)}
              disabled={isReceipted}
              className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm disabled:bg-gray-50 disabled:text-gray-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Store Reference 4</label>
            <input
              type="text"
              value={storeRef4}
              onChange={e => setStoreRef4(e.target.value)}
              disabled={isReceipted}
              className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm disabled:bg-gray-50 disabled:text-gray-500"
            />
          </div>
        </div>

        {/* Manual save button for receipt details */}
        {!isReceipted && (
          <div className="mt-4 flex justify-end">
            <button
              onClick={() => saveReceipt()}
              disabled={saving}
              className="px-4 py-1.5 text-sm font-medium text-[var(--color-primary)] border border-[var(--color-primary)]/30 rounded-lg hover:bg-[var(--color-primary)]/5 disabled:opacity-50 flex items-center gap-2"
            >
              {saving && <div className="h-3.5 w-3.5 border-2 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin" />}
              Save Details
            </button>
          </div>
        )}
      </div>

      {/* Box scanning section */}
      <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
        <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Scanned Boxes</h2>

        {/* Scan input row */}
        {!isReceipted && (
          <div className="flex gap-3 mb-4 items-end">
            <div className="flex-1">
              <label className="block text-xs text-gray-600 mb-1">Scan Box Number</label>
              <input
                ref={scanInputRef}
                type="text"
                value={scanBarcode}
                onChange={e => setScanBarcode(e.target.value)}
                onKeyDown={onScanKeyDown}
                placeholder="STK-GAU-0001"
                className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm font-mono"
                autoFocus
              />
            </div>
            <div className="w-32">
              <label className="block text-xs text-gray-600 mb-1">Number of Boxes</label>
              <input
                type="number"
                min={1}
                value={scanBoxCount}
                onChange={e => setScanBoxCount(Math.max(1, Number(e.target.value) || 1))}
                className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm text-right"
              />
            </div>
            <button
              onClick={handleScan}
              disabled={scanLoading || !scanBarcode.trim()}
              className="px-4 py-1.5 bg-[var(--color-primary)] text-white rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
            >
              {scanLoading && <div className="h-3.5 w-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />}
              Add
            </button>
          </div>
        )}

        {/* Boxes table */}
        {boxes.length > 0 ? (
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold text-gray-600 uppercase tracking-wide border-b border-gray-200">
                <th className="pb-2">#</th>
                <th className="pb-2">Box Number</th>
                <th className="pb-2 text-right">No of Boxes</th>
                <th className="pb-2">Scanned At</th>
                {!isReceipted && <th className="pb-2 w-10"></th>}
              </tr>
            </thead>
            <tbody>
              {boxes.map((b, i) => (
                <tr key={b.id} className="border-t border-gray-100">
                  <td className="py-1.5 text-gray-400">{i + 1}</td>
                  <td className="py-1.5 font-mono font-medium">{b.stickerBarcode}</td>
                  <td className="py-1.5 text-right">{b.numberOfBoxes}</td>
                  <td className="py-1.5 text-xs text-gray-500">{fmtDate(b.scannedAt)}</td>
                  {!isReceipted && (
                    <td className="py-1.5 text-center">
                      <button
                        onClick={() => deleteBox(b.id)}
                        title="Remove"
                        className="text-red-400 hover:text-red-600"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-gray-300 font-bold">
                <td className="py-2" colSpan={2}>Total</td>
                <td className="py-2 text-right">{boxes.reduce((s, b) => s + b.numberOfBoxes, 0)}</td>
                <td></td>
                {!isReceipted && <td></td>}
              </tr>
            </tfoot>
          </table>
        ) : (
          <p className="text-center text-gray-400 text-sm py-6">
            {isReceipted ? 'No boxes were recorded' : 'No boxes scanned yet — use the input above to scan sticker barcodes'}
          </p>
        )}
      </div>

      {/* Action buttons */}
      {!isReceipted && (
        <div className="flex gap-3">
          <button
            onClick={handleComplete}
            disabled={completing || boxes.length === 0}
            className="px-5 py-2.5 bg-[var(--color-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {completing && <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            Complete Receipt
          </button>
          <button
            onClick={() => router.push('/aged-stock/receipts')}
            className="px-5 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
        </div>
      )}
    </>
  );
}
