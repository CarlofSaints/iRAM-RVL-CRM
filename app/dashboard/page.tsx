'use client';

import { useAuth } from '@/lib/useAuth';
import Sidebar from '@/components/Sidebar';
import Link from 'next/link';
import { useEffect, useState } from 'react';

export default function DashboardPage() {
  const { session, loading, logout } = useAuth('admin');
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!session) return;
    const types = ['clients', 'stores', 'products', 'reps', 'warehouses'];
    types.forEach(async (type) => {
      try {
        const res = await fetch(`/api/control/${type}`, { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          setCounts(prev => ({ ...prev, [type]: data.length }));
        }
      } catch { /* ignore */ }
    });
  }, [session]);

  if (loading || !session) return null;

  const stats = [
    { label: 'Clients / Suppliers', count: counts.clients ?? 0, href: '/control-centre/clients', color: 'bg-green-500' },
    { label: 'Stores', count: counts.stores ?? 0, href: '/control-centre/stores', color: 'bg-blue-500' },
    { label: 'Products', count: counts.products ?? 0, href: '/control-centre/products', color: 'bg-purple-500' },
    { label: 'Reps', count: counts.reps ?? 0, href: '/control-centre/reps', color: 'bg-orange-500' },
    { label: 'Warehouses', count: counts.warehouses ?? 0, href: '/control-centre/warehouses', color: 'bg-teal-500' },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <Sidebar session={session} onLogout={logout} />

      <main className="ml-64 px-8 py-8 flex flex-col gap-8">
        {/* Welcome */}
        <div className="bg-white rounded-xl shadow-sm border-l-4 border-[var(--color-primary)] px-6 py-5">
          <h1 className="text-xl font-bold text-gray-900">
            Welcome back, {session.name}
          </h1>
          <p className="text-sm text-gray-500 mt-1">iRam Reverse Logistics Value — CRM Dashboard</p>
        </div>

        {/* Quick Stats */}
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

        {/* Quick Actions */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-4">Quick Actions</h2>
          <div className="flex flex-wrap gap-3">
            <Link href="/control-centre"
              className="px-4 py-2 bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white text-sm font-medium rounded-lg transition-colors">
              Control Centre
            </Link>
            {session.role === 'super-user' && (
              <Link href="/admin/users"
                className="px-4 py-2 bg-[var(--color-charcoal)] hover:bg-gray-700 text-white text-sm font-medium rounded-lg transition-colors">
                Manage Users
              </Link>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
