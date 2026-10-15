'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { SHORTFALL_REASONS } from '@/lib/deliveryShortfall';
import { formatStoreRefs, type StoreRef } from '@/lib/storeRefs';

/**
 * References for either shape on this page: a note, or one store within a
 * multi-store note. Falls back to the GRN-only array so a note issued before
 * Return Orders existed still prints its numbers.
 */
const refsOf = (x: { refs?: StoreRef[]; storeRefs?: string[] }): StoreRef[] =>
  x.refs && x.refs.length > 0
    ? x.refs
    : (x.storeRefs ?? []).filter(Boolean).map((grn) => ({ grn, returnOrder: '' }));

interface ContactDto {
  name: string;
  surname: string;
}

interface SlipBreakdown {
  slipId: string;
  siteName: string;
  siteCode: string;
  warehouse: string;
  totalQty: number;
  totalVal: number;
  boxCount: number;
  /** Boxes this note was asked for. Greater than boxCount on a short release. */
  totalBoxes?: number;
  status: string;
  manual: boolean;
  /** GRN/GRV document number(s) captured at receipt */
  storeRefs?: string[];
  refs?: StoreRef[];
  /** GRN/GRV document date captured at receipt */
  receiptGrnDate?: string;
}

interface SlipSummary {
  slipId: string;
  clientName: string;
  vendorNumber: string;
  siteName: string;
  siteCode: string;
  warehouse: string;
  status: string;
  releaseRepName: string;
  releasedAt: string;
  totalQty: number;
  totalVal: number;
  boxCount: number;
  /** Boxes this note was asked for across every store on it. */
  totalBoxCount?: number;
  manual: boolean;
  storeRefs?: string[];
  refs?: StoreRef[];
  receiptGrnDate?: string;
  contacts?: ContactDto[];
  deliveredAt?: string;
  deliverySignedByName?: string;
  slips?: SlipBreakdown[];
}

/** A sign-off that could not be sent (no signal, or the server failed) and is
 *  kept on this phone until it goes through. */
interface PendingSignOff {
  savedAt: string;
  payload: {
    securityCode: string;
    vendorName: string;
    signature?: string;
    signedCopyPhoto?: string;
    capturedAt: string;
    deliveredSlipIds?: string[];
    shortReasons?: Record<string, { reasonKey: string; note: string }>;
  };
  lastError?: string;
}

const pendingKey = (token: string) => `iramflow_pending_delivery_${token}`;

function readPending(token: string): PendingSignOff | null {
  try {
    const raw = localStorage.getItem(pendingKey(token));
    return raw ? (JSON.parse(raw) as PendingSignOff) : null;
  } catch {
    return null;
  }
}

/** False when the phone's storage refused it (full, or private mode). */
function writePending(token: string, p: PendingSignOff): boolean {
  try {
    localStorage.setItem(pendingKey(token), JSON.stringify(p));
    return true;
  } catch {
    return false;
  }
}

function clearPending(token: string) {
  try { localStorage.removeItem(pendingKey(token)); } catch { /* nothing to clear */ }
}

/** Shrinks a camera photo to a JPEG the server and the phone's storage can
 *  hold (~200-400KB). A raw phone photo is 3-6MB. */
function compressPhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const max = 1600;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('no canvas')); return; }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable image')); };
    img.src = url;
  });
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

export default function DeliveryConfirmationPage() {
  const params = useParams();
  const token = params.token as string;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [slip, setSlip] = useState<SlipSummary | null>(null);

  // Form state
  const [securityCode, setSecurityCode] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [contactMode, setContactMode] = useState<'select' | 'other'>('select');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [success, setSuccess] = useState(false);

  // Per-store physical check. Every store starts ticked (the normal case is a
  // complete delivery); unticking one means its boxes were not handed over.
  const [deliveredIds, setDeliveredIds] = useState<string[]>([]);
  const [shortReasons, setShortReasons] = useState<Record<string, { reasonKey: string; note: string }>>({});
  const [shortResult, setShortResult] = useState<Array<{ siteName: string; siteCode: string; boxCount: number }>>([]);

  // Signature pad state
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);

  // Signed on paper instead: a photo of the signed delivery note.
  const [signMode, setSignMode] = useState<'draw' | 'photo'>('draw');
  const [signedCopyPhoto, setSignedCopyPhoto] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);

  // A sign-off saved on this phone because it could not be sent yet.
  const [pending, setPending] = useState<PendingSignOff | null>(null);
  const [pendingNotStored, setPendingNotStored] = useState(false);
  const [alreadyDone, setAlreadyDone] = useState(false);
  // No signal when the page first loaded the delivery details.
  const [loadFailedOffline, setLoadFailedOffline] = useState(false);
  const sendingRef = useRef(false);
  const justFailedRef = useRef(false);

  // ── Load slip data ──
  const loadSlip = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setLoadFailedOffline(false);
    try {
      const res = await fetch(`/api/delivery/${token}`, { cache: 'no-store' });
      const data = await res.json();
      if (res.ok) {
        setSlip(data);
        setDeliveredIds(((data.slips ?? []) as SlipBreakdown[]).map(s => s.slipId));
      } else {
        setError(data.error || 'Failed to load delivery details');
      }
    } catch {
      // No signal (or the server did not answer) is not an invalid link.
      setLoadFailedOffline(true);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    setPending(readPending(token));
    loadSlip();
  }, [token, loadSlip]);

  // ── Signature pad setup ──
  const lastCanvasWidth = useRef(0);
  const initCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas to actual display size. Resizing a canvas wipes it, and a
    // phone fires `resize` whenever the keyboard opens or closes — so only
    // re-initialise when the width really changed (a rotation), and say so.
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.width === lastCanvasWidth.current) return;
    if (lastCanvasWidth.current !== 0) setHasSignature(false);
    lastCanvasWidth.current = rect.width;
    canvas.width = rect.width * 2; // 2x for retina
    canvas.height = rect.height * 2;
    ctx.scale(2, 2);

    // Style
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  useEffect(() => {
    // The canvas is unmounted while in photo mode; a fresh one must re-init.
    lastCanvasWidth.current = 0;
    initCanvas();
    window.addEventListener('resize', initCanvas);
    return () => window.removeEventListener('resize', initCanvas);
  }, [initCanvas, slip, signMode, pending]);

  function getPos(e: React.TouchEvent | React.MouseEvent): { x: number; y: number } {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    if ('touches' in e) {
      const touch = e.touches[0];
      return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
    }
    return { x: (e as React.MouseEvent).clientX - rect.left, y: (e as React.MouseEvent).clientY - rect.top };
  }

  function startDraw(e: React.TouchEvent | React.MouseEvent) {
    e.preventDefault();
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
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
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;

    const { x, y } = getPos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  function endDraw() {
    setIsDrawing(false);
  }

  function clearSignature() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
  }

  function getSignatureBase64(): string {
    const canvas = canvasRef.current;
    if (!canvas) return '';
    return canvas.toDataURL('image/png');
  }

  // ── Submit ──
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError('');

    if (!securityCode.trim()) {
      setSubmitError('Please enter the security code');
      return;
    }
    if (!vendorName.trim()) {
      setSubmitError('Please enter the name of the person receiving the stock');
      return;
    }
    if (signMode === 'draw' && !hasSignature) {
      setSubmitError('Please provide a signature');
      return;
    }
    if (signMode === 'photo' && !signedCopyPhoto) {
      setSubmitError('Please take a photo of the signed delivery note');
      return;
    }

    // Per-store checks (only shown for a multi-store delivery note)
    const allSlips = slip?.slips ?? [];
    if (allSlips.length > 1) {
      if (deliveredIds.length === 0) {
        setSubmitError(
          'Tick at least one store. If nothing was delivered, do not sign — ask the office to cancel the release instead.'
        );
        return;
      }
      const unticked = allSlips.filter(s => !deliveredIds.includes(s.slipId));
      const missingReason = unticked.filter(s => !shortReasons[s.slipId]?.reasonKey);
      if (missingReason.length > 0) {
        setSubmitError(
          `Please select a reason for ${missingReason.map(s => `${s.siteName} (${s.siteCode})`).join(', ')}.`
        );
        return;
      }
      const missingNote = unticked.filter(s => {
        const def = SHORTFALL_REASONS.find(r => r.key === shortReasons[s.slipId]?.reasonKey);
        return def?.requiresNote && !(shortReasons[s.slipId]?.note ?? '').trim();
      });
      if (missingNote.length > 0) {
        setSubmitError(
          `Please add a note for ${missingNote.map(s => `${s.siteName} (${s.siteCode})`).join(', ')}.`
        );
        return;
      }
    }

    const payload: PendingSignOff['payload'] = {
      securityCode: securityCode.trim(),
      vendorName: vendorName.trim(),
      ...(signMode === 'draw' ? { signature: getSignatureBase64() } : { signedCopyPhoto }),
      capturedAt: new Date().toISOString(),
      // Omitted for a single-store note, which keeps the all-or-nothing path.
      ...(allSlips.length > 1 ? { deliveredSlipIds: deliveredIds, shortReasons } : {}),
    };

    setSubmitting(true);
    try {
      await sendSignOff(payload, false);
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Sends a sign-off. If it cannot get through — no signal, or the server
   * failed — it is kept on this phone and retried until it does, instead of
   * losing what the receiver signed. A clear "no" from the server (wrong code,
   * missing name) is shown so it can be fixed; that is not worth retrying.
   */
  async function sendSignOff(payload: PendingSignOff['payload'], isRetry: boolean) {
    if (sendingRef.current) return;
    sendingRef.current = true;
    let failure = '';
    try {
      const res = await fetch(`/api/delivery/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // A queued sign-off is sent without its capture time on the first try
        // only; once saved, the time it was filled in is what matters.
        body: JSON.stringify(isRetry ? payload : { ...payload, capturedAt: undefined }),
      });
      let data: { error?: string; alreadyConfirmed?: boolean; notDelivered?: typeof shortResult } | null = null;
      try { data = await res.json(); } catch { /* server answered with something that is not JSON */ }

      if (res.ok && data) {
        clearPending(token);
        setPending(null);
        setShortResult(data.notDelivered ?? []);
        setSuccess(true);
        return;
      }
      if (data?.alreadyConfirmed) {
        // An earlier attempt landed before the signal dropped.
        clearPending(token);
        setPending(null);
        setAlreadyDone(true);
        setSuccess(true);
        return;
      }
      if (res.status >= 400 && res.status < 500 && data?.error) {
        // The server read it and said no. Put the details back on the form so
        // the person can fix them, and stop retrying.
        clearPending(token);
        setPending(null);
        restoreForm(payload);
        setSubmitError(data.error);
        // Opened with no signal, the form was never loaded — load it now.
        if (!slip) loadSlip();
        return;
      }
      failure = data?.error || `The server did not respond properly (HTTP ${res.status}).`;
    } catch {
      failure = typeof navigator !== 'undefined' && navigator.onLine === false
        ? 'No signal on this phone.'
        : 'Could not reach the server.';
    } finally {
      sendingRef.current = false;
    }

    // Could not get through: keep it on the phone.
    const kept: PendingSignOff = {
      savedAt: pending?.savedAt ?? new Date().toISOString(),
      payload,
      lastError: failure,
    };
    setPendingNotStored(!writePending(token, kept));
    justFailedRef.current = true; // don't fire a second attempt straight away
    setPending(kept);
  }

  function restoreForm(payload: PendingSignOff['payload']) {
    setSecurityCode(payload.securityCode);
    setVendorName(payload.vendorName);
    if (slip?.contacts?.some(c => `${c.name} ${c.surname}`.trim() === payload.vendorName)) {
      setContactMode('select');
    } else {
      setContactMode('other');
    }
    if (payload.deliveredSlipIds) setDeliveredIds(payload.deliveredSlipIds);
    if (payload.shortReasons) setShortReasons(payload.shortReasons);
    if (payload.signedCopyPhoto) {
      setSignMode('photo');
      setSignedCopyPhoto(payload.signedCopyPhoto);
    } else {
      // A drawn signature cannot be put back on the pad; ask for it again.
      setSignMode('draw');
      setHasSignature(false);
    }
  }

  // While a sign-off is waiting on this phone, send it as soon as there is
  // signal, and keep trying every 20 seconds in case `online` never fires.
  useEffect(() => {
    if (!pending) return;
    const attempt = () => { if (navigator.onLine !== false) sendSignOff(pending.payload, true); };
    // Found waiting when the page opened: try at once. Just failed: wait.
    if (!justFailedRef.current) attempt();
    justFailedRef.current = false;
    window.addEventListener('online', attempt);
    const timer = window.setInterval(attempt, 20000);
    return () => {
      window.removeEventListener('online', attempt);
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.savedAt, pending?.payload.capturedAt]);

  async function onPhotoPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setSubmitError('');
    setPhotoBusy(true);
    try {
      setSignedCopyPhoto(await compressPhoto(file));
    } catch {
      setSubmitError('That photo could not be read. Please take it again.');
    } finally {
      setPhotoBusy(false);
    }
  }

  // ── Loading state ──
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="h-10 w-10 border-4 border-[#7CC042] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-gray-500 text-sm">Loading delivery details...</p>
        </div>
      </div>
    );
  }

  // ── Saved on this phone, waiting for signal ──
  if (pending && !success) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="bg-white rounded-xl shadow-sm border border-amber-300 p-8 max-w-md w-full text-center">
          <div className="w-14 h-14 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-7 h-7 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900 mb-2">Saved on this phone. Not sent yet.</h1>
          <p className="text-gray-600 text-sm mb-3">
            The delivery is signed but could not be sent. It will send by itself as soon as this
            phone has signal. You do not need to sign again.
          </p>
          <p className="text-gray-600 text-sm mb-4">
            You can close this page. To finish, open the same link again (scan the QR code on the
            delivery note) when you have signal.
          </p>
          <div className="text-left text-xs bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 mb-4 space-y-1">
            <p><span className="text-gray-500">Received by:</span> <strong>{pending.payload.vendorName}</strong></p>
            <p><span className="text-gray-500">Signed:</span> {pending.payload.signedCopyPhoto ? 'on paper (photo saved)' : 'on the phone'}</p>
            <p><span className="text-gray-500">Saved:</span> {fmtDateTime(pending.savedAt)}</p>
            {pending.lastError && <p><span className="text-gray-500">Last try:</span> {pending.lastError}</p>}
          </div>
          {pendingNotStored && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">
              This phone would not let the page save it. <strong>Keep this page open</strong> until it
              sends, or it will be lost.
            </p>
          )}
          <button
            type="button"
            onClick={() => sendSignOff(pending.payload, true)}
            className="w-full py-3 bg-[#7CC042] text-white rounded-xl text-base font-bold hover:bg-[#5a9a2e]"
          >
            Send now
          </button>
        </div>
      </div>
    );
  }

  // ── No signal when the page opened ──
  if (loadFailedOffline) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 max-w-md w-full text-center">
          <h1 className="text-xl font-bold text-gray-900 mb-2">No signal</h1>
          <p className="text-gray-600 text-sm mb-4">
            The delivery details could not be loaded. Get the receiver to sign the paper delivery
            note, then open this link again when you have signal and choose
            &quot;Signed on paper? Use a photo&quot;.
          </p>
          <button
            type="button"
            onClick={loadSlip}
            className="w-full py-3 bg-[#7CC042] text-white rounded-xl text-base font-bold hover:bg-[#5a9a2e]"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  // ── Error state ──
  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 max-w-md w-full text-center">
          <div className="w-14 h-14 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-7 h-7 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900 mb-2">Invalid Link</h1>
          <p className="text-gray-500 text-sm">{error}</p>
        </div>
      </div>
    );
  }

  // ── Already delivered ──
  if (slip && slip.status === 'delivered') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 max-w-md w-full text-center">
          <div className="w-14 h-14 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-7 h-7 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900 mb-2">Already Delivered</h1>
          <p className="text-gray-500 text-sm mb-3">
            This delivery was confirmed on {slip.deliveredAt ? fmtDateTime(slip.deliveredAt) : 'N/A'}
          </p>
          {slip.deliverySignedByName && (
            <p className="text-gray-500 text-sm">
              Signed by: <strong>{slip.deliverySignedByName}</strong>
            </p>
          )}
        </div>
      </div>
    );
  }

  // ── Success state ──
  if (success) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 max-w-md w-full text-center">
          <div className="w-14 h-14 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-7 h-7 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900 mb-2">Delivery Confirmed</h1>
          <p className="text-gray-500 text-sm">
            {alreadyDone
              ? 'This delivery was already confirmed. Nothing more to do.'
              : 'Thank you. The delivery has been confirmed and recorded.'}
          </p>

          {shortResult.length > 0 && (
            <div className="mt-5 text-left border border-amber-200 bg-amber-50 rounded-lg px-4 py-3">
              <p className="text-sm font-semibold text-amber-900 mb-2">
                {shortResult.length} store{shortResult.length === 1 ? '' : 's'} recorded as not delivered
              </p>
              <ul className="text-xs text-amber-900 space-y-1">
                {shortResult.map(s => (
                  <li key={`${s.siteCode}-${s.siteName}`}>
                    {s.siteName} ({s.siteCode}) — {s.boxCount} box{s.boxCount === 1 ? '' : 'es'}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-amber-800 mt-2">
                This stock has not been signed for. The office has been notified and it is
                recorded against each store.
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Not in a deliverable status ──
  if (slip && slip.status !== 'in-transit' && slip.status !== 'partial-release') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 max-w-md w-full text-center">
          <div className="w-14 h-14 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-7 h-7 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900 mb-2">Not Available</h1>
          <p className="text-gray-500 text-sm">
            This delivery is not currently awaiting confirmation.
          </p>
          <p className="text-gray-400 text-xs mt-2">
            Current status: <span className="font-mono">{slip.status}</span>
          </p>
        </div>
      </div>
    );
  }

  if (!slip) return null;

  // ── Main delivery confirmation form ──
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-[#7CC042] text-white px-4 py-5">
        <div className="max-w-lg mx-auto">
          <h1 className="text-xl font-bold">iRam Delivery Confirmation</h1>
          <p className="text-white/80 text-sm mt-1">Confirm receipt of stock</p>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-6">
        {/* Slip details */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5 mb-5">
          <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Delivery Details</h2>
          <div className="grid grid-cols-2 gap-3 text-sm">
            {slip.slips && slip.slips.length > 1 ? (
              <>
                <div>
                  <span className="text-gray-500 text-xs block">Pick Slips</span>
                  <span className="font-medium">{slip.slips.length} slips</span>
                </div>
                <div>
                  <span className="text-gray-500 text-xs block">Client</span>
                  <span className="font-medium">{slip.clientName}</span>
                </div>
              </>
            ) : (
              <>
                <div>
                  <span className="text-gray-500 text-xs block">Pick Slip</span>
                  <span className="font-mono font-medium text-xs">{slip.slipId}</span>
                </div>
                <div>
                  <span className="text-gray-500 text-xs block">Client</span>
                  <span className="font-medium">{slip.clientName}</span>
                </div>
                <div>
                  <span className="text-gray-500 text-xs block">Store</span>
                  <span className="font-medium">{slip.siteName} ({slip.siteCode})</span>
                </div>
                <div>
                  <span className="text-gray-500 text-xs block">Warehouse</span>
                  <span className="font-medium">{slip.warehouse}</span>
                </div>
              </>
            )}
            <div>
              <span className="text-gray-500 text-xs block">Collecting Rep</span>
              <span className="font-medium">{slip.releaseRepName}</span>
            </div>
            <div>
              <span className="text-gray-500 text-xs block">Boxes</span>
              <span className={`font-medium ${(slip.totalBoxCount ?? slip.boxCount) > slip.boxCount ? 'text-red-600 font-bold' : ''}`}>
                {slip.boxCount} of {slip.totalBoxCount ?? slip.boxCount}
              </span>
            </div>
            <div>
              <span className="text-gray-500 text-xs block">Total Qty</span>
              <span className="font-medium">{slip.totalQty.toLocaleString()}</span>
            </div>
            <div>
              <span className="text-gray-500 text-xs block">Released</span>
              <span className="font-medium text-xs">{slip.releasedAt ? fmtDateTime(slip.releasedAt) : 'N/A'}</span>
            </div>
          </div>

          {/* GRN/GRV document number(s). Single-store notes only — on a
              multi-store note each store carries its own, shown on its card
              below. Always rendered, "—" when nothing was captured, so a blank
              never reads as the app having dropped it. */}
          {!(slip.slips && slip.slips.length > 1) && (
            <div className="mt-4 border-t border-gray-100 pt-3">
              <span className="text-gray-500 text-xs block">GRN/GRV Document No (Return Order)</span>
              <span className="font-mono font-medium text-sm break-words">
                {formatStoreRefs(refsOf(slip)) || '—'}
              </span>
              {slip.receiptGrnDate && (
                <span className="text-gray-500 text-xs block mt-0.5">Date: {slip.receiptGrnDate}</span>
              )}
            </div>
          )}

          {/* Per-store physical check. Tick each store as its boxes are
              physically counted off; anything left unticked is recorded as not
              delivered and its stock stays with iRam. */}
          {slip.slips && slip.slips.length > 1 && (
            <div className="mt-4 border-t border-gray-100 pt-3">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                Physical Check — tick each store as you count it off
              </h3>
              <p className="text-xs text-gray-500 mb-3">
                Leave a store unticked if its boxes are not here. You will still sign for
                everything you have received.
              </p>

              <div className="flex flex-col gap-2">
                {slip.slips.map(s => {
                  const ticked = deliveredIds.includes(s.slipId);
                  return (
                    <div key={s.slipId}
                      className={`rounded-lg border px-3 py-2.5 transition-colors ${
                        ticked ? 'border-gray-200 bg-white' : 'border-amber-300 bg-amber-50'
                      }`}>
                      <label className="flex items-start gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={ticked}
                          onChange={() => {
                            setSubmitError('');
                            setDeliveredIds(prev =>
                              prev.includes(s.slipId)
                                ? prev.filter(id => id !== s.slipId)
                                : [...prev, s.slipId]
                            );
                          }}
                          className="mt-0.5 h-5 w-5 accent-green-600 shrink-0"
                        />
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm font-medium text-gray-900">
                            {s.siteName} ({s.siteCode})
                          </span>
                          <span className="block text-xs text-gray-500 font-mono">{s.slipId}</span>
                          <span className="block text-xs text-gray-600 mt-0.5">
                            <span className="text-gray-500">GRN/GRV: </span>
                            <span className="font-mono break-words">
                              {formatStoreRefs(refsOf(s)) || '—'}
                            </span>
                            {s.receiptGrnDate && (
                              <span className="text-gray-500"> · {s.receiptGrnDate}</span>
                            )}
                          </span>
                          <span className="block text-xs text-gray-500 mt-0.5">
                            {s.totalQty.toLocaleString()} units ·{' '}
                            <span className={(s.totalBoxes ?? s.boxCount) > s.boxCount ? 'text-red-600 font-bold' : ''}>
                              {s.boxCount} of {s.totalBoxes ?? s.boxCount} box{(s.totalBoxes ?? s.boxCount) === 1 ? '' : 'es'}
                            </span>
                          </span>
                        </span>
                        {!ticked && (
                          <span className="text-[10px] font-bold uppercase tracking-wide text-amber-800 bg-amber-200 px-2 py-0.5 rounded-full shrink-0">
                            Not delivered
                          </span>
                        )}
                      </label>

                      {!ticked && (() => {
                        const entry = shortReasons[s.slipId] ?? { reasonKey: '', note: '' };
                        const def = SHORTFALL_REASONS.find(r => r.key === entry.reasonKey);
                        const setEntry = (patch: Partial<{ reasonKey: string; note: string }>) => {
                          setSubmitError('');
                          setShortReasons(prev => ({
                            ...prev,
                            [s.slipId]: { ...(prev[s.slipId] ?? { reasonKey: '', note: '' }), ...patch },
                          }));
                        };
                        return (
                          <div className="mt-2 pl-8 flex flex-col gap-2">
                            <div>
                              <label className="block text-xs font-medium text-amber-900 mb-1">
                                Why not? (required)
                              </label>
                              <select
                                value={entry.reasonKey}
                                onChange={e => setEntry({ reasonKey: e.target.value })}
                                className="w-full border border-amber-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                              >
                                <option value="">— Select a reason —</option>
                                {SHORTFALL_REASONS.map(r => (
                                  <option key={r.key} value={r.key}>{r.label}</option>
                                ))}
                              </select>
                              {def && <p className="text-xs text-amber-800 mt-1">{def.hint}</p>}
                            </div>

                            <div>
                              <label className="block text-xs font-medium text-amber-900 mb-1">
                                Note {def?.requiresNote ? '(required)' : '(optional)'}
                              </label>
                              <input
                                type="text"
                                value={entry.note}
                                onChange={e => setEntry({ note: e.target.value })}
                                placeholder="Anything the office should know"
                                className="w-full border border-amber-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                              />
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>

              {slip.slips.length > deliveredIds.length && (
                <p className="mt-3 text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <strong>{slip.slips.length - deliveredIds.length} store
                  {slip.slips.length - deliveredIds.length === 1 ? '' : 's'} marked as not delivered.</strong>{' '}
                  This stock is excluded from what you are signing for, and the shortfall is
                  printed on the delivery note itself.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Confirmation form */}
        <form onSubmit={handleSubmit}>
          {/* Security code */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5 mb-5">
            <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Security Code</h2>
            <p className="text-xs text-gray-500 mb-3">
              Enter the 4-character release code provided by the collecting rep.
            </p>
            <input
              type="text"
              value={securityCode}
              onChange={e => setSecurityCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
              maxLength={4}
              placeholder="e.g. AB12"
              className="w-full px-4 py-3 border border-gray-300 rounded-lg text-lg font-mono tracking-[0.3em] text-center uppercase"
              autoComplete="off"
            />
          </div>

          {/* Vendor name */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5 mb-5">
            <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Received By</h2>
            <p className="text-xs text-gray-500 mb-3">
              Select the person receiving the stock, or choose &quot;Other&quot; to type a name.
            </p>
            {slip.contacts && slip.contacts.length > 0 ? (
              <>
                <select
                  value={contactMode === 'other' ? '__other__' : vendorName}
                  onChange={e => {
                    if (e.target.value === '__other__') {
                      setContactMode('other');
                      setVendorName('');
                    } else {
                      setContactMode('select');
                      setVendorName(e.target.value);
                    }
                  }}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg text-sm mb-2"
                >
                  <option value="">Select name...</option>
                  {slip.contacts.map((c, i) => {
                    const fullName = `${c.name} ${c.surname}`.trim();
                    return (
                      <option key={i} value={fullName}>{fullName}</option>
                    );
                  })}
                  <option value="__other__">Other</option>
                </select>
                {contactMode === 'other' && (
                  <input
                    type="text"
                    value={vendorName}
                    onChange={e => setVendorName(e.target.value)}
                    placeholder="Enter full name"
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg text-sm"
                    autoComplete="off"
                  />
                )}
              </>
            ) : (
              <input
                type="text"
                value={vendorName}
                onChange={e => setVendorName(e.target.value)}
                placeholder="Full name"
                className="w-full px-4 py-3 border border-gray-300 rounded-lg text-sm"
                autoComplete="off"
              />
            )}
          </div>

          {/* Signature pad */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5 mb-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">Signature</h2>
              {signMode === 'draw' && hasSignature && (
                <button
                  type="button"
                  onClick={clearSignature}
                  className="text-xs text-red-500 hover:text-red-700 font-medium"
                >
                  Clear
                </button>
              )}
            </div>

            {/* Two ways to sign. Paper is for when the phone has no signal or
                the receiver has already signed the printed note. */}
            <div className="grid grid-cols-2 gap-2 mb-3">
              <button
                type="button"
                onClick={() => { setSignMode('draw'); setHasSignature(false); setSubmitError(''); }}
                className={`py-2 rounded-lg text-xs font-semibold border ${signMode === 'draw' ? 'bg-[#7CC042] text-white border-[#7CC042]' : 'bg-white text-gray-700 border-gray-300'}`}
              >
                Sign on the phone
              </button>
              <button
                type="button"
                onClick={() => { setSignMode('photo'); setSubmitError(''); }}
                className={`py-2 rounded-lg text-xs font-semibold border ${signMode === 'photo' ? 'bg-[#7CC042] text-white border-[#7CC042]' : 'bg-white text-gray-700 border-gray-300'}`}
              >
                Signed on paper? Use a photo
              </button>
            </div>

            {signMode === 'photo' ? (
              <div>
                <p className="text-xs text-gray-500 mb-3">
                  Get the receiver to sign and date the printed delivery note, then take a clear photo
                  of the signed page. The photo is attached to the signed delivery note.
                </p>
                {signedCopyPhoto ? (
                  <div>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={signedCopyPhoto} alt="Signed delivery note" className="w-full rounded-lg border border-gray-200" />
                    <label className="mt-2 block text-center text-xs font-medium text-[#5a9a2e] underline cursor-pointer">
                      Retake photo
                      <input type="file" accept="image/*" className="hidden" onChange={onPhotoPicked} />
                    </label>
                  </div>
                ) : (
                  <label className="flex flex-col items-center justify-center gap-1 h-[140px] border-2 border-dashed border-gray-300 rounded-lg cursor-pointer text-gray-600 text-sm font-medium">
                    {photoBusy ? 'Preparing photo...' : 'Tap to take a photo of the signed page'}
                    <span className="text-xs text-gray-400 font-normal">or choose one already taken</span>
                    {/* No `capture` attribute: the phone offers camera OR
                        gallery, so a photo taken earlier with no signal works. */}
                    <input type="file" accept="image/*" className="hidden" onChange={onPhotoPicked} disabled={photoBusy} />
                  </label>
                )}
              </div>
            ) : (
            <>
            <p className="text-xs text-gray-500 mb-3">
              Sign below with your finger or stylus.
            </p>
            <div className="border-2 border-dashed border-gray-300 rounded-lg bg-white overflow-hidden touch-none">
              <canvas
                ref={canvasRef}
                className="w-full"
                style={{ height: '180px' }}
                onMouseDown={startDraw}
                onMouseMove={draw}
                onMouseUp={endDraw}
                onMouseLeave={endDraw}
                onTouchStart={startDraw}
                onTouchMove={draw}
                onTouchEnd={endDraw}
              />
            </div>
            {!hasSignature && (
              <p className="text-center text-gray-400 text-xs mt-2">Draw your signature above</p>
            )}
            </>
            )}
          </div>

          {/* Error message */}
          {submitError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 mb-5">
              <p className="text-sm text-red-700">{submitError}</p>
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={submitting || photoBusy || !securityCode.trim() || !vendorName.trim()
              || (signMode === 'draw' ? !hasSignature : !signedCopyPhoto)}
            className="w-full py-3.5 bg-[#7CC042] text-white rounded-xl text-base font-bold hover:bg-[#5a9a2e] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-sm"
          >
            {submitting && <div className="h-5 w-5 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            Confirm Delivery
          </button>
        </form>

        {/* Footer */}
        <p className="text-center text-xs text-gray-400 mt-6">
          Powered by OuterJoin
        </p>
      </div>
    </div>
  );
}
