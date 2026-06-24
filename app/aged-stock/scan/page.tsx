'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SlipSummary {
  id: string;
  loadId: string;
  clientId: string;
  clientName: string;
  vendorNumber: string;
  siteCode: string;
  siteName: string;
  warehouse: string;
  warehouseCode: string;
  totalQty: number;
  totalVal: number;
  status: string;
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtCurrency(v: number): string {
  return `R ${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Decode base64 PDF string and trigger browser download + print dialog */
function downloadAndPrintPdf(base64: string, filename: string) {
  const byteChars = atob(base64);
  const byteNums = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteNums[i] = byteChars.charCodeAt(i);
  }
  const blob = new Blob([new Uint8Array(byteNums)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);

  // Trigger download
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // Also open in new tab for printing
  window.open(url, '_blank');
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ScanPage() {
  const { session } = useAuth('scan_stock');

  const [toast, setToast] = useState<ToastData | null>(null);
  const notify = (message: string, type: 'success' | 'error' = 'success') =>
    setToast({ message, type });

  // Step 1: Pick slip lookup — multi-slip with per-slip box count
  const [slipQuery, setSlipQuery] = useState('');
  const [slipLoading, setSlipLoading] = useState(false);
  const [slips, setSlips] = useState<SlipSummary[]>([]);
  const [slipError, setSlipError] = useState('');
  const slipInputRef = useRef<HTMLInputElement>(null);

  // Per-slip box counts: slipId → number
  const [boxCounts, setBoxCounts] = useState<Record<string, number>>({});

  // Step 2: Rep, security code
  const [reps, setReps] = useState<RepDto[]>([]);
  const [users, setUsers] = useState<UserDto[]>([]);
  const [selectedRepId, setSelectedRepId] = useState('');
  const [securityCode, setSecurityCode] = useState('');
  // Sticker print format for this booking (rep chooses roll vs A4 sheet)
  const [bookFormat, setBookFormat] = useState<'roll' | 'a4sheet'>('roll');

  // Submit
  const [booking, setBooking] = useState(false);

  // Nothing to return modal
  const [showNtrModal, setShowNtrModal] = useState(false);
  const [ntrRepId, setNtrRepId] = useState('');
  const [ntrSecurityCode, setNtrSecurityCode] = useState('');
  const [ntrSubmitting, setNtrSubmitting] = useState(false);

  // Add boxes to an already-booked slip (wrong box count was entered at booking)
  const [addBoxesSlip, setAddBoxesSlip] = useState<(SlipSummary & { currentBoxes: number }) | null>(null);
  const [addBoxCount, setAddBoxCount] = useState('');
  const [addRepId, setAddRepId] = useState('');
  const [addSecurityCode, setAddSecurityCode] = useState('');
  const [addingBoxes, setAddingBoxes] = useState(false);

  // ── Load reps + users on mount ──
  const loadRepsAndUsers = useCallback(async () => {
    try {
      const [repsRes, usersRes] = await Promise.all([
        authFetch('/api/control/reps', { cache: 'no-store' }),
        authFetch('/api/users', { cache: 'no-store' }),
      ]);
      if (repsRes.ok) {
        const data = await repsRes.json();
        setReps(Array.isArray(data) ? data : []);
      }
      if (usersRes.ok) {
        const data = await usersRes.json();
        setUsers((data as UserDto[]).filter(u => !!u.releaseCode));
      }
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    if (session) loadRepsAndUsers();
  }, [session, loadRepsAndUsers]);

  // ── Lookup and add a pick slip ──
  async function addSlip() {
    const query = slipQuery.trim();
    if (!query) return;

    // Already adding boxes to a booked slip — finish or cancel that first
    if (addBoxesSlip) {
      setSlipError('Finish adding boxes to the booked slip, or cancel, before scanning another');
      setSlipQuery('');
      return;
    }

    // Check if already added
    if (slips.some(s => s.id === query)) {
      setSlipError(`Pick slip ${query} is already added`);
      setSlipQuery('');
      return;
    }

    setSlipLoading(true);
    setSlipError('');

    try {
      const res = await authFetch(`/api/scan/lookup-slip?slipId=${encodeURIComponent(query)}`, { cache: 'no-store' });
      const data = await res.json();

      if (!data.found) {
        setSlipError(data.error || 'Pick slip not found');
      } else if (data.addable && data.slip) {
        // Slip is already booked — switch into "add more boxes" mode.
        // Only allowed when no in-progress booking is on screen.
        if (slips.length > 0) {
          setSlipError('Clear the current booking before adding boxes to an already-booked slip');
          setSlipQuery('');
        } else {
          setAddBoxesSlip(data.slip as SlipSummary & { currentBoxes: number });
          setSlipQuery('');
          setSlipError('');
        }
      } else if (!data.bookable) {
        setSlipError(data.error || `Pick slip status "${data.status}" is not bookable`);
      } else {
        const newSlip = data.slip as SlipSummary;
        setSlips(prev => [...prev, newSlip]);
        setBoxCounts(prev => ({ ...prev, [newSlip.id]: 1 }));
        setSlipQuery('');
        setSlipError('');
        // Focus back on input for next scan
        setTimeout(() => slipInputRef.current?.focus(), 50);
      }
    } catch {
      setSlipError('Network error — please try again');
    } finally {
      setSlipLoading(false);
    }
  }

  function removeSlip(slipId: string) {
    setSlips(prev => prev.filter(s => s.id !== slipId));
    setBoxCounts(prev => {
      const next = { ...prev };
      delete next[slipId];
      return next;
    });
  }

  function clearAll() {
    setSlips([]);
    setSlipQuery('');
    setSlipError('');
    setBoxCounts({});
    setSelectedRepId('');
    setSecurityCode('');
  }

  function onSlipKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addSlip();
    }
  }

  function updateBoxCount(slipId: string, value: string) {
    const num = parseInt(value, 10);
    setBoxCounts(prev => ({
      ...prev,
      [slipId]: isNaN(num) || num < 1 ? 1 : num,
    }));
  }

  // ── Book stock + print stickers ──
  async function handleBook() {
    if (slips.length === 0) return;

    if (!selectedRepId) {
      notify('Select a rep', 'error');
      return;
    }
    if (!securityCode.trim()) {
      notify('Enter the security code', 'error');
      return;
    }

    // Validate all slips have box counts
    for (const slip of slips) {
      const count = boxCounts[slip.id] || 0;
      if (count < 1) {
        notify(`Enter a box count for ${slip.id}`, 'error');
        return;
      }
    }

    setBooking(true);
    try {
      const res = await authFetch('/api/scan/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slips: slips.map(s => ({
            slipId: s.id,
            clientId: s.clientId,
            loadId: s.loadId,
            boxCount: boxCounts[s.id] || 1,
          })),
          repId: selectedRepId,
          securityCode: securityCode.trim(),
          format: bookFormat,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        const slipCount = slips.length;
        const totalBoxes = slips.reduce((sum, s) => sum + (boxCounts[s.id] || 1), 0);
        notify(
          slipCount === 1
            ? `Stock booked — ${totalBoxes} sticker${totalBoxes !== 1 ? 's' : ''} generated`
            : `${slipCount} pick slips booked — ${totalBoxes} stickers generated`
        );

        // Download + print the sticker PDF
        if (data.pdfBase64) {
          const filename = `Stickers-${new Date().toISOString().slice(0, 10)}-${totalBoxes}pcs.pdf`;
          downloadAndPrintPdf(data.pdfBase64, filename);
        }

        clearAll();
        setTimeout(() => slipInputRef.current?.focus(), 100);
      } else {
        notify(data.error || 'Booking failed', 'error');
      }
    } catch {
      notify('Network error booking stock', 'error');
    } finally {
      setBooking(false);
    }
  }

  // ── Nothing to return ──
  async function handleNothingToReturn() {
    if (slips.length === 0) return;
    if (!ntrRepId) {
      notify('Select a rep', 'error');
      return;
    }
    if (ntrSecurityCode.trim().length !== 4) {
      notify('Enter the 4-character release code', 'error');
      return;
    }

    setNtrSubmitting(true);
    try {
      const res = await authFetch('/api/scan/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slips: slips.map(s => ({
            slipId: s.id,
            clientId: s.clientId,
            loadId: s.loadId,
            boxCount: 0,
          })),
          repId: ntrRepId,
          securityCode: ntrSecurityCode.trim(),
          nothingToReturn: true,
          format: bookFormat,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        const slipCount = slips.length;
        notify(slipCount === 1 ? 'Booked as nothing to return' : `${slipCount} pick slips booked as nothing to return`);
        setShowNtrModal(false);
        setNtrRepId('');
        setNtrSecurityCode('');
        clearAll();
        setTimeout(() => slipInputRef.current?.focus(), 100);
      } else {
        notify(data.error || 'Booking failed', 'error');
      }
    } catch {
      notify('Network error booking stock', 'error');
    } finally {
      setNtrSubmitting(false);
    }
  }

  // ── Add boxes to an already-booked slip ──
  function cancelAddBoxes() {
    setAddBoxesSlip(null);
    setAddBoxCount('');
    setAddRepId('');
    setAddSecurityCode('');
    setSlipQuery('');
    setSlipError('');
  }

  async function handleAddBoxes() {
    if (!addBoxesSlip) return;
    const count = parseInt(addBoxCount, 10);
    if (!count || count < 1) {
      notify('Enter how many more boxes to add', 'error');
      return;
    }
    if (!addRepId) {
      notify('Select a rep', 'error');
      return;
    }
    if (addSecurityCode.trim().length !== 4) {
      notify('Enter the 4-character release code', 'error');
      return;
    }

    setAddingBoxes(true);
    try {
      const res = await authFetch('/api/scan/add-boxes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slipId: addBoxesSlip.id,
          clientId: addBoxesSlip.clientId,
          loadId: addBoxesSlip.loadId,
          additionalBoxes: count,
          repId: addRepId,
          securityCode: addSecurityCode.trim(),
          format: bookFormat,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        notify(`${data.addedBoxes} sticker${data.addedBoxes !== 1 ? 's' : ''} added — ${data.totalBoxes} boxes total`);
        if (data.pdfBase64) {
          const filename = `Stickers-${addBoxesSlip.id}-additional-${data.addedBoxes}pcs.pdf`;
          downloadAndPrintPdf(data.pdfBase64, filename);
        }
        cancelAddBoxes();
        setTimeout(() => slipInputRef.current?.focus(), 100);
      } else {
        notify(data.error || 'Failed to add boxes', 'error');
      }
    } catch {
      notify('Network error adding boxes', 'error');
    } finally {
      setAddingBoxes(false);
    }
  }

  // Combined rep/user options for dropdown — only those with release codes
  const repOptions = [
    ...reps.filter(r => r.releaseCode).map(r => ({
      id: r.id,
      label: `${r.name} ${r.surname} (Rep)`,
    })),
    ...users.filter(u => !reps.some(r => r.id === u.id)).map(u => ({
      id: u.id,
      label: `${u.name} ${u.surname}`,
    })),
  ];

  const allBoxCountsValid = slips.length > 0 && slips.every(s => (boxCounts[s.id] || 0) >= 1);
  const canBook = slips.length > 0 && selectedRepId && securityCode.trim().length === 4 && allBoxCountsValid;

  // Totals across all slips
  const totalQty = slips.reduce((sum, s) => sum + s.totalQty, 0);
  const totalVal = slips.reduce((sum, s) => sum + s.totalVal, 0);
  const totalBoxes = slips.reduce((sum, s) => sum + (boxCounts[s.id] || 1), 0);

  if (!session) return null;

  return (
    <>
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Book Stock into WH</h1>
        <p className="text-sm text-gray-600 mt-1">
          Scan picking slips, enter box counts, and print pre-filled sticker labels
        </p>
      </div>

      {/* Step 1: Scan Picking Slips */}
      <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
        <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-1">Step 1: Scan Picking Slips</h2>
        <p className="text-xs text-gray-500 mb-3">Scan one or more Uplift Instructions Forms. Re-scan an already-booked slip to print additional box stickers.</p>

        <div className="flex gap-3 items-end">
          <div className="flex-1">
            <label className="block text-xs text-gray-600 mb-1">Pick Slip ID</label>
            <input
              ref={slipInputRef}
              type="text"
              value={slipQuery}
              onChange={e => setSlipQuery(e.target.value)}
              onKeyDown={onSlipKeyDown}
              placeholder="PS-1234-20260101-001"
              className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm font-mono"
              autoFocus
            />
          </div>
          <button
            onClick={addSlip}
            disabled={slipLoading || !slipQuery.trim()}
            className="px-4 py-1.5 bg-[var(--color-primary)] text-white rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
          >
            {slipLoading && <div className="h-3.5 w-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            Add Slip
          </button>
          {slips.length > 0 && (
            <>
              <button
                onClick={() => { setNtrRepId(''); setNtrSecurityCode(''); setShowNtrModal(true); }}
                className="px-4 py-1.5 bg-amber-500 text-white rounded-md text-sm font-medium hover:bg-amber-600"
              >
                Nothing to Return
              </button>
              <button
                onClick={clearAll}
                className="px-4 py-1.5 border border-gray-300 text-gray-600 rounded-md text-sm font-medium hover:bg-gray-50"
              >
                Clear All
              </button>
            </>
          )}
        </div>

        {slipError && (
          <div className="mt-3 px-3 py-2 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">
            {slipError}
          </div>
        )}

        {/* List of added slips with per-slip box count */}
        {slips.length > 0 && (
          <div className="mt-4">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              {slips.length} Pick Slip{slips.length !== 1 ? 's' : ''} Added
            </div>
            <div className="space-y-2">
              {slips.map(s => (
                <div key={s.id} className="flex items-center gap-3 px-3 py-2 bg-green-50 border border-green-200 rounded-md">
                  <div className="flex-1 min-w-0">
                    <span className="font-mono font-medium text-sm">{s.id}</span>
                    <span className="text-xs text-gray-500 ml-2">{s.clientName} &middot; {s.siteName}</span>
                  </div>
                  <span className="text-xs text-gray-500 shrink-0">{s.totalQty.toLocaleString()} units</span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <label className="text-xs text-gray-500">Boxes:</label>
                    <input
                      type="number"
                      min={1}
                      value={boxCounts[s.id] || ''}
                      onChange={e => updateBoxCount(s.id, e.target.value)}
                      className="w-16 px-1.5 py-0.5 border border-gray-300 rounded text-sm text-center"
                    />
                  </div>
                  <button
                    onClick={() => removeSlip(s.id)}
                    title="Remove slip"
                    className="text-red-400 hover:text-red-600 shrink-0"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
            {slips.length > 0 && (
              <div className="mt-2 text-xs text-gray-500 text-right">
                Total stickers to print: <span className="font-semibold text-gray-700">{totalBoxes}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Add Boxes to an already-booked slip */}
      {addBoxesSlip && (
        <div className="bg-white border border-amber-300 rounded-lg p-5 mb-4">
          <div className="flex items-start gap-3 mb-4">
            <svg className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <h2 className="text-sm font-bold text-amber-800 uppercase tracking-wide">Add Boxes to Booked Slip</h2>
              <p className="text-xs text-amber-600 mt-0.5">
                This slip is already booked with {addBoxesSlip.currentBoxes} box{addBoxesSlip.currentBoxes !== 1 ? 'es' : ''}.
                Print additional stickers if too few boxes were entered at booking. New labels continue the box numbering.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mb-4">
            <div>
              <span className="text-gray-500 text-xs block">Document No</span>
              <span className="font-mono font-medium">{addBoxesSlip.id}</span>
            </div>
            <div>
              <span className="text-gray-500 text-xs block">Principal</span>
              <span className="font-medium">{addBoxesSlip.clientName}</span>
            </div>
            <div>
              <span className="text-gray-500 text-xs block">Store</span>
              <span className="font-medium">{addBoxesSlip.siteName} - {addBoxesSlip.siteCode}</span>
            </div>
            <div>
              <span className="text-gray-500 text-xs block">Current Boxes</span>
              <span className="font-medium">{addBoxesSlip.currentBoxes}</span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div>
              <label className="block text-xs text-gray-600 mb-1">Additional Boxes <span className="text-red-500">*</span></label>
              <input
                type="number"
                min={1}
                value={addBoxCount}
                onChange={e => setAddBoxCount(e.target.value)}
                placeholder="How many more?"
                className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Select Rep <span className="text-red-500">*</span></label>
              <select
                value={addRepId}
                onChange={e => setAddRepId(e.target.value)}
                className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm"
              >
                <option value="">{repOptions.length === 0 ? 'No reps with release codes' : 'Select rep/user...'}</option>
                {repOptions.map(r => (
                  <option key={r.id} value={r.id}>{r.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Security Code <span className="text-red-500">*</span></label>
              <input
                type="password"
                autoComplete="new-password"
                value={addSecurityCode}
                onChange={e => setAddSecurityCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
                maxLength={4}
                placeholder=""
                className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm font-mono tracking-widest"
              />
              <span className="text-[10px] text-gray-400 mt-0.5 block">The rep must provide their 4-character release code</span>
            </div>
          </div>

          <div className="flex items-center gap-2 mb-4">
            <label className="text-xs font-medium text-gray-600">Sticker Format:</label>
            <select
              value={bookFormat}
              onChange={e => setBookFormat(e.target.value as 'roll' | 'a4sheet')}
              className="px-2.5 py-1.5 border border-gray-300 rounded-md text-sm"
            >
              <option value="roll">Roll (thermal)</option>
              <option value="a4sheet">A4 Sheet</option>
            </select>
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleAddBoxes}
              disabled={addingBoxes}
              className="px-5 py-2.5 bg-amber-500 text-white rounded-lg text-sm font-medium hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {addingBoxes && <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
              Print Additional Stickers
            </button>
            <button
              onClick={cancelAddBoxes}
              className="px-5 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Slip details summary (shown when slips added) */}
      {slips.length > 0 && (
        <>
          <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
            <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">
              {slips.length === 1 ? 'Pick Slip Details' : 'Combined Pick Slip Details'}
            </h2>
            {slips.length === 1 ? (
              // Single slip — show full detail
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div>
                  <span className="text-gray-500 text-xs block">Principal</span>
                  <span className="font-medium">{slips[0].clientName}</span>
                </div>
                <div>
                  <span className="text-gray-500 text-xs block">Vendor Number</span>
                  <span className="font-medium">{slips[0].vendorNumber}</span>
                </div>
                <div>
                  <span className="text-gray-500 text-xs block">Document No</span>
                  <span className="font-mono font-medium">{slips[0].id}</span>
                </div>
                <div>
                  <span className="text-gray-500 text-xs block">Store</span>
                  <span className="font-medium">{slips[0].siteName} - {slips[0].siteCode}</span>
                </div>
                <div>
                  <span className="text-gray-500 text-xs block">Warehouse</span>
                  <span className="font-medium">{slips[0].warehouse}</span>
                </div>
                <div>
                  <span className="text-gray-500 text-xs block">Total Qty</span>
                  <span className="font-medium">{slips[0].totalQty.toLocaleString()}</span>
                </div>
                <div>
                  <span className="text-gray-500 text-xs block">Total Value</span>
                  <span className="font-medium">{fmtCurrency(slips[0].totalVal)}</span>
                </div>
                <div>
                  <span className="text-gray-500 text-xs block">Status</span>
                  <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
                    {slips[0].status.charAt(0).toUpperCase() + slips[0].status.slice(1)}
                  </span>
                </div>
              </div>
            ) : (
              // Multi-slip — show summary table
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs font-semibold text-gray-600 uppercase tracking-wide border-b border-gray-200">
                      <th className="pb-2 pr-3">Slip ID</th>
                      <th className="pb-2 pr-3">Principal</th>
                      <th className="pb-2 pr-3">Store</th>
                      <th className="pb-2 pr-3">Warehouse</th>
                      <th className="pb-2 pr-3 text-right">Qty</th>
                      <th className="pb-2 text-right">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slips.map(s => (
                      <tr key={s.id} className="border-t border-gray-100">
                        <td className="py-1.5 pr-3 font-mono font-medium">{s.id}</td>
                        <td className="py-1.5 pr-3">{s.clientName}</td>
                        <td className="py-1.5 pr-3">{s.siteName}</td>
                        <td className="py-1.5 pr-3">{s.warehouse}</td>
                        <td className="py-1.5 pr-3 text-right">{s.totalQty.toLocaleString()}</td>
                        <td className="py-1.5 text-right">{fmtCurrency(s.totalVal)}</td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-gray-300 font-bold">
                      <td className="py-1.5 pr-3" colSpan={4}>Totals</td>
                      <td className="py-1.5 pr-3 text-right">{totalQty.toLocaleString()}</td>
                      <td className="py-1.5 text-right">{fmtCurrency(totalVal)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Step 2: Rep, Security Code */}
          <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
            <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Step 2: Verify Identity</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Select Rep <span className="text-red-500">*</span></label>
                <select
                  value={selectedRepId}
                  onChange={e => setSelectedRepId(e.target.value)}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm"
                >
                  <option value="">{repOptions.length === 0 ? 'No reps with release codes' : 'Select rep/user...'}</option>
                  {repOptions.map(r => (
                    <option key={r.id} value={r.id}>{r.label}</option>
                  ))}
                </select>
                <span className="text-[10px] text-gray-400 mt-0.5 block">Only reps/users with a release code are shown</span>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Security Code <span className="text-red-500">*</span></label>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={securityCode}
                  onChange={e => setSecurityCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
                  maxLength={4}
                  placeholder=""
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm font-mono tracking-widest"
                />
                <span className="text-[10px] text-gray-400 mt-0.5 block">The rep must provide their 4-character release code</span>
              </div>
            </div>
          </div>

          {/* Sticker format for this booking */}
          <div className="flex items-center gap-2 mb-3">
            <label className="text-xs font-medium text-gray-600">Sticker Format:</label>
            <select
              value={bookFormat}
              onChange={e => setBookFormat(e.target.value as 'roll' | 'a4sheet')}
              className="px-2.5 py-1.5 border border-gray-300 rounded-md text-sm"
            >
              <option value="roll">Roll (thermal)</option>
              <option value="a4sheet">A4 Sheet</option>
            </select>
          </div>

          {/* Print Stickers & Book button */}
          <div className="flex gap-3">
            <button
              onClick={handleBook}
              disabled={booking || !canBook}
              className="px-5 py-2.5 bg-[var(--color-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {booking && <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 011.913-.247m10.5 0a48.536 48.536 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18.75 12h.008v.008h-.008V12zm-2.25 0h.008v.008H16.5V12z" />
              </svg>
              Print Stickers &amp; Book{slips.length > 1 ? ` (${slips.length} Slips)` : ''}
            </button>
            <button
              onClick={clearAll}
              className="px-5 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </>
      )}

      {/* ── Nothing to Return Modal ─────────────────────────────────────── */}
      {showNtrModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-bold text-gray-900 mb-2">Nothing to Return</h2>
            <p className="text-sm text-gray-600 mb-4">
              The rep visited the store but found no stock to collect. This will book the pick slip{slips.length > 1 ? 's' : ''} with zero boxes so it can proceed to capture.
            </p>

            <div className="flex flex-col gap-3 mb-5">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Select Rep <span className="text-red-500">*</span></label>
                <select
                  value={ntrRepId}
                  onChange={e => setNtrRepId(e.target.value)}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm"
                >
                  <option value="">{repOptions.length === 0 ? 'No reps with release codes' : 'Select rep/user...'}</option>
                  {repOptions.map(r => (
                    <option key={r.id} value={r.id}>{r.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Release Code <span className="text-red-500">*</span></label>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={ntrSecurityCode}
                  onChange={e => setNtrSecurityCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
                  maxLength={4}
                  placeholder=""
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm font-mono tracking-widest"
                />
                <span className="text-[10px] text-gray-400 mt-0.5 block">The rep must provide their 4-character release code</span>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleNothingToReturn}
                disabled={ntrSubmitting || !ntrRepId || ntrSecurityCode.trim().length !== 4}
                className="px-4 py-2 bg-amber-500 text-white rounded-lg text-sm font-medium hover:bg-amber-600 disabled:opacity-50 flex items-center gap-2"
              >
                {ntrSubmitting && <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                Confirm
              </button>
              <button
                onClick={() => setShowNtrModal(false)}
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
