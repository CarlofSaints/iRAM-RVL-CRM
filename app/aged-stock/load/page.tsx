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

// ── Process Flow Steps ──────────────────────────────────────────────────────

const STEPS = [
  {
    num: 1,
    title: 'Load Aged Stock',
    desc: 'Upload the aged stock xlsx file',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
      </svg>
    ),
  },
  {
    num: 2,
    title: 'Generate Picking Slips',
    desc: 'System creates per-store PDFs',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
    ),
  },
  {
    num: 3,
    title: 'Send Picking Slips',
    desc: 'Email PDFs to stores & reps',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
      </svg>
    ),
  },
  {
    num: 4,
    title: 'Book Stock into WH',
    desc: 'Rep scans stock into warehouse',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21" />
      </svg>
    ),
  },
  {
    num: 5,
    title: 'Capture Picking Slip',
    desc: 'Record quantities received',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15a2.25 2.25 0 012.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
      </svg>
    ),
  },
  {
    num: 6,
    title: 'Release Stock',
    desc: 'Auto-generates delivery note',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
      </svg>
    ),
  },
  {
    num: 7,
    title: 'Deliver to Customer',
    desc: 'Customer signs via QR code',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 18.75a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 01-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h1.125c.621 0 1.129-.504 1.09-1.124a17.902 17.902 0 00-3.213-9.193 2.056 2.056 0 00-1.58-.86H14.25M16.5 18.75h-2.25m0-11.177v-.958c0-.568-.422-1.048-.987-1.106a48.554 48.554 0 00-10.026 0 1.106 1.106 0 00-.987 1.106v7.635m12-6.677v6.677m0 4.5v-4.5m0 0h-12" />
      </svg>
    ),
  },
  {
    num: 8,
    title: 'Signed DN Sent',
    desc: 'Auto-sent & saved to SharePoint',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 01-1.043 3.296 3.745 3.745 0 01-3.296 1.043A3.745 3.745 0 0112 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 01-3.296-1.043 3.745 3.745 0 01-1.043-3.296A3.745 3.745 0 013 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 011.043-3.296 3.746 3.746 0 013.296-1.043A3.746 3.746 0 0112 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 013.296 1.043 3.745 3.745 0 011.043 3.296A3.745 3.745 0 0121 12z" />
      </svg>
    ),
  },
  {
    num: 9,
    title: 'Dashboard Updated',
    desc: 'Reports update automatically',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
      </svg>
    ),
  },
];

function ArrowRight() {
  return (
    <div className="flex items-center justify-center text-gray-300">
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
      </svg>
    </div>
  );
}

function ArrowDown() {
  return (
    <div className="flex items-center justify-center text-gray-300 col-span-full py-1">
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 13.5L12 21m0 0l-7.5-7.5M12 21V3" />
      </svg>
    </div>
  );
}

function ProcessFlowDiagram() {
  return (
    <div className="mt-6 bg-white border border-gray-200 rounded-lg p-6">
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-5">
        Aged Stock Process Flow
      </h2>

      {/* Row 1: Steps 1 → 2 → 3 */}
      <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-2 mb-2">
        {STEPS.slice(0, 3).map((step, i) => (
          <div key={step.num} className="contents">
            {i > 0 && <ArrowRight />}
            <StepCard step={step} />
          </div>
        ))}
      </div>

      {/* Arrow row 1→2 (right-aligned to last col) */}
      <div className="flex justify-end pr-[calc(50%/3-10px)] mb-2">
        <div className="text-gray-300">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 13.5L12 21m0 0l-7.5-7.5M12 21V3" />
          </svg>
        </div>
      </div>

      {/* Row 2: Steps 4 → 5 → 6 */}
      <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-2 mb-2">
        {STEPS.slice(3, 6).map((step, i) => (
          <div key={step.num} className="contents">
            {i > 0 && <ArrowRight />}
            <StepCard step={step} />
          </div>
        ))}
      </div>

      {/* Arrow row 2→3 */}
      <div className="flex justify-end pr-[calc(50%/3-10px)] mb-2">
        <div className="text-gray-300">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 13.5L12 21m0 0l-7.5-7.5M12 21V3" />
          </svg>
        </div>
      </div>

      {/* Row 3: Steps 7 → 8 → 9 */}
      <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-2">
        {STEPS.slice(6, 9).map((step, i) => (
          <div key={step.num} className="contents">
            {i > 0 && <ArrowRight />}
            <StepCard step={step} />
          </div>
        ))}
      </div>

      {/* Tip banner */}
      <div className="mt-5 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
        <p className="text-xs text-amber-800 italic">
          Ensure that you have created contacts for each customer and that you have entered
          the relevant SP URL&apos;s for picking slips and DN&apos;s in the client setup.
        </p>
      </div>
    </div>
  );
}

function StepCard({ step }: { step: typeof STEPS[number] }) {
  return (
    <div className="bg-[var(--color-charcoal)] rounded-lg px-4 py-3 flex items-center gap-3 min-h-[72px]">
      <div className="flex items-center gap-2 shrink-0">
        <span className="w-6 h-6 rounded-full bg-[var(--color-primary)] text-white text-xs font-bold flex items-center justify-center">
          {step.num}
        </span>
        <span className="text-white/70">{step.icon}</span>
      </div>
      <div className="min-w-0">
        <div className="text-white text-sm font-semibold leading-tight">{step.title}</div>
        <div className="text-gray-400 text-xs mt-0.5 leading-tight">{step.desc}</div>
      </div>
    </div>
  );
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

        {/* Process flow diagram — visible when no file parsed yet */}
        {!parsed && (
          <ProcessFlowDiagram />
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
