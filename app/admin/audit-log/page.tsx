'use client';

import { useEffect, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';

interface AuditEntry {
  id: string;
  action: string;
  userId: string;
  userName: string;
  slipId?: string;
  clientId?: string;
  detail: string;
  timestamp: string;
}

const ACTION_LABELS: Record<string, string> = {
  receipt_complete: 'Receipt Complete',
  release_complete: 'Release Complete',
  partial_release: 'Partial Release',
  failed_release: 'Failed Release',
  release_code_changed: 'Release Code Changed',
};

const ACTION_COLORS: Record<string, string> = {
  receipt_complete: 'bg-green-100 text-green-700',
  release_complete: 'bg-purple-100 text-purple-700',
  partial_release: 'bg-red-100 text-red-700',
  failed_release: 'bg-red-100 text-red-700',
  release_code_changed: 'bg-blue-100 text-blue-700',
};

function fmtDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `${date} ${time}`;
  } catch { return iso; }
}

export default function AuditLogPage() {
  const { session, loading: authLoading, logout } = useAuth('manage_users');
  const [toast, setToast] = useState<ToastData | null>(null);
  const [months, setMonths] = useState<string[]>([]);
  const [selectedMonth, setSelectedMonth] = useState('');
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const notify = (message: string, type: 'success' | 'error' = 'success') =>
    setToast({ message, type });

  // Load available months
  useEffect(() => {
    if (!session) return;
    authFetch('/api/audit-log', { cache: 'no-store' })
      .then(async res => {
        if (res.ok) {
          const data = await res.json();
          setMonths(data.months ?? []);
          if (data.months?.length > 0) {
            setSelectedMonth(data.months[0]);
          }
        }
      })
      .catch(() => notify('Failed to load audit log', 'error'));
  }, [session]);

  // Load entries when month changes
  useEffect(() => {
    if (!session || !selectedMonth) return;
    setLoading(true);
    authFetch(`/api/audit-log?month=${selectedMonth}`, { cache: 'no-store' })
      .then(async res => {
        if (res.ok) {
          const data = await res.json();
          setEntries(data.entries ?? []);
        }
      })
      .catch(() => notify('Failed to load entries', 'error'))
      .finally(() => setLoading(false));
  }, [session, selectedMonth]);

  if (authLoading || !session) return null;

  const q = searchQuery.trim().toLowerCase();
  const filtered = entries
    .filter(e => {
      if (!q) return true;
      const hay = `${e.userName} ${e.action} ${e.detail} ${e.slipId ?? ''}`.toLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp)); // newest first

  return (
    <div className="min-h-screen bg-gray-50">
      <Sidebar session={session} onLogout={logout} />
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <main className="ml-64 px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Audit Log</h1>
            <p className="text-sm text-gray-600 mt-1">Track all stock receipt, release, and security actions</p>
          </div>
        </div>

        {/* Filters */}
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4 flex gap-4 items-end">
          <div>
            <label className="block text-xs text-gray-600 mb-1">Month</label>
            <select
              value={selectedMonth}
              onChange={e => setSelectedMonth(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm"
            >
              {months.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label className="block text-xs text-gray-600 mb-1">Search</label>
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="User name, action, slip ID, detail..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
          </div>
          <div className="text-sm text-gray-500">
            {filtered.length} entr{filtered.length === 1 ? 'y' : 'ies'}
          </div>
        </div>

        {/* Table */}
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="max-h-[70vh] overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr className="text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
                  <th className="px-3 py-2">Date & Time</th>
                  <th className="px-3 py-2">User</th>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Pick Slip</th>
                  <th className="px-3 py-2">Detail</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-500">Loading...</td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-500">No audit entries for this period.</td></tr>
                ) : filtered.map(e => (
                  <tr key={e.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-1.5 whitespace-nowrap text-xs text-gray-500">{fmtDateTime(e.timestamp)}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap font-medium">{e.userName}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${ACTION_COLORS[e.action] || 'bg-gray-100 text-gray-700'}`}>
                        {ACTION_LABELS[e.action] || e.action}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap font-mono text-xs">{e.slipId || '—'}</td>
                    <td className="px-3 py-1.5 text-gray-600 text-xs">{e.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}
