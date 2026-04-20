'use client';

import { useAuth, authFetch } from '@/lib/useAuth';
import Sidebar from '@/components/Sidebar';
import Link from 'next/link';
import { useEffect, useState, useMemo } from 'react';

interface DashboardStats {
  controlCounts: {
    clients: number;
    stores: number;
    products: number;
    reps: number;
    warehouses: number;
  };
  warehouses: Array<{ code: string; name: string }>;
  agedStock: {
    totalQty: number;
    totalVal: number;
    byClient: Array<{
      clientId: string;
      clientName: string;
      vendorNumbers: string[];
      totalQty: number;
      totalVal: number;
    }>;
  };
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

function fmtNum(n: number): string {
  return n.toLocaleString('en-ZA');
}

function fmtRand(n: number): string {
  return `R ${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function DashboardPage() {
  const { session, loading, logout } = useAuth();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [clientName, setClientName] = useState<string | null>(null);
  const [selectedClientIds, setSelectedClientIds] = useState<Set<string>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);

  const perms = session?.permissions ?? [];
  const has = (k: string) => perms.includes(k);
  const isScoped = session && !has('view_dashboard') && has('view_dashboard_scoped');

  useEffect(() => {
    if (!session) return;

    // Look up client name for scoped (Customer) users
    if (session.linkedClientId) {
      authFetch('/api/control/clients', { cache: 'no-store' }).then(async res => {
        if (!res.ok) return;
        const data: Client[] = await res.json();
        const c = data.find(c => c.id === session.linkedClientId);
        if (c) setClientName(c.name);
      }).catch(() => {/* ignore */});
    }

    // Only load stats for users with full dashboard access
    if (!perms.includes('view_dashboard')) return;

    authFetch('/api/dashboard/stats', { cache: 'no-store' }).then(async res => {
      if (!res.ok) return;
      const data: DashboardStats = await res.json();
      setStats(data);
      // Default: all clients selected
      setSelectedClientIds(new Set(data.agedStock.byClient.map(c => c.clientId)));
    }).catch(() => {/* ignore */});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Filtered aged stock data based on client selection
  const filteredClients = useMemo(() => {
    if (!stats) return [];
    return stats.agedStock.byClient.filter(c => selectedClientIds.has(c.clientId));
  }, [stats, selectedClientIds]);

  const filteredTotalQty = useMemo(() => filteredClients.reduce((sum, c) => sum + c.totalQty, 0), [filteredClients]);
  const filteredTotalVal = useMemo(() => filteredClients.reduce((sum, c) => sum + c.totalVal, 0), [filteredClients]);

  if (loading || !session) return null;

  const counts = stats?.controlCounts ?? { clients: 0, stores: 0, products: 0, reps: 0, warehouses: 0 };

  const allStats: StatCard[] = [
    { label: 'Clients / Suppliers', count: counts.clients, href: '/control-centre/clients', color: 'bg-green-500', perm: 'manage_clients' },
    { label: 'Stores', count: counts.stores, href: '/control-centre/stores', color: 'bg-blue-500', perm: 'manage_stores' },
    { label: 'Products', count: counts.products, href: '/control-centre/products', color: 'bg-purple-500', perm: 'manage_products' },
    { label: 'Reps', count: counts.reps, href: '/control-centre/reps', color: 'bg-orange-500', perm: 'manage_reps' },
    { label: 'Warehouses', count: counts.warehouses, href: '/control-centre/warehouses', color: 'bg-teal-500', perm: 'manage_warehouses' },
  ];
  const visibleStats = allStats.filter(s => has(s.perm));

  const warehouses = stats?.warehouses ?? [];
  const hasAgedStock = has('view_aged_stock') && stats;

  function toggleClient(clientId: string) {
    setSelectedClientIds(prev => {
      const next = new Set(prev);
      if (next.has(clientId)) next.delete(clientId);
      else next.add(clientId);
      return next;
    });
  }

  function selectAll() {
    if (!stats) return;
    setSelectedClientIds(new Set(stats.agedStock.byClient.map(c => c.clientId)));
  }

  function selectNone() {
    setSelectedClientIds(new Set());
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Sidebar session={session} onLogout={logout} />

      <main className="ml-64 px-8 py-8 flex flex-col gap-8">
        {/* Welcome */}
        <div className="bg-white rounded-xl shadow-sm border-l-4 border-[var(--color-primary)] px-6 py-5">
          <h1 className="text-xl font-bold text-gray-900">
            Welcome back, {session.name}
          </h1>
          <p className="text-sm text-gray-500 mt-1">iRam Reverse Logistics — CRM Dashboard</p>
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

        {/* Aged Stock KPI cards */}
        {hasAgedStock && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-amber-500" />
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Aged Stock Volume</span>
              </div>
              <div className="text-3xl font-bold text-gray-900 mt-2">{fmtNum(filteredTotalQty)}</div>
              <div className="text-xs text-gray-400 mt-1">Total units across {filteredClients.length} client{filteredClients.length !== 1 ? 's' : ''}</div>
            </div>
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-red-500" />
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Aged Stock Value</span>
              </div>
              <div className="text-3xl font-bold text-gray-900 mt-2">{fmtRand(filteredTotalVal)}</div>
              <div className="text-xs text-gray-400 mt-1">Total value across {filteredClients.length} client{filteredClients.length !== 1 ? 's' : ''}</div>
            </div>
          </div>
        )}

        {/* Client filter + Aged Stock Summary Grid */}
        {hasAgedStock && stats.agedStock.byClient.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">Aged Stock Summary</h2>
              <div className="relative">
                <button
                  onClick={() => setFilterOpen(prev => !prev)}
                  className="px-3 py-1.5 text-xs font-medium bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors flex items-center gap-1.5"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                  </svg>
                  Filter Clients ({selectedClientIds.size}/{stats.agedStock.byClient.length})
                </button>

                {filterOpen && (
                  <div className="absolute right-0 mt-1 w-80 bg-white border border-gray-200 rounded-lg shadow-lg z-20 max-h-72 overflow-y-auto">
                    <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 sticky top-0 bg-white">
                      <button onClick={selectAll} className="text-xs text-[var(--color-primary)] hover:underline font-medium">All</button>
                      <span className="text-gray-300">|</span>
                      <button onClick={selectNone} className="text-xs text-gray-500 hover:underline font-medium">None</button>
                    </div>
                    {stats.agedStock.byClient.map(c => (
                      <label key={c.clientId} className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer text-sm">
                        <input
                          type="checkbox"
                          checked={selectedClientIds.has(c.clientId)}
                          onChange={() => toggleClient(c.clientId)}
                          className="rounded border-gray-300 text-[var(--color-primary)] focus:ring-[var(--color-primary)]"
                        />
                        <span className="truncate">{c.clientName} - {c.vendorNumbers.join(', ')}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Summary Grid */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-left">
                    <th className="px-3 py-2 font-semibold text-gray-600 text-xs uppercase">Client</th>
                    <th className="px-3 py-2 font-semibold text-gray-600 text-xs uppercase">Vendor Numbers</th>
                    <th className="px-3 py-2 font-semibold text-gray-600 text-xs uppercase text-right">Aged Stock Qty</th>
                    <th className="px-3 py-2 font-semibold text-gray-600 text-xs uppercase text-right">Aged Stock Value</th>
                    {warehouses.map(w => (
                      <th key={w.code} className="px-3 py-2 font-semibold text-gray-600 text-xs uppercase text-right">{w.code}</th>
                    ))}
                    <th className="px-3 py-2 font-semibold text-gray-600 text-xs uppercase text-right">In Transit</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredClients.map(c => (
                    <tr key={c.clientId} className="border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-3 py-2 font-medium text-gray-900">{c.clientName}</td>
                      <td className="px-3 py-2 text-gray-500">{c.vendorNumbers.join(', ')}</td>
                      <td className="px-3 py-2 text-right font-medium">{fmtNum(c.totalQty)}</td>
                      <td className="px-3 py-2 text-right font-medium">{fmtRand(c.totalVal)}</td>
                      {warehouses.map(w => (
                        <td key={w.code} className="px-3 py-2 text-right text-gray-400">0</td>
                      ))}
                      <td className="px-3 py-2 text-right text-gray-400">0</td>
                    </tr>
                  ))}
                  {filteredClients.length === 0 && (
                    <tr><td colSpan={4 + warehouses.length + 1} className="px-3 py-6 text-center text-gray-400">No clients selected</td></tr>
                  )}
                </tbody>
                {filteredClients.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                      <td className="px-3 py-2 text-gray-900">Total</td>
                      <td className="px-3 py-2"></td>
                      <td className="px-3 py-2 text-right">{fmtNum(filteredTotalQty)}</td>
                      <td className="px-3 py-2 text-right">{fmtRand(filteredTotalVal)}</td>
                      {warehouses.map(w => (
                        <td key={w.code} className="px-3 py-2 text-right text-gray-400">0</td>
                      ))}
                      <td className="px-3 py-2 text-right text-gray-400">0</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
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
