'use client';

import { useState } from 'react';
import Sidebar from '@/components/Sidebar';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch } from '@/lib/useAuth';

export default function BackupPage() {
  const { session, loading: authLoading, logout } = useAuth('clear_data');
  const [downloading, setDownloading] = useState(false);
  const [toast, setToast] = useState<ToastData | null>(null);

  const notify = (message: string, type: 'success' | 'error' = 'success') =>
    setToast({ message, type });

  async function handleDownload() {
    setDownloading(true);
    try {
      const res = await authFetch('/api/admin/backup');
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Download failed' }));
        notify(err.error || 'Download failed', 'error');
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1]
        || `iram-backup-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      notify('Backup downloaded successfully');
    } catch {
      notify('Network error — please try again', 'error');
    } finally {
      setDownloading(false);
    }
  }

  if (authLoading || !session) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      <Sidebar session={session} onLogout={logout} />
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <main className="ml-64 px-8 py-8">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900">Backup Data</h1>
          <p className="text-sm text-gray-600 mt-1">
            Download a complete backup of all application data
          </p>
        </div>

        {/* Info card */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 max-w-2xl mb-6">
          <h2 className="text-sm font-semibold text-gray-800 mb-3">
            What&apos;s included in the backup
          </h2>
          <ul className="text-sm text-gray-600 space-y-1.5 ml-4 list-disc">
            <li>Clients, stores, products, reps &amp; warehouses</li>
            <li>Channels &amp; channel assignments</li>
            <li>Users, roles &amp; permissions</li>
            <li>Aged stock loads &amp; drafts</li>
            <li>Pick slip runs &amp; manual captures</li>
            <li>Sticker batches</li>
            <li>Audit log entries</li>
            <li>Profile avatars</li>
          </ul>
        </div>

        {/* Note */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 max-w-2xl mb-6 flex items-start gap-3">
          <svg className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm text-blue-800">
            The backup contains all blob storage data as a ZIP file.
            Large datasets may take a moment to prepare.
          </p>
        </div>

        {/* Download button */}
        <button
          onClick={handleDownload}
          disabled={downloading}
          className="flex items-center gap-2 px-6 py-2.5 bg-[#7CC042] text-white font-semibold rounded-lg hover:bg-[#6aad36] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {downloading ? (
            <>
              <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Preparing backup...
            </>
          ) : (
            <>
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Download Backup
            </>
          )}
        </button>
      </main>
    </div>
  );
}
