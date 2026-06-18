'use client';

import { useEffect, useState } from 'react';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';

type StickerLayout = 'roll' | 'a4sheet';

interface StickerProfile {
  widthMm: number;
  heightMm: number;
  gapMm: number;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
}

interface StickerSettings {
  defaultLayout: StickerLayout;
  roll: StickerProfile;
  a4sheet: StickerProfile;
}

interface AppSettings {
  sticker: StickerSettings;
}

// Form values are strings while editing; converted to numbers on save.
type ProfileForm = Record<keyof StickerProfile, string>;

const MM = 72 / 25.4;

function toForm(p: StickerProfile): ProfileForm {
  return {
    widthMm: String(p.widthMm),
    heightMm: String(p.heightMm),
    gapMm: String(p.gapMm),
    marginTop: String(p.marginTop),
    marginBottom: String(p.marginBottom),
    marginLeft: String(p.marginLeft),
    marginRight: String(p.marginRight),
  };
}

function toNumbers(f: ProfileForm): StickerProfile {
  const n = (v: string) => parseFloat(v) || 0;
  return {
    widthMm: n(f.widthMm),
    heightMm: n(f.heightMm),
    gapMm: n(f.gapMm),
    marginTop: n(f.marginTop),
    marginBottom: n(f.marginBottom),
    marginLeft: n(f.marginLeft),
    marginRight: n(f.marginRight),
  };
}

export default function StickersPage() {
  useAuth('manage_warehouses');
  const [loaded, setLoaded] = useState(false);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<StickerLayout | null>(null);

  const [defaultLayout, setDefaultLayout] = useState<StickerLayout>('a4sheet');
  const [roll, setRoll] = useState<ProfileForm>(toForm({ widthMm: 74, heightMm: 50, gapMm: 0, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 }));
  const [a4, setA4] = useState<ProfileForm>(toForm({ widthMm: 99.1, heightMm: 139, gapMm: 0, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 }));

  const notify = (message: string, type: 'success' | 'error' = 'success') =>
    setToast({ message, type });

  useEffect(() => {
    (async () => {
      try {
        const res = await authFetch('/api/settings', { cache: 'no-store' });
        if (res.ok) {
          const data: AppSettings = await res.json();
          setDefaultLayout(data.sticker.defaultLayout ?? 'a4sheet');
          setRoll(toForm(data.sticker.roll));
          setA4(toForm(data.sticker.a4sheet));
        }
      } catch { /* ignore */ }
      finally { setLoaded(true); }
    })();
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const rollP = toNumbers(roll);
    const a4P = toNumbers(a4);
    for (const [name, p] of [['Roll', rollP], ['A4 Sheet', a4P]] as const) {
      if (p.widthMm < 20 || p.heightMm < 20) { notify(`${name}: dimensions must be at least 20mm`, 'error'); return; }
      if (p.widthMm > 210 || p.heightMm > 297) { notify(`${name}: dimensions cannot exceed A4 (210x297mm)`, 'error'); return; }
    }

    setSaving(true);
    try {
      const res = await authFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sticker: { defaultLayout, roll: rollP, a4sheet: a4P } }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Unknown error' }));
        notify(data.error || 'Failed to save', 'error');
        return;
      }
      notify('Settings saved');
    } finally {
      setSaving(false);
    }
  }

  async function handleTestPrint(format: StickerLayout) {
    setTesting(format);
    try {
      const res = await authFetch(`/api/stickers/test?format=${format}`);
      if (!res.ok) { notify('Failed to generate test print', 'error'); return; }
      const blob = await res.blob();
      window.open(URL.createObjectURL(blob), '_blank');
    } catch {
      notify('Failed to generate test print', 'error');
    } finally {
      setTesting(null);
    }
  }

  if (!loaded) {
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
        <p className="text-sm text-gray-500 mt-0.5">Configure both Roll and A4 Sheet label formats. The format is chosen when you print.</p>
      </div>

      {/* Guidance */}
      <section className="bg-amber-50 rounded-xl border border-amber-200 p-4">
        <h2 className="text-sm font-bold text-amber-800 mb-1">How to get stickers printing correctly</h2>
        <ol className="text-xs text-amber-700 list-decimal list-inside space-y-1">
          <li><strong>Roll</strong> — for thermal/roll printers (e.g. Postek). Measure one physical label and the gap between labels on the roll.</li>
          <li><strong>A4 Sheet</strong> — for sheet label printers. For pre-cut sheets (e.g. 99.1 × 139 mm 4-up) set gap 0 so labels are contiguous; the grid auto-centres on the page.</li>
          <li>Click <strong>Print Test Label</strong> under a format and print at <strong>&quot;Actual Size&quot;</strong> (not &quot;Fit to Page&quot;). The border should align with the label edges.</li>
          <li>Set the <strong>Default Format</strong> below — it&rsquo;s used when printing without an explicit choice (e.g. rep bookings). You can still pick the other format at download time.</li>
        </ol>
      </section>

      <form onSubmit={handleSave} className="flex flex-col gap-6">
        {/* Default format */}
        <section className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-1">Default Format</h2>
          <p className="text-xs text-gray-500 mb-4">Used when a print doesn&rsquo;t specify Roll or A4.</p>
          <select
            value={defaultLayout}
            onChange={e => setDefaultLayout(e.target.value as StickerLayout)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm max-w-xs focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
          >
            <option value="roll">Roll (one sticker per page)</option>
            <option value="a4sheet">A4 Sheet (grid layout)</option>
          </select>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <ProfileEditor
            title="Roll (thermal printer)"
            mode="roll"
            form={roll}
            onChange={setRoll}
            onTest={() => handleTestPrint('roll')}
            testing={testing === 'roll'}
          />
          <ProfileEditor
            title="A4 Sheet"
            mode="a4sheet"
            form={a4}
            onChange={setA4}
            onTest={() => handleTestPrint('a4sheet')}
            testing={testing === 'a4sheet'}
          />
        </div>

        <div>
          <button
            type="submit"
            disabled={saving}
            className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white text-sm font-bold px-6 py-2 rounded-lg transition-colors"
          >
            {saving ? 'Saving...' : 'Save Both Formats'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Per-format editor card ────────────────────────────────────────────────────

function ProfileEditor({
  title, mode, form, onChange, onTest, testing,
}: {
  title: string;
  mode: StickerLayout;
  form: ProfileForm;
  onChange: (f: ProfileForm) => void;
  onTest: () => void;
  testing: boolean;
}) {
  const set = (k: keyof ProfileForm, v: string) => onChange({ ...form, [k]: v });

  const w = parseFloat(form.widthMm) || 0;
  const h = parseFloat(form.heightMm) || 0;
  const gapPt = (parseFloat(form.gapMm) || 0) * MM;
  const cols = w > 0 ? Math.floor((595.28 + gapPt) / (w * MM + gapPt)) : 0;
  const rows = h > 0 ? Math.floor((841.89 + gapPt) / (h * MM + gapPt)) : 0;
  const perPage = cols * rows;

  return (
    <section className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">{title}</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          {mode === 'roll'
            ? 'Each PDF page is sized to the sticker — for roll/thermal label printers.'
            : 'Stickers arranged in a grid on A4 pages — for sheet label printers.'}
        </p>
      </div>

      {/* Dimensions */}
      <div className="grid grid-cols-2 gap-4">
        <Field label="Width (mm)">
          <input type="number" min={20} max={210} step={0.1} value={form.widthMm} required
            onChange={e => set('widthMm', e.target.value)} className={inputCls} />
        </Field>
        <Field label="Height (mm)">
          <input type="number" min={20} max={297} step={0.1} value={form.heightMm} required
            onChange={e => set('heightMm', e.target.value)} className={inputCls} />
        </Field>
      </div>

      {/* Gap */}
      <Field label={mode === 'roll' ? 'Label Gap (mm)' : 'Gap Between Labels (mm)'}>
        <input type="number" min={0} max={20} step={0.5} value={form.gapMm}
          onChange={e => set('gapMm', e.target.value)} className={`${inputCls} max-w-[160px]`} />
        <p className="text-xs text-gray-400 mt-0.5">
          {mode === 'roll'
            ? 'Distance between labels on the roll (usually 2–3 mm).'
            : 'Gap between labels on the sheet. 0 = contiguous (pre-cut 4-up sheets).'}
        </p>
      </Field>

      {/* Margins */}
      <div>
        <label className="text-xs text-gray-500 font-medium block mb-2">Content Margins (mm)</label>
        <div className="grid grid-cols-4 gap-2">
          {(['marginTop', 'marginBottom', 'marginLeft', 'marginRight'] as const).map(k => (
            <div key={k} className="flex flex-col gap-1">
              <label className="text-[10px] text-gray-400 capitalize">{k.replace('margin', '')}</label>
              <input type="number" min={0} max={20} step={0.5} value={form[k]}
                onChange={e => set(k, e.target.value)} className={`${inputCls} px-2 py-1.5`} />
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-400 mt-1">Pushes content inward from label edges.</p>
      </div>

      {/* Preview */}
      <div className="bg-gray-50 rounded-lg border border-gray-200 px-4 py-3">
        {mode === 'a4sheet' ? (
          <p className="text-xs text-gray-500">
            {w > 0 && h > 0
              ? <>{cols} columns &times; {rows} rows = <span className="font-bold text-[var(--color-primary)]">{perPage} stickers per A4 page</span></>
              : 'Enter dimensions to preview'}
          </p>
        ) : (
          <p className="text-xs text-gray-500">
            {w > 0 && h > 0
              ? <>Each PDF page = <span className="font-bold text-[var(--color-primary)]">{w}mm &times; {h}mm</span> — one sticker per page</>
              : 'Enter dimensions to preview'}
          </p>
        )}
      </div>

      <button
        type="button"
        disabled={testing}
        onClick={onTest}
        className="self-start border border-gray-300 hover:bg-gray-50 disabled:opacity-50 text-gray-700 text-sm font-medium px-5 py-2 rounded-lg transition-colors"
      >
        {testing ? 'Generating...' : 'Print Test Label'}
      </button>
    </section>
  );
}

const inputCls = 'border border-gray-300 rounded-lg px-3 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-gray-500 font-medium">{label}</label>
      {children}
    </div>
  );
}
