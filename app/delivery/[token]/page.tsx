'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';

interface ContactDto {
  name: string;
  surname: string;
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
  manual: boolean;
  contacts?: ContactDto[];
  deliveredAt?: string;
  deliverySignedByName?: string;
}

function fmtDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
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

  // Signature pad state
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);

  // ── Load slip data ──
  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const res = await fetch(`/api/delivery/${token}`, { cache: 'no-store' });
        const data = await res.json();
        if (res.ok) {
          setSlip(data);
        } else {
          setError(data.error || 'Failed to load delivery details');
        }
      } catch {
        setError('Network error — please try again');
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  // ── Signature pad setup ──
  const initCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas to actual display size
    const rect = canvas.getBoundingClientRect();
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
    initCanvas();
    window.addEventListener('resize', initCanvas);
    return () => window.removeEventListener('resize', initCanvas);
  }, [initCanvas, slip]);

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
    if (!hasSignature) {
      setSubmitError('Please provide a signature');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/delivery/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          securityCode: securityCode.trim(),
          vendorName: vendorName.trim(),
          signature: getSignatureBase64(),
        }),
      });

      const data = await res.json();
      if (res.ok) {
        setSuccess(true);
      } else {
        setSubmitError(data.error || 'Failed to confirm delivery');
      }
    } catch {
      setSubmitError('Network error — please try again');
    } finally {
      setSubmitting(false);
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
            Thank you. The delivery has been confirmed and recorded.
          </p>
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
            <div>
              <span className="text-gray-500 text-xs block">Collecting Rep</span>
              <span className="font-medium">{slip.releaseRepName}</span>
            </div>
            <div>
              <span className="text-gray-500 text-xs block">Boxes</span>
              <span className="font-medium">{slip.boxCount}</span>
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
              {hasSignature && (
                <button
                  type="button"
                  onClick={clearSignature}
                  className="text-xs text-red-500 hover:text-red-700 font-medium"
                >
                  Clear
                </button>
              )}
            </div>
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
            disabled={submitting || !securityCode.trim() || !vendorName.trim() || !hasSignature}
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
