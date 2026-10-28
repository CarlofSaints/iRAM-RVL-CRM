'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useAuth, authFetch } from '@/lib/useAuth';
import {
  TAL_STAGES, TAL_STATUS_LABELS, TAL_REGIONS, regionOf, talStage, openSlots, expectedUnits, normCode, returnFormAnswers,
  type TalBooking, type TalScan, type TalUnit, type TalRegion,
} from '@/lib/talShared';
import TalApproval from './TalApproval';

interface Person { id: string; name: string; surname: string; releaseCode?: string }
interface Warehouse { id: string; name: string }
interface Popup { kind: 'ok' | 'deny' | 'missing'; title: string; lines: string[]; noteAt?: string }
/** A scan on the list. `key` tells no-RRN rows apart; `brn` is shown on unit-by-unit steps. */
type Row = TalScan & { key: string; brn?: string; ticket?: string };
type Moved = { bookingId: string; brn: string; region?: TalRegion; supplierName?: string; unit: TalUnit };

const input = 'px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[var(--color-primary)] outline-none';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });

export default function TalScanPage() {
  return <Suspense><TalScanInner /></Suspense>;
}

function TalScanInner() {
  const { session } = useAuth('scan_stock');
  const stage = talStage(useSearchParams().get('stage') ?? '') ?? TAL_STAGES[0];
  const unitMode = !!stage.anyBooking;
  const canManage = (session?.permissions ?? []).includes('manage_pick_slips');

  const [booking, setBooking] = useState<TalBooking | null>(null);
  const [lookup, setLookup] = useState('');
  const [currentIn, setCurrentIn] = useState('');
  const [inInput, setInInput] = useState('');
  const [rrnInput, setRrnInput] = useState('');
  const [noRrnDesc, setNoRrnDesc] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [busy, setBusy] = useState(false);

  const [people, setPeople] = useState<Person[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [repId, setRepId] = useState('');
  const [securityCode, setSecurityCode] = useState('');
  const [warehouseId, setWarehouseId] = useState('');

  // Return to TAL: answers for Takealot's delivery form, per ticket, after a save.
  const [deliveryDate, setDeliveryDate] = useState(today());
  const [vehicleReg, setVehicleReg] = useState('');
  const [returned, setReturned] = useState<Moved[]>([]);

  const inRef = useRef<HTMLInputElement>(null);
  const rrnRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const keySeq = useRef(0);
  const newKey = () => `k${++keySeq.current}`;

  // The scanner's trailing Enter must not land on the pop-up button and close it
  // unseen, so the button only takes focus once that keystroke is over.
  useEffect(() => {
    if (!popup) return;
    (document.activeElement as HTMLElement | null)?.blur();
    const t = setTimeout(() => okRef.current?.focus(), 400);
    return () => clearTimeout(t);
  }, [popup]);

  // A new stage is a new scan session.
  useEffect(() => { setBooking(null); setRows([]); setCurrentIn(''); setLookup(''); setReturned([]); }, [stage.key]);

  useEffect(() => {
    if (!session || !stage.needsRepAndWarehouse) return;
    Promise.all([
      authFetch('/api/control/reps', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : [])),
      authFetch('/api/users', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : [])),
      authFetch('/api/control/warehouses', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : [])),
    ]).then(([reps, users, whs]) => {
      setPeople([...(Array.isArray(reps) ? reps : []), ...(Array.isArray(users) ? users : []).filter((u: Person) => !!u.releaseCode)]);
      setWarehouses(Array.isArray(whs) ? whs : []);
    });
  }, [session, stage.needsRepAndWarehouse]);

  const deny = (title: string, ...lines: string[]) => setPopup({ kind: 'deny', title, lines });
  const focusRrn = () => setTimeout(() => rrnRef.current?.focus(), 0);

  const scannedOn = (ins: string) => rows.filter((s) => s.instructionNo === ins).length;
  const expectedOn = (b: TalBooking, ins: string) =>
    stage.from === null ? Math.max(0, openSlots(b, ins)) : expectedUnits(b, stage).filter((u) => u.instructionNo === ins).length;

  // ── Per-booking steps ─────────────────────────────────────────────────────
  const findBooking = async () => {
    const code = normCode(lookup);
    setLookup('');
    if (!code) return;
    if (rows.length && booking) return deny('Save or clear this booking first', `You have ${rows.length} unsaved scan(s) on ${booking.brn}.`);
    const res = await authFetch(`/api/tal?code=${encodeURIComponent(code)}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return deny('Not found', data.error || `Nothing found for ${code}`);
    const b: TalBooking = data.booking;
    setBooking(b);
    // BSC Drop-off: the whole booking goes, so everything at iRam is listed at once.
    if (stage.key === 'receipt_bsc') {
      const all = expectedUnits(b, stage);
      if (!all.length) return deny('Nothing to drop off', `Booking ${b.brn} has no units "${TAL_STATUS_LABELS.receipted_iram}".`);
      setRows(all.map((u) => ({ key: newKey(), instructionNo: u.instructionNo, rrn: u.rrn, noRrn: u.noRrn, description: u.description })));
      return;
    }
    const fromUnit = b.units.find((u) => u.rrn === code)?.instructionNo;
    const ins = fromUnit ?? (b.instructions.some((i) => i.instructionNo === code) ? code : '');
    setCurrentIn(ins);
    setTimeout(() => (ins ? rrnRef : inRef).current?.focus(), 0);
  };

  const pickIn = () => {
    const code = normCode(inInput);
    setInInput('');
    if (!code) return;
    if (booking && !booking.instructions.some((i) => i.instructionNo === code)) {
      return deny('Wrong instruction', `${code} is not on booking ${booking.brn}.`);
    }
    setCurrentIn(code);
    focusRrn();
  };

  const add = (row: Omit<Row, 'key'>) => {
    setRows((s) => [...s, { ...row, key: newKey() }]);
    focusRrn();
  };

  const scanRrnOnBooking = () => {
    const rrn = normCode(rrnInput);
    setRrnInput('');
    if (!booking || !rrn) return;
    if (!currentIn) return deny('Scan the instruction number first');
    if (rows.some((s) => s.rrn === rrn)) return deny('Already scanned', `${rrn} is already on this list.`);
    const unit = booking.units.find((u) => u.rrn === rrn);
    if (stage.from === null) {
      if (unit) return deny('Already collected', `${rrn} was already scanned on instruction ${unit.instructionNo}.`);
      if (scannedOn(currentIn) >= expectedOn(booking, currentIn)) {
        return deny('Too many units', `Instruction ${currentIn} has only ${expectedOn(booking, currentIn)} unit(s) left to collect.`);
      }
    } else {
      if (!unit) return deny('Does not match', `${rrn} is not on booking ${booking.brn}.`);
      if (unit.instructionNo !== currentIn) return deny('Wrong instruction', `${rrn} belongs to instruction ${unit.instructionNo}, not ${currentIn}.`);
      if (unit.status !== stage.from) {
        return deny('Wrong status', `${rrn} is "${TAL_STATUS_LABELS[unit.status]}". This step needs "${TAL_STATUS_LABELS[stage.from]}".`);
      }
    }
    add({ instructionNo: currentIn, rrn });
  };

  // ── Unit-by-unit steps (any booking) ──────────────────────────────────────
  const scanRrnAnyBooking = async () => {
    const rrn = normCode(rrnInput);
    setRrnInput('');
    if (!rrn) return;
    if (rows.some((s) => s.rrn === rrn)) return deny('Already scanned', `${rrn} is already on this list.`);
    const res = await authFetch(`/api/tal/scan?stage=${stage.key}&code=${encodeURIComponent(rrn)}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return deny('Not found', data.error || `${rrn} is not on any booking`);
    const unit: TalUnit = data.unit;
    if (unit.status !== stage.from) {
      return deny('Wrong status', `${rrn} is "${TAL_STATUS_LABELS[unit.status]}". This step needs "${TAL_STATUS_LABELS[stage.from!]}".`);
    }
    if (stage.needsTicket && !unit.returnTicket) {
      return deny('No Takealot approval yet', `${rrn} has no Zendesk ticket. Load Takealot's approval email above first.`);
    }
    add({ instructionNo: unit.instructionNo, rrn, brn: data.brn, description: unit.description, ticket: unit.returnTicket });
  };

  const addNoRrn = () => {
    const description = noRrnDesc.trim();
    if (!currentIn) return deny('Scan the instruction number first', 'A product with no RRN is matched on its Instruction Nr.');
    if (!description) return deny('Describe the product', 'Type what the product is, e.g. "Bosch angle grinder GWS 700".');
    if (booking && stage.from === null && scannedOn(currentIn) >= expectedOn(booking, currentIn)) {
      return deny('Too many units', `Instruction ${currentIn} has only ${expectedOn(booking, currentIn)} unit(s) left to collect.`);
    }
    add({ instructionNo: currentIn, rrn: '', noRrn: true, description });
    setNoRrnDesc('');
  };

  // ── Save ──────────────────────────────────────────────────────────────────
  const payload = (extra: object) => JSON.stringify({
    stage: stage.key, repId, securityCode, warehouseId, ...extra,
    scans: rows.map(({ instructionNo, rrn, noRrn, description, rejected }) => ({ instructionNo, rrn, noRrn, description, rejected })),
  });
  const post = (dryRun: boolean) =>
    authFetch(unitMode ? '/api/tal/scan' : `/api/tal/${booking!.id}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload({ dryRun }),
    }).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }));

  type Missing = { instructionNo: string; rrn?: string; count: number };
  const missingLines = (m: Missing[]) =>
    m.map((x) => (x.rrn ? `${x.rrn.startsWith('NO-RRN-') ? 'No-RRN product' : x.rrn} (instruction ${x.instructionNo})` : `Instruction ${x.instructionNo}: ${x.count} unit(s)`));

  const check = async () => {
    if (!rows.length) return;
    if (stage.needsRepAndWarehouse && (!repId || !securityCode || !warehouseId)) {
      return deny('Rep and warehouse needed', 'Choose the collecting rep, enter their code and choose the warehouse.');
    }
    if (unitMode) return save();
    setBusy(true);
    const { ok, data } = await post(true);
    setBusy(false);
    if (!ok) return deny('Cannot save', ...(data.errors ?? [data.error ?? 'Check failed']));
    if (data.missing?.length) {
      return setPopup({ kind: 'missing', title: stage.partialExpected ? 'Not everything is going' : 'Units are missing', lines: missingLines(data.missing) });
    }
    await save();
  };

  const save = async () => {
    setBusy(true);
    const { ok, data } = await post(false);
    setBusy(false);
    if (!ok) return deny('Cannot save', ...(data.errors ?? [data.error ?? 'Save failed']));
    const rejected = rows.filter((r) => r.rejected).length;
    const n = rows.length - rejected;
    if (unitMode) {
      const moved: Moved[] = data.moved ?? [];
      if (stage.key === 'return_tal') setReturned(moved);
      setPopup({
        kind: 'ok', title: `${moved.length} unit(s) now "${TAL_STATUS_LABELS[stage.to]}"`,
        lines: [...new Set(moved.map((m) => m.brn))].map((brn) => `Booking ${brn}: ${moved.filter((m) => m.brn === brn).length}`),
      });
    } else {
      const missing: Missing[] = data.missing ?? [];
      const b: TalBooking = data.booking;
      setPopup({
        kind: 'ok',
        title: `${n} unit(s) now "${TAL_STATUS_LABELS[stage.to]}"${rejected ? `, ${rejected} rejected` : ''}`,
        lines: missing.length
          ? [stage.from === null ? 'Not found at TAL:' : `Still "${TAL_STATUS_LABELS[stage.from]}":`, ...missingLines(missing)]
          : ['Everything expected was scanned.'],
        noteAt: stage.key === 'receipt_bsc' ? b.history[b.history.length - 1]?.at : undefined,
      });
      setBooking(b);
    }
    setRows([]); setSecurityCode('');
  };

  /** Opened as a blob: the API needs the auth header, which a plain link cannot send. */
  const openDeliveryNote = async (at: string) => {
    if (!booking) return;
    const res = await authFetch(`/api/tal/${booking.id}/delivery-note?at=${encodeURIComponent(at)}`);
    if (!res.ok) return deny('No delivery note', (await res.json().catch(() => ({}))).error || 'Could not make the delivery note');
    const url = URL.createObjectURL(await res.blob());
    if (!window.open(url, '_blank')) {
      const a = document.createElement('a');
      a.href = url; a.download = `${booking.brn} - BSC drop-off.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
    }
  };

  const forms = returned.length
    ? returnFormAnswers(returned.map((m) => m.unit), {
      deliveryDate, vehicleReg, region: returned[0].region ?? 'GAU', supplierName: returned[0].supplierName?.replace(/\s*\(?pty\)?\s*ltd\.?/i, ''),
    })
    : [];

  const scanBox = (
    <div className="bg-white rounded-xl border border-gray-200 p-5 grid grid-cols-2 gap-4">
      {!unitMode && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-gray-700">2. Scan Instruction Nr. on the product</span>
          <input ref={inRef} value={inInput} onChange={(e) => setInInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pickIn()}
            placeholder={currentIn || 'Instruction'} className={`${input} font-mono`} />
        </label>
      )}
      <label className={`flex flex-col gap-1 text-sm ${unitMode ? 'col-span-2' : ''}`}>
        <span className="font-medium text-gray-700">{unitMode ? 'Scan the RRN on each unit' : '3. Scan RRN'}</span>
        <input ref={rrnRef} value={rrnInput} onChange={(e) => setRrnInput(e.target.value)} autoFocus={unitMode}
          onKeyDown={(e) => e.key === 'Enter' && (unitMode ? scanRrnAnyBooking() : scanRrnOnBooking())} placeholder="RRN-…" className={`${input} font-mono`} />
      </label>
      {stage.key !== 'receipt_bsc' && (
        <div className="col-span-2 flex flex-wrap items-end gap-3 border-t border-gray-100 pt-4">
          <span className="text-sm font-medium text-gray-700 w-full">No RRN on the product?</span>
          {unitMode && (
            <input ref={inRef} value={inInput} onChange={(e) => setInInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pickIn()}
              placeholder={currentIn || 'Scan its Instruction Nr.'} aria-label="Instruction number" className={`${input} font-mono w-56`} />
          )}
          <input value={noRrnDesc} onChange={(e) => setNoRrnDesc(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addNoRrn()}
            placeholder={`Product description${currentIn ? ` (instruction ${currentIn})` : ''}`} aria-label="Product description"
            className={`${input} flex-1 min-w-64`} />
          <button onClick={addNoRrn} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 hover:bg-gray-50">Add as “No RRN on Product”</button>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-5 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Takealot: {stage.label}</h1>
        <p className="text-sm text-gray-500">
          Scanned units move from “{stage.from ? TAL_STATUS_LABELS[stage.from] : TAL_STATUS_LABELS.booking_received}” to “{TAL_STATUS_LABELS[stage.to]}”.
          {unitMode && ' Scan units from any booking, one by one.'}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {TAL_STAGES.map((s, i) => (
          <Link key={s.key} href={`/tal/scan?stage=${s.key}`}
            className={`px-3 py-1.5 rounded-lg text-sm border ${s.key === stage.key ? 'bg-[var(--color-primary)] text-white border-transparent' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}>
            {i + 2}. {s.label}
          </Link>
        ))}
      </div>

      {stage.key === 'return_tal' && canManage && <TalApproval />}

      {!unitMode && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col gap-3">
          <label className="text-sm font-medium text-gray-700">1. Scan the Booking Reference (or an Instruction / RRN barcode)</label>
          <input value={lookup} onChange={(e) => setLookup(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && findBooking()}
            placeholder="TALBQ…" className={`${input} font-mono w-96`} autoFocus />
          {booking && (
            <div className="text-sm text-gray-600">
              Booking <Link href={`/tal/${booking.id}`} className="font-mono text-[var(--color-primary)] hover:underline">{booking.brn}</Link>
              {booking.bookingDate && <> · {booking.bookingDate.split('-').reverse().join('/')}</>}
              {booking.timeSlot && <> {booking.timeSlot}</>}
              {' · '}{stage.key === 'receipt_bsc'
                ? [TAL_REGIONS[regionOf(booking)].bsc, TAL_REGIONS[regionOf(booking)].bscAddress].filter(Boolean).join(', ')
                : TAL_REGIONS[regionOf(booking)].tal}
              {rows.length > 0 && <button onClick={() => setRows([])} className="ml-4 text-red-600 hover:underline">Clear {rows.length} unsaved scan(s)</button>}
            </div>
          )}
        </div>
      )}

      {!unitMode && booking && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-gray-600">
              <tr>
                <th className="px-4 py-2">Instruction</th>
                <th className="px-4 py-2 text-right">Booked</th>
                <th className="px-4 py-2 text-right">Expected now</th>
                <th className="px-4 py-2 text-right">Scanned</th>
              </tr>
            </thead>
            <tbody>
              {booking.instructions.map((i) => {
                const exp = expectedOn(booking, i.instructionNo);
                const got = scannedOn(i.instructionNo);
                const active = i.instructionNo === currentIn;
                return (
                  <tr key={i.instructionNo} onClick={() => { setCurrentIn(i.instructionNo); rrnRef.current?.focus(); }}
                    className={`border-t border-gray-100 cursor-pointer ${active ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                    <td className="px-4 py-2 font-mono">{active ? '▶ ' : ''}{i.instructionNo}</td>
                    <td className="px-4 py-2 text-right">{i.qty}</td>
                    <td className="px-4 py-2 text-right">{exp}</td>
                    <td className={`px-4 py-2 text-right font-medium ${got === exp && exp > 0 ? 'text-emerald-600' : got ? 'text-amber-600' : 'text-gray-400'}`}>{got}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(unitMode || (booking && stage.key !== 'receipt_bsc')) && scanBox}

      {rows.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
          {stage.key === 'receipt_bsc' && (
            <div className="px-4 py-2 text-sm text-gray-600 border-b border-gray-100">
              Everything on this booking that is at iRam. Remove anything that is not going to BSC.
            </div>
          )}
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-gray-600">
              <tr>
                {unitMode && <th className="px-4 py-2">Booking</th>}
                <th className="px-4 py-2">Instruction</th>
                <th className="px-4 py-2">RRN</th>
                <th className="px-4 py-2">Description</th>
                {stage.key === 'return_tal' && <th className="px-4 py-2">Zendesk ticket</th>}
                {stage.key === 'collect_tal' && <th className="px-4 py-2">Rejected – New/Unopened</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.key} className="border-t border-gray-100">
                  {unitMode && <td className="px-4 py-2 font-mono">{s.brn ?? '—'}</td>}
                  <td className="px-4 py-2 font-mono">{s.instructionNo}</td>
                  <td className="px-4 py-2 font-mono">{s.noRrn ? <span className="text-amber-700">No RRN on Product</span> : s.rrn}</td>
                  <td className="px-4 py-2">{s.description || '—'}</td>
                  {stage.key === 'return_tal' && <td className="px-4 py-2 font-mono">{s.ticket}</td>}
                  {stage.key === 'collect_tal' && (
                    <td className="px-4 py-2">
                      <input type="checkbox" checked={!!s.rejected} aria-label={`Rejected new/unopened ${s.rrn || s.description}`}
                        onChange={() => setRows((x) => x.map((y) => (y.key === s.key ? { ...y, rejected: !y.rejected } : y)))} />
                    </td>
                  )}
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => setRows((x) => x.filter((y) => y.key !== s.key))} className="text-red-600 hover:underline">Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {stage.needsRepAndWarehouse && (unitMode || booking) && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 grid grid-cols-3 gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-gray-700">Collecting rep</span>
            <select value={repId} onChange={(e) => setRepId(e.target.value)} className={input}>
              <option value="">Choose…</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name} {p.surname}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-gray-700">Rep code</span>
            <input type="password" value={securityCode} onChange={(e) => setSecurityCode(e.target.value)} className={input} autoComplete="off" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-gray-700">Receiving warehouse</span>
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className={input}>
              <option value="">Choose…</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
        </div>
      )}

      {stage.key === 'return_tal' && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-gray-700">Delivery date (for Takealot’s form)</span>
            <input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} className={input} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-gray-700">Vehicle registration</span>
            <input value={vehicleReg} onChange={(e) => setVehicleReg(e.target.value.toUpperCase())} placeholder="e.g. MH89NXGP" className={`${input} font-mono`} />
          </label>
        </div>
      )}

      {(unitMode || booking) && (
        <div className="flex justify-end">
          <button onClick={check} disabled={busy || !rows.length}
            className="px-5 py-2 rounded-lg text-sm font-medium bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-50">
            {busy ? 'Checking…' : `Save ${rows.length} unit(s)`}
          </button>
        </div>
      )}

      {forms.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col gap-4">
          <div>
            <div className="text-sm font-semibold text-gray-700">Answers for Takealot’s “Dispute Delivery Schedule” form</div>
            <p className="text-xs text-gray-500">One form per Zendesk ticket. Flow does not know barcodes, so fill in Item Barcode yourself.</p>
          </div>
          {forms.map((f) => (
            <div key={f.ticket} className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Ticket #{f.ticket}</span>
                <button onClick={() => navigator.clipboard.writeText(f.text)} className="px-3 py-1 rounded-lg text-xs font-medium border border-gray-300 hover:bg-gray-50">Copy</button>
              </div>
              <pre className="text-xs bg-gray-50 border border-gray-200 rounded-lg p-3 whitespace-pre-wrap">{f.text}</pre>
            </div>
          ))}
        </div>
      )}

      {popup && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className={`w-full max-w-md rounded-xl shadow-xl p-6 text-white ${popup.kind === 'ok' ? 'bg-emerald-600' : popup.kind === 'missing' && stage.partialExpected ? 'bg-amber-600' : 'bg-red-600'}`}>
            <div className="text-xl font-bold mb-2">{popup.kind === 'ok' ? '✓ ' : '✕ '}{popup.title}</div>
            {popup.lines.map((l, i) => <div key={i} className="text-sm">{l}</div>)}
            {popup.kind === 'missing' && (
              <div className="text-sm mt-3 opacity-90">
                {stage.from === null
                  ? 'They will show as Not found at TAL and can still be collected on a later visit.'
                  : 'Units not scanned stay where they are.'}
              </div>
            )}
            <div className="flex justify-end gap-2 mt-5">
              {popup.noteAt && (
                <button onClick={() => openDeliveryNote(popup.noteAt!)} className="px-4 py-2 rounded-lg text-sm font-medium bg-white/20 hover:bg-white/30">
                  Open delivery note
                </button>
              )}
              {popup.kind === 'missing' && (
                <button onClick={() => { setPopup(null); save(); }} className="px-4 py-2 rounded-lg text-sm font-medium bg-white/20 hover:bg-white/30">
                  Save anyway
                </button>
              )}
              <button ref={okRef} onClick={() => { setPopup(null); focusRrn(); }}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-900 hover:bg-gray-100">
                {popup.kind === 'missing' ? 'Keep scanning' : 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
