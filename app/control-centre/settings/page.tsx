'use client';

import { useEffect, useState } from 'react';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';

interface StickerSettings {
  widthMm: number;
  heightMm: number;
}

interface AppSettings {
  sticker: StickerSettings;
}

export default function SettingsPage() {
  useAuth('manage_warehouses');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [saving, setSaving] = useState(false);

  // Sticker form fields
  const [stickerW, setStickerW] = useState('');
  const [stickerH, setStickerH] = useState('');

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

    setSaving(true);
    try {
      const res = await authFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sticker: { widthMm: w, heightMm: h } }),
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

  // Calculate preview info
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
        <p className="text-sm text-gray-500 mt-0.5">Configure sticker label size for PDF generation</p>
      </div>

      {/* Sticker Dimensions */}
      <section className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-1">
          Sticker Label Size
        </h2>
        <p className="text-xs text-gray-500 mb-5">
          Set the physical sticker dimensions. This affects the PDF layout when printing sticker batches.
        </p>

        <form onSubmit={handleSave} className="flex flex-col gap-5">
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

          {/* Live preview */}
          {previewW > 0 && previewH > 0 && (
            <div className="bg-gray-50 rounded-lg border border-gray-200 px-4 py-3 max-w-md">
              <p className="text-xs font-semibold text-gray-600 mb-1">A4 Sheet Preview</p>
              <p className="text-xs text-gray-500">
                {cols} columns &times; {rows} rows = <span className="font-bold text-[var(--color-primary)]">{perPage} stickers per page</span>
              </p>
            </div>
          )}

          <div>
            <button
              type="submit"
              disabled={saving}
              className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white text-sm font-bold px-6 py-2 rounded-lg transition-colors"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
