'use client';

import { useEffect, useState, useRef, useMemo } from 'react';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';
import { useTableSort } from '@/lib/useTableSort';
import SortableTh from '@/components/SortableTh';
import * as XLSX from 'xlsx';

interface Site {
  id: string;
  siteNum: string;
  storeName: string;
  channel: string;
  subChannel: string;
  country: string;
  province: string;
  town: string;
  status: string;
  type: string;
  createdAt: string;
}

type SiteRecord = Omit<Site, 'id' | 'createdAt'>;

/** Master site file column order — used by Download Template + parser hints. */
const TEMPLATE_HEADERS = [
  'SITE NUM', 'STORE NAME', 'CHANNEL', 'SUB_CHANNEL', 'COUNTRY',
  'PROVINCE', 'TOWN/CITY', 'STATUS', 'TYPE',
] as const;

/** Map a raw MASTER_SITE row to a site record (tolerant header lookup). */
function rowToSite(row: Record<string, unknown>): SiteRecord {
  const norm: Record<string, unknown> = {};
  for (const k of Object.keys(row)) norm[k.replace(/\s+/g, '').toLowerCase()] = row[k];
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = norm[k.replace(/\s+/g, '').toLowerCase()];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  };
  return {
    siteNum: pick('SITE NUM', 'SITENUM', 'Site Number', 'Site Code'),
    storeName: pick('STORE NAME', 'STORENAME', 'Store', 'Name'),
    channel: pick('CHANNEL'),
    subChannel: pick('SUB_CHANNEL', 'SUB CHANNEL', 'SUBCHANNEL', 'Sub Channel'),
    country: pick('COUNTRY'),
    province: pick('PROVINCE'),
    town: pick('TOWN/CITY', 'TOWN', 'CITY', 'TOWNCITY'),
    status: pick('STATUS'),
    type: pick('TYPE'),
  };
}

export default function SiteControlPage() {
  useAuth('manage_stores');
  const [items, setItems] = useState<Site[]>([]);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<ToastData | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  type ImportMode = 'append' | 'update' | 'overwrite';
  const [importRecords, setImportRecords] = useState<SiteRecord[]>([]);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [importStats, setImportStats] = useState({ newCount: 0, existingCount: 0, totalFile: 0, totalCurrent: 0, channels: [] as string[] });

  const notify = (message: string, type: 'success' | 'error' = 'success') => setToast({ message, type });

  async function fetchAll() {
    try {
      const res = await authFetch('/api/control/sites', { cache: 'no-store' });
      if (res.ok) setItems(await res.json());
    } catch { /* ignore */ }
  }
  useEffect(() => { fetchAll(); }, []);

  /** Step A: parse the MASTER_SITE sheet and open the import-mode modal. */
  async function handleExcelUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data);
      // Prefer the MASTER_SITE sheet; fall back to the first sheet.
      const sheetName = wb.SheetNames.find(n => /master.?site/i.test(n)) ?? wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });

      const records = rows.map(rowToSite).filter(r => r.siteNum);
      if (!records.length) { notify('No valid site rows found (need a SITE NUM column)', 'error'); return; }

      const existing = new Set(items.map(s => s.siteNum.toLowerCase()).filter(Boolean));
      let newCount = 0, existingCount = 0;
      for (const r of records) {
        if (existing.has(r.siteNum.toLowerCase())) existingCount++; else newCount++;
      }
      const channels = Array.from(new Set(records.map(r => r.channel).filter(Boolean))).sort();

      setImportRecords(records);
      setImportStats({ newCount, existingCount, totalFile: records.length, totalCurrent: items.length, channels });
      setImportModalOpen(true);
    } catch (err) {
      console.error('[site-control import]', err);
      notify('Failed to parse file', 'error');
    }
    if (fileRef.current) fileRef.current.value = '';
  }

  /** Step B: execute the chosen import mode. */
  async function executeImport(mode: ImportMode) {
    setImportLoading(true);
    try {
      const records = importRecords;

      if (mode === 'append') {
        const existing = new Set(items.map(s => s.siteNum.toLowerCase()).filter(Boolean));
        const toAdd = records.filter(r => !existing.has(r.siteNum.toLowerCase()));
        if (toAdd.length === 0) { notify('No new sites — all site numbers already exist'); setImportModalOpen(false); return; }
        const res = await authFetch('/api/control/sites', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(toAdd),
        });
        notify(res.ok ? `Appended ${toAdd.length} new sites (${importStats.existingCount} skipped)` : 'Import failed', res.ok ? 'success' : 'error');
      } else if (mode === 'update') {
        // Upsert by siteNum (keep id + createdAt on matches), add unmatched.
        const map = new Map<string, Site>();
        for (const s of items) if (s.siteNum) map.set(s.siteNum.toLowerCase(), s);
        const merged: (Site | Record<string, unknown>)[] = [...items];
        let updated = 0, added = 0;
        for (const r of records) {
          const ex = map.get(r.siteNum.toLowerCase());
          if (ex) {
            const idx = merged.findIndex(m => (m as Site).id === ex.id);
            if (idx !== -1) { merged[idx] = { ...ex, ...r, id: ex.id, createdAt: ex.createdAt }; updated++; }
          } else {
            merged.push({ ...r, id: crypto.randomUUID(), createdAt: new Date().toISOString() }); added++;
          }
        }
        const res = await authFetch('/api/control/sites', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(merged),
        });
        notify(res.ok ? `Updated ${updated} sites, added ${added} new` : 'Import failed', res.ok ? 'success' : 'error');
      } else {
        // Overwrite — scoped by channel: replace only rows whose channel is in
        // the uploaded file, so future separate files (PnP/Checkers) are safe.
        const fileChannels = new Set(importStats.channels.map(c => c.toLowerCase()));
        const kept = items.filter(s => !fileChannels.has((s.channel || '').toLowerCase()));
        const now = new Date().toISOString();
        const fresh = records.map(r => ({ ...r, id: crypto.randomUUID(), createdAt: now }));
        const next = [...kept, ...fresh];
        const res = await authFetch('/api/control/sites', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
        });
        const chLabel = importStats.channels.join(', ') || 'uploaded channels';
        notify(res.ok ? `Replaced ${chLabel}: ${fresh.length} sites (${kept.length} other-channel rows kept)` : 'Import failed', res.ok ? 'success' : 'error');
      }

      setImportModalOpen(false);
      setImportRecords([]);
      fetchAll();
    } catch (err) {
      console.error('[site-control import]', err);
      notify('Import failed', 'error');
    } finally {
      setImportLoading(false);
    }
  }

  function handleDownloadTemplate() {
    const ws = XLSX.utils.aoa_to_sheet([[...TEMPLATE_HEADERS]]);
    ws['!cols'] = TEMPLATE_HEADERS.map(h => ({ wch: Math.max(14, h.length + 2) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'MASTER_SITE');
    XLSX.writeFile(wb, 'iRamFlow_Master_Site_Template.xlsx');
  }

  const summary = useMemo(() => {
    const channels = new Set<string>(), subs = new Set<string>(), countries = new Set<string>();
    for (const s of items) {
      if (s.channel) channels.add(s.channel);
      if (s.subChannel) subs.add(s.subChannel);
      if (s.country) countries.add(s.country);
    }
    return { channels: channels.size, subs: subs.size, countries: countries.size };
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return items.filter(i =>
      i.siteNum.toLowerCase().includes(q) ||
      i.storeName.toLowerCase().includes(q) ||
      i.channel.toLowerCase().includes(q) ||
      i.subChannel.toLowerCase().includes(q) ||
      i.country.toLowerCase().includes(q)
    );
  }, [items, search]);

  // Sortable grid — defaults to Site # A–Z. Sort runs before the 1000-row cap.
  const { sorted, sortCol, sortDir, toggleSort } = useTableSort(filtered, {
    siteNum: (i) => i.siteNum,
    storeName: (i) => i.storeName,
    channel: (i) => i.channel,
    subChannel: (i) => i.subChannel,
    country: (i) => i.country,
    province: (i) => i.province,
    status: (i) => i.status,
    type: (i) => i.type,
  }, 'siteNum', 'asc');

  return (
    <div className="flex flex-col gap-6">
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <div className="bg-white rounded-xl shadow-sm border-l-4 border-[var(--color-primary)] px-6 py-4 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Site Control</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {items.length} sites · {summary.channels} channels · {summary.subs} sub-channels · {summary.countries} countries
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleDownloadTemplate}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            Download Template
          </button>
          <input ref={fileRef} type="file" accept=".xlsx,.xlsm,.xls,.csv" onChange={handleExcelUpload} className="hidden" />
          <button onClick={() => fileRef.current?.click()}
            className="px-4 py-2 text-sm bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white font-semibold rounded-lg transition-colors">
            Upload Master Site File
          </button>
        </div>
      </div>

      <div className="bg-blue-50 border border-blue-100 rounded-xl px-5 py-4 text-sm text-blue-900">
        Upload the channel&apos;s <strong>MasterSiteFile</strong> (the <code className="text-xs bg-white px-1 py-0.5 rounded">MASTER_SITE</code> sheet).
        Each site is keyed by <strong>SITE NUM</strong> and carries its sub-channel and country.
        Per-client aged-stock omissions (Africa sites, DCs, etc.) are then driven off this master from each client&apos;s settings page.
        <br />
        <span className="text-blue-700">Overwrite replaces only the channels present in the uploaded file — other channels are left untouched.</span>
      </div>

      <section className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-6 pb-0">
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by site number, store, channel, sub-channel, or country..."
            className="w-full max-w-md border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
        </div>
        <div className="overflow-x-auto overflow-y-auto mt-4 max-h-[600px]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-[1]">
              <tr className="border-b border-gray-100 bg-gray-50">
                {([
                  ['siteNum', 'Site #'],
                  ['storeName', 'Store Name'],
                  ['channel', 'Channel'],
                  ['subChannel', 'Sub-Channel'],
                  ['country', 'Country'],
                  ['province', 'Province'],
                  ['status', 'Status'],
                  ['type', 'Type'],
                ] as [string, string][]).map(([col, label]) => (
                  <SortableTh key={col} col={col} label={label} sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide" />
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.slice(0, 1000).map(item => (
                <tr key={item.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                  <td className="px-5 py-2.5 font-mono text-xs text-gray-700">{item.siteNum}</td>
                  <td className="px-5 py-2.5 font-medium text-gray-900">{item.storeName}</td>
                  <td className="px-5 py-2.5 text-gray-600">{item.channel}</td>
                  <td className="px-5 py-2.5 text-gray-600">{item.subChannel}</td>
                  <td className="px-5 py-2.5 text-gray-600">{item.country}</td>
                  <td className="px-5 py-2.5 text-gray-600">{item.province}</td>
                  <td className="px-5 py-2.5 text-gray-600 text-xs">{item.status}</td>
                  <td className="px-5 py-2.5 text-gray-600 text-xs">{item.type}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={8} className="px-6 py-8 text-center text-gray-400 text-sm">No sites loaded yet — upload a Master Site File to get started.</td></tr>
              )}
            </tbody>
          </table>
          {filtered.length > 1000 && (
            <p className="px-6 py-3 text-xs text-gray-400">Showing first 1000 of {filtered.length} matches — refine your search.</p>
          )}
        </div>
      </section>

      {importModalOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-base font-bold text-gray-900 mb-1">Import Sites</h2>
            <p className="text-sm text-gray-500 mb-1">
              {importStats.totalFile} sites parsed — {importStats.existingCount} match existing site numbers, {importStats.newCount} are new.
            </p>
            {importStats.channels.length > 0 && (
              <p className="text-xs text-gray-400 mb-4">Channels in file: {importStats.channels.join(', ')}</p>
            )}

            <div className="flex flex-col gap-3">
              <button disabled={importLoading} onClick={() => executeImport('append')}
                className="text-left border border-gray-200 rounded-lg p-4 hover:border-[var(--color-primary)] hover:bg-green-50/30 transition-colors disabled:opacity-50">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-bold text-gray-900">Append</span>
                  <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">Safe</span>
                </div>
                <p className="text-xs text-gray-500">Add only new sites. <strong>{importStats.newCount} new</strong> added, {importStats.existingCount} skipped.</p>
              </button>

              <button disabled={importLoading} onClick={() => executeImport('update')}
                className="text-left border border-gray-200 rounded-lg p-4 hover:border-[var(--color-primary)] hover:bg-blue-50/30 transition-colors disabled:opacity-50">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-bold text-gray-900">Update</span>
                  <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">Merge</span>
                </div>
                <p className="text-xs text-gray-500">Update matched sites + add new. <strong>{importStats.existingCount} updated</strong>, {importStats.newCount} new.</p>
              </button>

              <button disabled={importLoading} onClick={() => executeImport('overwrite')}
                className="text-left border border-amber-200 rounded-lg p-4 hover:border-amber-400 hover:bg-amber-50/30 transition-colors disabled:opacity-50">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-bold text-gray-900">Overwrite channel(s)</span>
                  <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium">Scoped</span>
                </div>
                <p className="text-xs text-gray-500">
                  Replace all sites for {importStats.channels.length ? <strong>{importStats.channels.join(', ')}</strong> : 'the uploaded channels'} with the {importStats.totalFile} from file. Other channels are kept.
                </p>
              </button>
            </div>

            <div className="flex justify-end mt-5">
              <button onClick={() => { setImportModalOpen(false); setImportRecords([]); }} disabled={importLoading}
                className="text-sm text-gray-600 hover:text-gray-900 px-4 py-2 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors disabled:opacity-50">
                Cancel
              </button>
            </div>
            {importLoading && <p className="text-xs text-gray-400 mt-3 text-center">Importing...</p>}
          </div>
        </div>
      )}
    </div>
  );
}
