'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Logo from '@/components/Logo';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [forgotMode, setForgotMode] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [forgotError, setForgotError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Login failed'); return; }

      localStorage.setItem('rvl_session', JSON.stringify({
        id: data.id, name: data.name, surname: data.surname,
        email: data.email, role: data.role,
        roleName: data.roleName,
        permissions: data.permissions ?? [],
        linkedClientId: data.linkedClientId,
        avatarUpdatedAt: data.avatarUpdatedAt,
        subscriptionTier: data.subscriptionTier ?? 'standard',
      }));

      if (data.forcePasswordChange) {
        router.push('/change-password');
      } else {
        router.push('/dashboard');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    setForgotError('');
    setForgotLoading(true);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail }),
      });
      if (!res.ok) {
        const data = await res.json();
        setForgotError(data.error || 'Something went wrong');
      } else {
        setForgotSent(true);
      }
    } catch {
      setForgotError('Network error. Please try again.');
    } finally {
      setForgotLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Header */}
        <div className="bg-[var(--color-primary)] rounded-t-xl px-8 py-6 text-white text-center">
          <div className="flex justify-center mb-3">
            <Logo size={60} light />
          </div>
          <p className="text-xs opacity-70 mt-1">Powered by OuterJoin</p>
        </div>

        {/* Form */}
        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-b-xl shadow-lg px-8 py-8 flex flex-col gap-5"
        >
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoFocus
              className="border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
              placeholder="you@example.com"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Password</label>
            <div className="relative">
              <input
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm pr-10 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPw(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs"
                tabIndex={-1}
              >
                {showPw ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white font-bold py-2.5 rounded-lg transition-colors text-sm tracking-wide"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>

          <button
            type="button"
            onClick={() => { setForgotMode(true); setForgotEmail(email); setForgotSent(false); setForgotError(''); }}
            className="text-xs text-gray-400 hover:text-[var(--color-primary)] transition-colors text-center"
          >
            Forgot Password?
          </button>
        </form>

        {/* Forgot Password Modal */}
        {forgotMode && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
            <div className="bg-white rounded-xl shadow-2xl max-w-sm w-full p-6 flex flex-col gap-4">
              <h3 className="text-lg font-bold text-gray-900">Reset Password</h3>

              {forgotSent ? (
                <>
                  <p className="text-sm text-gray-600">
                    If an account exists with that email, a temporary password has been sent. Check your inbox and use it to log in.
                  </p>
                  <button
                    onClick={() => { setForgotMode(false); setForgotSent(false); }}
                    className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white font-bold py-2 rounded-lg transition-colors text-sm"
                  >
                    Back to Login
                  </button>
                </>
              ) : (
                <form onSubmit={handleForgot} className="flex flex-col gap-4">
                  <p className="text-sm text-gray-600">
                    Enter your email address and we&apos;ll send you a temporary password.
                  </p>
                  <input
                    type="email"
                    value={forgotEmail}
                    onChange={e => setForgotEmail(e.target.value)}
                    required
                    autoFocus
                    placeholder="you@example.com"
                    className="border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
                  />

                  {forgotError && (
                    <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">
                      {forgotError}
                    </div>
                  )}

                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setForgotMode(false)}
                      className="flex-1 px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={forgotLoading}
                      className="flex-1 bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white font-bold py-2 rounded-lg transition-colors text-sm"
                    >
                      {forgotLoading ? 'Sending...' : 'Send Reset Email'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
