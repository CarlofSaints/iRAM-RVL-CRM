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
  warehouseCode?: string;
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
  generatedAt?: string;
  bookedAt?: string;
  rows?: Array<{ articleCode: string; description: string; qty: number; val: number }>;
  unreturnedStock?: UnreturnedRow[];
  unreturnedCapturedAt?: string;
  unreturnedSkipped?: boolean;
  manual?: boolean;
  deliveredAt?: string;
  deliverySignedByName?: string;
  deliverySignature?: string;
  deliveredByRepName?: string;
  deliveryNoteSpWebUrl?: string;
}

interface UnreturnedRow {
  articleCode: string;
  description: string;
  pickSlipQty: number;
  display: number;
  storeRefused: number;
  notFound: number;
  damaged: number;
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

interface UserDto {
  id: string;
  name: string;
  surname: string;
  releaseCode?: string;
  role: string;
}

type PageMode = 'receipt' | 'release' | 'view';

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return iso; }
}

function fmtDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    const tz = 'Africa/Johannesburg';
    const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: tz });
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
    return `${date} ${time}`;
  } catch { return iso; }
}

function uuid(): string {
  return crypto.randomUUID();
}

function resolveMode(status: string): PageMode {
  if (status === 'captured' || status === 'failed-release') return 'release';
  if (status === 'in-transit' || status === 'partial-release' || status === 'delivered') return 'view';
  return 'receipt'; // generated, sent, booked
}

const STATUS_BADGE: Record<string, string> = {
  'generated': 'bg-gray-100 text-gray-700',
  'sent': 'bg-blue-100 text-blue-700',
  'booked': 'bg-teal-100 text-teal-700',
  'captured': 'bg-green-100 text-green-700',
  'in-transit': 'bg-purple-100 text-purple-700',
  'failed-release': 'bg-red-100 text-red-700',
  'partial-release': 'bg-red-100 text-red-700',
  'delivered': 'bg-emerald-100 text-emerald-700',
};

const STATUS_LABEL: Record<string, string> = {
  'generated': 'Generated',
  'sent': 'Sent',
  'booked': 'Booked',
  'captured': 'Captured',
  'in-transit': 'In Transit',
  'failed-release': 'Failed Release',
  'partial-release': 'Partial Release',
  'delivered': 'Delivered',
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
  const [releaseUsers, setReleaseUsers] = useState<UserDto[]>([]);
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

  // Manager override for box count mismatch on release
  const [showReleaseCountModal, setShowReleaseCountModal] = useState(false);
  const [managerOverrideCode, setManagerOverrideCode] = useState('');
  const [managerOverrideRepId, setManagerOverrideRepId] = useState('');

  // ── Manual stock capture state (for manual pick slips) ──
  const [showManualCapture, setShowManualCapture] = useState(false);
  const [manualRows, setManualRows] = useState<Array<{ articleCode: string; description: string; qty: number; val: number }>>([]);
  const [savingManual, setSavingManual] = useState(false);

  // ── Unreturned stock capture state ──
  const [showUnreturnedCapture, setShowUnreturnedCapture] = useState(false);
  const [unreturnedRows, setUnreturnedRows] = useState<UnreturnedRow[]>([]);
  const [savingUnreturned, setSavingUnreturned] = useState(false);
  const [showSkipModal, setShowSkipModal] = useState(false);
  const [skipRepId, setSkipRepId] = useState('');
  const [skipRepName, setSkipRepName] = useState('');

  // ── GRN auto-suggest state ──
  const [grnAutoFilled, setGrnAutoFilled] = useState(false);
  const [grnRelatedSlipId, setGrnRelatedSlipId] = useState('');

  const mode: PageMode = slip ? resolveMode(slip.status) : 'receipt';

  // ── Load slip + reps ──
  const loadData = useCallback(async () => {
    if (!session || !slipId) return;
    setLoading(true);
    try {
      const [slipsRes, repsRes, usersRes] = await Promise.all([
        authFetch('/api/pick-slips', { cache: 'no-store' }),
        authFetch('/api/control/reps', { cache: 'no-store' }),
        authFetch('/api/users', { cache: 'no-store' }),
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

      if (usersRes.ok) {
        const usersData = await usersRes.json();
        // Users with release codes (for release dropdown)
        setReleaseUsers((usersData as UserDto[]).filter(u => !!u.releaseCode));
      }
    } catch {
      notify('Failed to load data', 'error');
    } finally {
      setLoading(false);
    }
  }, [session, slipId]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── GRN auto-suggest: check related slips for existing store refs ──
  useEffect(() => {
    if (!slip || !slipId || mode !== 'receipt') return;
    // Only auto-fill if store refs are currently empty
    const hasRefs = storeRefs.some(r => r.trim());
    if (hasRefs) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(`/api/receipts/related-grn?slipId=${encodeURIComponent(slipId)}`, { cache: 'no-store' });
        const data = await res.json();
        if (cancelled) return;
        if (data.storeRefs && data.storeRefs.length > 0) {
          setStoreRefs(data.storeRefs);
          setGrnAutoFilled(true);
          setGrnRelatedSlipId(data.relatedSlipId || '');
        }
      } catch { /* silent — GRN auto-fill is optional */ }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slip?.id, mode]);

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
    const user = releaseUsers.find(u => u.id === repId);
    const match = rep || user;
    setReleaseRepName(match ? `${match.name} ${match.surname}` : '');
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
      const slipWh = (slip.warehouseCode || slip.warehouse || '').toUpperCase().trim();
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
        if (slip.manual) {
          // Manual slips need stock qty/val capture first
          notify('Receipt completed — now enter the actual stock quantities and values');
          const rows = (slip.rows ?? []).map(r => ({
            articleCode: r.articleCode,
            description: r.description,
            qty: r.qty,
            val: r.val,
          }));
          setManualRows(rows);
          setShowManualCapture(true);
        } else {
          notify('Receipt completed — now capture unreturned stock details');
          // Initialize unreturned rows from pick slip products
          const productRows: UnreturnedRow[] = (slip.rows ?? []).map(r => ({
            articleCode: r.articleCode,
            description: r.description,
            pickSlipQty: r.qty,
            display: 0,
            storeRefused: 0,
            notFound: 0,
            damaged: 0,
          }));
          setUnreturnedRows(productRows);
          setShowUnreturnedCapture(true);
        }
      } else {
        notify(data.error || 'Failed to complete', 'error');
      }
    } catch {
      notify('Network error completing receipt', 'error');
    } finally {
      setCompleting(false);
    }
  }

  // ── Unreturned stock capture functions ──
  function updateUnreturnedField(idx: number, field: 'display' | 'storeRefused' | 'notFound' | 'damaged', value: number) {
    setUnreturnedRows(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: Math.max(0, value) };
      return next;
    });
  }

  function collectedQty(row: UnreturnedRow): number {
    return row.pickSlipQty - (row.display + row.storeRefused + row.notFound + row.damaged);
  }

  async function handleSaveUnreturned() {
    if (!slip) return;
    // Validate no negative collected
    for (const row of unreturnedRows) {
      if (collectedQty(row) < 0) {
        notify(`Reason totals exceed pick slip qty for "${row.description}"`, 'error');
        return;
      }
    }
    setSavingUnreturned(true);
    try {
      const res = await authFetch('/api/receipts/unreturned', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slipId: slip.id,
          clientId: slip.clientId,
          loadId: slip.loadId,
          rows: unreturnedRows,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        notify('Unreturned stock capture saved');
        router.push('/aged-stock/receipts');
      } else {
        notify(data.error || 'Save failed', 'error');
      }
    } catch {
      notify('Network error saving unreturned stock', 'error');
    } finally {
      setSavingUnreturned(false);
    }
  }

  // ── Save manual stock capture → then flow into unreturned ──
  async function handleSaveManualCapture() {
    if (!slip) return;
    setSavingManual(true);
    try {
      const res = await authFetch('/api/receipts/manual-capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slipId: slip.id,
          clientId: slip.clientId,
          loadId: slip.loadId,
          rows: manualRows,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        notify('Stock quantities saved — now capture unreturned stock details');
        // Update local slip with the new rows
        const updatedSlip = { ...slip, rows: manualRows, totalQty: manualRows.reduce((s, r) => s + r.qty, 0), totalVal: manualRows.reduce((s, r) => s + r.val, 0) };
        setSlip(updatedSlip);
        setShowManualCapture(false);
        // Flow into unreturned stock capture
        const productRows: UnreturnedRow[] = manualRows
          .filter(r => r.qty > 0)
          .map(r => ({
            articleCode: r.articleCode,
            description: r.description,
            pickSlipQty: r.qty,
            display: 0,
            storeRefused: 0,
            notFound: 0,
            damaged: 0,
          }));
        setUnreturnedRows(productRows);
        setShowUnreturnedCapture(true);
      } else {
        notify(data.error || 'Save failed', 'error');
      }
    } catch {
      notify('Network error saving manual stock capture', 'error');
    } finally {
      setSavingManual(false);
    }
  }

  function updateManualRow(idx: number, field: 'qty' | 'val', value: number) {
    setManualRows(prev => prev.map((r, i) => i === idx ? { ...r, [field]: Math.max(0, value) } : r));
  }

  async function handleSkipUnreturned() {
    if (!slip || !skipRepId) return;
    setSavingUnreturned(true);
    try {
      const res = await authFetch('/api/receipts/unreturned', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slipId: slip.id,
          clientId: slip.clientId,
          loadId: slip.loadId,
          skip: true,
          skipRepId,
          skipRepName,
          skipReason: 'Rep did not return paperwork',
        }),
      });
      const data = await res.json();
      if (res.ok) {
        notify('Capture skipped — managers notified');
        router.push('/aged-stock/receipts');
      } else {
        notify(data.error || 'Skip failed', 'error');
      }
    } catch {
      notify('Network error skipping capture', 'error');
    } finally {
      setSavingUnreturned(false);
      setShowSkipModal(false);
    }
  }

  function onSkipRepChange(repId: string) {
    setSkipRepId(repId);
    const rep = reps.find(r => r.id === repId);
    setSkipRepName(rep ? `${rep.name} ${rep.surname}` : '');
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

    // Validate barcode was received on this slip
    const receiptBarcodes = boxes.map(b => b.stickerBarcode);
    if (!receiptBarcodes.includes(barcode)) {
      notify('The barcode you scanned/entered does not match what was received. Ensure you enter the correct one!', 'error');
      setReleaseScanBarcode('');
      releaseScanRef.current?.focus();
      return;
    }

    addReleaseBox(barcode);
    releaseScanRef.current?.focus();
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
  async function handleRelease(managerCode?: string, managerRepId?: string) {
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

    // Check box count mismatch — require manager override
    const receiptBoxCount = boxes.length;
    if (!managerCode && releaseBoxes.length !== receiptBoxCount && receiptBoxCount > 0) {
      setShowReleaseCountModal(true);
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
          managerOverrideCode: managerCode,
          managerOverrideRepId: managerRepId,
        }),
      });
      const data = await res.json();
      if (data.status === 'in-transit') {
        const spMsg = data.slip?.deliveryNoteSpWebUrl
          ? 'Stock released — delivery note saved to SharePoint'
          : 'Stock released — delivery note generated (no SP folder configured)';
        notify(spMsg);
        router.push('/aged-stock/receipts');
      } else if (data.status === 'partial-release') {
        const spMsg = data.slip?.deliveryNoteSpWebUrl
          ? 'Partial release — delivery note saved to SharePoint'
          : 'Partial release — box count mismatch overridden by manager';
        notify(spMsg);
        router.push('/aged-stock/receipts');
      } else if (data.status === 'failed-release') {
        notify(data.error || 'Release code does not match — status set to Failed Release', 'error');
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
          Back
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
            {showUnreturnedCapture ? 'Unreturned Stock Capture' : mode === 'release' ? 'Release Stock' : mode === 'view' ? 'View Pick Slip' : 'Capture'}
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            {showUnreturnedCapture
              ? 'Record what happened to each product — display, refused, not found, damaged'
              : mode === 'release' && slip.status === 'failed-release'
              ? 'Previous release attempt failed — retry with the correct release code'
              : mode === 'release'
              ? 'Release stock from warehouse for transit back to the vendor'
              : mode === 'view' && slip.releasedAt
              ? `Released on ${fmtDateTime(slip.releasedAt)} by ${slip.releasedByName}`
              : mode === 'view'
              ? `Status: ${STATUS_LABEL[slip.status] || slip.status}`
              : slip.status === 'captured'
              ? `Captured on ${fmtDateTime(slip.receiptedAt!)} by ${slip.receiptedByName}`
              : 'Scan sticker barcodes and capture stock into the warehouse'}
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
      {mode === 'receipt' && !showUnreturnedCapture && !showManualCapture && (
        <>
          {/* GRN auto-fill banner */}
          {grnAutoFilled && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 mb-4 flex items-start gap-3">
              <svg className="w-5 h-5 text-blue-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="flex-1">
                <p className="text-sm font-medium text-blue-800">GRN Auto-Filled</p>
                <p className="text-xs text-blue-600 mt-0.5">
                  Store reference(s) have been pre-filled from related pick slip <strong className="font-mono">{grnRelatedSlipId}</strong> (shared boxes). You can edit or override them.
                </p>
              </div>
              <button
                onClick={() => setGrnAutoFilled(false)}
                className="text-blue-400 hover:text-blue-600 shrink-0 mt-0.5"
                title="Dismiss"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}

          {/* Receipt details form */}
          <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
            <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Receipt Details</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
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
                    <label className="block text-xs text-gray-600 mb-1">Store Reference (GRV/GRN) {i + 1}</label>
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
                    Add Store Reference (GRV/GRN)
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
                      <td className="py-1.5 text-xs text-gray-500">{fmtDateTime(b.scannedAt)}</td>
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
      {/* MANUAL STOCK CAPTURE (shown after receipt for manual pick slips)   */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      {showManualCapture && (
        <>
          <div className="bg-orange-50 border border-orange-200 rounded-lg px-4 py-3 mb-4 flex items-start gap-3">
            <svg className="w-5 h-5 text-orange-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-orange-800">Manual Stock Capture</p>
              <p className="text-xs text-orange-600 mt-0.5">
                This is a manual pick slip. Enter the actual quantity and value for each product that was collected from the store.
              </p>
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
            <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Product Quantities &amp; Values</h2>

            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-xs font-semibold text-gray-600 uppercase tracking-wide border-b border-gray-200">
                    <th className="pb-2 pr-3">Product</th>
                    <th className="pb-2 pr-3">Article Code</th>
                    <th className="pb-2 pr-3 text-center">Qty</th>
                    <th className="pb-2 text-center">Value (R)</th>
                  </tr>
                </thead>
                <tbody>
                  {manualRows.map((row, idx) => (
                    <tr key={idx} className="border-t border-gray-100">
                      <td className="py-2 pr-3 font-medium max-w-[250px] truncate" title={row.description}>{row.description}</td>
                      <td className="py-2 pr-3 font-mono text-gray-600 text-xs">{row.articleCode}</td>
                      <td className="py-2 pr-3">
                        <input
                          type="number"
                          min={0}
                          value={row.qty || ''}
                          onChange={e => updateManualRow(idx, 'qty', parseInt(e.target.value) || 0)}
                          className="w-20 mx-auto block px-1.5 py-1 border border-gray-300 rounded text-sm text-center"
                        />
                      </td>
                      <td className="py-2">
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={row.val || ''}
                          onChange={e => updateManualRow(idx, 'val', parseFloat(e.target.value) || 0)}
                          className="w-24 mx-auto block px-1.5 py-1 border border-gray-300 rounded text-sm text-center"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-3 pt-3 border-t border-gray-100 text-sm text-gray-600">
              Total: <strong>{manualRows.reduce((s, r) => s + r.qty, 0).toLocaleString()}</strong> units
              &nbsp;·&nbsp;
              <strong>R {manualRows.reduce((s, r) => s + r.val, 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleSaveManualCapture}
              disabled={savingManual || manualRows.every(r => r.qty === 0)}
              className="px-5 py-2.5 bg-[var(--color-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {savingManual && <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
              Save &amp; Continue
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
      {/* UNRETURNED STOCK CAPTURE (shown after receipt completes)           */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      {showUnreturnedCapture && (
        <>
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-4 flex items-start gap-3">
            <svg className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-amber-800">Unreturned Stock Capture</p>
              <p className="text-xs text-amber-600 mt-0.5">
                Record what happened to each product at the store. Enter quantities for each reason — collected is auto-calculated.
              </p>
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
            <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Product Breakdown</h2>

            <div className="overflow-x-auto max-h-[65vh] overflow-y-auto">
              <table className="min-w-full text-sm">
                <thead className="sticky top-0 bg-white z-10">
                  <tr className="text-left text-xs font-semibold text-gray-600 uppercase tracking-wide border-b border-gray-200">
                    <th className="pb-2 pr-3">Product</th>
                    <th className="pb-2 pr-3">Article Code</th>
                    <th className="pb-2 pr-3 text-center">Pick Slip Qty</th>
                    <th className="pb-2 pr-3 text-center">Display</th>
                    <th className="pb-2 pr-3 text-center">Store Refused</th>
                    <th className="pb-2 pr-3 text-center">Not Found</th>
                    <th className="pb-2 pr-3 text-center">Damaged</th>
                    <th className="pb-2 text-center">Collected</th>
                  </tr>
                </thead>
                <tbody>
                  {unreturnedRows.map((row, idx) => {
                    const collected = collectedQty(row);
                    const isNeg = collected < 0;
                    return (
                      <tr key={idx} className="border-t border-gray-100">
                        <td className="py-2 pr-3 font-medium max-w-[200px] truncate" title={row.description}>{row.description}</td>
                        <td className="py-2 pr-3 font-mono text-gray-600 text-xs">{row.articleCode}</td>
                        <td className="py-2 pr-3 text-center font-medium">{row.pickSlipQty}</td>
                        <td className="py-2 pr-3">
                          <input type="number" min={0} max={row.pickSlipQty} value={row.display || ''}
                            onChange={e => updateUnreturnedField(idx, 'display', parseInt(e.target.value) || 0)}
                            className="w-16 mx-auto block px-1.5 py-1 border border-gray-300 rounded text-sm text-center" />
                        </td>
                        <td className="py-2 pr-3">
                          <input type="number" min={0} max={row.pickSlipQty} value={row.storeRefused || ''}
                            onChange={e => updateUnreturnedField(idx, 'storeRefused', parseInt(e.target.value) || 0)}
                            className="w-16 mx-auto block px-1.5 py-1 border border-gray-300 rounded text-sm text-center" />
                        </td>
                        <td className="py-2 pr-3">
                          <input type="number" min={0} max={row.pickSlipQty} value={row.notFound || ''}
                            onChange={e => updateUnreturnedField(idx, 'notFound', parseInt(e.target.value) || 0)}
                            className="w-16 mx-auto block px-1.5 py-1 border border-gray-300 rounded text-sm text-center" />
                        </td>
                        <td className="py-2 pr-3">
                          <input type="number" min={0} max={row.pickSlipQty} value={row.damaged || ''}
                            onChange={e => updateUnreturnedField(idx, 'damaged', parseInt(e.target.value) || 0)}
                            className="w-16 mx-auto block px-1.5 py-1 border border-gray-300 rounded text-sm text-center" />
                        </td>
                        <td className={`py-2 text-center font-bold ${isNeg ? 'text-red-600' : 'text-green-700'}`}>
                          {collected}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Unreturned action buttons */}
          <div className="flex gap-3">
            <button
              onClick={handleSaveUnreturned}
              disabled={savingUnreturned || unreturnedRows.some(r => collectedQty(r) < 0)}
              className="px-5 py-2.5 bg-[var(--color-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {savingUnreturned && <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
              Save Capture
            </button>
            <button
              onClick={() => setShowSkipModal(true)}
              className="px-5 py-2.5 border border-amber-300 bg-amber-50 text-amber-700 rounded-lg text-sm font-medium hover:bg-amber-100"
            >
              Skip
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
                  <option value="">Select rep/user...</option>
                  {reps.filter(r => r.releaseCode).map(r => (
                    <option key={r.id} value={r.id}>{r.name} {r.surname} (Rep)</option>
                  ))}
                  {releaseUsers.filter(u => !reps.some(r => r.id === u.id)).map(u => (
                    <option key={u.id} value={u.id}>{u.name} {u.surname}</option>
                  ))}
                </select>
                <span className="text-[10px] text-gray-400 mt-0.5 block">Only reps/users with a release code are shown</span>
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
              <span className="text-sm text-gray-500">{releaseBoxes.length} / {boxes.length} scanned</span>
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

            {/* Receipt barcodes reference */}
            {boxes.length > 0 && (
              <div className="mb-4">
                <p className="text-xs text-gray-500 mb-1.5">Barcodes to match ({boxes.length}):</p>
                <div className="flex flex-wrap gap-1.5">
                  {boxes.map(b => {
                    const matched = releaseBoxes.some(rb => rb.stickerBarcode === b.stickerBarcode);
                    return (
                      <span
                        key={b.id}
                        className={`px-2 py-0.5 rounded text-xs font-mono ${matched ? 'bg-green-100 text-green-700 line-through' : 'bg-gray-100 text-gray-600'}`}
                      >
                        {b.stickerBarcode}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}

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
                      <td className="py-1.5 text-xs text-gray-500">{fmtDateTime(b.scannedAt)}</td>
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
              onClick={() => handleRelease()}
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
                <span className="font-medium">{slip.receiptedAt ? fmtDateTime(slip.receiptedAt) : '—'}</span>
              </div>
              <div>
                <span className="text-gray-500 text-xs block">Receipted By</span>
                <span className="font-medium">{slip.receiptedByName || '—'}</span>
              </div>
            </div>
            {/* Store refs */}
            {storeRefs.filter(r => r.trim()).length > 0 && (
              <div className="mt-3 pt-3 border-t border-gray-100">
                <span className="text-gray-500 text-xs block mb-1">Store References (GRV/GRN)</span>
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
                      <td className="py-1.5 text-xs text-gray-500">{fmtDateTime(b.scannedAt)}</td>
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
                  <span className="font-medium">{fmtDateTime(slip.releasedAt)}</span>
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
                      <td className="py-1.5 text-xs text-gray-500">{fmtDateTime(b.scannedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Delivery confirmation details (read-only, only for delivered slips) */}
          {slip.deliveredAt && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-5 mb-4">
              <h2 className="text-sm font-bold text-emerald-800 uppercase tracking-wide mb-3">Delivery Confirmation</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
                <div>
                  <span className="text-emerald-600 text-xs block">Received By</span>
                  <span className="font-medium">{slip.deliverySignedByName || '—'}</span>
                </div>
                <div>
                  <span className="text-emerald-600 text-xs block">Delivered At</span>
                  <span className="font-medium">{fmtDateTime(slip.deliveredAt)}</span>
                </div>
                <div>
                  <span className="text-emerald-600 text-xs block">Confirmed By Rep</span>
                  <span className="font-medium">{slip.deliveredByRepName || '—'}</span>
                </div>
                {slip.deliveryNoteSpWebUrl && (
                  <div>
                    <span className="text-emerald-600 text-xs block">Delivery Note</span>
                    <a href={slip.deliveryNoteSpWebUrl} target="_blank" rel="noopener noreferrer" className="text-emerald-700 font-medium hover:underline text-xs">
                      View PDF
                    </a>
                  </div>
                )}
              </div>
              {slip.deliverySignature && (
                <div className="mt-4 pt-3 border-t border-emerald-200">
                  <span className="text-emerald-600 text-xs block mb-2">Signature</span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={slip.deliverySignature} alt="Delivery signature" className="max-w-[300px] h-auto border border-emerald-200 rounded bg-white p-1" />
                </div>
              )}
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

      {/* ── Skip Unreturned Stock Modal ────────────────────────────────────── */}
      {showSkipModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-bold text-gray-900 mb-2">Skip Unreturned Stock Capture</h2>
            <p className="text-sm text-gray-600 mb-4">
              An email will be sent to all RVL Managers notifying them that this capture was skipped.
            </p>
            <div className="flex flex-col gap-3 mb-4">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Rep who did not return paperwork <span className="text-red-500">*</span></label>
                <select
                  value={skipRepId}
                  onChange={e => onSkipRepChange(e.target.value)}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm"
                >
                  <option value="">Select rep...</option>
                  {reps.map(r => (
                    <option key={r.id} value={r.id}>{r.name} {r.surname}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Reason</label>
                <select disabled className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm bg-gray-50 text-gray-500">
                  <option>Rep did not return paperwork</option>
                </select>
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleSkipUnreturned}
                disabled={savingUnreturned || !skipRepId}
                className="px-4 py-2 bg-amber-500 text-white rounded-lg text-sm font-medium hover:bg-amber-600 disabled:opacity-50 flex items-center gap-2"
              >
                {savingUnreturned && <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                Confirm Skip
              </button>
              <button
                onClick={() => setShowSkipModal(false)}
                className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Release Box Count Mismatch — Manager Override Modal ──────────── */}
      {showReleaseCountModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-bold text-red-700 mb-2">Box Count Mismatch</h2>
            <p className="text-sm text-gray-600 mb-1">
              <strong>{boxes.length}</strong> box{boxes.length !== 1 ? 'es were' : ' was'} received, but you are releasing <strong>{releaseBoxes.length}</strong>.
            </p>
            <p className="text-sm text-gray-600 mb-4">
              An RVL Manager must authorize this partial release. The slip will be marked as <span className="text-red-600 font-bold">Partial Release</span>.
            </p>
            <div className="flex flex-col gap-3 mb-4">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Manager</label>
                <select
                  value={managerOverrideRepId}
                  onChange={e => setManagerOverrideRepId(e.target.value)}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm"
                >
                  <option value="">Select manager...</option>
                  {releaseUsers.filter(u => u.role === 'rvl-manager' || u.role === 'super-admin').map(u => (
                    <option key={u.id} value={u.id}>{u.name} {u.surname}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Manager Release Code</label>
                <input
                  type="password"
                  value={managerOverrideCode}
                  onChange={e => setManagerOverrideCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
                  maxLength={4}
                  placeholder="4-char code"
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm font-mono tracking-widest"
                />
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => {
                  if (!managerOverrideRepId || !managerOverrideCode.trim()) {
                    notify('Select a manager and enter their release code', 'error');
                    return;
                  }
                  setShowReleaseCountModal(false);
                  handleRelease(managerOverrideCode.trim(), managerOverrideRepId);
                }}
                disabled={releasing || !managerOverrideRepId || managerOverrideCode.length !== 4}
                className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
              >
                {releasing && <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                Authorize Partial Release
              </button>
              <button
                onClick={() => {
                  setShowReleaseCountModal(false);
                  setManagerOverrideCode('');
                  setManagerOverrideRepId('');
                }}
                className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
