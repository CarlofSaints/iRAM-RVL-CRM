'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';
import type { AgedStockFormat, AgedStockPeriod, AgedStockRawRow } from '@/lib/agedStockParser';

interface ScopedClient {
  id: string;
  name: string;
  vendorNumbers: string[];
}

interface ParseResponse {
  ok: true;
  draftId: string;
  fileName: string;
  format: AgedStockFormat;
  rowCount: number;
  periods: AgedStockPeriod[];
  sampleRows: AgedStockRawRow[];
  warnings: string[];
}

function clientLabel(c: ScopedClient): string {
  const nums = (c.vendorNumbers ?? []).filter(Boolean);
  return nums.length ? `${c.name} - ${nums.join(', ')}` : c.name;
}

export default function LoadAgedStockPage() {
  useAuth('load_aged_stock');
  const router = useRouter();
  const [toast, setToast] = useState<ToastData | null>(null);
  const [clients, setClients] = useState<ScopedClient[]>([]);
  const [selectedClientIds, setSelectedClientIds] = useState<string[]>([]);
  const [clientDropdownOpen, setClientDropdownOpen] = useState(false);
  const clientDropdownRef = useRef<HTMLDivElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitProgress, setCommitProgress] = useState('');
  const [parsed, setParsed] = useState<ParseResponse | null>(null);
  const [selectedPeriods, setSelectedPeriods] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const notify = (message: string, type: 'success' | 'error' = 'success') => setToast({ message, type });

  useEffect(() => {
    (async () => {
      try {
        const res = await authFetch('/api/aged-stock/clients', { cache: 'no-store' });
        if (!res.ok) return;
        const json = await res.json();
        setClients(json.clients ?? []);
      } catch { /* empty */ }
    })();
  }, []);

  // Close client dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (clientDropdownRef.current && !clientDropdownRef.current.contains(e.target as Node)) {
        setClientDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function resetForNewFile() {
    setFile(null);
    setParsed(null);
    setSelectedPeriods([]);
    setCommitProgress('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function doParse(fileToParse: File) {
    if (selectedClientIds.length === 0) {
      notify('Pick at least one client first', 'error');
      return;
    }
    setParsing(true);
    setParsed(null);
    try {
      const form = new FormData();
      form.append('clientId', selectedClientIds[0]);
      form.append('file', fileToParse);
      const res = await authFetch('/api/aged-stock/parse', { method: 'POST', body: form });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        const errs = Array.isArray(json?.errors) ? json.errors.join('; ') : (json?.error ?? 'Parse failed');
        notify(errs, 'error');
        return;
      }
      setParsed(json as ParseResponse);
      // Default: preselect all periods
      setSelectedPeriods((json.periods as AgedStockPeriod[]).map(p => p.key));
      if ((json.warnings ?? []).length > 0) {
        notify(`Parsed with ${json.warnings.length} warning(s)`, 'success');
      } else {
        notify(`Parsed ${json.rowCount} rows`);
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Parse failed', 'error');
    } finally {
      setParsing(false);
    }
  }

  function togglePeriod(key: string) {
    setSelectedPeriods(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
  }

  async function doCommit() {
    if (!parsed || !file) return;
    if (selectedPeriods.length === 0) {
      notify('Select at least one period to load', 'error');
      return;
    }
    setCommitting(true);
    setCommitProgress('');
    const total = selectedClientIds.length;
    let totalRows = 0;
    let failed = 0;

    try {
      for (let i = 0; i < selectedClientIds.length; i++) {
        const cId = selectedClientIds[i];
        const cName = clients.find(c => c.id === cId)?.name ?? 'client';
        setCommitProgress(`Loading ${cName} (${i + 1}/${total})…`);

        let draftIdToCommit = parsed.draftId;

        // First client already has a draft from parse; others need their own
        if (i > 0) {
          const form = new FormData();
          form.append('clientId', cId);
          form.append('file', file);
          const parseRes = await authFetch('/api/aged-stock/parse', { method: 'POST', body: form });
          const parseJson = await parseRes.json();
          if (!parseRes.ok || !parseJson.ok) {
            notify(`Parse failed for ${cName}: ${parseJson?.error ?? parseJson?.errors?.join('; ') ?? 'Unknown error'}`, 'error');
            failed++;
            continue;
          }
          draftIdToCommit = parseJson.draftId;
        }

        const res = await authFetch('/api/aged-stock/commit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ draftId: draftIdToCommit, selectedPeriodKeys: selectedPeriods }),
        });
        const json = await res.json();
        if (!res.ok || !json.ok) {
          notify(`Commit failed for ${cName}: ${json?.error ?? 'Unknown error'}`, 'error');
          failed++;
          continue;
        }
        totalRows += json.rowCount ?? 0;
      }

      if (failed === 0) {
        notify(`Loaded ${totalRows.toLocaleString()} rows across ${total} client${total === 1 ? '' : 's'} — redirecting…`);
      } else {
        notify(`Loaded ${totalRows.toLocaleString()} rows. ${failed} client${failed === 1 ? '' : 's'} failed.`, failed === total ? 'error' : 'success');
      }
      if (failed < total) {
        setTimeout(() => router.push('/aged-stock'), 600);
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Commit failed', 'error');
    } finally {
      setCommitting(false);
      setCommitProgress('');
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    setFile(f);
    setParsed(null);
    void doParse(f);
  }

  function onSelectFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setParsed(null);
    void doParse(f);
  }

  const selectedSummary = parsed
    ? parsed.periods
        .filter(p => selectedPeriods.includes(p.key))
        .reduce((acc, p) => {
          for (const r of parsed.sampleRows) {
            const v = r.periods[p.key];
            if (!v) continue;
            acc.qty += v.qty;
            acc.val += v.val;
          }
          return acc;
        }, { qty: 0, val: 0 })
    : null;

  return (
    <>
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <div className="max-w-4xl">
        <h1 className="text-3xl font-bold text-gray-900">Load Aged Stock List</h1>
        <p className="text-sm text-gray-600 mt-1 mb-6">
          Pick a client, drop in the aged stock xlsx, select the aging period(s) to load.
        </p>

        {/* Step 1 — Client(s) */}
        <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">Client(s)</label>
          <div ref={clientDropdownRef} className="relative">
            <button
              type="button"
              onClick={() => setClientDropdownOpen(o => !o)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm text-left bg-white flex items-center justify-between gap-1 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
            >
              <span className="truncate">
                {selectedClientIds.length === 0
                  ? '— Select client(s) —'
                  : selectedClientIds.length === 1
                    ? clientLabel(clients.find(c => c.id === selectedClientIds[0])!)
                    : `${selectedClientIds.length} clients selected`}
              </span>
              <svg className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${clientDropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/></svg>
            </button>
            {clientDropdownOpen && (
              <div className="absolute z-30 mt-1 w-full bg-white border border-gray-200 rounded-md shadow-lg max-h-60 overflow-auto">
                {selectedClientIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => { setSelectedClientIds([]); resetForNewFile(); }}
                    className="w-full px-3 py-1.5 text-xs text-[var(--color-primary)] hover:bg-gray-50 text-left border-b border-gray-100"
                  >
                    Clear selection
                  </button>
                )}
                {clients.map(c => {
                  const checked = selectedClientIds.includes(c.id);
                  return (
                    <label
                      key={c.id}
                      className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setSelectedClientIds(prev =>
                            checked ? prev.filter(id => id !== c.id) : [...prev, c.id]
                          );
                          resetForNewFile();
                        }}
                        className="accent-[var(--color-primary)]"
                      />
                      <span className="truncate">{clientLabel(c)}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
          {clients.length === 0 && (
            <p className="text-xs text-gray-500 mt-2">
              You have no assigned clients. Ask a Super Admin to assign clients to your account.
            </p>
          )}
        </div>

        {/* Step 2 — Drop file */}
        {selectedClientIds.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">Aged stock file</label>
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`relative border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                dragging
                  ? 'border-[var(--color-primary)] bg-green-50'
                  : 'border-gray-300 hover:border-[var(--color-primary)] hover:bg-gray-50'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                onChange={onSelectFile}
              />
              {parsing ? (
                <div className="text-sm text-gray-600">Parsing {file?.name ?? 'file'}…</div>
              ) : file ? (
                <div>
                  <div className="text-sm font-medium text-gray-900">{file.name}</div>
                  <div className="text-xs text-gray-500 mt-1">
                    {(file.size / 1024).toFixed(0)} KB — click or drag to replace
                  </div>
                </div>
              ) : (
                <div>
                  <div className="text-sm font-medium text-gray-900">Drop xlsx here or click to browse</div>
                  <div className="text-xs text-gray-500 mt-1">
                    Genkem, SafeTop, USABCO layouts all auto-detected.
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Step 3 — Pick periods + commit */}
        {parsed && (
          <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-gray-900">Aging periods</h2>
              <div className="text-xs text-gray-500">
                Detected {parsed.periods.length} period{parsed.periods.length === 1 ? '' : 's'}
                &nbsp;·&nbsp;
                {parsed.rowCount.toLocaleString()} rows
              </div>
            </div>
            <p className="text-sm text-gray-600 mb-3">
              Tick the periods to sum into this load. Qty and Value are added across the
              selected periods. You can load the same file again later with different
              periods — each load is kept separate.
            </p>
            <div className="grid grid-cols-2 gap-2 mb-4">
              {parsed.periods.map(p => (
                <label key={p.key} className="flex items-center gap-2 px-3 py-2 border border-gray-200 rounded-md cursor-pointer hover:bg-gray-50">
                  <input
                    type="checkbox"
                    checked={selectedPeriods.includes(p.key)}
                    onChange={() => togglePeriod(p.key)}
                    className="w-4 h-4 accent-[var(--color-primary)]"
                  />
                  <span className="text-sm">{p.label}</span>
                </label>
              ))}
            </div>

            <div className="flex items-center justify-between gap-3 pt-4 border-t border-gray-200">
              <button
                type="button"
                onClick={resetForNewFile}
                className="text-sm text-gray-600 hover:text-gray-900"
              >
                Cancel / pick different file
              </button>
              <button
                type="button"
                onClick={doCommit}
                disabled={committing || selectedPeriods.length === 0}
                className="px-4 py-2 bg-[var(--color-primary)] text-white rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {committing ? (commitProgress || 'Loading…') : `Load Aged Stock${selectedClientIds.length > 1 ? ` (${selectedClientIds.length} clients)` : ''}`}
              </button>
            </div>

            {selectedSummary && (
              <div className="text-xs text-gray-500 mt-3">
                Preview from first {parsed.sampleRows.length} rows · summed qty {selectedSummary.qty.toLocaleString()} · value R{selectedSummary.val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            )}

            {parsed.warnings.length > 0 && (
              <details className="mt-3 text-xs">
                <summary className="text-amber-700 cursor-pointer">
                  {parsed.warnings.length} warning{parsed.warnings.length === 1 ? '' : 's'}
                </summary>
                <ul className="mt-2 ml-4 list-disc text-gray-600 space-y-0.5">
                  {parsed.warnings.slice(0, 20).map((w, i) => <li key={i}>{w}</li>)}
                  {parsed.warnings.length > 20 && (
                    <li>…and {parsed.warnings.length - 20} more</li>
                  )}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    </>
  );
}
