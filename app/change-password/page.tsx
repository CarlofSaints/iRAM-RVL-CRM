'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function ChangePasswordPage() {
  const router = useRouter();
  const [sessionId, setSessionId] = useState('');
  const [current, setCurrent] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const raw = localStorage.getItem('rvl_session');
    if (!raw) { router.replace('/login'); return; }
    const s = JSON.parse(raw);
    setSessionId(s.id);
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (newPw !== confirm) { setError('Passwords do not match'); return; }
    if (newPw.length < 6) { setError('Password must be at least 6 characters'); return; }

    setLoading(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: sessionId, currentPassword: current, newPassword: newPw }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed to update password'); return; }
      router.push('/dashboard');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="bg-[var(--color-primary)] rounded-t-xl px-8 py-6 text-white text-center">
          <h1 className="text-lg font-bold tracking-wide">Change Password</h1>
          <p className="text-xs opacity-80 mt-1">Please set a new password to continue</p>
        </div>
        <form onSubmit={handleSubmit} className="bg-white rounded-b-xl shadow-lg px-8 py-8 flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Current Password</label>
            <div className="relative">
              <input type={showCurrent ? 'text' : 'password'} value={current} onChange={e => setCurrent(e.target.value)} required
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm pr-10 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent" />
              <button type="button" onClick={() => setShowCurrent(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs" tabIndex={-1}>
                {showCurrent ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-gray-600 uppercase tracking-wide">New Password</label>
            <div className="relative">
              <input type={showNew ? 'text' : 'password'} value={newPw} onChange={e => setNewPw(e.target.value)} required
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm pr-10 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent" />
              <button type="button" onClick={() => setShowNew(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs" tabIndex={-1}>
                {showNew ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Confirm New Password</label>
            <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required
              className="border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent" />
          </div>
          {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">{error}</div>}
          <button type="submit" disabled={loading}
            className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white font-bold py-2.5 rounded-lg transition-colors text-sm">
            {loading ? 'Saving...' : 'Set New Password'}
          </button>
        </form>
      </div>
    </div>
  );
}
