'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { authFetch } from '@/lib/useAuth';

interface CardData {
  label: string;
  href: string;
  count: number;
  description: string;
}

export default function ControlCentreOverview() {
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
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
  }, []);

  const cards: CardData[] = [
    { label: 'Clients / Suppliers', href: '/control-centre/clients', count: counts.clients ?? 0, description: 'Manage ASL/NSL suppliers and vendor numbers' },
    { label: 'Stores', href: '/control-centre/stores', count: counts.stores ?? 0, description: 'Retail store locations and contacts' },
    { label: 'Products', href: '/control-centre/products', count: counts.products ?? 0, description: 'Product catalogue per vendor' },
    { label: 'Reps', href: '/control-centre/reps', count: counts.reps ?? 0, description: 'Field representatives' },
    { label: 'Warehouses', href: '/control-centre/warehouses', count: counts.warehouses ?? 0, description: 'Regional warehouse locations' },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="bg-white rounded-xl shadow-sm border-l-4 border-[var(--color-primary)] px-6 py-4">
        <h1 className="text-xl font-bold text-gray-900">Control Centre</h1>
        <p className="text-sm text-gray-500 mt-1">Manage master data files for the RVL system</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map(card => (
          <Link key={card.href} href={card.href}
            className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 hover:shadow-md hover:border-[var(--color-primary)] transition-all group">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wide group-hover:text-[var(--color-primary)] transition-colors">
                {card.label}
              </h3>
              <span className="text-2xl font-bold text-[var(--color-primary)]">{card.count}</span>
            </div>
            <p className="text-xs text-gray-500">{card.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
