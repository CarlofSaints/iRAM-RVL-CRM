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

interface ScannedBox {
  id: string;
  stickerBarcode: string;
  scannedAt: string;
  valid: boolean;
  error?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID();
}

function fmtCurrency(v: number): string {
  return `R ${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ScanPage() {
  const { session } = useAuth('scan_stock');

  const [toast, setToast] = useState<ToastData | null>(null);
  const notify = (message: string, type: 'success' | 'error' = 'success') =>
    setToast({ message, type });

  // Step 1: Pick slip lookup — multi-slip
  const [slipQuery, setSlipQuery] = useState('');
  const [slipLoading, setSlipLoading] = useState(false);
  const [slips, setSlips] = useState<SlipSummary[]>([]);
  const [slipError, setSlipError] = useState('');
  const slipInputRef = useRef<HTMLInputElement>(null);

  // Step 2: Rep, security code, box count
  const [reps, setReps] = useState<RepDto[]>([]);
  const [users, setUsers] = useState<UserDto[]>([]);
  const [selectedRepId, setSelectedRepId] = useState('');
  const [securityCode, setSecurityCode] = useState('');
  const [boxCount, setBoxCount] = useState('');

  // Step 3: Box scanning
  const [boxes, setBoxes] = useState<ScannedBox[]>([]);
  const [boxScanBarcode, setBoxScanBarcode] = useState('');
  const [boxScanLoading, setBoxScanLoading] = useState(false);
  const boxScanRef = useRef<HTMLInputElement>(null);

  // Submit
  const [booking, setBooking] = useState(false);

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
      } else if (!data.bookable) {
        setSlipError(data.error || `Pick slip status "${data.status}" is not bookable`);
      } else {
        const newSlip = data.slip as SlipSummary;
        setSlips(prev => [...prev, newSlip]);
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
  }

  function clearAll() {
    setSlips([]);
    setSlipQuery('');
    setSlipError('');
    setBoxes([]);
    setSelectedRepId('');
    setSecurityCode('');
    setBoxCount('');
  }

  function onSlipKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addSlip();
    }
  }

  // ── Box scanning ──
  async function handleBoxScan() {
    const barcode = boxScanBarcode.trim().toUpperCase();
    if (!barcode || slips.length === 0) return;

    // Client-side duplicate check
    if (boxes.some(b => b.stickerBarcode === barcode && b.valid)) {
      notify('This barcode is already scanned', 'error');
      setBoxScanBarcode('');
      boxScanRef.current?.focus();
      return;
    }

    setBoxScanLoading(true);
    try {
      const res = await authFetch(`/api/receipts/lookup?barcode=${encodeURIComponent(barcode)}`, { cache: 'no-store' });
      const data = await res.json();

      if (!data.found) {
        const box: ScannedBox = {
          id: uuid(),
          stickerBarcode: barcode,
          scannedAt: new Date().toISOString(),
          valid: false,
          error: 'Barcode not found in the system',
        };
        setBoxes(prev => [...prev, box]);
        notify(`Barcode "${barcode}" not found`, 'error');
      } else {
        // Check if linked to a slip that's NOT one of our currently selected slips
        const currentSlipIds = new Set(slips.map(s => s.id));
        const linkedIds: string[] = data.linkedPickSlipIds ?? (data.linkedPickSlipId ? [data.linkedPickSlipId] : []);
        const foreignLinks = linkedIds.filter(id => !currentSlipIds.has(id));

        if (foreignLinks.length > 0) {
          const box: ScannedBox = {
            id: uuid(),
            stickerBarcode: barcode,
            scannedAt: new Date().toISOString(),
            valid: false,
            error: `Already linked to ${foreignLinks.join(', ')}`,
          };
          setBoxes(prev => [...prev, box]);
          notify(`Barcode already linked to ${foreignLinks.join(', ')}`, 'error');
        } else {
          // Check warehouse match against ALL slips
          const stickerWh = (data.warehouseCode || '').toUpperCase().trim();
          const warehouseWarnings: string[] = [];
          for (const slip of slips) {
            const slipWh = (slip.warehouseCode || '').toUpperCase().trim();
            if (stickerWh && slipWh && stickerWh !== slipWh) {
              warehouseWarnings.push(`${slip.id}: sticker=${data.warehouseCode}, slip=${slip.warehouse}`);
            }
          }

          const warehouseWarning = warehouseWarnings.length > 0
            ? `Warehouse mismatch: ${warehouseWarnings.join('; ')}`
            : undefined;

          const box: ScannedBox = {
            id: uuid(),
            stickerBarcode: barcode,
            scannedAt: new Date().toISOString(),
            valid: true,
            error: warehouseWarning,
          };
          setBoxes(prev => [...prev, box]);
          if (warehouseWarning) {
            notify(`Box ${barcode} added (warehouse mismatch warning)`, 'error');
          } else {
            notify(`Box ${barcode} added`);
          }
        }
      }
    } catch {
      notify('Network error scanning barcode', 'error');
    } finally {
      setBoxScanBarcode('');
      setBoxScanLoading(false);
      boxScanRef.current?.focus();
    }
  }

  function onBoxScanKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleBoxScan();
    }
  }

  function removeBox(boxId: string) {
    setBoxes(prev => prev.filter(b => b.id !== boxId));
  }

  // ── Book stock ──
  async function handleBook() {
    if (slips.length === 0) return;

    const validBoxes = boxes.filter(b => b.valid);
    if (validBoxes.length === 0) {
      notify('Scan at least one valid box before booking', 'error');
      return;
    }
    if (!selectedRepId) {
      notify('Select a rep', 'error');
      return;
    }
    if (!securityCode.trim()) {
      notify('Enter the security code', 'error');
      return;
    }

    const expectedCount = boxCount ? Number(boxCount) : 0;
    if (expectedCount > 0 && expectedCount !== validBoxes.length) {
      const proceed = confirm(
        `You entered ${boxCount} boxes expected but scanned ${validBoxes.length} valid box${validBoxes.length !== 1 ? 'es' : ''}. Book anyway?`
      );
      if (!proceed) return;
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
          })),
          repId: selectedRepId,
          securityCode: securityCode.trim(),
          boxes: validBoxes.map(b => ({
            id: b.id,
            stickerBarcode: b.stickerBarcode,
            scannedAt: b.scannedAt,
          })),
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        const slipCount = slips.length;
        notify(slipCount === 1 ? 'Stock booked successfully' : `${slipCount} pick slips booked successfully`);
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

  const validBoxCount = boxes.filter(b => b.valid).length;
  const canBook = slips.length > 0 && selectedRepId && securityCode.trim().length === 4 && validBoxCount > 0;

  // Totals across all slips
  const totalQty = slips.reduce((sum, s) => sum + s.totalQty, 0);
  const totalVal = slips.reduce((sum, s) => sum + s.totalVal, 0);

  if (!session) return null;

  return (
    <>
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Scan to Receive/Release</h1>
        <p className="text-sm text-gray-600 mt-1">
          Scan picking slip barcodes, link sticker boxes, and book stock into the warehouse
        </p>
      </div>

      {/* Step 1: Scan Picking Slips */}
      <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
        <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-1">Step 1: Scan Picking Slips</h2>
        <p className="text-xs text-gray-500 mb-3">Scan one or more Uplift Instructions Forms</p>

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
            <button
              onClick={clearAll}
              className="px-4 py-1.5 border border-gray-300 text-gray-600 rounded-md text-sm font-medium hover:bg-gray-50"
            >
              Clear All
            </button>
          )}
        </div>

        {slipError && (
          <div className="mt-3 px-3 py-2 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">
            {slipError}
          </div>
        )}

        {/* List of added slips */}
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
          </div>
        )}
      </div>

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

          {/* Step 2: Rep, Security Code, Box Count */}
          <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
            <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Step 2: Verify Identity</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
                  value={securityCode}
                  onChange={e => setSecurityCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
                  maxLength={4}
                  placeholder="4-char code"
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm font-mono tracking-widest"
                />
                <span className="text-[10px] text-gray-400 mt-0.5 block">The rep must provide their 4-character release code</span>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Number of Boxes</label>
                <input
                  type="number"
                  min={1}
                  value={boxCount}
                  onChange={e => setBoxCount(e.target.value)}
                  placeholder="Expected box count"
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm"
                />
                <span className="text-[10px] text-gray-400 mt-0.5 block">Optional — warns if scanned count differs</span>
              </div>
            </div>
          </div>

          {/* Step 3: Box Scanning */}
          <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">Step 3: Scan Boxes</h2>
                <p className="text-xs text-gray-500 mt-0.5">Scan each sticker barcode on the boxes</p>
              </div>
              <span className="text-sm text-gray-500">
                {validBoxCount} valid
                {boxes.length > validBoxCount && (
                  <span className="text-red-500 ml-1">({boxes.length - validBoxCount} error{boxes.length - validBoxCount !== 1 ? 's' : ''})</span>
                )}
                {boxCount && Number(boxCount) > 0 && (
                  <> / {boxCount} expected</>
                )}
              </span>
            </div>

            <div className="flex gap-3 mb-4 items-end">
              <div className="flex-1">
                <label className="block text-xs text-gray-600 mb-1">Scan Box Sticker Barcode</label>
                <input
                  ref={boxScanRef}
                  type="text"
                  value={boxScanBarcode}
                  onChange={e => setBoxScanBarcode(e.target.value)}
                  onKeyDown={onBoxScanKeyDown}
                  placeholder="STK-GAU-0001"
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm font-mono"
                />
              </div>
              <button
                onClick={handleBoxScan}
                disabled={boxScanLoading || !boxScanBarcode.trim()}
                className="px-4 py-1.5 bg-[var(--color-primary)] text-white rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
              >
                {boxScanLoading && <div className="h-3.5 w-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                Scan
              </button>
            </div>

            {boxes.length > 0 ? (
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-xs font-semibold text-gray-600 uppercase tracking-wide border-b border-gray-200">
                    <th className="pb-2">#</th>
                    <th className="pb-2">Box Number</th>
                    <th className="pb-2">Status</th>
                    <th className="pb-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {boxes.map((b, i) => (
                    <tr key={b.id} className={`border-t border-gray-100 ${!b.valid ? 'bg-red-50' : ''}`}>
                      <td className="py-1.5 text-gray-400">{i + 1}</td>
                      <td className="py-1.5 font-mono font-medium">{b.stickerBarcode}</td>
                      <td className="py-1.5">
                        {b.valid ? (
                          <span className="inline-flex items-center gap-1 text-green-600 text-xs font-medium">
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                            Valid
                            {b.error && <span className="text-amber-600 ml-1">({b.error})</span>}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-red-600 text-xs font-medium">
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                            {b.error || 'Invalid'}
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 text-center">
                        <button
                          onClick={() => removeBox(b.id)}
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

          {/* Book Stock button */}
          <div className="flex gap-3">
            <button
              onClick={handleBook}
              disabled={booking || !canBook}
              className="px-5 py-2.5 bg-[var(--color-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {booking && <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
              Book Stock{slips.length > 1 ? ` (${slips.length} Slips)` : ''}
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
    </>
  );
}
