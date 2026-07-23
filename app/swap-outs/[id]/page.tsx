'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useAuth, authFetch } from '@/lib/useAuth';
import { Toast, ToastData } from '@/components/Toast';

interface SwapLine {
  product: string;
  description?: string;
  quantity: number;
  issuedQty?: number;
  returnedQty?: number;
}
interface SwapEvent { status: string; at: string; byName?: string; method?: string; note?: string }
interface SwapMovement {
  id: string;
  type: 'issue' | 'return';
  product: string;
  quantity: number;
  at: string;
  byName?: string;
  repName?: string;
  reference?: string;
  note?: string;
}
interface SignedForm { fileName: string; uploadedAt: string; uploadedByName?: string; spWebUrl?: string }
interface SwapOutDto {
  id: string;
  clientId: string;
  pickingNumber: string;
  requestDate?: string;
  channel?: string;
  storeName: string;
  storeCode?: string;
  sheetStoreName?: string;
  region?: string;
  pickingNote?: string;
  lines: SwapLine[];
  movements?: SwapMovement[];
  status: string;
  assignedRepId?: string;
  assignedRepName?: string;
  history: SwapEvent[];
  signedForm?: SignedForm;
  createdAt: string;
}
interface RepDto { id: string; name?: string; firstName?: string; surname?: string }
interface ClientDto { id: string; name: string }

const STATUS_LABELS: Record<string, string> = {
  requested: 'Requested',
  picking_assigned: 'Picking # Assigned',
  received_wh: 'Received at WH',
  issued_rep: 'Issued to Rep',
  faulty_returned: 'Faulty Returned to WH',
  returned_client: 'Returned to Client',
  cancelled: 'Cancelled',
};
const STAGES = ['requested', 'picking_assigned', 'received_wh', 'issued_rep', 'faulty_returned', 'returned_client'];
const repLabel = (r: RepDto) => r.name || `${r.firstName ?? ''} ${r.surname ?? ''}`.trim() || r.id;
const fmt = (iso?: string) => { if (!iso) return '—'; try { return new Date(iso).toLocaleString('en-GB'); } catch { return iso; } };

type BookMode = 'issue' | 'return' | null;

export default function SwapOutDetailPage() {
  const { session } = useAuth('view_aged_stock');
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [rec, setRec] = useState<SwapOutDto | null>(null);
  const [reps, setReps] = useState<RepDto[]>([]);
  const [clientName, setClientName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastData | null>(null);

  const [pickingInput, setPickingInput] = useState('');
  const [scanInput, setScanInput] = useState('');
  const [formFile, setFormFile] = useState<File | null>(null);
  const [pushSp, setPushSp] = useState(true);

  // Stock booking form state
  const [bookMode, setBookMode] = useState<BookMode>(null);
  const [bookQty, setBookQty] = useState<Record<string, string>>({});
  const [bookRep, setBookRep] = useState('');
  const [bookRef, setBookRef] = useState('');
  const [bookNote, setBookNote] = useState('');

  const canManage = (session?.permissions ?? []).includes('scan_stock');
  const canDelete = (session?.permissions ?? []).includes('manage_pick_slips');

  const load = useCallback(async () => {
    const [soRes, repRes, clRes] = await Promise.all([
      authFetch(`/api/swap-outs/${id}`, { cache: 'no-store' }),
      authFetch('/api/control/reps', { cache: 'no-store' }),
      authFetch('/api/control/clients', { cache: 'no-store' }),
    ]);
    if (soRes.ok) {
      const r: SwapOutDto = await soRes.json();
      setRec(r);
      if (clRes.ok) {
        const data = await clRes.json();
        const list: ClientDto[] = Array.isArray(data) ? data : data.clients ?? [];
        setClientName(list.find((c) => c.id === r.clientId)?.name ?? '');
      }
    }
    if (repRes.ok) {
      const data = await repRes.json();
      setReps(Array.isArray(data) ? data : data.reps ?? []);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { if (session) load(); }, [session, load]);

  const patch = async (body: Record<string, unknown>, ok = 'Updated') => {
    setBusy(true);
    const res = await authFetch(`/api/swap-outs/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) { setToast({ type: 'success', message: ok }); await load(); }
    else { const e = await res.json(); setToast({ type: 'error', message: e.error || 'Failed' }); }
    setBusy(false);
  };

  /** How many units of a line are still available for the given move. */
  const roomFor = useCallback((l: SwapLine, mode: 'issue' | 'return') => {
    const out = l.issuedQty ?? 0;
    const back = l.returnedQty ?? 0;
    return mode === 'issue' ? Math.max(0, (l.quantity || 0) - out) : Math.max(0, out - back);
  }, []);

  const openBooking = (mode: 'issue' | 'return') => {
    if (!rec) return;
    setBookMode(mode);
    setBookRep(mode === 'issue' ? rec.assignedRepId ?? '' : '');
    setBookRef('');
    setBookNote('');
    const seed: Record<string, string> = {};
    for (const l of rec.lines) {
      const room = roomFor(l, mode);
      seed[l.product] = room > 0 ? String(room) : '';
    }
    setBookQty(seed);
  };

  const submitBooking = async () => {
    if (!rec || !bookMode) return;
    const lines = rec.lines
      .map((l) => ({ product: l.product, quantity: Number(bookQty[l.product]) || 0 }))
      .filter((l) => l.quantity > 0);
    if (lines.length === 0) {
      setToast({ type: 'error', message: 'Enter a quantity on at least one line.' });
      return;
    }
    setBusy(true);
    const res = await authFetch(`/api/swap-outs/${id}/stock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: bookMode,
        lines,
        repId: bookMode === 'issue' ? bookRep : undefined,
        reference: bookRef || undefined,
        note: bookNote || undefined,
      }),
    });
    const data = await res.json();
    if (res.ok) {
      setToast({
        type: 'success',
        message: bookMode === 'issue' ? 'Good stock booked out' : 'Faulty stock booked in',
      });
      setBookMode(null);
      await load();
    } else {
      setToast({ type: 'error', message: data.error || 'Booking failed' });
    }
    setBusy(false);
  };

  const reverseMovement = async (m: SwapMovement) => {
    if (!confirm(`Reverse ${m.quantity} × ${m.product} (${m.type === 'issue' ? 'good out' : 'faulty in'})?`)) return;
    setBusy(true);
    const res = await authFetch(`/api/swap-outs/${id}/stock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reverseMovementId: m.id }),
    });
    const data = await res.json();
    if (res.ok) { setToast({ type: 'success', message: 'Movement reversed' }); await load(); }
    else setToast({ type: 'error', message: data.error || 'Reversal failed' });
    setBusy(false);
  };

  const totals = useMemo(() => {
    if (!rec) return { requested: 0, out: 0, back: 0 };
    return rec.lines.reduce(
      (t, l) => ({
        requested: t.requested + (l.quantity || 0),
        out: t.out + (l.issuedQty || 0),
        back: t.back + (l.returnedQty || 0),
      }),
      { requested: 0, out: 0, back: 0 }
    );
  }, [rec]);

  if (loading) return <div className="text-gray-500">Loading…</div>;
  if (!rec) return <div className="text-gray-500">Swap-out not found.</div>;

  const stageIdx = STAGES.indexOf(rec.status);
  const nextStatus = stageIdx >= 0 && stageIdx < STAGES.length - 1 ? STAGES[stageIdx + 1] : null;
  const movements = [...(rec.movements ?? [])].sort((a, b) => (a.at < b.at ? 1 : -1));
  const reversedIds = new Set(
    (rec.movements ?? [])
      .map((m) => m.reference?.startsWith('reversal:') ? m.reference.slice('reversal:'.length) : null)
      .filter(Boolean) as string[]
  );

  const advance = (method: 'manual' | 'scan') => {
    if (!nextStatus) return;
    patch({ status: nextStatus, method }, `Moved to ${STATUS_LABELS[nextStatus]}`);
  };

  const onScan = (e: React.FormEvent) => {
    e.preventDefault();
    const v = scanInput.trim().toLowerCase();
    setScanInput('');
    if (!rec.pickingNumber) { setToast({ type: 'error', message: 'This swap-out has no picking number to scan against.' }); return; }
    if (v !== rec.pickingNumber.toLowerCase()) { setToast({ type: 'error', message: 'Scanned code does not match this picking number.' }); return; }
    advance('scan');
  };

  const uploadForm = async () => {
    if (!formFile) return;
    setBusy(true);
    const fd = new FormData();
    fd.append('file', formFile);
    fd.append('pushToSp', pushSp ? 'yes' : 'no');
    const res = await authFetch(`/api/swap-outs/${id}/form`, { method: 'POST', body: fd });
    const data = await res.json();
    if (res.ok) {
      setToast({ type: data.spError ? 'error' : 'success', message: data.spError ? `Saved, but SharePoint: ${data.spError}` : 'Form uploaded' });
      setFormFile(null);
      await load();
    } else { setToast({ type: 'error', message: data.error || 'Upload failed' }); }
    setBusy(false);
  };

  const downloadForm = async () => {
    const res = await authFetch(`/api/swap-outs/${id}/form`);
    if (!res.ok) { setToast({ type: 'error', message: 'Download failed' }); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = rec.signedForm?.fileName || 'signed-form';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  const remove = async () => {
    if (!confirm('Delete this swap-out? This cannot be undone.')) return;
    const res = await authFetch(`/api/swap-outs/${id}`, { method: 'DELETE' });
    if (res.ok) router.push('/swap-outs');
    else setToast({ type: 'error', message: 'Delete failed' });
  };

  const canIssue = rec.lines.some((l) => roomFor(l, 'issue') > 0);
  const canReturn = rec.lines.some((l) => roomFor(l, 'return') > 0);

  return (
    <div className="flex flex-col gap-5 max-w-5xl">
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <div className="flex items-center gap-3">
        <Link href="/swap-outs" className="text-gray-400 hover:text-gray-600 text-sm">&larr; Back</Link>
        <h1 className="text-2xl font-bold text-gray-900">
          {rec.pickingNumber || <span className="text-gray-400 italic">No picking number</span>}
        </h1>
        <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
          {STATUS_LABELS[rec.status] ?? rec.status}
        </span>
        {canDelete && (
          <button onClick={remove} className="ml-auto text-sm text-red-600 hover:text-red-700">Delete</button>
        )}
      </div>
      <p className="text-sm text-gray-500 -mt-3">
        {clientName && <>{clientName} · </>}{rec.storeName}
        {rec.storeCode ? ` (${rec.storeCode})` : ''}
        {rec.region ? ` · ${rec.region}` : ''}{rec.channel ? ` · ${rec.channel}` : ''}
        {' · '}{totals.requested} requested · {totals.out} out · {totals.back} back
      </p>
      {rec.pickingNote && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-2 -mt-2">
          Supplier note on the sheet: “{rec.pickingNote}”
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Left: stock, lines, history */}
        <div className="lg:col-span-2 flex flex-col gap-5">
          {/* Stock position + booking */}
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-gray-500">STOCK</h3>
              {canManage && rec.status !== 'cancelled' && !bookMode && (
                <div className="flex gap-2">
                  <button
                    onClick={() => openBooking('issue')}
                    disabled={!canIssue}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--color-primary)] text-white disabled:opacity-40"
                  >
                    Book out good stock
                  </button>
                  <button
                    onClick={() => openBooking('return')}
                    disabled={!canReturn}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                  >
                    Book in faulty stock
                  </button>
                </div>
              )}
            </div>

            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-100">
                  <th className="py-2 font-medium">Product</th>
                  <th className="py-2 font-medium">Description</th>
                  <th className="py-2 font-medium text-right">Requested</th>
                  <th className="py-2 font-medium text-right">Good out</th>
                  <th className="py-2 font-medium text-right">Faulty in</th>
                  {bookMode && <th className="py-2 font-medium text-right w-28">
                    {bookMode === 'issue' ? 'Book out' : 'Book in'}
                  </th>}
                </tr>
              </thead>
              <tbody>
                {rec.lines.map((l, i) => {
                  const out = l.issuedQty ?? 0;
                  const back = l.returnedQty ?? 0;
                  const room = bookMode ? roomFor(l, bookMode) : 0;
                  return (
                    <tr key={i} className="border-b border-gray-50 last:border-0">
                      <td className="py-2 text-gray-800 font-medium">{l.product}</td>
                      <td className="py-2 text-gray-500">{l.description ?? '—'}</td>
                      <td className="py-2 text-right text-gray-700">{l.quantity}</td>
                      <td className={`py-2 text-right ${out >= l.quantity ? 'text-emerald-600 font-medium' : out > 0 ? 'text-amber-600' : 'text-gray-400'}`}>{out}</td>
                      <td className={`py-2 text-right ${out > 0 && back >= out ? 'text-emerald-600 font-medium' : back > 0 ? 'text-amber-600' : 'text-gray-400'}`}>{back}</td>
                      {bookMode && (
                        <td className="py-2 text-right">
                          <input
                            type="number"
                            min={0}
                            max={room}
                            disabled={room === 0}
                            value={bookQty[l.product] ?? ''}
                            onChange={(e) => setBookQty((q) => ({ ...q, [l.product]: e.target.value }))}
                            className="w-20 px-2 py-1 border border-gray-300 rounded-lg text-sm text-right disabled:bg-gray-50 disabled:text-gray-300"
                          />
                          <div className="text-[10px] text-gray-400">max {room}</div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {bookMode && (
              <div className="mt-4 pt-4 border-t border-gray-100 flex flex-col gap-3">
                <p className="text-sm text-gray-600">
                  {bookMode === 'issue'
                    ? 'Booking replacement stock OUT of the warehouse for the rep to take to store.'
                    : 'Booking the faulty units back IN, against the good stock already issued.'}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {bookMode === 'issue' && (
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Issued to rep</label>
                      <select value={bookRep} onChange={(e) => setBookRep(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
                        <option value="">— Not assigned —</option>
                        {reps.map((r) => <option key={r.id} value={r.id}>{repLabel(r)}</option>)}
                      </select>
                    </div>
                  )}
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Reference (form / waybill no.)</label>
                    <input value={bookRef} onChange={(e) => setBookRef(e.target.value)}
                      placeholder="e.g. JI2606V0050"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                  </div>
                  <div className={bookMode === 'issue' ? 'sm:col-span-2' : ''}>
                    <label className="block text-xs text-gray-500 mb-1">Note</label>
                    <input value={bookNote} onChange={(e) => setBookNote(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={submitBooking} disabled={busy}
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-[var(--color-primary)] text-white disabled:opacity-50">
                    {busy ? 'Saving…' : bookMode === 'issue' ? 'Book out' : 'Book in'}
                  </button>
                  <button onClick={() => setBookMode(null)}
                    className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Movement ledger */}
          {movements.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
              <h3 className="text-sm font-medium text-gray-500 mb-3">STOCK MOVEMENTS</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-gray-100">
                    <th className="py-2 font-medium">When</th>
                    <th className="py-2 font-medium">Move</th>
                    <th className="py-2 font-medium">Product</th>
                    <th className="py-2 font-medium text-right">Qty</th>
                    <th className="py-2 font-medium">By / Rep</th>
                    {canManage && <th className="py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {movements.map((m) => {
                    const isReversal = m.reference?.startsWith('reversal:');
                    return (
                      <tr key={m.id} className="border-b border-gray-50 last:border-0">
                        <td className="py-2 text-gray-500 text-xs">{fmt(m.at)}</td>
                        <td className="py-2">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            m.type === 'issue' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
                          }`}>
                            {m.type === 'issue' ? 'Good out' : 'Faulty in'}
                          </span>
                        </td>
                        <td className="py-2 text-gray-800">{m.product}</td>
                        <td className={`py-2 text-right font-medium ${m.quantity < 0 ? 'text-red-600' : 'text-gray-700'}`}>
                          {m.quantity}
                        </td>
                        <td className="py-2 text-gray-500 text-xs">
                          {m.byName ?? '—'}{m.repName ? ` → ${m.repName}` : ''}
                          {m.reference && !isReversal && <div className="text-gray-400">Ref {m.reference}</div>}
                          {m.note && <div className="text-gray-400">{m.note}</div>}
                        </td>
                        {canManage && (
                          <td className="py-2 text-right">
                            {!isReversal && !reversedIds.has(m.id) && m.quantity > 0 && (
                              <button onClick={() => reverseMovement(m)} disabled={busy}
                                className="text-xs text-red-600 hover:text-red-700">
                                Reverse
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
            <h3 className="text-sm font-medium text-gray-500 mb-3">HISTORY</h3>
            <ol className="flex flex-col gap-3">
              {[...rec.history].reverse().map((e, i) => (
                <li key={i} className="flex gap-3 text-sm">
                  <div className="w-2 h-2 rounded-full bg-[var(--color-primary)] mt-1.5 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-gray-800">{STATUS_LABELS[e.status] ?? e.status}</span>
                    {e.method && <span className="text-xs text-gray-400 ml-2">({e.method})</span>}
                    <div className="text-xs text-gray-500">{fmt(e.at)} · {e.byName ?? 'Unknown'}{e.note ? ` — ${e.note}` : ''}</div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>

        {/* Right: actions */}
        <div className="flex flex-col gap-5">
          {/* Picking number */}
          {!rec.pickingNumber && canManage && (
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
              <h3 className="text-sm font-medium text-gray-500 mb-2">SET PICKING NUMBER</h3>
              <div className="flex gap-2">
                <input value={pickingInput} onChange={(e) => setPickingInput(e.target.value)}
                  placeholder="J152606…" className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                <button disabled={busy || !pickingInput.trim()}
                  onClick={() => patch({ pickingNumber: pickingInput.trim() }, 'Picking number set')}
                  className="px-3 py-2 rounded-lg text-sm font-medium bg-[var(--color-primary)] text-white disabled:opacity-50">Save</button>
              </div>
            </div>
          )}

          {/* Progress */}
          {canManage && rec.status !== 'cancelled' && (
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 flex flex-col gap-3">
              <h3 className="text-sm font-medium text-gray-500">PROGRESS</h3>
              {nextStatus ? (
                <>
                  <button disabled={busy} onClick={() => advance('manual')}
                    className="w-full px-4 py-2 rounded-lg text-sm font-medium bg-[var(--color-primary)] text-white disabled:opacity-50">
                    Advance → {STATUS_LABELS[nextStatus]}
                  </button>
                  <form onSubmit={onScan} className="flex gap-2">
                    <input value={scanInput} onChange={(e) => setScanInput(e.target.value)}
                      placeholder="Scan picking # to confirm"
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                    <button type="submit" className="px-3 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50">Scan</button>
                  </form>
                </>
              ) : (
                <p className="text-sm text-emerald-600 font-medium">Returned to client — complete.</p>
              )}
              <div className="border-t border-gray-100 pt-3">
                <label className="block text-xs text-gray-500 mb-1">Set status manually</label>
                <select value={rec.status} disabled={busy}
                  onChange={(e) => patch({ status: e.target.value, method: 'manual' }, 'Status updated')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
                  {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
            </div>
          )}

          {/* Rep assignment */}
          {canManage && (
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
              <h3 className="text-sm font-medium text-gray-500 mb-2">ASSIGNED REP</h3>
              <select value={rec.assignedRepId ?? ''} disabled={busy}
                onChange={(e) => patch({ assignedRepId: e.target.value }, 'Rep assigned')}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
                <option value="">— Unassigned —</option>
                {reps.map((r) => <option key={r.id} value={r.id}>{repLabel(r)}</option>)}
              </select>
            </div>
          )}

          {/* Sheet provenance */}
          {rec.sheetStoreName && rec.sheetStoreName !== rec.storeName && (
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
              <h3 className="text-sm font-medium text-gray-500 mb-1">MAPPED FROM SHEET</h3>
              <p className="text-sm text-gray-600">“{rec.sheetStoreName}” → {rec.storeName}</p>
            </div>
          )}

          {/* Signed form */}
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 flex flex-col gap-3">
            <h3 className="text-sm font-medium text-gray-500">SIGNED FORM</h3>
            {rec.signedForm ? (
              <div className="text-sm">
                <button onClick={downloadForm} className="text-[var(--color-primary)] hover:underline">{rec.signedForm.fileName}</button>
                <div className="text-xs text-gray-400">Uploaded {fmt(rec.signedForm.uploadedAt)} · {rec.signedForm.uploadedByName ?? ''}</div>
                {rec.signedForm.spWebUrl && (
                  <a href={rec.signedForm.spWebUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-emerald-600 hover:underline">On SharePoint ↗</a>
                )}
              </div>
            ) : <p className="text-sm text-gray-400">None uploaded.</p>}
            {canManage && (
              <>
                <input type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => setFormFile(e.target.files?.[0] ?? null)}
                  className="block w-full text-xs text-gray-600 file:mr-2 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-gray-100 file:text-gray-700" />
                <label className="flex items-center gap-2 text-xs text-gray-600">
                  <input type="checkbox" checked={pushSp} onChange={(e) => setPushSp(e.target.checked)} /> Also push to client SharePoint
                </label>
                <button disabled={busy || !formFile} onClick={uploadForm}
                  className="self-start px-4 py-2 rounded-lg text-sm font-medium bg-[var(--color-primary)] text-white disabled:opacity-50">Upload form</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
