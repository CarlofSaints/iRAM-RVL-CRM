'use client';

import { useEffect, useState } from 'react';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';

type StickerLayout = 'roll' | 'a4sheet';

interface StickerSettings {
  widthMm: number;
  heightMm: number;
  layout: StickerLayout;
  gapMm: number;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
}

interface AppSettings {
  sticker: StickerSettings;
}

export default function StickersPage() {
  useAuth('manage_warehouses');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [saving, setSaving] = useState(false);
  const [testingPrint, setTestingPrint] = useState(false);

  // Sticker form fields
  const [stickerW, setStickerW] = useState('');
  const [stickerH, setStickerH] = useState('');
  const [layout, setLayout] = useState<StickerLayout>('roll');
  const [gap, setGap] = useState('0');
  const [mTop, setMTop] = useState('0');
  const [mBottom, setMBottom] = useState('0');
  const [mLeft, setMLeft] = useState('0');
  const [mRight, setMRight] = useState('0');

  const notify = (message: string, type: 'success' | 'error' = 'success') =>
    setToast({ message, type });

  useEffect(() => {
    (async () => {
      try {
        const res = await authFetch('/api/settings', { cache: 'no-store' });
        if (res.ok) {
          const data: AppSettings = await res.json();
          setSettings(data);
          setStickerW(String(data.sticker.widthMm));
          setStickerH(String(data.sticker.heightMm));
          setLayout(data.sticker.layout ?? 'roll');
          setGap(String(data.sticker.gapMm ?? 0));
          setMTop(String(data.sticker.marginTop ?? 0));
          setMBottom(String(data.sticker.marginBottom ?? 0));
          setMLeft(String(data.sticker.marginLeft ?? 0));
          setMRight(String(data.sticker.marginRight ?? 0));
        }
      } catch { /* ignore */ }
    })();
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const w = parseFloat(stickerW);
    const h = parseFloat(stickerH);
    if (isNaN(w) || isNaN(h) || w < 20 || h < 20) {
      notify('Dimensions must be at least 20mm', 'error');
      return;
    }
    if (w > 210 || h > 297) {
      notify('Dimensions cannot exceed A4 size (210x297mm)', 'error');
      return;
    }

    const g = parseFloat(gap) || 0;
    const mt = parseFloat(mTop) || 0;
    const mb = parseFloat(mBottom) || 0;
    const ml = parseFloat(mLeft) || 0;
    const mr = parseFloat(mRight) || 0;

    setSaving(true);
    try {
      const res = await authFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sticker: {
            widthMm: w,
            heightMm: h,
            layout,
            gapMm: g,
            marginTop: mt,
            marginBottom: mb,
            marginLeft: ml,
            marginRight: mr,
          },
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Unknown error' }));
        notify(data.error || 'Failed to save', 'error');
        return;
      }
      const updated: AppSettings = await res.json();
      setSettings(updated);
      notify('Settings saved');
    } finally {
      setSaving(false);
    }
  }

  async function handleTestPrint() {
    setTestingPrint(true);
    try {
      const res = await authFetch('/api/stickers/test');
      if (!res.ok) {
        notify('Failed to generate test print', 'error');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    } catch {
      notify('Failed to generate test print', 'error');
    } finally {
      setTestingPrint(false);
    }
  }

  // Calculate A4 preview info
  const MM = 72 / 25.4;
  const previewW = parseFloat(stickerW) || 0;
  const previewH = parseFloat(stickerH) || 0;
  const cols = previewW > 0 ? Math.floor((595.28 + 8) / (previewW * MM + 8)) : 0;
  const rows = previewH > 0 ? Math.floor((841.89 + 8) / (previewH * MM + 8)) : 0;
  const perPage = cols * rows;

  if (!settings) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--color-primary)]" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <div className="bg-white rounded-xl shadow-sm border-l-4 border-[var(--color-primary)] px-6 py-4">
        <h1 className="text-xl font-bold text-gray-900">Sticker Dimensions</h1>
        <p className="text-sm text-gray-500 mt-0.5">Configure sticker label size and layout for PDF generation</p>
      </div>

      {/* Guidance */}
      <section className="bg-amber-50 rounded-xl border border-amber-200 p-4">
        <h2 className="text-sm font-bold text-amber-800 mb-1">How to get stickers printing correctly</h2>
        <ol className="text-xs text-amber-700 list-decimal list-inside space-y-1">
          <li><strong>Measure one physical label</strong> on the roll with a ruler &mdash; width and height in mm.</li>
          <li>Enter those exact dimensions below and save.</li>
          <li>Click <strong>Print Test Label</strong> &mdash; it prints one page with a border and dimensions.</li>
          <li>Print the test PDF to your label printer. Select <strong>&quot;Actual Size&quot;</strong> (not &quot;Fit to Page&quot;).</li>
          <li>The border should align exactly with the label edges. If it overflows onto a second label, the height is too large. If there&rsquo;s blank space, the height is too small.</li>
          <li>If label 1 is fine but labels 2 &amp; 3 drift, set the <strong>Label Gap</strong> &mdash; measure the space between labels on the roll (usually 2&ndash;3 mm).</li>
          <li>Use <strong>margins</strong> to nudge content inward if it&rsquo;s clipped at the edges.</li>
        </ol>
      </section>

      <section className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-1">
          Sticker Label Size
        </h2>
        <p className="text-xs text-gray-500 mb-5">
          Set the physical sticker dimensions and print layout.
        </p>

        <form onSubmit={handleSave} className="flex flex-col gap-5">
          {/* Layout mode */}
          <div className="flex flex-col gap-1 max-w-md">
            <label className="text-xs text-gray-500 font-medium">Print Layout</label>
            <select
              value={layout}
              onChange={e => setLayout(e.target.value as StickerLayout)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
            >
              <option value="roll">Roll (one sticker per page)</option>
              <option value="a4sheet">A4 Sheet (grid layout)</option>
            </select>
            <p className="text-xs text-gray-400 mt-0.5">
              {layout === 'roll'
                ? 'Each PDF page is sized to the sticker — for roll/thermal label printers.'
                : 'Stickers arranged in a grid on A4 pages — for sheet label printers.'}
            </p>
          </div>

          {/* Dimensions */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-md">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500 font-medium">Width (mm)</label>
              <input
                type="number"
                min={20}
                max={210}
                step={0.1}
                value={stickerW}
                onChange={e => setStickerW(e.target.value)}
                required
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500 font-medium">Height (mm)</label>
              <input
                type="number"
                min={20}
                max={297}
                step={0.1}
                value={stickerH}
                onChange={e => setStickerH(e.target.value)}
                required
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
              />
            </div>
          </div>

          {/* Label gap (roll mode only) */}
          {layout === 'roll' && (
            <div className="flex flex-col gap-1 max-w-[200px]">
              <label className="text-xs text-gray-500 font-medium">Label Gap (mm)</label>
              <input
                type="number"
                min={0}
                max={20}
                step={0.5}
                value={gap}
                onChange={e => setGap(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
              />
              <p className="text-xs text-gray-400 mt-0.5">
                Distance between labels on the roll. Measure the gap between the bottom of one label and the top of the next. Usually 2–3 mm.
              </p>
            </div>
          )}

          {/* Margins */}
          <div>
            <label className="text-xs text-gray-500 font-medium block mb-2">Content Margins (mm)</label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 max-w-md">
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-gray-400">Top</label>
                <input
                  type="number"
                  min={0}
                  max={20}
                  step={0.5}
                  value={mTop}
                  onChange={e => setMTop(e.target.value)}
                  className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-gray-400">Bottom</label>
                <input
                  type="number"
                  min={0}
                  max={20}
                  step={0.5}
                  value={mBottom}
                  onChange={e => setMBottom(e.target.value)}
                  className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-gray-400">Left</label>
                <input
                  type="number"
                  min={0}
                  max={20}
                  step={0.5}
                  value={mLeft}
                  onChange={e => setMLeft(e.target.value)}
                  className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-gray-400">Right</label>
                <input
                  type="number"
                  min={0}
                  max={20}
                  step={0.5}
                  value={mRight}
                  onChange={e => setMRight(e.target.value)}
                  className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                />
              </div>
            </div>
            <p className="text-xs text-gray-400 mt-1 max-w-md">
              Pushes content inward from label edges. Use if text is being clipped at the edges.
            </p>
          </div>

          {/* Live preview */}
          {layout === 'a4sheet' && previewW > 0 && previewH > 0 && (
            <div className="bg-gray-50 rounded-lg border border-gray-200 px-4 py-3 max-w-md">
              <p className="text-xs font-semibold text-gray-600 mb-1">A4 Sheet Preview</p>
              <p className="text-xs text-gray-500">
                {cols} columns &times; {rows} rows = <span className="font-bold text-[var(--color-primary)]">{perPage} stickers per page</span>
              </p>
            </div>
          )}

          {layout === 'roll' && previewW > 0 && previewH > 0 && (
            <div className="bg-gray-50 rounded-lg border border-gray-200 px-4 py-3 max-w-md">
              <p className="text-xs font-semibold text-gray-600 mb-1">Roll Preview</p>
              <p className="text-xs text-gray-500">
                Each PDF page = <span className="font-bold text-[var(--color-primary)]">{previewW}mm &times; {previewH}mm</span> — one sticker per page
              </p>
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="submit"
              disabled={saving}
              className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white text-sm font-bold px-6 py-2 rounded-lg transition-colors"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              disabled={testingPrint}
              onClick={handleTestPrint}
              className="border border-gray-300 hover:bg-gray-50 disabled:opacity-50 text-gray-700 text-sm font-medium px-5 py-2 rounded-lg transition-colors"
            >
              {testingPrint ? 'Generating...' : 'Print Test Label'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
