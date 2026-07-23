'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useAuth, authFetch } from '@/lib/useAuth';

interface ClientDto { id: string; name: string; vendorNumbers?: string[]; swapOutEnabled?: boolean }
interface StoreDto { id: string; name: string; siteCode?: string; region?: string; channel?: string }

interface ParsedLine { product: string; description?: string; quantity: number }
interface ParsedConsignment {
  key: string;
  pickingNumber: string;
  needsPickingNumber: boolean;
  pickingNote?: string;
  requestDate?: string;
  channel?: string;
  storeName: string;
  storeCode?: string;
  region?: string;
  lines: ParsedLine[];
  sheetRow: number;
}
interface StoreGroup {
  key: string;
  sheetName: string;
  channel?: string;
  region?: string;
  consignments: number;
  units: number;
  sheetRows: number[];
  suggestedStoreId: string;
  matchType: 'alias' | 'code' | 'exact' | 'fuzzy' | 'none';
}
interface ParseResponse {
  fileName: string;
  consignments: ParsedConsignment[];
  storeGroups: StoreGroup[];
  duplicates: string[];
  totals: { consignments: number; units: number; stores: number; unmapped: number };
  warnings: string[];
}
interface CommitResult {
  created: number;
  skipped: number;
  total: number;
  skippedPicking: string[];
  storesRemembered: number;
  warnings: string[];
}

/** Label a client with its vendor number(s) so same-name records are distinguishable. */
function clientLabel(c: ClientDto): string {
  const nums = (c.vendorNumbers ?? []).filter(Boolean);
  return nums.length ? `${c.name} (${nums.join(', ')})` : c.name;
}

const MATCH_BADGE: Record<StoreGroup['matchType'], { label: string; cls: string } | null> = {
  alias: { label: 'Remembered', cls: 'bg-emerald-100 text-emerald-700' },
  code: { label: 'By site code', cls: 'bg-emerald-100 text-emerald-700' },
  exact: { label: 'Name match', cls: 'bg-blue-100 text-blue-700' },
  fuzzy: { label: 'Best guess — check', cls: 'bg-amber-100 text-amber-700' },
  none: null,
};

/**
 * Searchable store picker. The store masterfile is far too long for a plain
 * <select>, and the sheet names rarely match FLOW names exactly.
 */
function StorePicker({
  stores,
  value,
  onChange,
  placeholder,
}: {
  stores: StoreDto[];
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);

  const selected = stores.find((s) => s.id === value);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toUpperCase();
    const list = q
      ? stores.filter((s) =>
          `${s.name} ${s.siteCode ?? ''} ${s.region ?? ''} ${s.channel ?? ''}`.toUpperCase().includes(q)
        )
      : stores;
    return list.slice(0, 200);
  }, [stores, query]);

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); setQuery(''); }}
        className={`w-full text-left px-3 py-2 border rounded-lg text-sm bg-white flex items-center justify-between gap-2 hover:bg-gray-50 ${
          selected ? 'border-gray-300' : 'border-amber-300 bg-amber-50/40'
        }`}
      >
        <span className={`truncate ${selected ? 'text-gray-800' : 'text-amber-700'}`}>
          {selected
            ? `${selected.name}${selected.siteCode ? ` · ${selected.siteCode}` : ''}`
            : placeholder}
        </span>
        <svg className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-full min-w-[20rem] bg-white border border-gray-200 rounded-lg shadow-lg">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search stores…"
            className="w-full px-3 py-2 border-b border-gray-100 text-sm outline-none"
          />
          <div className="max-h-64 overflow-y-auto py-1">
            {value && (
              <button
                type="button"
                onClick={() => { onChange(''); setOpen(false); }}
                className="w-full text-left px-3 py-2 text-sm text-gray-400 hover:bg-gray-50"
              >
                — Clear —
              </button>
            )}
            {matches.length === 0 && (
              <p className="px-3 py-2 text-sm text-gray-400 italic">No store matches that search.</p>
            )}
            {matches.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => { onChange(s.id); setOpen(false); }}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 ${
                  s.id === value ? 'bg-gray-50 font-medium' : ''
                }`}
              >
                <span className="text-gray-800">{s.name}</span>
                <span className="text-xs text-gray-400 ml-2">
                  {[s.siteCode, s.channel, s.region].filter(Boolean).join(' · ')}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function SwapOutImportPage() {
  const { session } = useAuth('import_excel');
  const [clients, setClients] = useState<ClientDto[]>([]);
  const [stores, setStores] = useState<StoreDto[]>([]);
  const [clientId, setClientId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [parsed, setParsed] = useState<ParseResponse | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [result, setResult] = useState<CommitResult | null>(null);

  useEffect(() => {
    if (!session) return;
    (async () => {
      const [clRes, stRes] = await Promise.all([
        authFetch('/api/control/clients', { cache: 'no-store' }),
        authFetch('/api/control/stores', { cache: 'no-store' }),
      ]);
      if (clRes.ok) {
        const data = await clRes.json();
        setClients(Array.isArray(data) ? data : data.clients ?? []);
      }
      if (stRes.ok) {
        const data = await stRes.json();
        const list: StoreDto[] = Array.isArray(data) ? data : data.stores ?? [];
        setStores([...list].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')));
      }
    })();
  }, [session]);

  const enabledClients = clients.filter((c) => c.swapOutEnabled);
  const step: 1 | 2 | 3 = result ? 3 : parsed ? 2 : 1;

  const upload = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!clientId || !file) {
      setError('Pick a client and an Excel file.');
      return;
    }
    setBusy(true);
    const fd = new FormData();
    fd.append('clientId', clientId);
    fd.append('file', file);
    const res = await authFetch('/api/swap-outs/import/parse', { method: 'POST', body: fd });
    const data = await res.json();
    if (res.ok) {
      setParsed(data);
      const seed: Record<string, string> = {};
      for (const g of data.storeGroups as StoreGroup[]) {
        if (g.suggestedStoreId) seed[g.key] = g.suggestedStoreId;
      }
      setMapping(seed);
    } else {
      setError(data.error || 'Could not read that sheet');
    }
    setBusy(false);
  };

  const commit = async () => {
    if (!parsed) return;
    setError('');
    setBusy(true);
    const res = await authFetch('/api/swap-outs/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId,
        fileName: parsed.fileName,
        consignments: parsed.consignments,
        mapping,
      }),
    });
    const data = await res.json();
    if (res.ok) setResult(data);
    else setError(data.error || 'Import failed');
    setBusy(false);
  };

  const restart = () => {
    setParsed(null);
    setResult(null);
    setMapping({});
    setFile(null);
    setError('');
  };

  const unmappedCount = parsed ? parsed.storeGroups.filter((g) => !mapping[g.key]).length : 0;
  const dupeSet = useMemo(() => new Set((parsed?.duplicates ?? []).map((d) => d.toUpperCase())), [parsed]);

  return (
    <div className="flex flex-col gap-5 max-w-5xl">
      <div className="flex items-center gap-3">
        <Link href="/swap-outs" className="text-gray-400 hover:text-gray-600 text-sm">&larr; Back</Link>
        <h1 className="text-2xl font-bold text-gray-900">Import Swap-Out Sheet</h1>
      </div>

      {/* Steps */}
      <ol className="flex items-center gap-2 text-sm">
        {['Upload sheet', 'Map stores', 'Done'].map((label, i) => {
          const n = (i + 1) as 1 | 2 | 3;
          const state = step === n ? 'current' : step > n ? 'done' : 'todo';
          return (
            <li key={label} className="flex items-center gap-2">
              <span
                className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold ${
                  state === 'current'
                    ? 'bg-[var(--color-primary)] text-white'
                    : state === 'done'
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-gray-100 text-gray-400'
                }`}
              >
                {state === 'done' ? '✓' : n}
              </span>
              <span className={state === 'todo' ? 'text-gray-400' : 'text-gray-700'}>{label}</span>
              {n < 3 && <span className="text-gray-300 mx-1">›</span>}
            </li>
          );
        })}
      </ol>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3">{error}</div>
      )}

      {/* ---------------- Step 1: upload ---------------- */}
      {step === 1 && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
          <form onSubmit={upload} className="flex flex-col gap-4 max-w-xl">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Client</label>
              <select
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              >
                <option value="">Select a client…</option>
                {enabledClients.map((c) => (
                  <option key={c.id} value={c.id}>{clientLabel(c)}</option>
                ))}
              </select>
              {enabledClients.length === 0 && (
                <p className="text-xs text-amber-600 mt-1">
                  No client has Swap-Out enabled. Enable it on the client first.
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Supplier sheet (.xlsx)</label>
              <input
                type="file"
                accept=".xlsx,.xls"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-[var(--color-primary)] file:text-white hover:file:opacity-90"
              />
              <p className="text-xs text-gray-400 mt-1">
                Expected columns: DATE, CHANNEL, STORE, REGION, PRODUCT, QUANTITY, PICKING NUMBERS.
                Store, date, channel and region only need to appear on the first line of each
                block — blank rows between blocks are ignored.
              </p>
            </div>

            <button
              type="submit"
              disabled={busy}
              className="self-start px-5 py-2 rounded-lg text-sm font-medium bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Reading sheet…' : 'Read sheet'}
            </button>
          </form>
        </div>
      )}

      {/* ---------------- Step 2: map stores ---------------- */}
      {step === 2 && parsed && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { n: parsed.totals.consignments, l: 'Consignments', c: 'text-gray-700' },
              { n: parsed.totals.units, l: 'Units', c: 'text-gray-700' },
              { n: parsed.totals.stores, l: 'Stores in sheet', c: 'text-gray-700' },
              { n: unmappedCount, l: 'Still to map', c: unmappedCount ? 'text-amber-600' : 'text-emerald-600' },
            ].map((s) => (
              <div key={s.l} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 text-center">
                <div className={`text-2xl font-bold ${s.c}`}>{s.n}</div>
                <div className="text-xs text-gray-500">{s.l}</div>
              </div>
            ))}
          </div>

          {parsed.warnings.length > 0 && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-3">
              <ul className="list-disc pl-5 flex flex-col gap-1">
                {parsed.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}

          <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
            <div className="px-5 py-4 border-b border-gray-100">
              <h2 className="font-semibold text-gray-900">Map each store in the sheet to a FLOW store</h2>
              <p className="text-sm text-gray-500">
                The supplier sheet has no site codes. Confirm every store once and FLOW will
                remember it for next week&apos;s sheet.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-gray-100">
                    <th className="px-5 py-3 font-medium">Store in sheet</th>
                    <th className="px-4 py-3 font-medium">Channel</th>
                    <th className="px-4 py-3 font-medium">Region</th>
                    <th className="px-4 py-3 font-medium text-right">Cons.</th>
                    <th className="px-4 py-3 font-medium text-right">Units</th>
                    <th className="px-5 py-3 font-medium w-[22rem]">FLOW store</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.storeGroups.map((g) => {
                    const badge = MATCH_BADGE[g.matchType];
                    const touched = mapping[g.key] !== g.suggestedStoreId;
                    return (
                      <tr key={g.key} className="border-b border-gray-50 last:border-0 align-top">
                        <td className="px-5 py-3">
                          <div className="font-medium text-gray-800">{g.sheetName}</div>
                          <div className="text-xs text-gray-400">
                            sheet row{g.sheetRows.length > 1 ? 's' : ''} {g.sheetRows.join(', ')}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-gray-600">{g.channel ?? '—'}</td>
                        <td className="px-4 py-3 text-gray-600">{g.region ?? '—'}</td>
                        <td className="px-4 py-3 text-right text-gray-600">{g.consignments}</td>
                        <td className="px-4 py-3 text-right text-gray-600">{g.units}</td>
                        <td className="px-5 py-3">
                          <StorePicker
                            stores={stores}
                            value={mapping[g.key] ?? ''}
                            onChange={(id) => setMapping((m) => ({ ...m, [g.key]: id }))}
                            placeholder="Choose a store…"
                          />
                          {badge && !touched && (
                            <span className={`inline-block mt-1 px-2 py-0.5 rounded-full text-xs font-medium ${badge.cls}`}>
                              {badge.label}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Consignment preview */}
          <details className="bg-white rounded-xl border border-gray-100 shadow-sm">
            <summary className="px-5 py-4 cursor-pointer font-semibold text-gray-900">
              Preview the {parsed.consignments.length} consignments
            </summary>
            <div className="overflow-x-auto border-t border-gray-100">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-gray-100">
                    <th className="px-5 py-2 font-medium">Row</th>
                    <th className="px-4 py-2 font-medium">Picking #</th>
                    <th className="px-4 py-2 font-medium">Date</th>
                    <th className="px-4 py-2 font-medium">Channel</th>
                    <th className="px-4 py-2 font-medium">Store</th>
                    <th className="px-4 py-2 font-medium">Region</th>
                    <th className="px-4 py-2 font-medium">Products</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.consignments.map((c) => {
                    const dupe = c.pickingNumber && dupeSet.has(c.pickingNumber.toUpperCase());
                    return (
                      <tr key={c.key} className="border-b border-gray-50 last:border-0">
                        <td className="px-5 py-2 text-gray-400">{c.sheetRow}</td>
                        <td className="px-4 py-2">
                          {c.pickingNumber
                            ? <span className="font-medium text-gray-800">{c.pickingNumber}</span>
                            : <span className="text-amber-600 italic">awaiting picking #</span>}
                          {dupe && (
                            <span className="ml-2 px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-500">
                              already imported — will skip
                            </span>
                          )}
                          {c.pickingNote && (
                            <div className="text-xs text-amber-600">“{c.pickingNote}”</div>
                          )}
                        </td>
                        <td className="px-4 py-2 text-gray-600">{c.requestDate ?? '—'}</td>
                        <td className="px-4 py-2 text-gray-600">{c.channel ?? '—'}</td>
                        <td className="px-4 py-2 text-gray-700">{c.storeName}</td>
                        <td className="px-4 py-2 text-gray-600">{c.region ?? '—'}</td>
                        <td className="px-4 py-2 text-gray-600">
                          {c.lines.map((l) => `${l.product} × ${l.quantity}`).join(', ')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>

          <div className="flex items-center gap-3">
            <button
              onClick={commit}
              disabled={busy || unmappedCount > 0}
              className="px-5 py-2 rounded-lg text-sm font-medium bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Importing…' : `Import ${parsed.consignments.length} consignments`}
            </button>
            <button onClick={restart} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50">
              Start over
            </button>
            {unmappedCount > 0 && (
              <span className="text-sm text-amber-600">
                {unmappedCount} store{unmappedCount > 1 ? 's' : ''} still need mapping.
              </span>
            )}
          </div>
        </>
      )}

      {/* ---------------- Step 3: result ---------------- */}
      {step === 3 && result && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 flex flex-col gap-4">
          <h2 className="font-semibold text-gray-900">Import complete</h2>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-lg bg-emerald-50 p-3">
              <div className="text-2xl font-bold text-emerald-600">{result.created}</div>
              <div className="text-xs text-gray-500">Created</div>
            </div>
            <div className="rounded-lg bg-gray-50 p-3">
              <div className="text-2xl font-bold text-gray-600">{result.skipped}</div>
              <div className="text-xs text-gray-500">Skipped (already imported)</div>
            </div>
            <div className="rounded-lg bg-blue-50 p-3">
              <div className="text-2xl font-bold text-blue-600">{result.storesRemembered}</div>
              <div className="text-xs text-gray-500">Store mappings remembered</div>
            </div>
          </div>
          {result.skippedPicking?.length > 0 && (
            <p className="text-sm text-gray-500">
              Skipped picking numbers: {result.skippedPicking.join(', ')}
            </p>
          )}
          {result.warnings?.length > 0 && (
            <ul className="text-sm text-amber-700 list-disc pl-5">
              {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
          <div className="flex gap-3">
            <Link href="/swap-outs" className="px-5 py-2 rounded-lg text-sm font-medium bg-[var(--color-primary)] text-white hover:opacity-90">
              View swap-outs
            </Link>
            <button onClick={restart} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50">
              Import another sheet
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
