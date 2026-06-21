'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useAuth, authFetch } from '@/lib/useAuth';
import { Toast, ToastData } from '@/components/Toast';

interface SwapLine { product: string; description?: string; quantity: number }
interface SwapEvent { status: string; at: string; byName?: string; method?: string; note?: string }
interface SignedForm { fileName: string; uploadedAt: string; uploadedByName?: string; spWebUrl?: string }
interface SwapOutDto {
  id: string;
  clientId: string;
  pickingNumber: string;
  requestDate?: string;
  channel?: string;
  storeName: string;
  storeCode?: string;
  region?: string;
  lines: SwapLine[];
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

  if (loading) return <div className="text-gray-500">Loading…</div>;
  if (!rec) return <div className="text-gray-500">Swap-out not found.</div>;

  const stageIdx = STAGES.indexOf(rec.status);
  const nextStatus = stageIdx >= 0 && stageIdx < STAGES.length - 1 ? STAGES[stageIdx + 1] : null;
  const units = rec.lines.reduce((t, l) => t + (l.quantity || 0), 0);

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
        {clientName && <>{clientName} · </>}{rec.storeName}{rec.region ? ` · ${rec.region}` : ''}
        {rec.channel ? ` · ${rec.channel}` : ''} · {units} unit(s)
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Left: lines + history */}
        <div className="lg:col-span-2 flex flex-col gap-5">
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
            <h3 className="text-sm font-medium text-gray-500 mb-3">PRODUCT LINES</h3>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-gray-400 border-b border-gray-100">
                <th className="py-2 font-medium">Product</th>
                <th className="py-2 font-medium">Description</th>
                <th className="py-2 font-medium text-right">Qty</th>
              </tr></thead>
              <tbody>
                {rec.lines.map((l, i) => (
                  <tr key={i} className="border-b border-gray-50 last:border-0">
                    <td className="py-2 text-gray-800 font-medium">{l.product}</td>
                    <td className="py-2 text-gray-500">{l.description ?? '—'}</td>
                    <td className="py-2 text-right text-gray-700">{l.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

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
