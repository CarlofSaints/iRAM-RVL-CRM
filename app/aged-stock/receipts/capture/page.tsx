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
  receiptQty?: string;
  receiptValue?: string;
  receiptTotalBoxes?: number;
  receiptUpliftedById?: string;
  receiptUpliftedByName?: string;
  receiptStoreRef1?: string;
  receiptStoreRef2?: string;
  receiptStoreRef3?: string;
  receiptStoreRef4?: string;
  receiptStoreRefs?: string[];
  receiptBoxes?: ReceiptBox[];
  receiptedAt?: string;
  receiptedByName?: string;
  releaseRepId?: string;
  releaseRepName?: string;
  releaseBoxes?: ReceiptBox[];
  releasedAt?: string;
  releasedByName?: string;
}

interface ReceiptBox {
  id: string;
  stickerBarcode: string;
  scannedAt: string;
}

interface RepDto {
  id: string;
  name: string;
  surname: string;
  releaseCode?: string;
}

type PageMode = 'receipt' | 'release' | 'view';

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return iso; }
}

function uuid(): string {
  return crypto.randomUUID();
}

function resolveMode(status: string): PageMode {
  if (status === 'receipted' || status === 'failed-release') return 'release';
  if (status === 'in-transit' || status === 'returned-to-vendor') return 'view';
  return 'receipt'; // generated, sent, picked
}

const STATUS_BADGE: Record<string, string> = {
  'generated': 'bg-gray-100 text-gray-700',
  'sent': 'bg-blue-100 text-blue-700',
  'picked': 'bg-amber-100 text-amber-700',
  'receipted': 'bg-green-100 text-green-700',
  'in-transit': 'bg-purple-100 text-purple-700',
  'returned-to-vendor': 'bg-red-100 text-red-700',
  'failed-release': 'bg-red-100 text-red-700',
};

const STATUS_LABEL: Record<string, string> = {
  'generated': 'Generated',
  'sent': 'Sent',
  'picked': 'Picked',
  'receipted': 'Receipted',
  'in-transit': 'In Transit',
  'returned-to-vendor': 'Returned to Vendor',
  'failed-release': 'Failed Release',
};

export default function ReceiptCapturePage() {
  const { session } = useAuth('receipt_stock');
  const router = useRouter();
  const searchParams = useSearchParams();
  const scanInputRef = useRef<HTMLInputElement>(null);
  const releaseScanRef = useRef<HTMLInputElement>(null);

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
  const [receiptQty, setReceiptQty] = useState('');
  const [receiptValue, setReceiptValue] = useState('');
  const [receiptTotalBoxes, setReceiptTotalBoxes] = useState('');
  const [upliftedById, setUpliftedById] = useState('');
  const [upliftedByName, setUpliftedByName] = useState('');
  const [storeRefs, setStoreRefs] = useState<string[]>(['']);

  // Box scanning (receipt)
  const [scanBarcode, setScanBarcode] = useState('');
  const [scanLoading, setScanLoading] = useState(false);
  const [boxes, setBoxes] = useState<ReceiptBox[]>([]);

  // Box count mismatch confirmation modal
  const [showMismatchModal, setShowMismatchModal] = useState(false);

  // Warehouse mismatch confirmation modal
  const [warehouseMismatch, setWarehouseMismatch] = useState<{
    barcode: string;
    stickerWarehouse: string;
    slipWarehouse: string;
  } | null>(null);

  // ── Release form fields ──
  const [releaseRepId, setReleaseRepId] = useState('');
  const [releaseRepName, setReleaseRepName] = useState('');
  const [releaseBoxes, setReleaseBoxes] = useState<ReceiptBox[]>([]);
  const [releaseScanBarcode, setReleaseScanBarcode] = useState('');
  const [releaseScanLoading, setReleaseScanLoading] = useState(false);
  const [releaseCode, setReleaseCode] = useState('');
  const [releasing, setReleasing] = useState(false);

  const mode: PageMode = slip ? resolveMode(slip.status) : 'receipt';
  const isReadOnly = mode === 'view';

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
          // Hydrate receipt form from existing data
          setReceiptQty(found.receiptQty ?? '');
          setReceiptValue(found.receiptValue ?? '');
          setReceiptTotalBoxes(found.receiptTotalBoxes != null ? String(found.receiptTotalBoxes) : '');
          setUpliftedById(found.receiptUpliftedById ?? '');
          setUpliftedByName(found.receiptUpliftedByName ?? '');
          // Hydrate store refs — prefer array field, fall back to legacy
          const arrayRefs = found.receiptStoreRefs ?? [];
          const legacyRefs = [found.receiptStoreRef1, found.receiptStoreRef2, found.receiptStoreRef3, found.receiptStoreRef4]
            .filter((r): r is string => !!r);
          const refs = arrayRefs.length > 0 ? arrayRefs : legacyRefs;
          setStoreRefs(refs.length > 0 ? refs : ['']);
          setBoxes(found.receiptBoxes ?? []);
          // Hydrate release form
          setReleaseRepId(found.releaseRepId ?? '');
          setReleaseRepName(found.releaseRepName ?? '');
          setReleaseBoxes(found.releaseBoxes ?? []);
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

  // ── Rep dropdown change (receipt) ──
  function onRepChange(repId: string) {
    setUpliftedById(repId);
    const rep = reps.find(r => r.id === repId);
    setUpliftedByName(rep ? `${rep.name} ${rep.surname}` : '');
  }

  // ── Rep dropdown change (release) ──
  function onReleaseRepChange(repId: string) {
    setReleaseRepId(repId);
    const rep = reps.find(r => r.id === repId);
    setReleaseRepName(rep ? `${rep.name} ${rep.surname}` : '');
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
          qty: receiptQty,
          value: receiptValue,
          totalBoxes: receiptTotalBoxes ? Number(receiptTotalBoxes) : undefined,
          upliftedById,
          upliftedByName,
          storeRef1: storeRefs[0] ?? '',
          storeRef2: storeRefs[1] ?? '',
          storeRef3: storeRefs[2] ?? '',
          storeRef4: storeRefs[3] ?? '',
          storeRefs: storeRefs.filter(r => r.trim()),
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

  // ── Add box (shared by scan + warehouse mismatch confirm) ──
  async function addBox(barcode: string) {
    const newBox: ReceiptBox = {
      id: uuid(),
      stickerBarcode: barcode,
      scannedAt: new Date().toISOString(),
    };

    const updatedBoxes = [...boxes, newBox];
    setBoxes(updatedBoxes);
    setScanBarcode('');

    // Auto-save after adding box
    await saveReceipt(updatedBoxes);
    notify(`Box ${barcode} added`);
  }

  // ── Scan barcode (receipt) ──
  async function handleScan() {
    const barcode = scanBarcode.trim().toUpperCase();
    if (!barcode || !slip) return;

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

      const stickerWh = (data.warehouseCode || '').toUpperCase().trim();
      const slipWh = (slip.warehouse || '').toUpperCase().trim();
      if (stickerWh && slipWh && stickerWh !== slipWh) {
        setWarehouseMismatch({
          barcode,
          stickerWarehouse: data.warehouseName ? `${data.warehouseName} (${data.warehouseCode})` : data.warehouseCode,
          slipWarehouse: slip.warehouse,
        });
        setScanLoading(false);
        return;
      }

      await addBox(barcode);
    } catch {
      notify('Network error scanning barcode', 'error');
    } finally {
      setScanLoading(false);
      scanInputRef.current?.focus();
    }
  }

  // ── Delete box (receipt) ──
  async function deleteBox(boxId: string) {
    const updatedBoxes = boxes.filter(b => b.id !== boxId);
    setBoxes(updatedBoxes);
    await saveReceipt(updatedBoxes);
  }

  // ── Complete receipt ──
  async function handleComplete(force = false) {
    if (!slip) return;
    if (boxes.length === 0) {
      notify('Scan at least one box before completing', 'error');
      return;
    }

    const expectedBoxes = receiptTotalBoxes ? Number(receiptTotalBoxes) : 0;
    if (!force && expectedBoxes > 0 && expectedBoxes !== boxes.length) {
      setShowMismatchModal(true);
      return;
    }

    setCompleting(true);
    try {
      await saveReceipt();

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

  // Handle Enter key in receipt scan input
  function onScanKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleScan();
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Release mode functions
  // ──────────────────────────────────────────────────────────────────────────

  // ── Add release box (client-side only, no sticker linking) ──
  function addReleaseBox(barcode: string) {
    const newBox: ReceiptBox = {
      id: uuid(),
      stickerBarcode: barcode,
      scannedAt: new Date().toISOString(),
    };
    setReleaseBoxes(prev => [...prev, newBox]);
    setReleaseScanBarcode('');
    notify(`Box ${barcode} added for release`);
  }

  // ── Scan barcode (release) ──
  async function handleReleaseScan() {
    const barcode = releaseScanBarcode.trim().toUpperCase();
    if (!barcode || !slip) return;

    if (releaseBoxes.some(b => b.stickerBarcode === barcode)) {
      notify('This barcode is already scanned for release', 'error');
      setReleaseScanBarcode('');
      releaseScanRef.current?.focus();
      return;
    }

    // Validate barcode exists in system
    setReleaseScanLoading(true);
    try {
      const res = await authFetch(`/api/receipts/lookup?barcode=${encodeURIComponent(barcode)}`, { cache: 'no-store' });
      const data = await res.json();

      if (!data.found) {
        notify(`Barcode "${barcode}" not found in the system`, 'error');
        setReleaseScanLoading(false);
        releaseScanRef.current?.focus();
        return;
      }

      addReleaseBox(barcode);
    } catch {
      notify('Network error scanning barcode', 'error');
    } finally {
      setReleaseScanLoading(false);
      releaseScanRef.current?.focus();
    }
  }

  function deleteReleaseBox(boxId: string) {
    setReleaseBoxes(prev => prev.filter(b => b.id !== boxId));
  }

  function onReleaseScanKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleReleaseScan();
    }
  }

  // ── Complete release ──
  async function handleRelease() {
    if (!slip) return;
    if (!releaseRepId) {
      notify('Select a rep before releasing', 'error');
      return;
    }
    if (releaseBoxes.length === 0) {
      notify('Scan at least one box before releasing', 'error');
      return;
    }
    if (!releaseCode.trim()) {
      notify('Enter the release code', 'error');
      return;
    }

    setReleasing(true);
    try {
      const res = await authFetch('/api/receipts/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slipId: slip.id,
          clientId: slip.clientId,
          loadId: slip.loadId,
          releaseRepId,
          releaseRepName,
          releaseBoxes,
          releaseCode: releaseCode.trim(),
        }),
      });
      const data = await res.json();
      if (data.status === 'in-transit') {
        notify('Stock released — now in transit');
        router.push('/aged-stock/receipts');
      } else if (data.status === 'failed-release') {
        notify(data.error || 'Release code does not match — status set to Failed Release', 'error');
        // Reload to reflect the new status
        loadData();
      } else {
        notify(data.error || 'Release failed', 'error');
      }
    } catch {
      notify('Network error releasing stock', 'error');
    } finally {
      setReleasing(false);
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
          Back to Receive Stock
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
          <h1 className="text-3xl font-bold text-gray-900">
            {mode === 'release' ? 'Release Stock' : mode === 'view' ? 'View Pick Slip' : 'Receive Stock (WH)'}
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            {mode === 'release' && slip.status === 'failed-release'
              ? 'Previous release attempt failed — retry with the correct release code'
              : mode === 'release'
              ? 'Release stock from warehouse for transit back to the vendor'
              : mode === 'view' && slip.releasedAt
              ? `Released on ${fmtDate(slip.releasedAt)} by ${slip.releasedByName}`
              : mode === 'view'
              ? `Status: ${STATUS_LABEL[slip.status] || slip.status}`
              : slip.status === 'receipted'
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

      {/* Failed release warning banner */}
      {slip.status === 'failed-release' && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 mb-4 flex items-start gap-3">
          <svg className="w-5 h-5 text-red-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div>
            <p className="text-sm font-medium text-red-800">Release Failed</p>
            <p className="text-xs text-red-600 mt-0.5">The release code entered did not match. Please verify the correct code with the rep and try again.</p>
          </div>
        </div>
      )}

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
            <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[slip.status] || 'bg-gray-100 text-gray-700'}`}>
              {STATUS_LABEL[slip.status] || slip.status}
            </span>
          </div>
        </div>
      </div>

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* RECEIPT MODE                                                       */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      {mode === 'receipt' && (
        <>
          {/* Receipt details form */}
          <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
            <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Receipt Details</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Quantity</label>
                <input
                  type="text"
                  value={receiptQty}
                  onChange={e => setReceiptQty(e.target.value)}
                  placeholder="e.g. 150"
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Value</label>
                <input
                  type="text"
                  value={receiptValue}
                  onChange={e => setReceiptValue(e.target.value)}
                  placeholder="e.g. R 1,500.00"
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Total Boxes</label>
                <input
                  type="number"
                  min={0}
                  value={receiptTotalBoxes}
                  onChange={e => setReceiptTotalBoxes(e.target.value)}
                  placeholder="Expected number of boxes"
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Uplifted By</label>
                <select
                  value={upliftedById}
                  onChange={e => onRepChange(e.target.value)}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm"
                >
                  <option value="">Select rep...</option>
                  {reps.map(r => (
                    <option key={r.id} value={r.id}>{r.name} {r.surname}</option>
                  ))}
                </select>
              </div>
              {storeRefs.map((ref, i) => (
                <div key={i} className="flex items-end gap-1.5">
                  <div className="flex-1">
                    <label className="block text-xs text-gray-600 mb-1">Store Reference (GRV) {i + 1}</label>
                    <input
                      type="text"
                      value={ref}
                      onChange={e => {
                        const next = [...storeRefs];
                        next[i] = e.target.value;
                        setStoreRefs(next);
                      }}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm"
                    />
                  </div>
                  {storeRefs.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setStoreRefs(prev => prev.filter((_, j) => j !== i))}
                      title="Remove"
                      className="px-1.5 py-1.5 text-red-400 hover:text-red-600 mb-px"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
              {storeRefs.length < 30 && (
                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={() => setStoreRefs(prev => [...prev, ''])}
                    className="flex items-center gap-1 text-xs font-medium text-[var(--color-primary)] hover:text-[var(--color-primary-dark)] py-1.5"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                    </svg>
                    Add Store Reference (GRV)
                  </button>
                </div>
              )}
            </div>

            {/* Manual save button */}
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
          </div>

          {/* Box scanning section */}
          <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">Scanned Boxes</h2>
              <span className="text-sm text-gray-500">
                {boxes.length} scanned
                {receiptTotalBoxes && Number(receiptTotalBoxes) > 0 && (
                  <> / {receiptTotalBoxes} expected</>
                )}
              </span>
            </div>

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
              <button
                onClick={handleScan}
                disabled={scanLoading || !scanBarcode.trim()}
                className="px-4 py-1.5 bg-[var(--color-primary)] text-white rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
              >
                {scanLoading && <div className="h-3.5 w-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                Add
              </button>
            </div>

            {boxes.length > 0 ? (
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-xs font-semibold text-gray-600 uppercase tracking-wide border-b border-gray-200">
                    <th className="pb-2">#</th>
                    <th className="pb-2">Box Number</th>
                    <th className="pb-2">Scanned At</th>
                    <th className="pb-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {boxes.map((b, i) => (
                    <tr key={b.id} className="border-t border-gray-100">
                      <td className="py-1.5 text-gray-400">{i + 1}</td>
                      <td className="py-1.5 font-mono font-medium">{b.stickerBarcode}</td>
                      <td className="py-1.5 text-xs text-gray-500">{fmtDate(b.scannedAt)}</td>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-center text-gray-400 text-sm py-6">
                No boxes scanned yet — use the input above to scan sticker barcodes
              </p>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex gap-3">
            <button
              onClick={() => handleComplete()}
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
        </>
      )}

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* RELEASE MODE                                                       */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      {mode === 'release' && (
        <>
          {/* Release form */}
          <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
            <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Release Details</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Collecting Rep <span className="text-red-500">*</span></label>
                <select
                  value={releaseRepId}
                  onChange={e => onReleaseRepChange(e.target.value)}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm"
                >
                  <option value="">Select rep...</option>
                  {reps.filter(r => r.releaseCode).map(r => (
                    <option key={r.id} value={r.id}>{r.name} {r.surname}</option>
                  ))}
                </select>
                <span className="text-[10px] text-gray-400 mt-0.5 block">Only reps with a release code are shown</span>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Release Code <span className="text-red-500">*</span></label>
                <input
                  type="password"
                  value={releaseCode}
                  onChange={e => setReleaseCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
                  maxLength={4}
                  placeholder="4-char code"
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm font-mono tracking-widest"
                />
                <span className="text-[10px] text-gray-400 mt-0.5 block">The rep must provide their 4-character release code</span>
              </div>
            </div>
          </div>

          {/* Release box scanning */}
          <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">Boxes Being Released</h2>
              <span className="text-sm text-gray-500">{releaseBoxes.length} scanned</span>
            </div>

            <div className="flex gap-3 mb-4 items-end">
              <div className="flex-1">
                <label className="block text-xs text-gray-600 mb-1">Scan Box Number</label>
                <input
                  ref={releaseScanRef}
                  type="text"
                  value={releaseScanBarcode}
                  onChange={e => setReleaseScanBarcode(e.target.value)}
                  onKeyDown={onReleaseScanKeyDown}
                  placeholder="STK-GAU-0001"
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm font-mono"
                  autoFocus
                />
              </div>
              <button
                onClick={handleReleaseScan}
                disabled={releaseScanLoading || !releaseScanBarcode.trim()}
                className="px-4 py-1.5 bg-purple-600 text-white rounded-md text-sm font-medium hover:bg-purple-700 disabled:opacity-50 flex items-center gap-2"
              >
                {releaseScanLoading && <div className="h-3.5 w-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                Add
              </button>
            </div>

            {releaseBoxes.length > 0 ? (
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-xs font-semibold text-gray-600 uppercase tracking-wide border-b border-gray-200">
                    <th className="pb-2">#</th>
                    <th className="pb-2">Box Number</th>
                    <th className="pb-2">Scanned At</th>
                    <th className="pb-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {releaseBoxes.map((b, i) => (
                    <tr key={b.id} className="border-t border-gray-100">
                      <td className="py-1.5 text-gray-400">{i + 1}</td>
                      <td className="py-1.5 font-mono font-medium">{b.stickerBarcode}</td>
                      <td className="py-1.5 text-xs text-gray-500">{fmtDate(b.scannedAt)}</td>
                      <td className="py-1.5 text-center">
                        <button
                          onClick={() => deleteReleaseBox(b.id)}
                          title="Remove"
                          className="text-red-400 hover:text-red-600"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-center text-gray-400 text-sm py-6">
                No boxes scanned yet — scan the sticker barcodes of boxes being released
              </p>
            )}
          </div>

          {/* Release action buttons */}
          <div className="flex gap-3">
            <button
              onClick={handleRelease}
              disabled={releasing || releaseBoxes.length === 0 || !releaseRepId || !releaseCode.trim()}
              className="px-5 py-2.5 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {releasing && <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
              Complete Release
            </button>
            <button
              onClick={() => router.push('/aged-stock/receipts')}
              className="px-5 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </>
      )}

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* VIEW MODE — read-only receipt + release summary                    */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      {mode === 'view' && (
        <>
          {/* Receipt summary (read-only) */}
          <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
            <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Receipt Details</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
              <div>
                <span className="text-gray-500 text-xs block">Quantity</span>
                <span className="font-medium">{slip.receiptQty || '—'}</span>
              </div>
              <div>
                <span className="text-gray-500 text-xs block">Value</span>
                <span className="font-medium">{slip.receiptValue || '—'}</span>
              </div>
              <div>
                <span className="text-gray-500 text-xs block">Total Boxes</span>
                <span className="font-medium">{slip.receiptTotalBoxes ?? '—'}</span>
              </div>
              <div>
                <span className="text-gray-500 text-xs block">Uplifted By</span>
                <span className="font-medium">{slip.receiptUpliftedByName || '—'}</span>
              </div>
              <div>
                <span className="text-gray-500 text-xs block">Receipted At</span>
                <span className="font-medium">{slip.receiptedAt ? fmtDate(slip.receiptedAt) : '—'}</span>
              </div>
              <div>
                <span className="text-gray-500 text-xs block">Receipted By</span>
                <span className="font-medium">{slip.receiptedByName || '—'}</span>
              </div>
            </div>
            {/* Store refs */}
            {storeRefs.filter(r => r.trim()).length > 0 && (
              <div className="mt-3 pt-3 border-t border-gray-100">
                <span className="text-gray-500 text-xs block mb-1">Store References (GRV)</span>
                <div className="flex flex-wrap gap-2">
                  {storeRefs.filter(r => r.trim()).map((ref, i) => (
                    <span key={i} className="px-2 py-0.5 bg-gray-100 rounded text-xs font-mono">{ref}</span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Receipt boxes (read-only) */}
          {boxes.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
              <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Receipt Boxes ({boxes.length})</h2>
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-xs font-semibold text-gray-600 uppercase tracking-wide border-b border-gray-200">
                    <th className="pb-2">#</th>
                    <th className="pb-2">Box Number</th>
                    <th className="pb-2">Scanned At</th>
                  </tr>
                </thead>
                <tbody>
                  {boxes.map((b, i) => (
                    <tr key={b.id} className="border-t border-gray-100">
                      <td className="py-1.5 text-gray-400">{i + 1}</td>
                      <td className="py-1.5 font-mono font-medium">{b.stickerBarcode}</td>
                      <td className="py-1.5 text-xs text-gray-500">{fmtDate(b.scannedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Release summary (read-only) */}
          {slip.releasedAt && (
            <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
              <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Release Details</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
                <div>
                  <span className="text-gray-500 text-xs block">Collecting Rep</span>
                  <span className="font-medium">{slip.releaseRepName || '—'}</span>
                </div>
                <div>
                  <span className="text-gray-500 text-xs block">Released At</span>
                  <span className="font-medium">{fmtDate(slip.releasedAt)}</span>
                </div>
                <div>
                  <span className="text-gray-500 text-xs block">Released By</span>
                  <span className="font-medium">{slip.releasedByName || '—'}</span>
                </div>
              </div>
            </div>
          )}

          {/* Release boxes (read-only) */}
          {releaseBoxes.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
              <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Release Boxes ({releaseBoxes.length})</h2>
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-xs font-semibold text-gray-600 uppercase tracking-wide border-b border-gray-200">
                    <th className="pb-2">#</th>
                    <th className="pb-2">Box Number</th>
                    <th className="pb-2">Scanned At</th>
                  </tr>
                </thead>
                <tbody>
                  {releaseBoxes.map((b, i) => (
                    <tr key={b.id} className="border-t border-gray-100">
                      <td className="py-1.5 text-gray-400">{i + 1}</td>
                      <td className="py-1.5 font-mono font-medium">{b.stickerBarcode}</td>
                      <td className="py-1.5 text-xs text-gray-500">{fmtDate(b.scannedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── Warehouse Mismatch Modal ──────────────────────────────────────── */}
      {warehouseMismatch && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
            <h2 className="text-lg font-bold text-gray-900 mb-2">Warehouse Mismatch</h2>
            <p className="text-sm text-gray-600 mb-4">
              This barcode (<strong className="font-mono">{warehouseMismatch.barcode}</strong>) was created for warehouse <strong>{warehouseMismatch.stickerWarehouse}</strong>, but this pick slip is for warehouse <strong>{warehouseMismatch.slipWarehouse}</strong>.
            </p>
            <p className="text-sm text-gray-600 mb-4">Are you sure you want to link this?</p>
            <div className="flex gap-3">
              <button
                onClick={async () => {
                  const barcode = warehouseMismatch.barcode;
                  setWarehouseMismatch(null);
                  setScanLoading(true);
                  try {
                    await addBox(barcode);
                  } finally {
                    setScanLoading(false);
                    scanInputRef.current?.focus();
                  }
                }}
                className="px-4 py-2 bg-amber-500 text-white rounded-lg text-sm font-medium hover:bg-amber-600"
              >
                Yes, Link Anyway
              </button>
              <button
                onClick={() => {
                  setWarehouseMismatch(null);
                  scanInputRef.current?.focus();
                }}
                className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
              >
                No
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Box Count Mismatch Modal ─────────────────────────────────────── */}
      {showMismatchModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
            <h2 className="text-lg font-bold text-gray-900 mb-2">Box Count Mismatch</h2>
            <p className="text-sm text-gray-600 mb-4">
              You entered <strong>{receiptTotalBoxes}</strong> total boxes but scanned <strong>{boxes.length}</strong> barcode{boxes.length !== 1 ? 's' : ''}.
              Do you want to complete anyway?
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => {
                  setShowMismatchModal(false);
                  handleComplete(true);
                }}
                disabled={completing}
                className="px-4 py-2 bg-amber-500 text-white rounded-lg text-sm font-medium hover:bg-amber-600 disabled:opacity-50 flex items-center gap-2"
              >
                {completing && <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                Complete Anyway
              </button>
              <button
                onClick={() => setShowMismatchModal(false)}
                className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
              >
                Go Back
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
