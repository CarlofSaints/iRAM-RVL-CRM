'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useAuth, authFetch } from '@/lib/useAuth';
import {
  TAL_STAGES, TAL_STATUS_LABELS, TAL_REGIONS, regionOf, talStage, openSlots, expectedUnits, normCode,
  type TalBooking, type TalScan,
} from '@/lib/talShared';

interface Person { id: string; name: string; surname: string; releaseCode?: string }
interface Warehouse { id: string; name: string }
interface Popup { kind: 'ok' | 'deny' | 'missing'; title: string; lines: string[] }

const input = 'px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[var(--color-primary)] outline-none';

export default function TalScanPage() {
  return <Suspense><TalScanInner /></Suspense>;
}

function TalScanInner() {
  const { session } = useAuth('scan_stock');
  const stage = talStage(useSearchParams().get('stage') ?? '') ?? TAL_STAGES[0];

  const [booking, setBooking] = useState<TalBooking | null>(null);
  const [lookup, setLookup] = useState('');
  const [currentIn, setCurrentIn] = useState('');
  const [inInput, setInInput] = useState('');
  const [rrnInput, setRrnInput] = useState('');
  const [pendingRrn, setPendingRrn] = useState('');
  const [serialInput, setSerialInput] = useState('');
  const [scans, setScans] = useState<TalScan[]>([]);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [busy, setBusy] = useState(false);

  const [people, setPeople] = useState<Person[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [repId, setRepId] = useState('');
  const [securityCode, setSecurityCode] = useState('');
  const [warehouseId, setWarehouseId] = useState('');

  const inRef = useRef<HTMLInputElement>(null);
  const rrnRef = useRef<HTMLInputElement>(null);
  const serialRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  // The scanner's trailing Enter must not land on the pop-up button and close it
  // unseen, so the button only takes focus once that keystroke is over.
  useEffect(() => {
    if (!popup) return;
    (document.activeElement as HTMLElement | null)?.blur();
    const t = setTimeout(() => okRef.current?.focus(), 400);
    return () => clearTimeout(t);
  }, [popup]);

  // A new stage is a new scan session.
  useEffect(() => { setBooking(null); setScans([]); setCurrentIn(''); setPendingRrn(''); setLookup(''); }, [stage.key]);

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

  const scannedOn = (ins: string) => scans.filter((s) => s.instructionNo === ins).length;
  const expectedOn = (b: TalBooking, ins: string) =>
    stage.from === null ? Math.max(0, openSlots(b, ins)) : expectedUnits(b, stage).filter((u) => u.instructionNo === ins).length;

  const findBooking = async () => {
    const code = normCode(lookup);
    setLookup('');
    if (!code) return;
    if (scans.length && booking) return deny('Save or clear this booking first', `You have ${scans.length} unsaved scan(s) on ${booking.brn}.`);
    const res = await authFetch(`/api/tal?code=${encodeURIComponent(code)}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return deny('Not found', data.error || `Nothing found for ${code}`);
    const b: TalBooking = data.booking;
    if (stage.needsTicket && !b.returnTicket) {
      return deny('No Zendesk ticket yet', `Booking ${b.brn} has no Zendesk ticket number. Add it on the booking page once Takealot approves the return.`);
    }
    setBooking(b);
    // A half-scanned unit (RRN waiting for its serial) belongs to the old booking.
    setPendingRrn(''); setSerialInput('');
    const fromUnit = b.units.find((u) => u.rrn === code)?.instructionNo;
    const ins = fromUnit ?? (b.instructions.some((i) => i.instructionNo === code) ? code : '');
    setCurrentIn(ins);
    setTimeout(() => (ins ? rrnRef : inRef).current?.focus(), 0);
  };

  const pickIn = () => {
    const code = normCode(inInput);
    setInInput('');
    if (!booking || !code) return;
    if (!booking.instructions.some((i) => i.instructionNo === code)) {
      return deny('Wrong instruction', `${code} is not on booking ${booking.brn}.`);
    }
    setCurrentIn(code);
    setTimeout(() => rrnRef.current?.focus(), 0);
  };

  const add = (scan: TalScan) => {
    setScans((s) => [...s, scan]);
    setPendingRrn(''); setSerialInput('');
    setTimeout(() => rrnRef.current?.focus(), 0);
  };

  const scanRrn = () => {
    const rrn = normCode(rrnInput);
    setRrnInput('');
    if (!booking || !rrn) return;
    if (!currentIn) return deny('Scan the instruction number first');
    if (scans.some((s) => s.rrn === rrn)) return deny('Already scanned', `${rrn} is already on this list.`);
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
    if (stage.serial) {
      setPendingRrn(rrn);
      setTimeout(() => serialRef.current?.focus(), 0);
      return;
    }
    add({ instructionNo: currentIn, rrn });
  };

  const scanSerial = () => {
    const serial = normCode(serialInput);
    if (!booking || !pendingRrn || !serial) return;
    const captured = booking.units.find((u) => u.rrn === pendingRrn)?.serial;
    if (stage.serial === 'match' && captured && captured !== serial) {
      setSerialInput('');
      return deny('Serial does not match', `${pendingRrn} was collected with serial ${captured}.`, `Scanned: ${serial}`);
    }
    add({ instructionNo: currentIn, rrn: pendingRrn, serial });
  };

  const post = (dryRun: boolean) =>
    authFetch(`/api/tal/${booking!.id}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: stage.key, scans, repId, securityCode, warehouseId, dryRun }),
    }).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }));

  type Missing = { instructionNo: string; rrn?: string; count: number };
  const missingLines = (m: Missing[]) =>
    m.map((x) => (x.rrn ? `${x.rrn} (instruction ${x.instructionNo})` : `Instruction ${x.instructionNo}: ${x.count} unit(s)`));

  const check = async () => {
    if (!booking || !scans.length) return;
    if (stage.needsRepAndWarehouse && (!repId || !securityCode || !warehouseId)) {
      return deny('Rep and warehouse needed', 'Choose the collecting rep, enter their code and choose the warehouse.');
    }
    setBusy(true);
    const { ok, data } = await post(true);
    setBusy(false);
    if (!ok) return deny('Cannot save', ...(data.errors ?? [data.error ?? 'Check failed']));
    if (data.missing?.length) {
      return setPopup({
        kind: 'missing',
        title: stage.partialExpected ? 'Not everything is being collected' : 'Units are missing',
        lines: missingLines(data.missing),
      });
    }
    await save();
  };

  const save = async () => {
    setBusy(true);
    const { ok, data } = await post(false);
    setBusy(false);
    if (!ok) return deny('Cannot save', ...(data.errors ?? [data.error ?? 'Save failed']));
    const missing: Missing[] = data.missing ?? [];
    setPopup({
      kind: 'ok',
      title: `${scans.length} unit(s) now "${TAL_STATUS_LABELS[stage.to]}"`,
      lines: missing.length
        ? [stage.from === null ? 'Not found at TAL:' : `Still "${TAL_STATUS_LABELS[stage.from]}":`, ...missingLines(missing)]
        : ['Everything expected was scanned.'],
    });
    setBooking(data.booking);
    setScans([]); setSecurityCode('');
  };

  return (
    <div className="flex flex-col gap-5 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Takealot: {stage.label}</h1>
        <p className="text-sm text-gray-500">
          Scanned units move from “{stage.from ? TAL_STATUS_LABELS[stage.from] : TAL_STATUS_LABELS.booking_received}” to “{TAL_STATUS_LABELS[stage.to]}”.
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

      <div className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col gap-3">
        <label className="text-sm font-medium text-gray-700">1. Scan the Booking Reference (or an Instruction / RRN barcode)</label>
        <input value={lookup} onChange={(e) => setLookup(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && findBooking()}
          placeholder="TALBQ…" className={`${input} font-mono w-96`} autoFocus />
        {booking && (
          <div className="text-sm text-gray-600">
            Booking <Link href={`/tal/${booking.id}`} className="font-mono text-[var(--color-primary)] hover:underline">{booking.brn}</Link>
            {booking.bookingDate && <> · {booking.bookingDate.split('-').reverse().join('/')}</>}
            {booking.timeSlot && <> {booking.timeSlot}</>}
            {' · '}{stage.key === 'receipt_bsc' || stage.key === 'collect_bsc' ? TAL_REGIONS[regionOf(booking)].bsc : TAL_REGIONS[regionOf(booking)].tal}
            {booking.returnTicket && <> · Zendesk ticket <span className="font-mono">{booking.returnTicket}</span></>}
            {scans.length > 0 && <button onClick={() => setScans([])} className="ml-4 text-red-600 hover:underline">Clear {scans.length} unsaved scan(s)</button>}
          </div>
        )}
      </div>

      {booking && (
        <>
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

          <div className="bg-white rounded-xl border border-gray-200 p-5 grid grid-cols-3 gap-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-gray-700">2. Scan Instruction Nr. on the product</span>
              <input ref={inRef} value={inInput} onChange={(e) => setInInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pickIn()}
                placeholder={currentIn || 'Instruction'} className={`${input} font-mono`} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-gray-700">3. Scan RRN</span>
              <input ref={rrnRef} value={pendingRrn || rrnInput} disabled={!!pendingRrn} onChange={(e) => setRrnInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && scanRrn()} placeholder="RRN-…" className={`${input} font-mono`} />
            </label>
            {stage.serial && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-gray-700">4. Scan serial number</span>
                <input ref={serialRef} value={serialInput} disabled={!pendingRrn} onChange={(e) => setSerialInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') scanSerial(); if (e.key === 'Escape') { setPendingRrn(''); setSerialInput(''); } }}
                  placeholder={pendingRrn ? 'Serial' : 'Scan an RRN first'} className={`${input} font-mono`} />
              </label>
            )}
          </div>

          {scans.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-gray-600">
                  <tr><th className="px-4 py-2">Instruction</th><th className="px-4 py-2">RRN</th>{stage.serial && <th className="px-4 py-2">Serial</th>}<th /></tr>
                </thead>
                <tbody>
                  {scans.map((s) => (
                    <tr key={s.rrn} className="border-t border-gray-100">
                      <td className="px-4 py-2 font-mono">{s.instructionNo}</td>
                      <td className="px-4 py-2 font-mono">{s.rrn}</td>
                      {stage.serial && <td className="px-4 py-2 font-mono">{s.serial}</td>}
                      <td className="px-4 py-2 text-right">
                        <button onClick={() => setScans((x) => x.filter((y) => y.rrn !== s.rrn))} className="text-red-600 hover:underline">Remove</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {stage.needsRepAndWarehouse && (
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

          <div className="flex justify-end">
            <button onClick={check} disabled={busy || !scans.length}
              className="px-5 py-2 rounded-lg text-sm font-medium bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-50">
              {busy ? 'Checking…' : `Save ${scans.length} unit(s)`}
            </button>
          </div>
        </>
      )}

      {popup && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className={`w-full max-w-md rounded-xl shadow-xl p-6 text-white ${popup.kind === 'ok' ? 'bg-emerald-600' : popup.kind === 'missing' && stage.partialExpected ? 'bg-amber-600' : 'bg-red-600'}`}>
            <div className="text-xl font-bold mb-2">{popup.kind === 'ok' ? '✓ ' : '✕ '}{popup.title}</div>
            {popup.lines.map((l, i) => <div key={i} className="text-sm">{l}</div>)}
            {popup.kind === 'missing' && (
              <div className="text-sm mt-3 opacity-90">
                {stage.partialExpected
                  ? 'These stay at BSC. They can be collected later, or marked Unrepairable on the booking.'
                  : stage.from === null
                    ? 'They will show as Not found at TAL and can still be collected on a later visit.'
                    : 'Units not scanned keep their current status.'}
              </div>
            )}
            <div className="flex justify-end gap-2 mt-5">
              {popup.kind === 'missing' && (
                <button onClick={() => { setPopup(null); save(); }} className="px-4 py-2 rounded-lg text-sm font-medium bg-white/20 hover:bg-white/30">
                  Save anyway
                </button>
              )}
              <button ref={okRef} onClick={() => { setPopup(null); setTimeout(() => (pendingRrn ? serialRef : rrnRef).current?.focus(), 0); }}
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
