'use client';

import { useAuth, authFetch } from '@/lib/useAuth';
import Sidebar from '@/components/Sidebar';
import Link from 'next/link';
import { useEffect, useState } from 'react';

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

export default function DashboardPage() {
  // Any logged-in user can see the dashboard. Each stat card / action is gated
  // individually by the permissions resolved on the session.
  const { session, loading, logout } = useAuth();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [clientName, setClientName] = useState<string | null>(null);

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

    // Only load counts for users with full dashboard access
    if (!perms.includes('view_dashboard')) return;

    const types = ['clients', 'stores', 'products', 'reps', 'warehouses'];
    types.forEach(async (type) => {
      try {
        const res = await authFetch(`/api/control/${type}`, { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          setCounts(prev => ({ ...prev, [type]: data.length }));
        }
      } catch { /* ignore */ }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  if (loading || !session) return null;

  const allStats: StatCard[] = [
    { label: 'Clients / Suppliers', count: counts.clients ?? 0, href: '/control-centre/clients', color: 'bg-green-500', perm: 'manage_clients' },
    { label: 'Stores', count: counts.stores ?? 0, href: '/control-centre/stores', color: 'bg-blue-500', perm: 'manage_stores' },
    { label: 'Products', count: counts.products ?? 0, href: '/control-centre/products', color: 'bg-purple-500', perm: 'manage_products' },
    { label: 'Reps', count: counts.reps ?? 0, href: '/control-centre/reps', color: 'bg-orange-500', perm: 'manage_reps' },
    { label: 'Warehouses', count: counts.warehouses ?? 0, href: '/control-centre/warehouses', color: 'bg-teal-500', perm: 'manage_warehouses' },
  ];
  const stats = allStats.filter(s => has(s.perm));

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

        {/* Quick Stats — only if user has full dashboard view AND at least one control perm */}
        {has('view_dashboard') && stats.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {stats.map(stat => (
              <Link key={stat.href} href={stat.href}
                className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 hover:shadow-md transition-all group">
                <div className="flex items-center gap-3">
                  <div className={`w-3 h-3 rounded-full ${stat.color}`} />
                  <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide group-hover:text-[var(--color-primary)] transition-colors">
                    {stat.label}
                  </span>
                </div>
                <div className="text-3xl font-bold text-gray-900 mt-2">{stat.count}</div>
              </Link>
            ))}
          </div>
        )}

        {/* Quick Actions */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-4">Quick Actions</h2>
          <div className="flex flex-wrap gap-3">
            {stats.length > 0 && (
              <Link href="/control-centre"
                className="px-4 py-2 bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white text-sm font-medium rounded-lg transition-colors">
                Control Centre
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
