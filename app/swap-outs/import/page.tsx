'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useAuth, authFetch } from '@/lib/useAuth';

interface ClientDto { id: string; name: string; vendorNumbers?: string[]; swapOutEnabled?: boolean }
interface StoreDto { id: string; name: string; siteCode?: string; region?: string; channel?: string }

interface ParsedLine { product: string; description?: string; quantity: number }
interface ParsedConsignment {
  key: string;
  /** Store-group key stamped by the parse route — the mapping is held under it. */
  groupKey?: string;
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
  /** Which selected vendor record this store should land on ('' = user must pick). */
  suggestedClientId: string;
  vendorRemembered: boolean;
}
interface ParseResponse {
  fileName: string;
  clientIds: string[];
  consignments: ParsedConsignment[];
  storeGroups: StoreGroup[];
  duplicates: string[];
  /** picking # (upper-case) → vendor record(s) it is already sitting on. */
  duplicateVendors: Record<string, string[]>;
  totals: { consignments: number; units: number; stores: number; unmapped: number };
  warnings: string[];
}
interface CommitResult {
  created: number;
  skipped: number;
  total: number;
  skippedPicking: string[];
  skippedDetail?: Array<{ pickingNumber: string; store: string; onClientId: string; sameVendor: boolean }>;
  createdByClient?: Record<string, number>;
  storesRemembered: number;
  warnings: string[];
}

/** What the user has confirmed for one store group: which store, which vendor. */
interface GroupChoice {
  storeId: string;
  clientId: string;
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
  // One supplier can run several vendor numbers (Major Tech (Builders) is both
  // 2130 and 4394) and a single weekly sheet spans them, so the import is
  // scoped to a SET of client records and each store picks one.
  const [selectedClientIds, setSelectedClientIds] = useState<Set<string>>(new Set());
  const [clientDropOpen, setClientDropOpen] = useState(false);
  const clientDropRef = useRef<HTMLDivElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [parsed, setParsed] = useState<ParseResponse | null>(null);
  const [mapping, setMapping] = useState<Record<string, GroupChoice>>({});
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

  const enabledClients = useMemo(
    () =>
      clients
        .filter((c) => c.swapOutEnabled)
        .sort((a, b) => clientLabel(a).localeCompare(clientLabel(b))),
    [clients],
  );
  const step: 1 | 2 | 3 = result ? 3 : parsed ? 2 : 1;

  // The vendor records this parse was scoped to, in a stable display order.
  const chosenClients = useMemo(() => {
    const ids = parsed?.clientIds ?? [...selectedClientIds];
    return ids
      .map((id) => clients.find((c) => c.id === id))
      .filter((c): c is ClientDto => Boolean(c));
  }, [parsed, selectedClientIds, clients]);
  const multiVendor = chosenClients.length > 1;

  const clientName = (id: string) => {
    const c = clients.find((x) => x.id === id);
    return c ? clientLabel(c) : id;
  };

  // Close the vendor dropdown on outside click.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (clientDropRef.current && !clientDropRef.current.contains(e.target as Node)) {
        setClientDropOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const toggleClient = (id: string) =>
    setSelectedClientIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });

  const upload = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (selectedClientIds.size === 0 || !file) {
      setError('Pick at least one client / vendor number and an Excel file.');
      return;
    }
    setBusy(true);
    const fd = new FormData();
    fd.append('clientIds', [...selectedClientIds].join(','));
    fd.append('file', file);
    const res = await authFetch('/api/swap-outs/import/parse', { method: 'POST', body: fd });
    const data = await res.json();
    if (res.ok) {
      setParsed(data);
      const seed: Record<string, GroupChoice> = {};
      for (const g of data.storeGroups as StoreGroup[]) {
        if (g.suggestedStoreId) {
          seed[g.key] = { storeId: g.suggestedStoreId, clientId: g.suggestedClientId ?? '' };
        }
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
        clientIds: parsed.clientIds ?? [...selectedClientIds],
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

  const setGroupStore = (key: string, storeId: string) =>
    setMapping((m) => ({ ...m, [key]: { storeId, clientId: m[key]?.clientId ?? '' } }));
  const setGroupClient = (key: string, clientId: string) =>
    setMapping((m) => ({ ...m, [key]: { storeId: m[key]?.storeId ?? '', clientId } }));

  // A group is only "mapped" once it has BOTH a store and a vendor record.
  const isMapped = (g: StoreGroup) => Boolean(mapping[g.key]?.storeId && mapping[g.key]?.clientId);
  const unmappedCount = parsed ? parsed.storeGroups.filter((g) => !isMapped(g)).length : 0;
  const dupeSet = useMemo(() => new Set((parsed?.duplicates ?? []).map((d) => d.toUpperCase())), [parsed]);

  /** Consignments + units heading for each vendor, so the split is visible before committing. */
  const vendorSplit = useMemo(() => {
    if (!parsed) return [];
    const tally = new Map<string, { consignments: number; units: number; stores: number }>();
    for (const g of parsed.storeGroups) {
      const cid = mapping[g.key]?.clientId;
      if (!cid) continue;
      const t = tally.get(cid) ?? { consignments: 0, units: 0, stores: 0 };
      t.consignments += g.consignments;
      t.units += g.units;
      t.stores += 1;
      tally.set(cid, t);
    }
    return chosenClients
      .map((c) => ({ client: c, ...(tally.get(c.id) ?? { consignments: 0, units: 0, stores: 0 }) }));
  }, [parsed, mapping, chosenClients]);

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
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Client / vendor number{selectedClientIds.size > 1 ? 's' : ''}
              </label>
              <div className="relative" ref={clientDropRef}>
                <button
                  type="button"
                  onClick={() => setClientDropOpen((o) => !o)}
                  className={`w-full text-left px-3 py-2 border rounded-lg text-sm bg-white flex items-center justify-between gap-2 hover:bg-gray-50 ${
                    selectedClientIds.size ? 'border-gray-300' : 'border-amber-300 bg-amber-50/40'
                  }`}
                >
                  <span className={`truncate ${selectedClientIds.size ? 'text-gray-800' : 'text-amber-700'}`}>
                    {selectedClientIds.size === 0
                      ? 'Select a client…'
                      : enabledClients
                          .filter((c) => selectedClientIds.has(c.id))
                          .map((c) => clientLabel(c))
                          .join('  ·  ')}
                  </span>
                  <svg className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform ${clientDropOpen ? 'rotate-180' : ''}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {clientDropOpen && (
                  <div className="absolute z-30 mt-1 w-full min-w-[20rem] max-h-72 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg py-1">
                    {enabledClients.length === 0 ? (
                      <p className="px-3 py-2 text-sm text-gray-400 italic">No swap-out clients enabled.</p>
                    ) : (
                      enabledClients.map((c) => (
                        <label key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedClientIds.has(c.id)}
                            onChange={() => toggleClient(c.id)}
                          />
                          <span className="truncate">{clientLabel(c)}</span>
                        </label>
                      ))
                    )}
                  </div>
                )}
              </div>
              <p className="text-xs text-gray-400 mt-1">
                Tick more than one when the same supplier runs several vendor numbers and one
                sheet covers them all — you choose the vendor per store in the next step.
              </p>
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

          {/* Where the sheet is heading, per vendor record. */}
          {multiVendor && (
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-5 py-4">
              <h2 className="font-semibold text-gray-900 mb-2">How this sheet splits</h2>
              <div className="flex flex-wrap gap-4">
                {vendorSplit.map((v) => (
                  <div key={v.client.id} className="text-sm">
                    <span className="font-medium text-gray-800">{clientLabel(v.client)}</span>
                    <span className="text-gray-500">
                      {' '}— {v.stores} store{v.stores === 1 ? '' : 's'}, {v.consignments} consignment
                      {v.consignments === 1 ? '' : 's'}, {v.units} unit{v.units === 1 ? '' : 's'}
                    </span>
                  </div>
                ))}
                {unmappedCount > 0 && (
                  <div className="text-sm text-amber-600">
                    {unmappedCount} store{unmappedCount > 1 ? 's' : ''} not yet assigned.
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
            <div className="px-5 py-4 border-b border-gray-100">
              <h2 className="font-semibold text-gray-900">
                Map each store in the sheet to a FLOW store{multiVendor ? ' and a vendor number' : ''}
              </h2>
              <p className="text-sm text-gray-500">
                The supplier sheet has no site codes{multiVendor ? ' and does not say which vendor account a store belongs to' : ''}.
                Confirm every store once and FLOW will remember it for next week&apos;s sheet.
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
                    {multiVendor && <th className="px-5 py-3 font-medium w-[16rem]">Vendor number</th>}
                  </tr>
                </thead>
                <tbody>
                  {parsed.storeGroups.map((g) => {
                    const badge = MATCH_BADGE[g.matchType];
                    const choice = mapping[g.key];
                    const touched = choice?.storeId !== g.suggestedStoreId;
                    const needsVendor = multiVendor && !choice?.clientId;
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
                            value={choice?.storeId ?? ''}
                            onChange={(id) => setGroupStore(g.key, id)}
                            placeholder="Choose a store…"
                          />
                          {badge && !touched && (
                            <span className={`inline-block mt-1 px-2 py-0.5 rounded-full text-xs font-medium ${badge.cls}`}>
                              {badge.label}
                            </span>
                          )}
                        </td>
                        {multiVendor && (
                          <td className="px-5 py-3">
                            <select
                              value={choice?.clientId ?? ''}
                              onChange={(e) => setGroupClient(g.key, e.target.value)}
                              className={`w-full px-3 py-2 border rounded-lg text-sm bg-white ${
                                needsVendor ? 'border-amber-300 bg-amber-50/40 text-amber-700' : 'border-gray-300 text-gray-800'
                              }`}
                            >
                              <option value="">Choose a vendor…</option>
                              {chosenClients.map((c) => (
                                <option key={c.id} value={c.id}>{clientLabel(c)}</option>
                              ))}
                            </select>
                            {g.vendorRemembered && choice?.clientId === g.suggestedClientId && (
                              <span className="inline-block mt-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
                                Remembered
                              </span>
                            )}
                            {g.matchType === 'alias' && !g.suggestedClientId && (
                              <span className="inline-block mt-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                                Used on both before — check
                              </span>
                            )}
                          </td>
                        )}
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
                    {multiVendor && <th className="px-4 py-2 font-medium">Vendor</th>}
                    <th className="px-4 py-2 font-medium">Products</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.consignments.map((c) => {
                    const upper = (c.pickingNumber ?? '').toUpperCase();
                    const dupe = Boolean(c.pickingNumber) && dupeSet.has(upper);
                    const dupeOn = (parsed.duplicateVendors?.[upper] ?? [])
                      .map((id) => clientName(id))
                      .join(', ');
                    // The vendor a consignment inherits from its store group.
                    const groupChoice = c.groupKey ? mapping[c.groupKey] : undefined;
                    return (
                      <tr key={c.key} className="border-b border-gray-50 last:border-0">
                        <td className="px-5 py-2 text-gray-400">{c.sheetRow}</td>
                        <td className="px-4 py-2">
                          {c.pickingNumber
                            ? <span className="font-medium text-gray-800">{c.pickingNumber}</span>
                            : <span className="text-amber-600 italic">awaiting picking #</span>}
                          {dupe && (
                            <span className="ml-2 px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-500">
                              already imported{dupeOn ? ` on ${dupeOn}` : ''} — will skip
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
                        {multiVendor && (
                          <td className="px-4 py-2 text-gray-600">
                            {groupChoice?.clientId
                              ? clientName(groupChoice.clientId)
                              : <span className="text-amber-600 italic">not assigned</span>}
                          </td>
                        )}
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
          {result.createdByClient && Object.keys(result.createdByClient).length > 1 && (
            <div className="rounded-lg border border-gray-100 bg-gray-50 px-4 py-3">
              <div className="text-sm font-medium text-gray-700 mb-1">Split across vendor numbers</div>
              <ul className="text-sm text-gray-600 flex flex-col gap-0.5">
                {Object.entries(result.createdByClient).map(([id, n]) => (
                  <li key={id}>
                    <span className="font-medium text-gray-800">{n}</span> → {clientName(id)}
                  </li>
                ))}
              </ul>
            </div>
          )}
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
