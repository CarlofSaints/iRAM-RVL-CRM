'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth, authFetch } from '@/lib/useAuth';

interface ClientDto { id: string; name: string; vendorNumbers?: string[]; swapOutEnabled?: boolean }

/** Label a client with its vendor number(s) so same-name records are distinguishable. */
function clientLabel(c: ClientDto): string {
  const nums = (c.vendorNumbers ?? []).filter(Boolean);
  return nums.length ? `${c.name} (${nums.join(', ')})` : c.name;
}

interface ImportResult {
  created: number;
  skipped: number;
  total: number;
  unmappedStores: number;
  warnings: string[];
}

export default function SwapOutImportPage() {
  const { session } = useAuth('import_excel');
  const [clients, setClients] = useState<ClientDto[]>([]);
  const [clientId, setClientId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!session) return;
    (async () => {
      const res = await authFetch('/api/control/clients', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setClients(Array.isArray(data) ? data : data.clients ?? []);
      }
    })();
  }, [session]);

  const enabledClients = clients.filter((c) => c.swapOutEnabled);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setResult(null);
    if (!clientId || !file) {
      setError('Pick a client and an Excel file.');
      return;
    }
    setBusy(true);
    const fd = new FormData();
    fd.append('clientId', clientId);
    fd.append('file', file);
    const res = await authFetch('/api/swap-outs/import', { method: 'POST', body: fd });
    const data = await res.json();
    if (res.ok) {
      setResult(data);
    } else {
      setError(data.error || 'Import failed');
      if (data.warnings) setResult({ created: 0, skipped: 0, total: 0, unmappedStores: 0, warnings: data.warnings });
    }
    setBusy(false);
  };

  return (
    <div className="max-w-2xl flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <Link href="/swap-outs" className="text-gray-400 hover:text-gray-600 text-sm">&larr; Back</Link>
        <h1 className="text-2xl font-bold text-gray-900">Import Swap-Out Sheet</h1>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
        <form onSubmit={submit} className="flex flex-col gap-4">
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
            <label className="block text-sm font-medium text-gray-700 mb-1">Excel file (.xlsx)</label>
            <input
              type="file"
              accept=".xlsx,.xls"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-[var(--color-primary)] file:text-white hover:file:opacity-90"
            />
            <p className="text-xs text-gray-400 mt-1">
              Expected columns: DATE, CHANNEL, STORE, REGION, PRODUCT, QUANTITY, PICKING NUMBERS
              (SITE CODE optional). Already-imported picking numbers are skipped.
            </p>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="self-start px-5 py-2 rounded-lg text-sm font-medium bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Importing…' : 'Import'}
          </button>
        </form>
      </div>

      {result && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 flex flex-col gap-3">
          <h2 className="font-semibold text-gray-900">Import summary</h2>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-lg bg-emerald-50 p-3">
              <div className="text-2xl font-bold text-emerald-600">{result.created}</div>
              <div className="text-xs text-gray-500">Created</div>
            </div>
            <div className="rounded-lg bg-gray-50 p-3">
              <div className="text-2xl font-bold text-gray-600">{result.skipped}</div>
              <div className="text-xs text-gray-500">Skipped (already imported)</div>
            </div>
            <div className="rounded-lg bg-amber-50 p-3">
              <div className="text-2xl font-bold text-amber-600">{result.unmappedStores}</div>
              <div className="text-xs text-gray-500">Stores not yet mapped</div>
            </div>
          </div>
          {result.warnings?.length > 0 && (
            <ul className="text-sm text-amber-700 list-disc pl-5">
              {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
          <Link href="/swap-outs" className="text-sm text-[var(--color-primary)] hover:underline">
            View swap-outs &rarr;
          </Link>
        </div>
      )}
    </div>
  );
}
