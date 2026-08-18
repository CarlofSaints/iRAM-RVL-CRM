'use client';

/**
 * PUBLIC swap-out return sign-off. No login — the token in the URL is the
 * credential, mirroring /delivery/[token] for aged stock. Built for a phone
 * held by the supplier's collector standing at the warehouse door.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';

interface NoteLine {
  product: string;
  description: string;
  requested: number;
  issued: number;
  returned: number;
}
interface NoteDto {
  pickingNumber: string;
  podNumber?: string;
  clientName: string;
  vendorNumber: string;
  storeName: string;
  storeCode?: string;
  channel?: string;
  region?: string;
  repName?: string;
  releasedAt?: string;
  releasedByName?: string;
  releaseReference?: string;
  lines: NoteLine[];
  totalReturned: number;
  signed: boolean;
  signedByName?: string;
  signedAt?: string;
}

const fmt = (iso?: string) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg',
    });
  } catch { return iso; }
};

export default function SwapOutDeliverySignOffPage() {
  const params = useParams();
  const token = params.token as string;

  const [note, setNote] = useState<NoteDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [done, setDone] = useState<{ warning?: string } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/swap-out-delivery/${token}`, { cache: 'no-store' });
        const data = await res.json();
        if (res.ok) setNote(data);
        else setLoadError(data.error || 'This link is not valid.');
      } catch {
        setLoadError('Could not load this delivery. Check your signal and try again.');
      }
      setLoading(false);
    })();
  }, [token]);

  // ── Signature pad ──
  const initCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * 2; // retina
    canvas.height = rect.height * 2;
    ctx.scale(2, 2);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  useEffect(() => {
    initCanvas();
    window.addEventListener('resize', initCanvas);
    return () => window.removeEventListener('resize', initCanvas);
  }, [initCanvas, note]);

  function getPos(e: React.TouchEvent | React.MouseEvent) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    if ('touches' in e) {
      const t = e.touches[0];
      return { x: t.clientX - rect.left, y: t.clientY - rect.top };
    }
    return { x: (e as React.MouseEvent).clientX - rect.left, y: (e as React.MouseEvent).clientY - rect.top };
  }

  function startDraw(e: React.TouchEvent | React.MouseEvent) {
    e.preventDefault();
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    setIsDrawing(true);
    setHasSignature(true);
    const { x, y } = getPos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function draw(e: React.TouchEvent | React.MouseEvent) {
    if (!isDrawing) return;
    e.preventDefault();
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const { x, y } = getPos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  function clearSignature() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError('');
    if (!name.trim()) { setSubmitError('Please enter your name.'); return; }
    if (!hasSignature) { setSubmitError('Please sign in the box.'); return; }
    const canvas = canvasRef.current;
    if (!canvas) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/swap-out-delivery/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signedByName: name.trim(), signature: canvas.toDataURL('image/png') }),
      });
      const data = await res.json();
      if (res.ok) setDone({ warning: data.warning });
      else setSubmitError(data.error || 'Could not submit. Please try again.');
    } catch {
      setSubmitError('Could not submit. Check your signal and try again.');
    }
    setSubmitting(false);
  }

  if (loading) {
    return <main className="min-h-screen flex items-center justify-center p-6 text-gray-500">Loading…</main>;
  }
  if (loadError || !note) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-xl border border-red-200 bg-red-50 text-red-700 px-5 py-6 text-center">
          {loadError || 'This link is not valid.'}
        </div>
      </main>
    );
  }

  const alreadySigned = note.signed && !done;

  return (
    <main className="min-h-screen bg-gray-50 py-6 px-4">
      <div className="max-w-2xl mx-auto flex flex-col gap-4">
        <header className="text-center">
          <h1 className="text-xl font-bold text-gray-900">Swap-Out Return</h1>
          <p className="text-sm text-gray-500">Faulty stock collected from the iRam warehouse</p>
        </header>

        {/* What is being handed over */}
        <section className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col gap-1 text-sm">
          <div className="text-lg font-semibold text-gray-900">
            {note.storeName}{note.storeCode ? ` (${note.storeCode})` : ''}
          </div>
          <div className="text-gray-600">
            {note.clientName}{note.vendorNumber ? ` — ${note.vendorNumber}` : ''}
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-y-2 gap-x-3">
            <dt className="text-gray-500">Picking #</dt>
            <dd className="font-mono text-gray-900 break-all">{note.pickingNumber || '—'}</dd>
            <dt className="text-gray-500">POD</dt>
            <dd className="font-mono text-gray-900 break-all">{note.podNumber || '—'}</dd>
            <dt className="text-gray-500">Released</dt>
            <dd className="text-gray-900">{fmt(note.releasedAt)}</dd>
            <dt className="text-gray-500">Released by</dt>
            <dd className="text-gray-900">{note.releasedByName ?? '—'}</dd>
            {note.releaseReference && (
              <>
                <dt className="text-gray-500">Reference</dt>
                <dd className="text-gray-900">{note.releaseReference}</dd>
              </>
            )}
          </dl>
        </section>

        {/* Lines */}
        <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 font-semibold text-gray-900 text-sm">
            Faulty units being returned
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-100">
                  <th className="px-4 py-2 font-medium">Product</th>
                  <th className="px-4 py-2 font-medium">Description</th>
                  <th className="px-4 py-2 font-medium text-right">Qty</th>
                </tr>
              </thead>
              <tbody>
                {note.lines.map((l, i) => (
                  <tr key={`${l.product}-${i}`} className="border-b border-gray-50 last:border-0">
                    <td className="px-4 py-2 font-mono text-gray-800">{l.product}</td>
                    <td className="px-4 py-2 text-gray-600">{l.description || '—'}</td>
                    <td className="px-4 py-2 text-right font-semibold text-gray-900">{l.returned}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50">
                  <td className="px-4 py-3 font-semibold text-gray-900" colSpan={2}>Total</td>
                  <td className="px-4 py-3 text-right font-bold text-gray-900">{note.totalReturned}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {note.totalReturned === 0 && (
            <div className="px-5 py-3 bg-amber-50 border-t border-amber-200 text-amber-800 text-sm">
              No faulty units were booked in against this swap-out. Please check with iRam
              before signing.
            </div>
          )}
        </section>

        {/* Outcome / already signed / the pad */}
        {done ? (
          <section className="bg-white rounded-xl border border-emerald-200 p-6 text-center flex flex-col gap-2">
            <div className="text-2xl">✓</div>
            <div className="font-semibold text-emerald-700">Thank you — signed.</div>
            <p className="text-sm text-gray-600">
              A copy of the signed delivery note has been sent to {note.clientName || 'your team'}.
            </p>
            {done.warning && <p className="text-sm text-amber-700">{done.warning}</p>}
          </section>
        ) : alreadySigned ? (
          <section className="bg-white rounded-xl border border-gray-200 p-6 text-center flex flex-col gap-1">
            <div className="font-semibold text-gray-900">Already signed</div>
            <p className="text-sm text-gray-600">
              Signed by {note.signedByName ?? 'a representative'} on {fmt(note.signedAt)}.
            </p>
          </section>
        ) : (
          <form onSubmit={submit} className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col gap-4">
            <h2 className="font-semibold text-gray-900">Sign for this return</h2>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Your name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Full name"
                className="w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-gray-700">Signature</label>
                <button type="button" onClick={clearSignature} className="text-sm text-gray-500 hover:text-gray-700">
                  Clear
                </button>
              </div>
              <canvas
                ref={canvasRef}
                className="w-full h-40 border border-gray-300 rounded-lg bg-white touch-none"
                onMouseDown={startDraw}
                onMouseMove={draw}
                onMouseUp={() => setIsDrawing(false)}
                onMouseLeave={() => setIsDrawing(false)}
                onTouchStart={startDraw}
                onTouchMove={draw}
                onTouchEnd={() => setIsDrawing(false)}
              />
              <p className="text-xs text-gray-400 mt-1">Sign with your finger or a stylus.</p>
            </div>

            {submitError && (
              <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3">
                {submitError}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full px-4 py-3 rounded-lg text-base font-semibold bg-[#7CC042] text-white disabled:opacity-50"
            >
              {submitting ? 'Submitting…' : 'Confirm & Sign'}
            </button>
          </form>
        )}

        <p className="text-center text-xs text-gray-400 pb-6">iRamFlow · Powered by OuterJoin</p>
      </div>
    </main>
  );
}
