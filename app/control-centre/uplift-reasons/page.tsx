'use client';

import { useEffect, useState } from 'react';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';

export default function UpliftReasonsPage() {
  useAuth('manage_warehouses');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [newReason, setNewReason] = useState('');

  const notify = (message: string, type: 'success' | 'error' = 'success') =>
    setToast({ message, type });

  useEffect(() => {
    (async () => {
      try {
        const res = await authFetch('/api/settings', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          setReasons(Array.isArray(data.upliftFailureReasons) ? data.upliftFailureReasons : []);
        } else {
          notify('Failed to load reasons', 'error');
        }
      } catch {
        notify('Network error loading reasons', 'error');
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  function addReason() {
    const t = newReason.trim();
    if (!t) return;
    if (reasons.some(r => r.toLowerCase() === t.toLowerCase())) {
      notify('That reason already exists', 'error');
      return;
    }
    setReasons(prev => [...prev, t]);
    setNewReason('');
  }

  function updateReason(idx: number, value: string) {
    setReasons(prev => prev.map((r, i) => (i === idx ? value : r)));
  }

  function removeReason(idx: number) {
    setReasons(prev => prev.filter((_, i) => i !== idx));
  }

  function move(idx: number, dir: -1 | 1) {
    setReasons(prev => {
      const next = [...prev];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  }

  async function save() {
    // Trim + drop blanks + dedupe (case-insensitive) before saving.
    const seen = new Set<string>();
    const clean: string[] = [];
    for (const r of reasons) {
      const t = r.trim();
      if (!t) continue;
      const lc = t.toLowerCase();
      if (seen.has(lc)) continue;
      seen.add(lc);
      clean.push(t);
    }
    setSaving(true);
    try {
      const res = await authFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upliftFailureReasons: clean }),
      });
      if (res.ok) {
        const data = await res.json();
        setReasons(Array.isArray(data.upliftFailureReasons) ? data.upliftFailureReasons : clean);
        notify('Reasons saved');
      } else {
        const data = await res.json().catch(() => ({}));
        notify(data.error || 'Failed to save', 'error');
      }
    } catch {
      notify('Network error saving', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) {
    return <div className="text-sm text-gray-500">Loading…</div>;
  }

  return (
    <>
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <div className="flex flex-col gap-6 max-w-2xl">
        <div className="bg-white rounded-xl shadow-sm border-l-4 border-[var(--color-primary)] px-6 py-4">
          <h1 className="text-xl font-bold text-gray-900">Upliftment Reasons</h1>
          <p className="text-sm text-gray-500 mt-1">
            Reasons an admin can pick from when marking a sent pick slip{' '}
            <span className="font-medium text-rose-600">Unsuccessful</span> — e.g. when the rep
            couldn&apos;t complete the upliftment at the store. The slip then becomes re-sendable.
          </p>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex flex-col gap-2">
            {reasons.length === 0 && (
              <p className="text-sm text-gray-500">No reasons yet — add one below.</p>
            )}
            {reasons.map((r, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <input
                  value={r}
                  onChange={e => updateReason(idx, e.target.value)}
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30"
                />
                <button
                  type="button"
                  onClick={() => move(idx, -1)}
                  disabled={idx === 0}
                  className="px-2 py-2 text-gray-400 hover:text-gray-700 disabled:opacity-30"
                  aria-label="Move up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(idx, 1)}
                  disabled={idx === reasons.length - 1}
                  className="px-2 py-2 text-gray-400 hover:text-gray-700 disabled:opacity-30"
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => removeReason(idx)}
                  className="px-2 py-2 text-rose-500 hover:text-rose-700"
                  aria-label="Remove"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2 mt-4 pt-4 border-t border-gray-100">
            <input
              value={newReason}
              onChange={e => setNewReason(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addReason(); } }}
              placeholder="Add a reason…"
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30"
            />
            <button
              type="button"
              onClick={addReason}
              className="px-4 py-2 border border-[var(--color-primary)]/30 text-[var(--color-primary)] rounded-lg text-sm font-medium hover:bg-[var(--color-primary)]/5"
            >
              Add
            </button>
          </div>

          <div className="mt-6">
            <button
              onClick={save}
              disabled={saving}
              className="px-5 py-2 bg-[var(--color-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {saving && <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
              Save Reasons
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
