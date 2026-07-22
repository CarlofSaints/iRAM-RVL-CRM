'use client';

import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';

interface ReceiptBox {
  id: string;
  stickerBarcode: string;
  scannedAt: string;
}

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
  receiptBoxes?: ReceiptBox[];
  receiptStoreRefs?: string[];
  receiptGrnDate?: string;
  manual?: boolean;
  rows?: Array<{ articleCode: string; description: string; qty: number; val: number }>;
  // Recency timestamps used to order the "Available Slips" list
  generatedAt?: string;
  receiptedAt?: string;
  // Release fields — populated once stock has been released
  deliveryToken?: string;
  releaseRepId?: string;
  releaseRepName?: string;
  releaseBoxes?: ReceiptBox[];
  releasedAt?: string;
}

interface RepDto {
  id: string;
  name: string;
  surname: string;
  releaseCode?: string;
}

interface UserDto {
  id: string;
  name: string;
  surname: string;
  releaseCode?: string;
  role: string;
}

/** Barcode → parent slip mapping */
interface BarcodeIndex {
  [barcode: string]: string; // stickerBarcode → slipId
}

/** Per-slip scanned state */
interface SlipScanState {
  slip: SlipDto;
  scannedBarcodes: string[];
  totalBoxes: number;
}

function fmtCurrency(v: number): string {
  return `R ${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function ReleasePage() {
  const { session } = useAuth('receipt_stock');
  const scanInputRef = useRef<HTMLInputElement>(null);

  const [toast, setToast] = useState<ToastData | null>(null);
  const notify = (message: string, type: 'success' | 'error' = 'success') =>
    setToast({ message, type });

  // Data
  const [allSlips, setAllSlips] = useState<SlipDto[]>([]);
  const [releasedSlips, setReleasedSlips] = useState<SlipDto[]>([]);
  const [reps, setReps] = useState<RepDto[]>([]);
  const [releaseUsers, setReleaseUsers] = useState<UserDto[]>([]);
  const [loading, setLoading] = useState(true);

  // Reassign-rep modal state
  const [reassignToken, setReassignToken] = useState<string | null>(null);
  const [reassignRepId, setReassignRepId] = useState('');
  const [reassignRepName, setReassignRepName] = useState('');
  const [reassignCode, setReassignCode] = useState('');
  const [reassigning, setReassigning] = useState(false);

  // Cancel-release modal state
  const [cancelToken, setCancelToken] = useState<string | null>(null);
  const [cancelManagerId, setCancelManagerId] = useState('');
  const [cancelManagerName, setCancelManagerName] = useState('');
  const [cancelCode, setCancelCode] = useState('');
  const [cancelling, setCancelling] = useState(false);

  // Barcode index: stickerBarcode → slipId
  const barcodeIndex = useMemo<BarcodeIndex>(() => {
    const idx: BarcodeIndex = {};
    for (const slip of allSlips) {
      for (const box of slip.receiptBoxes ?? []) {
        if (box.stickerBarcode) {
          idx[box.stickerBarcode] = slip.id;
        }
      }
    }
    return idx;
  }, [allSlips]);

  // Slip lookup by ID
  const slipMap = useMemo(() => {
    const m = new Map<string, SlipDto>();
    for (const s of allSlips) m.set(s.id, s);
    return m;
  }, [allSlips]);

  // "Available Slips" list — order by how recently the slip became releasable
  // (i.e. when it was receipted/captured), NOT when it was generated. A slip
  // from an old aged-stock load that was only just captured is the newest thing
  // on the release floor, so it must sit at the top — otherwise it sinks to the
  // bottom behind its old generatedAt. Falls back to generatedAt, then id.
  const availableSlips = useMemo(() => {
    const recency = (s: SlipDto) => s.receiptedAt || s.generatedAt || '';
    return [...allSlips].sort((a, b) => {
      const ra = recency(a);
      const rb = recency(b);
      if (ra !== rb) return ra < rb ? 1 : -1; // newest first
      return a.id < b.id ? 1 : -1;
    });
  }, [allSlips]);

  // Scanning state
  const [scanBarcode, setScanBarcode] = useState('');
  const [scannedBarcodes, setScannedBarcodes] = useState<string[]>([]);
  const [scanError, setScanError] = useState('');

  // Discovered slips from scanning — most recently scanned store FIRST.
  // The scanner works down a pallet box by box; if the queue kept discovery
  // order the store you just scanned could be several cards down the page and
  // you'd have to scroll to see whether it registered (Complete / Partial).
  // Ordering by the last scan for each slip means the card you just touched is
  // always the one directly under the scan box. `scannedBarcodes` stays in
  // chronological order so the per-slip barcode chips still render newest-first.
  const discoveredSlips = useMemo<SlipScanState[]>(() => {
    const slipScans = new Map<string, string[]>();
    const lastScanSeq = new Map<string, number>();
    scannedBarcodes.forEach((bc, i) => {
      const slipId = barcodeIndex[bc];
      if (!slipId) return;
      if (!slipScans.has(slipId)) slipScans.set(slipId, []);
      slipScans.get(slipId)!.push(bc);
      lastScanSeq.set(slipId, i);
    });
    const result: SlipScanState[] = [];
    for (const [slipId, bcs] of slipScans) {
      const slip = slipMap.get(slipId);
      if (!slip) continue;
      result.push({
        slip,
        scannedBarcodes: bcs,
        totalBoxes: (slip.receiptBoxes ?? []).length,
      });
    }
    result.sort(
      (a, b) => (lastScanSeq.get(b.slip.id) ?? -1) - (lastScanSeq.get(a.slip.id) ?? -1),
    );
    return result;
  }, [scannedBarcodes, barcodeIndex, slipMap]);

  // Release form
  const [releaseRepId, setReleaseRepId] = useState('');
  const [releaseRepName, setReleaseRepName] = useState('');
  const [releaseCode, setReleaseCode] = useState('');
  const [releasing, setReleasing] = useState(false);

  // Manager override for partial release
  const [showPartialModal, setShowPartialModal] = useState(false);
  const [managerOverrideCode, setManagerOverrideCode] = useState('');
  const [managerOverrideRepId, setManagerOverrideRepId] = useState('');

  // All slips complete? (all boxes for every discovered slip are scanned)
  const allComplete = discoveredSlips.length > 0 && discoveredSlips.every(s => s.scannedBarcodes.length >= s.totalBoxes);
  const anyPartial = discoveredSlips.length > 0 && discoveredSlips.some(s => s.scannedBarcodes.length < s.totalBoxes);

  // Combined rep list (reps + users with release codes)
  const releaseRepOptions = useMemo(() => {
    const options: Array<{ id: string; label: string }> = [];
    for (const r of reps) {
      if (r.releaseCode) options.push({ id: r.id, label: `${r.name} ${r.surname}` });
    }
    for (const u of releaseUsers) {
      if (u.releaseCode && !options.some(o => o.id === u.id)) {
        options.push({ id: u.id, label: `${u.name} ${u.surname}` });
      }
    }
    return options;
  }, [reps, releaseUsers]);

  // Manager options for partial release override
  const managerOptions = useMemo(() => {
    return releaseUsers.filter(u => u.releaseCode && u.role !== 'rep');
  }, [releaseUsers]);

  // Group released slips by delivery token (a "release" = one DN + one QR).
  // Slips with no token (legacy) fall back to their own id as a standalone group.
  interface ReleaseGroup {
    token: string;
    slips: SlipDto[];
    repName: string;
    clientName: string;
    status: string;
    releasedAt?: string;
    totalBoxes: number;
  }
  const releaseGroups = useMemo<ReleaseGroup[]>(() => {
    const map = new Map<string, SlipDto[]>();
    for (const s of releasedSlips) {
      const key = s.deliveryToken || `__notoken__${s.id}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    const groups: ReleaseGroup[] = [];
    for (const [token, slips] of map) {
      const first = slips[0];
      groups.push({
        token,
        slips,
        repName: first.releaseRepName || '(unassigned)',
        clientName: first.clientName,
        status: first.status,
        releasedAt: first.releasedAt,
        totalBoxes: slips.reduce((n, s) => n + (s.releaseBoxes ?? []).length, 0),
      });
    }
    // Newest released first
    groups.sort((a, b) => ((a.releasedAt || '') < (b.releasedAt || '') ? 1 : -1));
    return groups;
  }, [releasedSlips]);

  const reassignTarget = useMemo(
    () => releaseGroups.find(g => g.token === reassignToken) ?? null,
    [releaseGroups, reassignToken],
  );

  const cancelTarget = useMemo(
    () => releaseGroups.find(g => g.token === cancelToken) ?? null,
    [releaseGroups, cancelToken],
  );

  // ── Load data ──
  const loadData = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [slipsRes, repsRes, usersRes] = await Promise.all([
        authFetch('/api/pick-slips', { cache: 'no-store' }),
        authFetch('/api/control/reps', { cache: 'no-store' }),
        authFetch('/api/users', { cache: 'no-store' }),
      ]);

      if (slipsRes.ok) {
        const data = await slipsRes.json();
        const all = (data.slips ?? []) as SlipDto[];
        // Releasable slips (for scanning)
        setAllSlips(all.filter(s => s.status === 'captured' || s.status === 'failed-release'));
        // Already-released slips (for rep reassignment)
        setReleasedSlips(all.filter(s => s.status === 'in-transit' || s.status === 'partial-release'));
      }

      if (repsRes.ok) {
        const data = await repsRes.json();
        setReps(data.reps ?? data ?? []);
      }

      if (usersRes.ok) {
        const data = await usersRes.json();
        const userList = (data.users ?? data ?? []) as UserDto[];
        setReleaseUsers(userList.filter(u => u.releaseCode));
      }
    } catch {
      notify('Failed to load data', 'error');
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { loadData(); }, [loadData]);

  // Auto-focus scan input
  useEffect(() => {
    if (!loading && scanInputRef.current) {
      scanInputRef.current.focus();
    }
  }, [loading]);

  // ── Scan handler ──
  function handleScan(rawBarcode: string) {
    const barcode = rawBarcode.trim();
    if (!barcode) return;
    setScanError('');

    // Duplicate check
    if (scannedBarcodes.includes(barcode)) {
      setScanError(`Already scanned: ${barcode}`);
      setScanBarcode('');
      return;
    }

    // Look up in index
    const slipId = barcodeIndex[barcode];
    if (!slipId) {
      setScanError(`Documents Not Captured! Ask admin personnel for help! (Barcode not found in any releasable slip: ${barcode})`);
      setScanBarcode('');
      return;
    }

    // Supplier lock — a delivery note may only contain ONE supplier's stock.
    // A supplier can be split across several client records that share the same
    // NAME but carry different vendor numbers (e.g. Major Tech 2130 + 4394), so
    // we match on the client NAME, not the clientId. Different suppliers block.
    const supplierKey = (s: SlipDto) => (s.clientName || '').trim().toUpperCase();
    const newSlip = slipMap.get(slipId);
    if (newSlip && discoveredSlips.length > 0) {
      const current = discoveredSlips[0].slip;
      if (supplierKey(newSlip) !== supplierKey(current)) {
        setScanError(
          `This box is ${newSlip.clientName} (vendor ${newSlip.vendorNumber}). ` +
          `The current release is for ${current.clientName} (vendor ${current.vendorNumber}). ` +
          `Stock from different suppliers can't be released on the same delivery note.`,
        );
        setScanBarcode('');
        return;
      }
    }

    setScannedBarcodes(prev => [...prev, barcode]);
    setScanBarcode('');

    // Re-focus
    setTimeout(() => scanInputRef.current?.focus(), 50);
  }

  function removeScan(barcode: string) {
    setScannedBarcodes(prev => prev.filter(b => b !== barcode));
  }

  // ── Release handler ──
  async function handleRelease() {
    if (!releaseRepId || !releaseCode.trim()) {
      notify('Select a rep and enter the release code', 'error');
      return;
    }
    if (discoveredSlips.length === 0) {
      notify('Scan at least one box sticker barcode', 'error');
      return;
    }

    // Check for partial — not all boxes scanned
    if (anyPartial && !showPartialModal) {
      setShowPartialModal(true);
      return;
    }

    setReleasing(true);
    try {
      const slipsPayload = discoveredSlips.map(ds => ({
        slipId: ds.slip.id,
        clientId: ds.slip.clientId,
        loadId: ds.slip.loadId,
        releaseBoxes: ds.scannedBarcodes.map(bc => ({
          id: crypto.randomUUID(),
          stickerBarcode: bc,
          scannedAt: new Date().toISOString(),
        })),
      }));

      const payload: Record<string, unknown> = {
        slips: slipsPayload,
        releaseRepId,
        releaseRepName,
        releaseCode: releaseCode.trim(),
      };

      if (managerOverrideCode && managerOverrideRepId) {
        payload.managerOverrideCode = managerOverrideCode.trim();
        payload.managerOverrideRepId = managerOverrideRepId;
      }

      const res = await authFetch('/api/receipts/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (data.ok) {
        const status = data.status === 'partial-release' ? 'Partial release' : 'Released';
        notify(`${status} — ${discoveredSlips.length} slip(s) in transit`, 'success');
        // Reset
        setScannedBarcodes([]);
        setReleaseCode('');
        setManagerOverrideCode('');
        setManagerOverrideRepId('');
        setShowPartialModal(false);
        // Reload to refresh available slips
        await loadData();
      } else {
        notify(data.error || 'Release failed', 'error');
        setShowPartialModal(false);
      }
    } catch {
      notify('Network error during release', 'error');
    } finally {
      setReleasing(false);
    }
  }

  // ── Reassign rep handler ──
  function openReassign(group: ReleaseGroup) {
    setReassignToken(group.token);
    setReassignRepId('');
    setReassignRepName('');
    setReassignCode('');
  }

  function closeReassign() {
    setReassignToken(null);
    setReassignRepId('');
    setReassignRepName('');
    setReassignCode('');
  }

  async function handleReassign() {
    if (!reassignTarget) return;
    if (!reassignRepId || !reassignCode.trim()) {
      notify('Select a rep and enter their release code', 'error');
      return;
    }
    setReassigning(true);
    try {
      const res = await authFetch('/api/receipts/reassign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deliveryToken: reassignTarget.token,
          slips: reassignTarget.slips.map(s => ({
            slipId: s.id,
            clientId: s.clientId,
            loadId: s.loadId,
          })),
          newRepId: reassignRepId,
          newRepName: reassignRepName,
          releaseCode: reassignCode.trim(),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        if (data.emailSent) {
          notify(`Reassigned to ${reassignRepName} — delivery note resent`, 'success');
        } else {
          notify(
            `Reassigned to ${reassignRepName}, but email not sent: ${data.emailError || data.dnError || 'unknown error'}`,
            'error',
          );
        }
        closeReassign();
        await loadData();
      } else {
        notify(data.error || 'Reassignment failed', 'error');
      }
    } catch {
      notify('Network error during reassignment', 'error');
    } finally {
      setReassigning(false);
    }
  }

  // ── Cancel release handler ──
  function openCancel(group: ReleaseGroup) {
    setCancelToken(group.token);
    setCancelManagerId('');
    setCancelManagerName('');
    setCancelCode('');
  }

  function closeCancel() {
    setCancelToken(null);
    setCancelManagerId('');
    setCancelManagerName('');
    setCancelCode('');
  }

  async function handleCancelRelease() {
    if (!cancelTarget) return;
    if (!cancelManagerId || !cancelCode.trim()) {
      notify('Select a manager and enter their security code', 'error');
      return;
    }
    setCancelling(true);
    try {
      const res = await authFetch('/api/receipts/cancel-release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deliveryToken: cancelTarget.token,
          slips: cancelTarget.slips.map(s => ({
            slipId: s.id,
            clientId: s.clientId,
            loadId: s.loadId,
          })),
          managerId: cancelManagerId,
          managerName: cancelManagerName,
          securityCode: cancelCode.trim(),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        notify(`Release cancelled — ${cancelTarget.slips.length} slip(s) back in the warehouse`, 'success');
        closeCancel();
        await loadData();
      } else {
        notify(data.error || 'Cancellation failed', 'error');
      }
    } catch {
      notify('Network error during cancellation', 'error');
    } finally {
      setCancelling(false);
    }
  }

  if (!session) return null;

  return (
    <>
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Release Stock</h1>
          <p className="text-sm text-gray-600 mt-1">
            Scan box sticker barcodes to release stock from warehouse
          </p>
        </div>
        <div className="text-sm text-gray-500">
          {allSlips.length} slip{allSlips.length !== 1 ? 's' : ''} awaiting release
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 border-4 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left column: Scanner + scanned list */}
          <div className="lg:col-span-2 space-y-4">
            {/* Scan input */}
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">
                Scan Sticker Barcode
              </label>
              <div className="flex gap-2">
                <input
                  ref={scanInputRef}
                  value={scanBarcode}
                  onChange={e => setScanBarcode(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleScan(scanBarcode);
                    }
                  }}
                  placeholder="Scan or type sticker barcode..."
                  className="flex-1 px-3 py-2.5 border border-gray-300 rounded-md text-sm font-mono"
                  autoComplete="off"
                  autoFocus
                />
                <button
                  onClick={() => handleScan(scanBarcode)}
                  disabled={!scanBarcode.trim()}
                  className="px-4 py-2 bg-[var(--color-primary)] text-white rounded-md text-sm font-medium hover:bg-[#5a9a2e] disabled:opacity-50"
                >
                  Add
                </button>
              </div>
              {scanError && (
                <p className="text-red-600 text-xs mt-2">{scanError}</p>
              )}
              <p className="text-gray-400 text-xs mt-2">
                {scannedBarcodes.length} barcode{scannedBarcodes.length !== 1 ? 's' : ''} scanned
              </p>
            </div>

            {/* Discovered slips */}
            {discoveredSlips.length === 0 && scannedBarcodes.length === 0 && (
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center">
                <svg className="w-12 h-12 text-gray-300 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 013.75 9.375v-4.5zM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5zM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0113.5 9.375v-4.5z" />
                </svg>
                <p className="text-gray-500 text-sm">Scan box sticker barcodes to begin</p>
                <p className="text-gray-400 text-xs mt-1">The system will auto-discover the parent pick slips</p>
              </div>
            )}

            {discoveredSlips.map((ds, idx) => {
              const isComplete = ds.scannedBarcodes.length >= ds.totalBoxes;
              // Top card = the store scanned most recently; ring it so the floor
              // can confirm the scan registered without reading the whole queue.
              const isLatest = idx === 0;
              return (
                <div
                  key={ds.slip.id}
                  className={`bg-white border rounded-lg p-4 transition-all ${
                    isComplete ? 'border-emerald-300' : 'border-amber-300'
                  } ${
                    isLatest
                      ? `ring-2 ring-offset-1 ${isComplete ? 'ring-emerald-400' : 'ring-amber-400'}`
                      : ''
                  }`}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-bold text-gray-900">{ds.slip.id}</span>
                        {isLatest && (
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">
                            Last scanned
                          </span>
                        )}
                        {isComplete ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full">
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                            Complete
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">
                            Partial
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-gray-600 mt-0.5">
                        {ds.slip.siteName} ({ds.slip.siteCode}) — {ds.slip.warehouse}
                      </p>
                      <p className="text-xs text-gray-500">
                        {ds.slip.clientName} — {ds.slip.vendorNumber}
                      </p>
                    </div>
                    <div className="text-right">
                      <div className={`text-lg font-bold ${isComplete ? 'text-emerald-600' : 'text-amber-600'}`}>
                        {ds.scannedBarcodes.length} / {ds.totalBoxes}
                      </div>
                      <div className="text-xs text-gray-500">boxes</div>
                    </div>
                  </div>

                  {/* GRN/GRV refs */}
                  {(ds.slip.receiptStoreRefs ?? []).length > 0 && (
                    <p className="text-xs text-gray-500 mb-2">
                      GRN/GRV: {ds.slip.receiptStoreRefs!.join(', ')}
                    </p>
                  )}

                  {/* Progress bar */}
                  <div className="w-full bg-gray-100 rounded-full h-2 mb-3">
                    <div
                      className={`h-2 rounded-full transition-all ${isComplete ? 'bg-emerald-500' : 'bg-amber-400'}`}
                      style={{ width: `${Math.min(100, (ds.scannedBarcodes.length / ds.totalBoxes) * 100)}%` }}
                    />
                  </div>

                  {/* Scanned barcodes — newest first */}
                  <div className="flex flex-wrap gap-1.5">
                    {[...ds.scannedBarcodes].reverse().map(bc => (
                      <span
                        key={bc}
                        className="inline-flex items-center gap-1 text-xs font-mono bg-gray-100 text-gray-700 px-2 py-1 rounded"
                      >
                        {bc}
                        <button
                          onClick={() => removeScan(bc)}
                          className="text-gray-400 hover:text-red-500 ml-0.5"
                          title="Remove"
                        >
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Right column: Release form */}
          <div className="space-y-4">
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <h2 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-3">Release Details</h2>

              {/* Rep selection */}
              <label className="block text-xs text-gray-600 mb-1">Collecting Rep</label>
              <select
                value={releaseRepId}
                onChange={e => {
                  setReleaseRepId(e.target.value);
                  const opt = releaseRepOptions.find(o => o.id === e.target.value);
                  setReleaseRepName(opt?.label ?? '');
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm mb-3"
              >
                <option value="">Select rep...</option>
                {releaseRepOptions.map(o => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>

              {/* Release code */}
              <label className="block text-xs text-gray-600 mb-1">Release Code</label>
              <input
                type="password"
                value={releaseCode}
                onChange={e => setReleaseCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
                maxLength={4}
                placeholder="4-char code"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono tracking-widest text-center uppercase mb-4"
                autoComplete="off"
              />

              {/* Summary */}
              {discoveredSlips.length > 0 && (
                <div className="bg-gray-50 rounded-md p-3 mb-4 text-sm">
                  <div className="flex justify-between mb-1">
                    <span className="text-gray-600">Pick slips:</span>
                    <span className="font-medium">{discoveredSlips.length}</span>
                  </div>
                  <div className="flex justify-between mb-1">
                    <span className="text-gray-600">Total boxes:</span>
                    <span className="font-medium">{scannedBarcodes.length}</span>
                  </div>
                  <div className="flex justify-between mb-1">
                    <span className="text-gray-600">Total qty:</span>
                    <span className="font-medium">{discoveredSlips.reduce((s, d) => s + d.slip.totalQty, 0).toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Total value:</span>
                    <span className="font-medium">{fmtCurrency(discoveredSlips.reduce((s, d) => s + d.slip.totalVal, 0))}</span>
                  </div>
                </div>
              )}

              {/* Release button */}
              <button
                onClick={handleRelease}
                disabled={
                  releasing ||
                  discoveredSlips.length === 0 ||
                  !releaseRepId ||
                  !releaseCode.trim()
                }
                className="w-full py-2.5 bg-[var(--color-primary)] text-white rounded-md text-sm font-bold hover:bg-[#5a9a2e] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {releasing && <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                {allComplete
                  ? `Release ${discoveredSlips.length} Slip${discoveredSlips.length > 1 ? 's' : ''}`
                  : discoveredSlips.length > 0
                    ? 'Release (Partial)'
                    : 'Release'}
              </button>

              {anyPartial && !allComplete && (
                <p className="text-amber-600 text-xs mt-2 text-center">
                  Not all boxes are scanned — manager override required for partial release
                </p>
              )}
            </div>

            {/* Quick info: available slips */}
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <h2 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">Available Slips</h2>
              <div className="max-h-48 overflow-y-auto space-y-1">
                {availableSlips.length === 0 ? (
                  <p className="text-xs text-gray-400">No slips awaiting release</p>
                ) : availableSlips.map(s => (
                  <div key={s.id} className="text-xs flex items-center justify-between">
                    <span className="font-mono text-gray-700">{s.id.slice(-7)}</span>
                    <span className="text-gray-500 truncate ml-2">{s.siteName}</span>
                    <span className="text-gray-400 ml-1">{(s.receiptBoxes ?? []).length}b</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Released — In Transit (rep reassignment) */}
        {releaseGroups.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-lg p-4 mt-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                Released — In Transit
              </h2>
              <span className="text-xs text-gray-400">
                {releaseGroups.length} release{releaseGroups.length !== 1 ? 's' : ''} — reassign rep or resend the delivery note
              </span>
            </div>
            <div className="space-y-2">
              {releaseGroups.map(g => (
                <div
                  key={g.token}
                  className="flex items-start justify-between gap-3 border border-gray-200 rounded-lg p-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-gray-900">{g.repName}</span>
                      {g.status === 'partial-release' ? (
                        <span className="text-xs font-medium text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">Partial</span>
                      ) : (
                        <span className="text-xs font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full">In Transit</span>
                      )}
                      <span className="text-xs text-gray-400">
                        {g.slips.length} slip{g.slips.length !== 1 ? 's' : ''} · {g.totalBoxes} box{g.totalBoxes !== 1 ? 'es' : ''}
                      </span>
                    </div>
                    <p className="text-xs text-gray-600 mt-0.5">{g.clientName}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {g.slips.map(s => `${s.siteName} (${s.siteCode})`).join(', ')}
                    </p>
                    {g.releasedAt && (
                      <p className="text-xs text-gray-400 mt-0.5">
                        Released {new Date(g.releasedAt).toLocaleString('en-GB', {
                          day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
                        })}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 flex flex-col gap-2">
                    <button
                      onClick={() => openReassign(g)}
                      className="px-3 py-1.5 border border-[var(--color-primary)] text-[var(--color-primary)] rounded-md text-xs font-medium hover:bg-[var(--color-primary)] hover:text-white transition-colors"
                    >
                      Reassign Rep
                    </button>
                    <button
                      onClick={() => openCancel(g)}
                      className="px-3 py-1.5 border border-red-400 text-red-600 rounded-md text-xs font-medium hover:bg-red-500 hover:text-white transition-colors"
                    >
                      Cancel Release
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        </>
      )}

      {/* Partial release manager override modal */}
      {showPartialModal && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4"
          onClick={() => { setShowPartialModal(false); setManagerOverrideCode(''); setManagerOverrideRepId(''); }}
        >
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 mb-2">Partial Release</h3>
            <p className="text-sm text-gray-600 mb-4">
              Not all boxes have been scanned for the following slip(s):
            </p>
            <div className="space-y-1 mb-4">
              {discoveredSlips.filter(d => d.scannedBarcodes.length < d.totalBoxes).map(d => (
                <div key={d.slip.id} className="flex justify-between text-sm">
                  <span className="font-mono">{d.slip.id}</span>
                  <span className="text-amber-600 font-medium">{d.scannedBarcodes.length} / {d.totalBoxes}</span>
                </div>
              ))}
            </div>
            <p className="text-sm text-gray-600 mb-3">
              A manager must authorise this partial release.
            </p>

            {managerOptions.length === 0 ? (
              <div className="bg-amber-50 border border-amber-200 rounded-md p-3 mb-4 text-xs text-amber-800">
                <p className="font-semibold mb-1">No authorising managers are set up yet.</p>
                <p>
                  A partial release must be authorised by a manager/admin who has a <strong>Release Code</strong>.
                  Set one in <strong>User Management → Edit user → Release Code</strong> for any non-rep user,
                  then try again.
                </p>
              </div>
            ) : (
              <>
                <label className="block text-xs text-gray-600 mb-1">Manager</label>
                <select
                  value={managerOverrideRepId}
                  onChange={e => setManagerOverrideRepId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm mb-3"
                >
                  <option value="">Select manager...</option>
                  {managerOptions.map(u => (
                    <option key={u.id} value={u.id}>{u.name} {u.surname}</option>
                  ))}
                </select>

                <label className="block text-xs text-gray-600 mb-1">Manager Release Code</label>
                <input
                  type="password"
                  value={managerOverrideCode}
                  onChange={e => setManagerOverrideCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
                  maxLength={4}
                  placeholder="4-char code"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono tracking-widest text-center uppercase mb-4"
                  autoComplete="off"
                />
              </>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => { setShowPartialModal(false); setManagerOverrideCode(''); setManagerOverrideRepId(''); }}
                className="flex-1 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleRelease}
                disabled={releasing || managerOptions.length === 0 || !managerOverrideRepId || !managerOverrideCode.trim()}
                className="flex-1 py-2 bg-amber-500 text-white rounded-md text-sm font-bold hover:bg-amber-600 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {releasing && <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                Authorise Release
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reassign rep modal */}
      {reassignTarget && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4"
          onClick={closeReassign}
        >
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 relative" onClick={e => e.stopPropagation()}>
            <button
              onClick={closeReassign}
              aria-label="Close"
              className="absolute top-3 right-3 text-gray-400 hover:text-gray-700 rounded-md p-1 hover:bg-gray-100"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <h3 className="text-lg font-bold text-gray-900 mb-1 pr-8">Reassign Collecting Rep</h3>
            <p className="text-sm text-gray-600 mb-4">
              Reassign this release to a different rep. The delivery note will be regenerated and re-sent to the new rep.
            </p>

            <div className="bg-gray-50 rounded-md p-3 mb-4 text-sm">
              <div className="flex justify-between mb-1">
                <span className="text-gray-600">Current rep:</span>
                <span className="font-medium">{reassignTarget.repName}</span>
              </div>
              <div className="flex justify-between mb-1">
                <span className="text-gray-600">Client:</span>
                <span className="font-medium">{reassignTarget.clientName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Slips / boxes:</span>
                <span className="font-medium">{reassignTarget.slips.length} / {reassignTarget.totalBoxes}</span>
              </div>
            </div>

            <label className="block text-xs text-gray-600 mb-1">New Collecting Rep</label>
            <select
              value={reassignRepId}
              onChange={e => {
                setReassignRepId(e.target.value);
                const opt = releaseRepOptions.find(o => o.id === e.target.value);
                setReassignRepName(opt?.label ?? '');
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm mb-3"
            >
              <option value="">Select rep...</option>
              {releaseRepOptions.map(o => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>

            <label className="block text-xs text-gray-600 mb-1">New Rep&apos;s Release Code</label>
            <input
              type="password"
              value={reassignCode}
              onChange={e => setReassignCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
              maxLength={4}
              placeholder="4-char code"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono tracking-widest text-center uppercase mb-4"
              autoComplete="off"
            />

            <div className="flex gap-2">
              <button
                onClick={closeReassign}
                className="flex-1 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleReassign}
                disabled={reassigning || !reassignRepId || !reassignCode.trim()}
                className="flex-1 py-2 bg-[var(--color-primary)] text-white rounded-md text-sm font-bold hover:bg-[#5a9a2e] disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {reassigning && <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                Reassign &amp; Resend
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cancel release modal */}
      {cancelTarget && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4"
          onClick={closeCancel}
        >
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 relative" onClick={e => e.stopPropagation()}>
            <button
              onClick={closeCancel}
              aria-label="Close"
              className="absolute top-3 right-3 text-gray-400 hover:text-gray-700 rounded-md p-1 hover:bg-gray-100"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <h3 className="text-lg font-bold text-gray-900 mb-1 pr-8">Cancel Release</h3>
            <p className="text-sm text-gray-600 mb-4">
              Reverts this release back to <strong>Captured</strong> (in the warehouse, ready to release again)
              and invalidates the delivery note&apos;s QR link. Use this when the rep can no longer do the return.
            </p>

            <div className="bg-red-50 border border-red-200 rounded-md p-3 mb-4 text-xs text-red-700">
              A manager or admin must authorise this — it is recorded in the activity log.
            </div>

            <div className="bg-gray-50 rounded-md p-3 mb-4 text-sm">
              <div className="flex justify-between mb-1">
                <span className="text-gray-600">Current rep:</span>
                <span className="font-medium">{cancelTarget.repName}</span>
              </div>
              <div className="flex justify-between mb-1">
                <span className="text-gray-600">Client:</span>
                <span className="font-medium">{cancelTarget.clientName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Slips / boxes:</span>
                <span className="font-medium">{cancelTarget.slips.length} / {cancelTarget.totalBoxes}</span>
              </div>
            </div>

            {managerOptions.length === 0 ? (
              <div className="bg-amber-50 border border-amber-200 rounded-md p-3 mb-4 text-xs text-amber-800">
                <p className="font-semibold mb-1">No authorising managers are set up yet.</p>
                <p>
                  A cancellation must be authorised by a manager/admin who has a <strong>Release Code</strong>.
                  Set one in <strong>User Management → Edit user → Release Code</strong> for any non-rep user,
                  then come back here.
                </p>
              </div>
            ) : (
              <>
                <label className="block text-xs text-gray-600 mb-1">Authorising Manager</label>
                <select
                  value={cancelManagerId}
                  onChange={e => {
                    setCancelManagerId(e.target.value);
                    const m = managerOptions.find(o => o.id === e.target.value);
                    setCancelManagerName(m ? `${m.name} ${m.surname}` : '');
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm mb-3"
                >
                  <option value="">Select manager...</option>
                  {managerOptions.map(m => (
                    <option key={m.id} value={m.id}>{m.name} {m.surname}</option>
                  ))}
                </select>

                <label className="block text-xs text-gray-600 mb-1">Manager Security Code</label>
                <input
                  type="password"
                  value={cancelCode}
                  onChange={e => setCancelCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
                  maxLength={4}
                  placeholder="4-char code"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono tracking-widest text-center uppercase mb-4"
                  autoComplete="off"
                />
              </>
            )}

            <div className="flex gap-2">
              <button
                onClick={closeCancel}
                className="flex-1 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Keep Release
              </button>
              <button
                onClick={handleCancelRelease}
                disabled={cancelling || managerOptions.length === 0 || !cancelManagerId || !cancelCode.trim()}
                className="flex-1 py-2 bg-red-500 text-white rounded-md text-sm font-bold hover:bg-red-600 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {cancelling && <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                Cancel Release
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
