'use client';

import { useAuth, authFetch } from '@/lib/useAuth';
import Sidebar from '@/components/Sidebar';
import Link from 'next/link';
import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import * as XLSX from 'xlsx';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';

// ── Types ───────────────────────────────────────────────────────────────────

interface DashboardRow {
  clientId: string;
  clientName: string;
  vendorNumbers: string[];
  storeName: string;
  storeCode: string;
  warehouse: string;
  product: string;
  articleCode: string;
  repName: string;
  pickSlipRef: string;
  qty: number;
  val: number;
  date: string;
  category: 'aged' | 'warehouse' | 'transit' | 'display' | 'store-refused' | 'not-found' | 'damaged' | 'collected';
}

interface DashboardStats {
  controlCounts: {
    clients: number;
    stores: number;
    products: number;
    reps: number;
    warehouses: number;
  };
  warehouses: Array<{ code: string; name: string }>;
  rows: DashboardRow[];
}

interface StatCard {
  label: string;
  count: number;
  href: string;
  color: string;
  perm: string;
}

interface Client {
  id: string;
  name: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  return n.toLocaleString('en-ZA');
}

function fmtRand(n: number): string {
  return `R ${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Multi-filter dropdown component ─────────────────────────────────────────

function MultiFilter({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const count = selected.size;
  const isAll = count === 0; // empty set = no filter = all

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors flex items-center gap-1.5 whitespace-nowrap ${
          !isAll
            ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]'
            : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
        }`}
      >
        <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
        </svg>
        {label}{!isAll ? ` (${count})` : ''}
      </button>

      {open && (
        <div className="absolute left-0 mt-1 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-30 max-h-60 overflow-y-auto">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 sticky top-0 bg-white">
            <button onClick={() => onChange(new Set())} className="text-xs text-[var(--color-primary)] hover:underline font-medium">All</button>
            <span className="text-gray-300">|</span>
            <button onClick={() => onChange(new Set(['__none__']))} className="text-xs text-gray-500 hover:underline font-medium">None</button>
          </div>
          {options.map(opt => (
            <label key={opt} className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer text-xs">
              <input
                type="checkbox"
                checked={selected.has(opt)}
                onChange={() => {
                  const next = new Set(selected);
                  next.delete('__none__');
                  if (next.has(opt)) next.delete(opt);
                  else next.add(opt);
                  // If everything unchecked, means "all"
                  if (next.size === 0) onChange(new Set());
                  else onChange(next);
                }}
                className="rounded border-gray-300 text-[var(--color-primary)] focus:ring-[var(--color-primary)]"
              />
              <span className="truncate">{opt}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Summary Grid (reusable for unreturned stock grids) ──────────────────────

interface SummaryCol {
  key: string;
  label: string;
  align?: 'left' | 'right';
  format?: 'number' | 'rand';
}

function SummaryGrid({
  title,
  columns,
  rows,
  exportFileName,
}: {
  title: string;
  columns: SummaryCol[];
  rows: Array<Record<string, string | number>>;
  exportFileName: string;
}) {
  const [sortKey, setSortKey] = useState<string>(columns[0]?.key ?? '');
  const [sortAsc, setSortAsc] = useState(true);
  const [widths, setWidths] = useState<Record<number, number>>({});
  const resizing = useRef<{ idx: number; startX: number; startW: number } | null>(null);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!resizing.current) return;
      const diff = e.clientX - resizing.current.startX;
      setWidths(prev => ({ ...prev, [resizing.current!.idx]: Math.max(60, resizing.current!.startW + diff) }));
    }
    function onUp() { resizing.current = null; document.body.style.cursor = ''; document.body.style.userSelect = ''; }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []);

  function toggleSort(key: string) {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(true); }
  }

  const sorted = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      const va = a[sortKey] ?? '';
      const vb = b[sortKey] ?? '';
      if (typeof va === 'number' && typeof vb === 'number') return sortAsc ? va - vb : vb - va;
      return sortAsc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
    });
    return arr;
  }, [rows, sortKey, sortAsc]);

  const totals = useMemo(() => {
    const t: Record<string, number> = {};
    for (const col of columns) {
      if (col.format === 'number' || col.format === 'rand') {
        t[col.key] = rows.reduce((sum, r) => sum + (Number(r[col.key]) || 0), 0);
      }
    }
    return t;
  }, [rows, columns]);

  function doExport() {
    if (sorted.length === 0) return;
    const xlRows = sorted.map(r => {
      const out: Record<string, string | number> = {};
      for (const c of columns) out[c.label] = r[c.key] ?? '';
      return out;
    });
    const totRow: Record<string, string | number> = {};
    for (const c of columns) totRow[c.label] = totals[c.key] != null ? totals[c.key] : (c === columns[0] ? 'TOTAL' : '');
    xlRows.push(totRow);
    const ws = XLSX.utils.json_to_sheet(xlRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Summary');
    XLSX.writeFile(wb, exportFileName);
  }

  function startRes(idx: number, e: React.MouseEvent) {
    e.preventDefault();
    const th = (e.target as HTMLElement).closest('th');
    if (!th) return;
    resizing.current = { idx, startX: e.clientX, startW: th.getBoundingClientRect().width };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">{title}</h2>
        <button
          onClick={doExport}
          disabled={sorted.length === 0}
          className="px-3 py-1.5 text-xs font-medium border border-gray-200 hover:bg-gray-50 rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-50"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          Export
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={Object.keys(widths).length > 0 ? { tableLayout: 'fixed', minWidth: columns.length * 100 } : undefined}>
          <thead>
            <tr className="bg-gray-50 text-left">
              {columns.map((col, ci) => (
                <th key={col.key}
                  style={widths[ci] ? { width: widths[ci] } : undefined}
                  className={`px-3 py-2 font-semibold text-gray-600 text-xs uppercase relative cursor-pointer select-none hover:bg-gray-100 whitespace-normal ${col.align === 'right' ? 'text-right' : ''}`}
                  onClick={() => toggleSort(col.key)}
                >
                  {col.label}
                  {sortKey === col.key
                    ? <span className="text-[var(--color-primary)] ml-1">{sortAsc ? '▲' : '▼'}</span>
                    : <span className="text-gray-300 ml-1">&#8597;</span>}
                  <div onMouseDown={e => startRes(ci, e)} className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-[var(--color-primary)]/30 z-10" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, ri) => (
              <tr key={ri} className="border-t border-gray-100 hover:bg-gray-50">
                {columns.map(col => (
                  <td key={col.key} className={`px-3 py-2 ${col.align === 'right' ? 'text-right' : ''} ${(col.format === 'number' || col.format === 'rand') && (Number(r[col.key]) || 0) > 0 ? 'font-medium' : 'text-gray-400'}`}>
                    {col.format === 'rand' ? fmtRand(Number(r[col.key]) || 0) : col.format === 'number' ? fmtNum(Number(r[col.key]) || 0) : r[col.key]}
                  </td>
                ))}
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr><td colSpan={columns.length} className="px-3 py-6 text-center text-gray-400">No data</td></tr>
            )}
          </tbody>
          {sorted.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                {columns.map((col, ci) => (
                  <td key={col.key} className={`px-3 py-2 ${col.align === 'right' ? 'text-right' : ''}`}>
                    {totals[col.key] != null
                      ? (col.format === 'rand' ? fmtRand(totals[col.key]) : fmtNum(totals[col.key]))
                      : ci === 0 ? 'Total' : ''}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

// ── Grid column definition ──────────────────────────────────────────────────

interface GridRow {
  clientId: string;
  clientName: string;
  vendorNumbers: string[];
  agedQty: number;
  agedVal: number;
  warehouseQty: Record<string, number>;
  warehouseVal: Record<string, number>;
  transitQty: number;
  transitVal: number;
}

// ── Main component ──────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { session, loading, logout } = useAuth();

  // Data
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [clientName, setClientName] = useState<string | null>(null);

  // Multi-select filters (empty Set = all / no filter)
  const [clientFilter, setClientFilter] = useState<Set<string>>(new Set());
  const [repFilter, setRepFilter] = useState<Set<string>>(new Set());
  const [storeFilter, setStoreFilter] = useState<Set<string>>(new Set());
  const [pickSlipFilter, setPickSlipFilter] = useState<Set<string>>(new Set());
  const [warehouseFilter, setWarehouseFilter] = useState<Set<string>>(new Set());
  const [productFilter, setProductFilter] = useState<Set<string>>(new Set());

  // Date range
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Cross-filter selections
  const [selectedWarehouse, setSelectedWarehouse] = useState<string | null>(null);
  const [selectedClient, setSelectedClient] = useState<string | null>(null);

  // Grid sorting
  const [sortCol, setSortCol] = useState<string>('clientName');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // Filters bar collapsed state
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Column resize
  const [colWidths, setColWidths] = useState<Record<number, number>>({});
  const resizingCol = useRef<{ idx: number; startX: number; startW: number } | null>(null);

  const perms = session?.permissions ?? [];
  const has = useCallback((k: string) => perms.includes(k), [perms]);
  const isScoped = session && !has('view_dashboard') && has('view_dashboard_scoped');

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!resizingCol.current) return;
      const diff = e.clientX - resizingCol.current.startX;
      const newW = Math.max(50, resizingCol.current.startW + diff);
      setColWidths(prev => ({ ...prev, [resizingCol.current!.idx]: newW }));
    }
    function onMouseUp() {
      resizingCol.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  useEffect(() => {
    if (!session) return;

    if (session.linkedClientId) {
      authFetch('/api/control/clients', { cache: 'no-store' }).then(async res => {
        if (!res.ok) return;
        const data: Client[] = await res.json();
        const c = data.find(c => c.id === session.linkedClientId);
        if (c) setClientName(c.name);
      }).catch(() => {/* ignore */});
    }

    if (!perms.includes('view_dashboard')) return;

    authFetch('/api/dashboard/stats', { cache: 'no-store' }).then(async res => {
      if (!res.ok) return;
      const data: DashboardStats = await res.json();
      setStats(data);
    }).catch(() => {/* ignore */});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // ── Derive filter options from ALL rows (not narrowed by other filters) ──
  const allRows = stats?.rows ?? [];
  const warehouses = stats?.warehouses ?? [];

  const filterOptions = useMemo(() => {
    const clients = new Set<string>();
    const reps = new Set<string>();
    const storeNames = new Set<string>();
    const pickSlipRefs = new Set<string>();
    const warehouseCodes = new Set<string>();
    const products = new Set<string>();

    for (const r of allRows) {
      clients.add(`${r.clientName}${r.vendorNumbers.length ? ` - ${r.vendorNumbers.join(', ')}` : ''}`);
      if (r.repName) reps.add(r.repName);
      if (r.storeName) storeNames.add(r.storeName);
      if (r.pickSlipRef) pickSlipRefs.add(r.pickSlipRef);
      if (r.warehouse) warehouseCodes.add(r.warehouse);
      if (r.product) products.add(r.product);
    }

    return {
      clients: [...clients].sort(),
      reps: [...reps].sort(),
      stores: [...storeNames].sort(),
      pickSlips: [...pickSlipRefs].sort(),
      warehouses: [...warehouseCodes].sort(),
      products: [...products].sort(),
    };
  }, [allRows]);

  // Client display label → clientId lookup
  const clientLabelToIds = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const r of allRows) {
      const lbl = `${r.clientName}${r.vendorNumbers.length ? ` - ${r.vendorNumbers.join(', ')}` : ''}`;
      if (!map.has(lbl)) map.set(lbl, new Set());
      map.get(lbl)!.add(r.clientId);
    }
    return map;
  }, [allRows]);

  // ── Filtering pipeline ──────────────────────────────────────────────────

  function matchesSet(value: string, filter: Set<string>): boolean {
    if (filter.size === 0) return true; // empty = all
    if (filter.has('__none__')) return false;
    return filter.has(value);
  }

  function matchesClientFilter(r: DashboardRow): boolean {
    if (clientFilter.size === 0) return true;
    if (clientFilter.has('__none__')) return false;
    const lbl = `${r.clientName}${r.vendorNumbers.length ? ` - ${r.vendorNumbers.join(', ')}` : ''}`;
    return clientFilter.has(lbl);
  }

  // 1. baseFiltered = rows filtered by 6 multi-select filters + date range
  const baseFiltered = useMemo(() => {
    return allRows.filter(r => {
      if (!matchesClientFilter(r)) return false;
      if (!matchesSet(r.repName || '', repFilter) && repFilter.size > 0 && !r.repName) return false;
      if (repFilter.size > 0 && !repFilter.has('__none__') && r.repName && !repFilter.has(r.repName)) return false;
      if (storeFilter.size > 0 && !storeFilter.has('__none__') && !storeFilter.has(r.storeName)) return false;
      if (storeFilter.has('__none__')) return false;
      if (pickSlipFilter.size > 0 && !pickSlipFilter.has('__none__') && r.pickSlipRef && !pickSlipFilter.has(r.pickSlipRef)) return false;
      if (pickSlipFilter.size > 0 && !pickSlipFilter.has('__none__') && !r.pickSlipRef) return false;
      if (pickSlipFilter.has('__none__')) return false;
      if (warehouseFilter.size > 0 && !warehouseFilter.has('__none__') && r.warehouse && !warehouseFilter.has(r.warehouse)) return false;
      if (warehouseFilter.size > 0 && !warehouseFilter.has('__none__') && !r.warehouse) return false;
      if (warehouseFilter.has('__none__')) return false;
      if (productFilter.size > 0 && !productFilter.has('__none__') && !productFilter.has(r.product)) return false;
      if (productFilter.has('__none__')) return false;

      // Date range
      if (dateFrom || dateTo) {
        const d = r.date.slice(0, 10); // YYYY-MM-DD
        if (dateFrom && d < dateFrom) return false;
        if (dateTo && d > dateTo) return false;
      }

      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRows, clientFilter, repFilter, storeFilter, pickSlipFilter, warehouseFilter, productFilter, dateFrom, dateTo]);

  // 2. cardTotals = baseFiltered filtered by BOTH cross-selects
  const cardTotals = useMemo(() => {
    let subset = baseFiltered;
    if (selectedWarehouse) {
      subset = subset.filter(r =>
        (r.category === 'warehouse' && r.warehouse === selectedWarehouse) ||
        (r.category === 'transit' && selectedWarehouse === '__transit__') ||
        (r.category === 'aged' && selectedWarehouse === '__aged__')
      );
    }
    if (selectedClient) {
      subset = subset.filter(r => r.clientId === selectedClient);
    }
    const aged = { qty: 0, val: 0 };
    const warehouse = { qty: 0, val: 0 };
    const transit = { qty: 0, val: 0 };
    for (const r of subset) {
      if (r.category === 'aged') { aged.qty += r.qty; aged.val += r.val; }
      else if (r.category === 'warehouse') { warehouse.qty += r.qty; warehouse.val += r.val; }
      else if (r.category === 'transit') { transit.qty += r.qty; transit.val += r.val; }
    }
    return { aged, warehouse, transit };
  }, [baseFiltered, selectedWarehouse, selectedClient]);

  // 3. chartData = baseFiltered filtered by selectedClient, aggregated by warehouse
  const chartData = useMemo(() => {
    let subset = baseFiltered;
    if (selectedClient) {
      subset = subset.filter(r => r.clientId === selectedClient);
    }
    const byWh: Record<string, { qty: number; val: number }> = {};
    let transitQty = 0;
    let transitVal = 0;
    for (const r of subset) {
      if (r.category === 'warehouse' && r.warehouse) {
        if (!byWh[r.warehouse]) byWh[r.warehouse] = { qty: 0, val: 0 };
        byWh[r.warehouse].qty += r.qty;
        byWh[r.warehouse].val += r.val;
      } else if (r.category === 'transit') {
        transitQty += r.qty;
        transitVal += r.val;
      }
    }
    const bars: Array<{ name: string; key: string; qty: number; val: number }> = [];
    // Warehouse bars in control-centre order
    for (const w of warehouses) {
      const k = w.code.toUpperCase().trim();
      const d = byWh[k];
      if (d && d.qty > 0) {
        bars.push({ name: w.code, key: k, qty: d.qty, val: d.val });
      }
    }
    // Also include warehouses from data not in the control list
    for (const [k, d] of Object.entries(byWh)) {
      if (!bars.some(b => b.key === k) && d.qty > 0) {
        bars.push({ name: k, key: k, qty: d.qty, val: d.val });
      }
    }
    if (transitQty > 0) {
      bars.push({ name: 'In Transit', key: '__transit__', qty: transitQty, val: transitVal });
    }
    return bars;
  }, [baseFiltered, selectedClient, warehouses]);

  // 4. gridData = baseFiltered filtered by selectedWarehouse, aggregated by client
  const gridRows = useMemo(() => {
    let subset = baseFiltered;
    if (selectedWarehouse) {
      subset = subset.filter(r =>
        (r.category === 'warehouse' && r.warehouse === selectedWarehouse) ||
        (r.category === 'transit' && selectedWarehouse === '__transit__') ||
        (r.category === 'aged' && selectedWarehouse === '__aged__')
      );
    }
    const map = new Map<string, GridRow>();
    for (const r of subset) {
      if (!map.has(r.clientId)) {
        map.set(r.clientId, {
          clientId: r.clientId,
          clientName: r.clientName,
          vendorNumbers: r.vendorNumbers,
          agedQty: 0, agedVal: 0,
          warehouseQty: {}, warehouseVal: {},
          transitQty: 0, transitVal: 0,
        });
      }
      const g = map.get(r.clientId)!;
      if (r.category === 'aged') {
        g.agedQty += r.qty;
        g.agedVal += r.val;
      } else if (r.category === 'warehouse' && r.warehouse) {
        g.warehouseQty[r.warehouse] = (g.warehouseQty[r.warehouse] ?? 0) + r.qty;
        g.warehouseVal[r.warehouse] = (g.warehouseVal[r.warehouse] ?? 0) + r.val;
      } else if (r.category === 'transit') {
        g.transitQty += r.qty;
        g.transitVal += r.val;
      }
    }
    return [...map.values()];
  }, [baseFiltered, selectedWarehouse]);

  // Sorted grid
  const sortedGrid = useMemo(() => {
    const arr = [...gridRows];
    arr.sort((a, b) => {
      let va: string | number = 0;
      let vb: string | number = 0;
      if (sortCol === 'clientName') { va = a.clientName.toLowerCase(); vb = b.clientName.toLowerCase(); }
      else if (sortCol === 'vendorNumbers') { va = a.vendorNumbers.join(', ').toLowerCase(); vb = b.vendorNumbers.join(', ').toLowerCase(); }
      else if (sortCol === 'agedQty') { va = a.agedQty; vb = b.agedQty; }
      else if (sortCol === 'agedVal') { va = a.agedVal; vb = b.agedVal; }
      else if (sortCol === 'transitQty') { va = a.transitQty; vb = b.transitQty; }
      else if (sortCol === 'transitVal') { va = a.transitVal; vb = b.transitVal; }
      else if (sortCol.startsWith('wh-qty-')) {
        const k = sortCol.replace('wh-qty-', '');
        va = a.warehouseQty[k] ?? 0; vb = b.warehouseQty[k] ?? 0;
      } else if (sortCol.startsWith('wh-val-')) {
        const k = sortCol.replace('wh-val-', '');
        va = a.warehouseVal[k] ?? 0; vb = b.warehouseVal[k] ?? 0;
      }
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return arr;
  }, [gridRows, sortCol, sortDir]);

  // Grid totals
  const gridTotals = useMemo(() => {
    const t = { agedQty: 0, agedVal: 0, transitQty: 0, transitVal: 0, warehouseQty: {} as Record<string, number>, warehouseVal: {} as Record<string, number> };
    for (const g of gridRows) {
      t.agedQty += g.agedQty;
      t.agedVal += g.agedVal;
      t.transitQty += g.transitQty;
      t.transitVal += g.transitVal;
      for (const [k, v] of Object.entries(g.warehouseQty)) {
        t.warehouseQty[k] = (t.warehouseQty[k] ?? 0) + v;
      }
      for (const [k, v] of Object.entries(g.warehouseVal)) {
        t.warehouseVal[k] = (t.warehouseVal[k] ?? 0) + v;
      }
    }
    return t;
  }, [gridRows]);

  // ── Unreturned stock summary grids ────────────────────────────────────

  const unreturnedCategories = ['display', 'store-refused', 'not-found', 'damaged', 'collected'] as const;
  type UrCat = typeof unreturnedCategories[number];

  // Only rows that are unreturned categories (for the 4 summary grids)
  const urFiltered = useMemo(() => {
    const catSet = new Set<string>(unreturnedCategories);
    let subset = baseFiltered.filter(r => catSet.has(r.category));
    if (selectedWarehouse) {
      // Don't filter unreturned rows by warehouse cross-select (they inherit from the slip)
    }
    if (selectedClient) {
      subset = subset.filter(r => r.clientId === selectedClient);
    }
    return subset;
  }, [baseFiltered, selectedClient]);

  function sumCat(rows: DashboardRow[], cat: UrCat): number {
    return rows.filter(r => r.category === cat).reduce((s, r) => s + r.qty, 0);
  }
  function sumCatVal(rows: DashboardRow[], cat: UrCat): number {
    return rows.filter(r => r.category === cat).reduce((s, r) => s + r.val, 0);
  }

  const urCols: SummaryCol[] = [
    { key: 'label', label: 'Name', align: 'left' },
    { key: 'agedQty', label: 'Total Aged', align: 'right', format: 'number' },
    { key: 'agedVal', label: 'Aged Value', align: 'right', format: 'rand' },
    { key: 'collected', label: 'Collected', align: 'right', format: 'number' },
    { key: 'collectedVal', label: 'Collected Value', align: 'right', format: 'rand' },
    { key: 'display', label: 'Display', align: 'right', format: 'number' },
    { key: 'displayVal', label: 'Display Value', align: 'right', format: 'rand' },
    { key: 'storeRefused', label: 'Store Refused', align: 'right', format: 'number' },
    { key: 'storeRefusedVal', label: 'Refused Value', align: 'right', format: 'rand' },
    { key: 'notFound', label: 'Not Found', align: 'right', format: 'number' },
    { key: 'notFoundVal', label: 'Not Found Value', align: 'right', format: 'rand' },
    { key: 'damaged', label: 'Damaged', align: 'right', format: 'number' },
    { key: 'damagedVal', label: 'Damaged Value', align: 'right', format: 'rand' },
  ];

  // Also include aged stock in the unreturned grids (for the "Total Aged" column)
  const agedFiltered = useMemo(() => {
    let subset = baseFiltered.filter(r => r.category === 'aged');
    if (selectedClient) subset = subset.filter(r => r.clientId === selectedClient);
    return subset;
  }, [baseFiltered, selectedClient]);

  // Grid 1: By Vendor (Client)
  const urByVendor = useMemo(() => {
    const map = new Map<string, { label: string; vendorNum: string; aged: DashboardRow[]; ur: DashboardRow[] }>();
    for (const r of [...agedFiltered, ...urFiltered]) {
      if (!map.has(r.clientId)) map.set(r.clientId, { label: r.clientName, vendorNum: r.vendorNumbers.join(', '), aged: [], ur: [] });
      const g = map.get(r.clientId)!;
      if (r.category === 'aged') g.aged.push(r); else g.ur.push(r);
    }
    return [...map.values()].map(g => ({
      label: g.label,
      vendorNum: g.vendorNum,
      agedQty: g.aged.reduce((s, r) => s + r.qty, 0),
      agedVal: g.aged.reduce((s, r) => s + r.val, 0),
      collected: sumCat(g.ur, 'collected'),
      collectedVal: sumCatVal(g.ur, 'collected'),
      display: sumCat(g.ur, 'display'),
      displayVal: sumCatVal(g.ur, 'display'),
      storeRefused: sumCat(g.ur, 'store-refused'),
      storeRefusedVal: sumCatVal(g.ur, 'store-refused'),
      notFound: sumCat(g.ur, 'not-found'),
      notFoundVal: sumCatVal(g.ur, 'not-found'),
      damaged: sumCat(g.ur, 'damaged'),
      damagedVal: sumCatVal(g.ur, 'damaged'),
    }));
  }, [agedFiltered, urFiltered]);

  const urByVendorCols: SummaryCol[] = [
    { key: 'label', label: 'Client', align: 'left' },
    { key: 'vendorNum', label: 'Vendor #', align: 'left' },
    ...urCols.slice(1),
  ];

  // Grid 2: By Store
  const urByStore = useMemo(() => {
    const map = new Map<string, { aged: DashboardRow[]; ur: DashboardRow[] }>();
    for (const r of [...agedFiltered, ...urFiltered]) {
      const key = r.storeName || '(unknown)';
      if (!map.has(key)) map.set(key, { aged: [], ur: [] });
      const g = map.get(key)!;
      if (r.category === 'aged') g.aged.push(r); else g.ur.push(r);
    }
    return [...map.entries()].map(([store, g]) => ({
      label: store,
      agedQty: g.aged.reduce((s, r) => s + r.qty, 0),
      agedVal: g.aged.reduce((s, r) => s + r.val, 0),
      collected: sumCat(g.ur, 'collected'),
      collectedVal: sumCatVal(g.ur, 'collected'),
      display: sumCat(g.ur, 'display'),
      displayVal: sumCatVal(g.ur, 'display'),
      storeRefused: sumCat(g.ur, 'store-refused'),
      storeRefusedVal: sumCatVal(g.ur, 'store-refused'),
      notFound: sumCat(g.ur, 'not-found'),
      notFoundVal: sumCatVal(g.ur, 'not-found'),
      damaged: sumCat(g.ur, 'damaged'),
      damagedVal: sumCatVal(g.ur, 'damaged'),
    }));
  }, [agedFiltered, urFiltered]);

  // Grid 3: By Product
  const urByProduct = useMemo(() => {
    const map = new Map<string, { desc: string; code: string; aged: DashboardRow[]; ur: DashboardRow[] }>();
    for (const r of [...agedFiltered, ...urFiltered]) {
      const key = r.product || '(unknown)';
      if (!map.has(key)) map.set(key, { desc: r.product, code: r.articleCode, aged: [], ur: [] });
      const g = map.get(key)!;
      if (r.category === 'aged') g.aged.push(r); else g.ur.push(r);
    }
    return [...map.values()].map(g => ({
      label: g.desc,
      articleCode: g.code,
      agedQty: g.aged.reduce((s, r) => s + r.qty, 0),
      agedVal: g.aged.reduce((s, r) => s + r.val, 0),
      collected: sumCat(g.ur, 'collected'),
      collectedVal: sumCatVal(g.ur, 'collected'),
      display: sumCat(g.ur, 'display'),
      displayVal: sumCatVal(g.ur, 'display'),
      storeRefused: sumCat(g.ur, 'store-refused'),
      storeRefusedVal: sumCatVal(g.ur, 'store-refused'),
      notFound: sumCat(g.ur, 'not-found'),
      notFoundVal: sumCatVal(g.ur, 'not-found'),
      damaged: sumCat(g.ur, 'damaged'),
      damagedVal: sumCatVal(g.ur, 'damaged'),
    }));
  }, [agedFiltered, urFiltered]);

  const urByProductCols: SummaryCol[] = [
    { key: 'label', label: 'Product', align: 'left' },
    { key: 'articleCode', label: 'Article Code', align: 'left' },
    ...urCols.slice(1),
  ];

  // Grid 4: Detail (Product x Store)
  const urDetail = useMemo(() => {
    const map = new Map<string, { desc: string; code: string; store: string; aged: DashboardRow[]; ur: DashboardRow[] }>();
    for (const r of [...agedFiltered, ...urFiltered]) {
      const key = `${r.product}|${r.storeName}`;
      if (!map.has(key)) map.set(key, { desc: r.product, code: r.articleCode, store: r.storeName, aged: [], ur: [] });
      const g = map.get(key)!;
      if (r.category === 'aged') g.aged.push(r); else g.ur.push(r);
    }
    return [...map.values()].map(g => ({
      label: g.desc,
      articleCode: g.code,
      store: g.store,
      agedQty: g.aged.reduce((s, r) => s + r.qty, 0),
      agedVal: g.aged.reduce((s, r) => s + r.val, 0),
      collected: sumCat(g.ur, 'collected'),
      collectedVal: sumCatVal(g.ur, 'collected'),
      display: sumCat(g.ur, 'display'),
      displayVal: sumCatVal(g.ur, 'display'),
      storeRefused: sumCat(g.ur, 'store-refused'),
      storeRefusedVal: sumCatVal(g.ur, 'store-refused'),
      notFound: sumCat(g.ur, 'not-found'),
      notFoundVal: sumCatVal(g.ur, 'not-found'),
      damaged: sumCat(g.ur, 'damaged'),
      damagedVal: sumCatVal(g.ur, 'damaged'),
    }));
  }, [agedFiltered, urFiltered]);

  const urDetailCols: SummaryCol[] = [
    { key: 'label', label: 'Product', align: 'left' },
    { key: 'articleCode', label: 'Article Code', align: 'left' },
    { key: 'store', label: 'Store', align: 'left' },
    ...urCols.slice(1),
  ];

  // ── Helpers ─────────────────────────────────────────────────────────────

  const hasAnyFilter = clientFilter.size > 0 || repFilter.size > 0 || storeFilter.size > 0 ||
    pickSlipFilter.size > 0 || warehouseFilter.size > 0 || productFilter.size > 0 || dateFrom || dateTo;

  function clearAllFilters() {
    setClientFilter(new Set());
    setRepFilter(new Set());
    setStoreFilter(new Set());
    setPickSlipFilter(new Set());
    setWarehouseFilter(new Set());
    setProductFilter(new Set());
    setDateFrom('');
    setDateTo('');
    setSelectedWarehouse(null);
    setSelectedClient(null);
  }

  function handleSort(col: string) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  }

  function SortArrow({ col }: { col: string }) {
    if (sortCol !== col) return <span className="text-gray-300 ml-1">&#8597;</span>;
    return <span className="text-[var(--color-primary)] ml-1">{sortDir === 'asc' ? '▲' : '▼'}</span>;
  }

  function startResize(colIdx: number, e: React.MouseEvent) {
    e.preventDefault();
    const th = (e.target as HTMLElement).closest('th');
    if (!th) return;
    resizingCol.current = { idx: colIdx, startX: e.clientX, startW: th.getBoundingClientRect().width };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function ResizeHandle({ colIdx }: { colIdx: number }) {
    return (
      <div
        onMouseDown={e => startResize(colIdx, e)}
        className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-[var(--color-primary)]/30 z-10"
      />
    );
  }

  // ── Excel export ──────────────────────────────────────────────────────────
  function exportToExcel() {
    if (sortedGrid.length === 0) return;
    const rows = sortedGrid.map(c => {
      const row: Record<string, string | number> = {
        'Client': c.clientName,
        'Vendor Numbers': c.vendorNumbers.join(', '),
        'Aged Stock Qty': c.agedQty,
        'Aged Stock Value': c.agedVal,
      };
      for (const w of warehouses) {
        const whKey = w.code.toUpperCase().trim();
        row[`${w.code} Qty`] = c.warehouseQty[whKey] ?? 0;
        row[`${w.code} Value`] = c.warehouseVal[whKey] ?? 0;
      }
      row['Transit Qty'] = c.transitQty;
      row['Transit Value'] = c.transitVal;
      return row;
    });
    // Totals row
    const totals: Record<string, string | number> = {
      'Client': 'TOTAL',
      'Vendor Numbers': '',
      'Aged Stock Qty': gridTotals.agedQty,
      'Aged Stock Value': gridTotals.agedVal,
    };
    for (const w of warehouses) {
      const whKey = w.code.toUpperCase().trim();
      totals[`${w.code} Qty`] = gridTotals.warehouseQty[whKey] ?? 0;
      totals[`${w.code} Value`] = gridTotals.warehouseVal[whKey] ?? 0;
    }
    totals['Transit Qty'] = gridTotals.transitQty;
    totals['Transit Value'] = gridTotals.transitVal;
    rows.push(totals);

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Dashboard Summary');
    const date = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `iRamFlow Dashboard Summary - ${date}.xlsx`);
  }

  // ── Early return AFTER all hooks ──────────────────────────────────────────

  if (loading || !session) return null;

  const counts = stats?.controlCounts ?? { clients: 0, stores: 0, products: 0, reps: 0, warehouses: 0 };

  const allStatCards: StatCard[] = [
    { label: 'Clients / Suppliers', count: counts.clients, href: '/control-centre/clients', color: 'bg-green-500', perm: 'manage_clients' },
    { label: 'Stores', count: counts.stores, href: '/control-centre/stores', color: 'bg-blue-500', perm: 'manage_stores' },
    { label: 'Products', count: counts.products, href: '/control-centre/products', color: 'bg-purple-500', perm: 'manage_products' },
    { label: 'Reps', count: counts.reps, href: '/control-centre/reps', color: 'bg-orange-500', perm: 'manage_reps' },
    { label: 'Warehouses', count: counts.warehouses, href: '/control-centre/warehouses', color: 'bg-teal-500', perm: 'manage_warehouses' },
  ];
  const visibleStats = allStatCards.filter(s => has(s.perm));

  const hasAgedStock = has('view_aged_stock') && stats;

  // Column index counter for resize handles
  let ci = 0;
  const colIdx = () => ci++;
  const totalCols = 4 + warehouses.length * 2 + 2;

  // Chart bar click handler
  function handleBarClick(data: { key: string }) {
    if (!data) return;
    setSelectedWarehouse(prev => prev === data.key ? null : data.key);
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Sidebar session={session} onLogout={logout} />

      <main className="ml-64 px-8 py-8 flex flex-col gap-6">
        {/* Welcome */}
        <div className="bg-white rounded-xl shadow-sm border-l-4 border-[var(--color-primary)] px-6 py-5">
          <h1 className="text-xl font-bold text-gray-900">
            Welcome back, {session.name}
          </h1>
          <p className="text-sm text-gray-500 mt-1">iRamFlow — Dashboard</p>
        </div>

        {/* Scoped (Customer) banner */}
        {isScoped && (
          <div className="bg-[var(--color-primary)]/5 border border-[var(--color-primary)]/20 rounded-xl px-6 py-4">
            <div className="text-xs font-semibold text-[var(--color-primary)] uppercase tracking-wide">Scoped View</div>
            <div className="text-sm text-gray-700 mt-1">
              Viewing data for: <strong>{clientName ?? (session.linkedClientId ? '…' : 'No linked client')}</strong>
            </div>
          </div>
        )}

        {/* Control Centre stat cards */}
        {has('view_dashboard') && visibleStats.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {visibleStats.map(stat => (
              <Link key={stat.href} href={stat.href}
                className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 hover:shadow-md transition-all group">
                <div className="flex items-center gap-3">
                  <div className={`w-3 h-3 rounded-full ${stat.color}`} />
                  <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide group-hover:text-[var(--color-primary)] transition-colors">
                    {stat.label}
                  </span>
                </div>
                <div className="text-3xl font-bold text-gray-900 mt-2">{fmtNum(stat.count)}</div>
              </Link>
            ))}
          </div>
        )}

        {/* ── Filter Bar ──────────────────────────────────────────────────── */}
        {hasAgedStock && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100">
            <button
              onClick={() => setFiltersOpen(o => !o)}
              className="w-full flex items-center justify-between px-6 py-3"
            >
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                </svg>
                <span className="text-sm font-bold text-gray-700 uppercase tracking-wide">Filters</span>
                {hasAnyFilter && (
                  <span className="ml-1 px-2 py-0.5 text-[10px] font-bold bg-[var(--color-primary)] text-white rounded-full">Active</span>
                )}
              </div>
              <svg className={`w-4 h-4 text-gray-400 transition-transform ${filtersOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {filtersOpen && (
              <div className="px-6 pb-4 border-t border-gray-100 pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <MultiFilter label="Client" options={filterOptions.clients} selected={clientFilter} onChange={setClientFilter} />
                  <MultiFilter label="Rep" options={filterOptions.reps} selected={repFilter} onChange={setRepFilter} />
                  <MultiFilter label="Store" options={filterOptions.stores} selected={storeFilter} onChange={setStoreFilter} />
                  <MultiFilter label="Pick Slip" options={filterOptions.pickSlips} selected={pickSlipFilter} onChange={setPickSlipFilter} />
                  <MultiFilter label="Warehouse" options={filterOptions.warehouses} selected={warehouseFilter} onChange={setWarehouseFilter} />
                  <MultiFilter label="Product" options={filterOptions.products} selected={productFilter} onChange={setProductFilter} />

                  <div className="flex items-center gap-1.5">
                    <label className="text-xs text-gray-500 font-medium">From</label>
                    <input
                      type="date"
                      value={dateFrom}
                      onChange={e => setDateFrom(e.target.value)}
                      className="px-2 py-1.5 text-xs border border-gray-200 rounded-lg focus:ring-1 focus:ring-[var(--color-primary)] focus:border-[var(--color-primary)]"
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <label className="text-xs text-gray-500 font-medium">To</label>
                    <input
                      type="date"
                      value={dateTo}
                      onChange={e => setDateTo(e.target.value)}
                      className="px-2 py-1.5 text-xs border border-gray-200 rounded-lg focus:ring-1 focus:ring-[var(--color-primary)] focus:border-[var(--color-primary)]"
                    />
                  </div>

                  {(hasAnyFilter || selectedWarehouse || selectedClient) && (
                    <button
                      onClick={clearAllFilters}
                      className="px-3 py-1.5 text-xs font-medium text-red-600 border border-red-200 bg-red-50 hover:bg-red-100 rounded-lg transition-colors"
                    >
                      Clear All
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── 3 Grouped KPI Cards ─────────────────────────────────────────── */}
        {hasAgedStock && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Aged Stock */}
            <div className={`bg-white rounded-xl shadow-sm border-l-4 border-[var(--color-primary)] p-5 transition-all ${
              selectedWarehouse === '__aged__' ? 'ring-2 ring-[var(--color-primary)]' : ''
            }`}>
              <div className="flex items-start gap-3">
                <div className="mt-0.5 w-10 h-10 rounded-lg bg-[var(--color-primary)]/10 flex items-center justify-center shrink-0">
                  <svg className="w-5 h-5 text-[var(--color-primary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Total Aged Stock</div>
                  <div className="text-2xl font-bold text-gray-900 mt-1">{fmtRand(cardTotals.aged.val)}</div>
                  <div className="text-sm text-gray-500 mt-0.5">{fmtNum(cardTotals.aged.qty)} units</div>
                </div>
              </div>
            </div>

            {/* Warehouse Stock */}
            <div className="bg-white rounded-xl shadow-sm border-l-4 border-[var(--color-primary)] p-5">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 w-10 h-10 rounded-lg bg-[var(--color-primary)]/10 flex items-center justify-center shrink-0">
                  <svg className="w-5 h-5 text-[var(--color-primary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Warehouse Stock</div>
                  <div className="text-2xl font-bold text-gray-900 mt-1">{fmtRand(cardTotals.warehouse.val)}</div>
                  <div className="text-sm text-gray-500 mt-0.5">{fmtNum(cardTotals.warehouse.qty)} units</div>
                </div>
              </div>
            </div>

            {/* In Transit */}
            <div className={`bg-white rounded-xl shadow-sm border-l-4 border-[var(--color-primary)] p-5 transition-all ${
              selectedWarehouse === '__transit__' ? 'ring-2 ring-[var(--color-primary)]' : ''
            }`}>
              <div className="flex items-start gap-3">
                <div className="mt-0.5 w-10 h-10 rounded-lg bg-[var(--color-primary)]/10 flex items-center justify-center shrink-0">
                  <svg className="w-5 h-5 text-[var(--color-primary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">In Transit</div>
                  <div className="text-2xl font-bold text-gray-900 mt-1">{fmtRand(cardTotals.transit.val)}</div>
                  <div className="text-sm text-gray-500 mt-0.5">{fmtNum(cardTotals.transit.qty)} units</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Bar Chart ───────────────────────────────────────────────────── */}
        {hasAgedStock && chartData.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">Stock by Warehouse</h2>
              {selectedWarehouse && (
                <button
                  onClick={() => setSelectedWarehouse(null)}
                  className="text-xs text-gray-500 hover:text-gray-700 underline"
                >
                  Clear warehouse selection
                </button>
              )}
            </div>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip
                  formatter={(value, name) => {
                    const v = Number(value) || 0;
                    if (name === 'qty') return [fmtNum(v), 'Quantity'];
                    return [fmtRand(v), 'Value'];
                  }}
                  contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
                />
                <Bar dataKey="qty" radius={[4, 4, 0, 0]} cursor="pointer"
                  onClick={(_data, index) => {
                    const entry = chartData[index];
                    if (entry) handleBarClick(entry);
                  }}
                >
                  {chartData.map((entry) => (
                    <Cell
                      key={entry.key}
                      fill={entry.key === '__transit__' ? '#06b6d4' : '#7CC042'}
                      opacity={selectedWarehouse && selectedWarehouse !== entry.key ? 0.3 : 1}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* ── Client Summary Grid ─────────────────────────────────────────── */}
        {hasAgedStock && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">
                Client Summary
                {selectedClient && (
                  <button
                    onClick={() => setSelectedClient(null)}
                    className="ml-3 text-xs text-gray-500 hover:text-gray-700 underline font-normal normal-case"
                  >
                    Clear client selection
                  </button>
                )}
              </h2>
              <button
                onClick={exportToExcel}
                disabled={sortedGrid.length === 0}
                className="px-3 py-1.5 text-xs font-medium border border-gray-200 hover:bg-gray-50 rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-50"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Export to Excel
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={Object.keys(colWidths).length > 0 ? { tableLayout: 'fixed', minWidth: totalCols * 80 } : undefined}>
                <thead>
                  <tr className="bg-gray-50 text-left">
                    {(() => { const i = colIdx(); return (
                      <th key="client" style={colWidths[i] ? { width: colWidths[i] } : undefined}
                        className="px-3 py-2 font-semibold text-gray-600 text-xs uppercase relative cursor-pointer select-none hover:bg-gray-100"
                        onClick={() => handleSort('clientName')}>
                        Client<SortArrow col="clientName" /><ResizeHandle colIdx={i} />
                      </th>
                    ); })()}
                    {(() => { const i = colIdx(); return (
                      <th key="vendor" style={colWidths[i] ? { width: colWidths[i] } : undefined}
                        className="px-3 py-2 font-semibold text-gray-600 text-xs uppercase relative cursor-pointer select-none hover:bg-gray-100"
                        onClick={() => handleSort('vendorNumbers')}>
                        Vendor #<SortArrow col="vendorNumbers" /><ResizeHandle colIdx={i} />
                      </th>
                    ); })()}
                    {(() => { const i = colIdx(); return (
                      <th key="agedQty" style={colWidths[i] ? { width: colWidths[i] } : undefined}
                        className="px-3 py-2 font-semibold text-gray-600 text-xs uppercase text-right relative cursor-pointer select-none hover:bg-gray-100"
                        onClick={() => handleSort('agedQty')}>
                        Aged Qty<SortArrow col="agedQty" /><ResizeHandle colIdx={i} />
                      </th>
                    ); })()}
                    {(() => { const i = colIdx(); return (
                      <th key="agedVal" style={colWidths[i] ? { width: colWidths[i] } : undefined}
                        className="px-3 py-2 font-semibold text-gray-600 text-xs uppercase text-right relative cursor-pointer select-none hover:bg-gray-100"
                        onClick={() => handleSort('agedVal')}>
                        Aged Value<SortArrow col="agedVal" /><ResizeHandle colIdx={i} />
                      </th>
                    ); })()}
                    {warehouses.map(w => {
                      const qi = colIdx();
                      const vi = colIdx();
                      const whKey = w.code.toUpperCase().trim();
                      return [
                        <th key={`${w.code}-qty`} style={colWidths[qi] ? { width: colWidths[qi] } : undefined}
                          className="px-3 py-2 font-semibold text-gray-600 text-xs uppercase text-right relative cursor-pointer select-none hover:bg-gray-100"
                          onClick={() => handleSort(`wh-qty-${whKey}`)}>
                          {w.code} Qty<SortArrow col={`wh-qty-${whKey}`} /><ResizeHandle colIdx={qi} />
                        </th>,
                        <th key={`${w.code}-val`} style={colWidths[vi] ? { width: colWidths[vi] } : undefined}
                          className="px-3 py-2 font-semibold text-gray-600 text-xs uppercase text-right relative cursor-pointer select-none hover:bg-gray-100"
                          onClick={() => handleSort(`wh-val-${whKey}`)}>
                          {w.code} Val<SortArrow col={`wh-val-${whKey}`} /><ResizeHandle colIdx={vi} />
                        </th>,
                      ];
                    })}
                    {(() => { const i = colIdx(); return (
                      <th key="transitQty" style={colWidths[i] ? { width: colWidths[i] } : undefined}
                        className="px-3 py-2 font-semibold text-gray-600 text-xs uppercase text-right relative cursor-pointer select-none hover:bg-gray-100"
                        onClick={() => handleSort('transitQty')}>
                        Transit Qty<SortArrow col="transitQty" /><ResizeHandle colIdx={i} />
                      </th>
                    ); })()}
                    {(() => { const i = colIdx(); return (
                      <th key="transitVal" style={colWidths[i] ? { width: colWidths[i] } : undefined}
                        className="px-3 py-2 font-semibold text-gray-600 text-xs uppercase text-right relative cursor-pointer select-none hover:bg-gray-100"
                        onClick={() => handleSort('transitVal')}>
                        Transit Val<SortArrow col="transitVal" /><ResizeHandle colIdx={i} />
                      </th>
                    ); })()}
                  </tr>
                </thead>
                <tbody>
                  {sortedGrid.map(c => (
                    <tr
                      key={c.clientId}
                      className={`border-t border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors ${
                        selectedClient === c.clientId ? 'bg-green-50' : ''
                      }`}
                      onClick={() => setSelectedClient(prev => prev === c.clientId ? null : c.clientId)}
                    >
                      <td className="px-3 py-2 font-medium">
                        <Link
                          href={`/aged-stock?client=${encodeURIComponent(c.clientId)}`}
                          className="text-[var(--color-primary)] hover:underline"
                          onClick={e => e.stopPropagation()}
                        >
                          {c.clientName}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-gray-500">{c.vendorNumbers.join(', ')}</td>
                      <td className="px-3 py-2 text-right font-medium">{fmtNum(c.agedQty)}</td>
                      <td className="px-3 py-2 text-right font-medium">{fmtRand(c.agedVal)}</td>
                      {warehouses.map(w => {
                        const whKey = w.code.toUpperCase().trim();
                        const whQty = c.warehouseQty[whKey] ?? 0;
                        const whVal = c.warehouseVal[whKey] ?? 0;
                        return [
                          <td key={`${w.code}-qty`} className={`px-3 py-2 text-right ${whQty > 0 ? 'font-medium text-gray-900' : 'text-gray-400'}`}>
                            {fmtNum(whQty)}
                          </td>,
                          <td key={`${w.code}-val`} className={`px-3 py-2 text-right ${whVal > 0 ? 'font-medium text-gray-900' : 'text-gray-400'}`}>
                            {fmtRand(whVal)}
                          </td>,
                        ];
                      })}
                      <td className={`px-3 py-2 text-right ${c.transitQty > 0 ? 'font-medium text-gray-900' : 'text-gray-400'}`}>
                        {fmtNum(c.transitQty)}
                      </td>
                      <td className={`px-3 py-2 text-right ${c.transitVal > 0 ? 'font-medium text-gray-900' : 'text-gray-400'}`}>
                        {fmtRand(c.transitVal)}
                      </td>
                    </tr>
                  ))}
                  {sortedGrid.length === 0 && (
                    <tr><td colSpan={totalCols} className="px-3 py-6 text-center text-gray-400">No data matches current filters</td></tr>
                  )}
                </tbody>
                {sortedGrid.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                      <td className="px-3 py-2 text-gray-900">Total</td>
                      <td className="px-3 py-2"></td>
                      <td className="px-3 py-2 text-right">{fmtNum(gridTotals.agedQty)}</td>
                      <td className="px-3 py-2 text-right">{fmtRand(gridTotals.agedVal)}</td>
                      {warehouses.map(w => {
                        const whKey = w.code.toUpperCase().trim();
                        const whTotalQty = gridTotals.warehouseQty[whKey] ?? 0;
                        const whTotalVal = gridTotals.warehouseVal[whKey] ?? 0;
                        return [
                          <td key={`${w.code}-qty`} className={`px-3 py-2 text-right ${whTotalQty > 0 ? 'text-gray-900' : 'text-gray-400'}`}>
                            {fmtNum(whTotalQty)}
                          </td>,
                          <td key={`${w.code}-val`} className={`px-3 py-2 text-right ${whTotalVal > 0 ? 'text-gray-900' : 'text-gray-400'}`}>
                            {fmtRand(whTotalVal)}
                          </td>,
                        ];
                      })}
                      <td className={`px-3 py-2 text-right ${gridTotals.transitQty > 0 ? 'text-gray-900' : 'text-gray-400'}`}>
                        {fmtNum(gridTotals.transitQty)}
                      </td>
                      <td className={`px-3 py-2 text-right ${gridTotals.transitVal > 0 ? 'text-gray-900' : 'text-gray-400'}`}>
                        {fmtRand(gridTotals.transitVal)}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        )}

        {/* ── Unreturned Stock Summary Grids ──────────────────────────────── */}
        {hasAgedStock && (
          <>
            <SummaryGrid
              title="Unreturned Stock — By Vendor"
              columns={urByVendorCols}
              rows={urByVendor}
              exportFileName={`iRamFlow Unreturned By Vendor - ${new Date().toISOString().slice(0, 10)}.xlsx`}
            />
            <SummaryGrid
              title="Unreturned Stock — By Store"
              columns={[{ key: 'label', label: 'Store', align: 'left' }, ...urCols.slice(1)]}
              rows={urByStore}
              exportFileName={`iRamFlow Unreturned By Store - ${new Date().toISOString().slice(0, 10)}.xlsx`}
            />
            <SummaryGrid
              title="Unreturned Stock — By Product"
              columns={urByProductCols}
              rows={urByProduct}
              exportFileName={`iRamFlow Unreturned By Product - ${new Date().toISOString().slice(0, 10)}.xlsx`}
            />
            <SummaryGrid
              title="Unreturned Stock — Detail (Product x Store)"
              columns={urDetailCols}
              rows={urDetail}
              exportFileName={`iRamFlow Unreturned Detail - ${new Date().toISOString().slice(0, 10)}.xlsx`}
            />
          </>
        )}

        {/* Quick Actions */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-4">Quick Actions</h2>
          <div className="flex flex-wrap gap-3">
            {visibleStats.length > 0 && (
              <Link href="/control-centre"
                className="px-4 py-2 bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white text-sm font-medium rounded-lg transition-colors">
                Control Centre
              </Link>
            )}
            {has('view_aged_stock') && (
              <Link href="/aged-stock"
                className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white text-sm font-medium rounded-lg transition-colors">
                Aged Stock
              </Link>
            )}
            {has('manage_users') && (
              <Link href="/admin/users"
                className="px-4 py-2 bg-[var(--color-charcoal)] hover:bg-gray-700 text-white text-sm font-medium rounded-lg transition-colors">
                Manage Users
              </Link>
            )}
            {has('manage_roles') && (
              <Link href="/admin/roles"
                className="px-4 py-2 bg-[var(--color-charcoal)] hover:bg-gray-700 text-white text-sm font-medium rounded-lg transition-colors">
                Roles & Permissions
              </Link>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
