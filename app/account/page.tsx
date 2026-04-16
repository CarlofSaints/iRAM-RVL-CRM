'use client';

import { useEffect, useRef, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import { Toast, ToastData } from '@/components/Toast';
import { useAuth, authFetch, updateSession, avatarSrcFor } from '@/lib/useAuth';

type Tab = 'profile' | 'security' | 'billing';

interface AccountData {
  id: string;
  name: string;
  surname: string;
  email: string;
  role: string;
  avatarUpdatedAt?: string;
  hasAvatar?: boolean;
  subscription: { tier: 'standard' | 'pro'; upgradedAt?: string; requestedUpgradeAt?: string };
  createdAt: string;
}

function getInitials(name: string, surname: string) {
  const a = (name || '').trim().charAt(0).toUpperCase();
  const b = (surname || '').trim().charAt(0).toUpperCase();
  return `${a}${b}` || '?';
}

export default function AccountPage() {
  const { session, loading, logout } = useAuth();
  const [tab, setTab] = useState<Tab>('profile');
  const [data, setData] = useState<AccountData | null>(null);
  const [toast, setToast] = useState<ToastData | null>(null);

  // Profile / avatar
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // Email change
  const [newEmail, setNewEmail] = useState('');
  const [emailPw, setEmailPw] = useState('');
  const [emailLoading, setEmailLoading] = useState(false);

  // Password change
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwLoading, setPwLoading] = useState(false);

  // Upgrade
  const [upgradeLoading, setUpgradeLoading] = useState(false);

  const notify = (message: string, type: 'success' | 'error' = 'success') =>
    setToast({ message, type });

  async function fetchAccount() {
    const res = await authFetch('/api/account', { cache: 'no-store' });
    if (res.ok) {
      const d: AccountData = await res.json();
      setData(d);
      setNewEmail(d.email);
    }
  }

  useEffect(() => {
    if (session) fetchAccount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  async function handleAvatarPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await authFetch('/api/account/avatar', { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok) {
        notify(json.error || 'Upload failed', 'error');
        return;
      }
      notify('Profile picture updated');
      setData(d => (d ? { ...d, avatarUpdatedAt: json.avatarUpdatedAt, hasAvatar: true } : d));
      updateSession({ avatarUpdatedAt: json.avatarUpdatedAt });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function handleAvatarRemove() {
    if (!confirm('Remove your profile picture?')) return;
    const res = await authFetch('/api/account/avatar', { method: 'DELETE' });
    if (!res.ok) { notify('Failed to remove', 'error'); return; }
    notify('Profile picture removed');
    setData(d => (d ? { ...d, avatarUpdatedAt: undefined, hasAvatar: false } : d));
    updateSession({ avatarUpdatedAt: undefined });
  }

  async function handleEmailChange(e: React.FormEvent) {
    e.preventDefault();
    setEmailLoading(true);
    try {
      const res = await authFetch('/api/account/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newEmail, currentPassword: emailPw }),
      });
      const json = await res.json();
      if (!res.ok) { notify(json.error || 'Failed to update email', 'error'); return; }
      notify('Email updated');
      setEmailPw('');
      setData(d => (d ? { ...d, email: json.email } : d));
      updateSession({ email: json.email });
    } finally {
      setEmailLoading(false);
    }
  }

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault();
    if (newPw !== confirmPw) { notify('Passwords do not match', 'error'); return; }
    if (newPw.length < 6) { notify('Password must be at least 6 characters', 'error'); return; }
    if (!session) return;
    setPwLoading(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: session.id, currentPassword: currentPw, newPassword: newPw }),
      });
      const json = await res.json();
      if (!res.ok) { notify(json.error || 'Failed to change password', 'error'); return; }
      notify('Password changed');
      setCurrentPw(''); setNewPw(''); setConfirmPw('');
    } finally {
      setPwLoading(false);
    }
  }

  async function handleUpgrade() {
    if (!confirm('Request an upgrade to the Pro plan? Our team will be in touch.')) return;
    setUpgradeLoading(true);
    try {
      const res = await authFetch('/api/account/upgrade', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) { notify(json.error || 'Failed to send request', 'error'); return; }
      notify('Upgrade requested — we\'ll be in touch shortly');
      fetchAccount();
    } finally {
      setUpgradeLoading(false);
    }
  }

  if (loading || !session || !data) return null;

  const fullName = `${data.name} ${data.surname}`.trim();
  const initials = getInitials(data.name, data.surname);
  const tier = data.subscription?.tier ?? 'standard';
  const requested = !!data.subscription?.requestedUpgradeAt && tier !== 'pro';
  const avatarSrc = data.hasAvatar ? avatarSrcFor(data.id, data.avatarUpdatedAt) : undefined;

  return (
    <div className="min-h-screen bg-gray-50">
      <Sidebar session={session} onLogout={logout} />
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <main className="ml-64 px-8 py-8 flex flex-col gap-6">
        {/* Header card */}
        <div className="bg-white rounded-xl shadow-sm border-l-4 border-[var(--color-primary)] px-6 py-5">
          <div className="flex items-center gap-5">
            {avatarSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarSrc}
                alt={fullName}
                className="w-16 h-16 rounded-full object-cover border-2 border-gray-100"
              />
            ) : (
              <div className="w-16 h-16 rounded-full bg-[var(--color-primary)] text-white flex items-center justify-center font-bold text-xl">
                {initials}
              </div>
            )}
            <div className="flex-1">
              <h1 className="text-xl font-bold text-gray-900">{fullName}</h1>
              <p className="text-sm text-gray-500">{data.email}</p>
            </div>
            <div className="text-right">
              <span className={`inline-block text-xs font-bold px-3 py-1 rounded-full ${
                tier === 'pro'
                  ? 'bg-gradient-to-r from-amber-400 to-amber-600 text-white'
                  : 'bg-gray-100 text-gray-600'
              }`}>
                {tier === 'pro' ? 'PRO' : 'STANDARD'}
              </span>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="flex border-b border-gray-100">
            {(['profile', 'security', 'billing'] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 sm:flex-none sm:px-6 px-4 py-3 text-sm font-semibold uppercase tracking-wide transition-colors ${
                  tab === t
                    ? 'text-[var(--color-primary)] border-b-2 border-[var(--color-primary)]'
                    : 'text-gray-500 hover:text-gray-700 border-b-2 border-transparent'
                }`}
              >
                {t === 'profile' ? 'Profile' : t === 'security' ? 'Security' : 'Billing'}
              </button>
            ))}
          </div>

          {/* Profile tab */}
          {tab === 'profile' && (
            <div className="p-6 flex flex-col gap-8">
              {/* Avatar */}
              <section>
                <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Profile Picture</h2>
                <div className="flex items-center gap-5">
                  {avatarSrc ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={avatarSrc}
                      alt={fullName}
                      className="w-24 h-24 rounded-full object-cover border-2 border-gray-100"
                    />
                  ) : (
                    <div className="w-24 h-24 rounded-full bg-[var(--color-primary)] text-white flex items-center justify-center font-bold text-3xl">
                      {initials}
                    </div>
                  )}
                  <div className="flex flex-col gap-2">
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      onChange={handleAvatarPick}
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      disabled={uploading}
                      className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white text-sm font-bold px-5 py-2 rounded-lg transition-colors"
                    >
                      {uploading ? 'Uploading...' : avatarSrc ? 'Change Picture' : 'Upload Picture'}
                    </button>
                    {avatarSrc && (
                      <button
                        type="button"
                        onClick={handleAvatarRemove}
                        className="text-xs text-gray-500 hover:text-red-600 transition-colors text-left"
                      >
                        Remove picture
                      </button>
                    )}
                    <p className="text-xs text-gray-400 mt-1">PNG, JPG, WEBP or GIF. Max 5 MB.</p>
                  </div>
                </div>
              </section>

              {/* Display Name (read-only) */}
              <section>
                <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Display Name</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-gray-500 font-medium">First Name</label>
                    <input value={data.name} readOnly
                      className="border border-gray-200 bg-gray-50 rounded-lg px-3 py-2 text-sm text-gray-600 cursor-not-allowed" />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-gray-500 font-medium">Surname</label>
                    <input value={data.surname} readOnly
                      className="border border-gray-200 bg-gray-50 rounded-lg px-3 py-2 text-sm text-gray-600 cursor-not-allowed" />
                  </div>
                </div>
                <p className="text-xs text-gray-400 mt-2">
                  Display name changes are managed by an administrator. Please contact your admin if your name needs updating.
                </p>
              </section>

              {/* Email */}
              <section>
                <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Email Address</h2>
                <form onSubmit={handleEmailChange} className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-xl">
                  <div className="flex flex-col gap-1 sm:col-span-2">
                    <label className="text-xs text-gray-500 font-medium">New Email</label>
                    <input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} required
                      className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
                  </div>
                  <div className="flex flex-col gap-1 sm:col-span-2">
                    <label className="text-xs text-gray-500 font-medium">Current Password (to confirm)</label>
                    <input type="password" value={emailPw} onChange={e => setEmailPw(e.target.value)} required
                      placeholder="••••••••"
                      className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
                  </div>
                  <div className="sm:col-span-2">
                    <button type="submit" disabled={emailLoading || newEmail === data.email}
                      className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white text-sm font-bold px-5 py-2 rounded-lg transition-colors">
                      {emailLoading ? 'Saving...' : 'Update Email'}
                    </button>
                  </div>
                </form>
              </section>
            </div>
          )}

          {/* Security tab */}
          {tab === 'security' && (
            <div className="p-6">
              <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Change Password</h2>
              <form onSubmit={handlePasswordChange} className="grid grid-cols-1 gap-4 max-w-md">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-gray-500 font-medium">Current Password</label>
                  <input type="password" value={currentPw} onChange={e => setCurrentPw(e.target.value)} required
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-gray-500 font-medium">New Password</label>
                  <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} required minLength={6}
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-gray-500 font-medium">Confirm New Password</label>
                  <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} required
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
                </div>
                <div>
                  <button type="submit" disabled={pwLoading}
                    className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white text-sm font-bold px-5 py-2 rounded-lg transition-colors">
                    {pwLoading ? 'Saving...' : 'Change Password'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Billing tab */}
          {tab === 'billing' && (
            <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Standard plan card */}
              <div className={`rounded-xl border-2 p-6 ${
                tier === 'standard' ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5' : 'border-gray-200 bg-gray-50'
              }`}>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-lg font-bold text-gray-900">Standard</h3>
                  {tier === 'standard' && (
                    <span className="bg-[var(--color-primary)] text-white text-xs font-bold px-2 py-0.5 rounded uppercase tracking-wide">
                      Current
                    </span>
                  )}
                </div>
                <div className="text-3xl font-bold text-gray-900 mb-1">Free</div>
                <p className="text-xs text-gray-500 mb-5">Everything you need to get started.</p>
                <ul className="flex flex-col gap-2 text-sm text-gray-700">
                  <li className="flex items-start gap-2"><span className="text-[var(--color-primary)] font-bold">✓</span> Core CRM access</li>
                  <li className="flex items-start gap-2"><span className="text-[var(--color-primary)] font-bold">✓</span> Master data management</li>
                  <li className="flex items-start gap-2"><span className="text-[var(--color-primary)] font-bold">✓</span> Standard dashboards</li>
                  <li className="flex items-start gap-2"><span className="text-[var(--color-primary)] font-bold">✓</span> Standard reports</li>
                </ul>
              </div>

              {/* Pro plan card */}
              <div className={`rounded-xl border-2 p-6 relative overflow-hidden ${
                tier === 'pro' ? 'border-amber-500 bg-amber-50' : 'border-amber-200 bg-white'
              }`}>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                    Pro
                    <span className="bg-gradient-to-r from-amber-400 to-amber-600 text-white text-xs font-bold px-2 py-0.5 rounded uppercase tracking-wide">
                      Pro
                    </span>
                  </h3>
                  {tier === 'pro' && (
                    <span className="bg-amber-500 text-white text-xs font-bold px-2 py-0.5 rounded uppercase tracking-wide">
                      Current
                    </span>
                  )}
                </div>
                <div className="text-3xl font-bold text-gray-900 mb-1">Contact Sales</div>
                <p className="text-xs text-gray-500 mb-5">Power tools for advanced reporting.</p>
                <ul className="flex flex-col gap-2 text-sm text-gray-700 mb-5">
                  <li className="flex items-start gap-2"><span className="text-amber-600 font-bold">✓</span> Everything in Standard</li>
                  <li className="flex items-start gap-2"><span className="text-amber-600 font-bold">✓</span> Additional reporting</li>
                  <li className="flex items-start gap-2"><span className="text-amber-600 font-bold">✓</span> Custom dashboards</li>
                  <li className="flex items-start gap-2"><span className="text-amber-600 font-bold">✓</span> Priority support</li>
                </ul>

                {tier === 'pro' ? (
                  <div className="text-sm font-semibold text-amber-700">
                    Pro plan active{data.subscription?.upgradedAt ? ` since ${new Date(data.subscription.upgradedAt).toLocaleDateString()}` : ''}.
                  </div>
                ) : requested ? (
                  <div className="bg-amber-100 border border-amber-300 text-amber-800 text-xs rounded-lg px-3 py-2">
                    Upgrade requested {new Date(data.subscription!.requestedUpgradeAt!).toLocaleDateString()} — our team will be in touch shortly.
                  </div>
                ) : (
                  <button
                    onClick={handleUpgrade}
                    disabled={upgradeLoading}
                    className="w-full bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 disabled:opacity-50 text-white text-sm font-bold px-5 py-2.5 rounded-lg transition-all"
                  >
                    {upgradeLoading ? 'Sending request...' : 'Upgrade to Pro'}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
