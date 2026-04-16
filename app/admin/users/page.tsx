'use client';

import { useAuth, authFetch } from '@/lib/useAuth';
import Sidebar from '@/components/Sidebar';
import { Toast, ToastData } from '@/components/Toast';
import { useEffect, useState } from 'react';

interface UserSubscription {
  tier: 'standard' | 'pro';
  upgradedAt?: string;
  requestedUpgradeAt?: string;
}

interface User {
  id: string;
  name: string;
  surname: string;
  email: string;
  role: string;
  linkedClientId?: string;
  subscription?: UserSubscription;
  forcePasswordChange: boolean;
  firstLoginAt: string | null;
  createdAt: string;
}

interface RoleOption {
  id: string;
  name: string;
}

interface ClientOption {
  id: string;
  name: string;
}

const ROLE_BADGE_CLASSES: Record<string, string> = {
  'super-admin': 'bg-green-100 text-green-700',
  'rvl-manager': 'bg-blue-100 text-blue-700',
  'rep': 'bg-orange-100 text-orange-700',
  'customer': 'bg-purple-100 text-purple-700',
};

export default function AdminUsersPage() {
  const { session, loading, logout } = useAuth('manage_users');
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [toast, setToast] = useState<ToastData | null>(null);

  // Add user form
  const [addName, setAddName] = useState('');
  const [addSurname, setAddSurname] = useState('');
  const [addEmail, setAddEmail] = useState('');
  const [addPw, setAddPw] = useState('');
  const [addRole, setAddRole] = useState<string>('rep');
  const [addLinkedClient, setAddLinkedClient] = useState('');
  const [addForcePwChange, setAddForcePwChange] = useState(true);
  const [showAddPw, setShowAddPw] = useState(false);
  const [sendWelcome, setSendWelcome] = useState(true);
  const [addLoading, setAddLoading] = useState(false);

  // Filters
  const [showPendingOnly, setShowPendingOnly] = useState(false);

  // Subscription flip state (per user, to disable row button while in-flight)
  const [flippingId, setFlippingId] = useState<string | null>(null);

  // Edit modal
  const [editUser, setEditUser] = useState<User | null>(null);
  const [editName, setEditName] = useState('');
  const [editSurname, setEditSurname] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editRole, setEditRole] = useState<string>('rep');
  const [editLinkedClient, setEditLinkedClient] = useState('');
  const [editPw, setEditPw] = useState('');
  const [showEditPw, setShowEditPw] = useState(false);
  const [sendReset, setSendReset] = useState(false);
  const [editLoading, setEditLoading] = useState(false);

  const notify = (message: string, type: 'success' | 'error' = 'success') =>
    setToast({ message, type });

  const roleLabel = (id: string) => roles.find(r => r.id === id)?.name ?? id;
  const clientName = (id?: string) => (id ? clients.find(c => c.id === id)?.name ?? '—' : '—');

  async function refresh() {
    const [uRes, rRes, cRes] = await Promise.all([
      authFetch('/api/users', { cache: 'no-store' }),
      authFetch('/api/roles', { cache: 'no-store' }),
      authFetch('/api/control/clients', { cache: 'no-store' }),
    ]);
    if (uRes.ok) setUsers(await uRes.json());
    if (rRes.ok) setRoles(await rRes.json());
    if (cRes.ok) setClients(await cRes.json());
  }

  useEffect(() => {
    if (session) refresh();
  }, [session]);

  // Default the add-role dropdown to the first non-super-admin role once loaded
  useEffect(() => {
    if (roles.length && !roles.find(r => r.id === addRole)) {
      const preferred = roles.find(r => r.id === 'rep') ?? roles[0];
      if (preferred) setAddRole(preferred.id);
    }
  }, [roles, addRole]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (addRole === 'customer' && !addLinkedClient) {
      notify('Please select a linked client for this customer', 'error');
      return;
    }
    setAddLoading(true);
    try {
      const res = await authFetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: addName, surname: addSurname, email: addEmail,
          password: addPw, role: addRole,
          linkedClientId: addRole === 'customer' ? addLinkedClient : undefined,
          forcePasswordChange: addForcePwChange, sendWelcome,
        }),
      });
      const data = await res.json();
      if (!res.ok) { notify(data.error || 'Failed to create user', 'error'); return; }

      if (sendWelcome) {
        await authFetch(`/api/users/${data.id}/notify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plainPassword: addPw, type: 'welcome', name: `${addName} ${addSurname}`, email: addEmail }),
        });
      }
      notify(`User ${addName} ${addSurname} created${sendWelcome ? ' — welcome email sent' : ''}`);
      setAddName(''); setAddSurname(''); setAddEmail(''); setAddPw('');
      setAddRole('rep'); setAddLinkedClient('');
      setAddForcePwChange(true); setSendWelcome(true);
      refresh();
    } finally {
      setAddLoading(false);
    }
  }

  function openEdit(user: User) {
    setEditUser(user);
    setEditName(user.name);
    setEditSurname(user.surname);
    setEditEmail(user.email);
    setEditRole(user.role);
    setEditLinkedClient(user.linkedClientId ?? '');
    setEditPw('');
    setShowEditPw(false);
    setSendReset(false);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editUser) return;
    if (editRole === 'customer' && !editLinkedClient) {
      notify('Please select a linked client for this customer', 'error');
      return;
    }
    setEditLoading(true);
    try {
      const body: Record<string, unknown> = {
        name: editName, surname: editSurname, email: editEmail, role: editRole,
        linkedClientId: editRole === 'customer' ? editLinkedClient : null,
      };
      if (editPw) body.password = editPw;

      const res = await authFetch(`/api/users/${editUser.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { notify('Failed to update user', 'error'); return; }

      if (editPw && sendReset) {
        await authFetch(`/api/users/${editUser.id}/notify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plainPassword: editPw, type: 'reset', name: `${editName} ${editSurname}`, email: editEmail }),
        });
      }
      notify(`User updated${editPw && sendReset ? ' — reset email sent' : ''}`);
      setEditUser(null);
      refresh();
    } finally {
      setEditLoading(false);
    }
  }

  async function handleDelete(user: User) {
    if (!confirm(`Delete user ${user.name} ${user.surname}? This cannot be undone.`)) return;
    const res = await authFetch(`/api/users/${user.id}`, { method: 'DELETE' });
    if (res.ok) { notify('User deleted'); refresh(); }
    else notify('Failed to delete user', 'error');
  }

  async function handleFlipTier(user: User, targetTier: 'standard' | 'pro') {
    const currentTier = user.subscription?.tier ?? 'standard';
    if (currentTier === targetTier) return;

    const label = targetTier === 'pro' ? 'Upgrade to Pro' : 'Downgrade to Standard';
    const sendConfirmationByDefault = targetTier === 'pro';
    const confirmMsg = targetTier === 'pro'
      ? `Upgrade ${user.name} ${user.surname} to Pro? They'll receive a confirmation email.`
      : `Downgrade ${user.name} ${user.surname} to Standard?`;
    if (!confirm(confirmMsg)) return;

    setFlippingId(user.id);
    try {
      const res = await authFetch(`/api/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscriptionTier: targetTier,
          sendConfirmation: sendConfirmationByDefault,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        notify(data.error || `${label} failed`, 'error');
        return;
      }
      notify(targetTier === 'pro'
        ? `${user.name} upgraded to Pro — confirmation email sent`
        : `${user.name} downgraded to Standard`);
      refresh();
    } finally {
      setFlippingId(null);
    }
  }

  if (loading || !session) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      <Sidebar session={session} onLogout={logout} />
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <main className="ml-64 px-8 py-8 flex flex-col gap-8">
        <div className="bg-white rounded-xl shadow-sm border-l-4 border-[var(--color-primary)] px-6 py-4">
          <h1 className="text-xl font-bold text-gray-900">User Management</h1>
        </div>

        {/* Add User */}
        <section className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-4">Add New User</h2>
          <form onSubmit={handleAdd} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500 font-medium">First Name</label>
              <input value={addName} onChange={e => setAddName(e.target.value)} required
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500 font-medium">Surname</label>
              <input value={addSurname} onChange={e => setAddSurname(e.target.value)} required
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500 font-medium">Email</label>
              <input type="email" value={addEmail} onChange={e => setAddEmail(e.target.value)} required
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500 font-medium">Password</label>
              <div className="relative">
                <input type={showAddPw ? 'text' : 'password'} value={addPw} onChange={e => setAddPw(e.target.value)} required
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm pr-10 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
                <button type="button" onClick={() => setShowAddPw(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs" tabIndex={-1}>
                  {showAddPw ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500 font-medium">Role</label>
              <select value={addRole} onChange={e => setAddRole(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]">
                {roles.map(r => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </div>
            {addRole === 'customer' && (
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Linked Client / Supplier</label>
                <select value={addLinkedClient} onChange={e => setAddLinkedClient(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]">
                  <option value="">— Select a client —</option>
                  {clients.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex flex-col gap-3 justify-end sm:col-span-2">
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input type="checkbox" checked={addForcePwChange} onChange={e => setAddForcePwChange(e.target.checked)}
                  className="accent-[var(--color-primary)]" />
                Force password change
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input type="checkbox" checked={sendWelcome} onChange={e => setSendWelcome(e.target.checked)}
                  className="accent-[var(--color-primary)]" />
                Send welcome email
              </label>
            </div>
            <div className="sm:col-span-2">
              <button type="submit" disabled={addLoading}
                className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white text-sm font-bold px-6 py-2 rounded-lg transition-colors">
                {addLoading ? 'Creating...' : 'Create User'}
              </button>
            </div>
          </form>
        </section>

        {/* Users Table */}
        <section className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 p-6 pb-0">
            <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">All Users</h2>
            {(() => {
              const pendingCount = users.filter(u => u.subscription?.requestedUpgradeAt).length;
              return (
                <div className="flex items-center gap-3">
                  {pendingCount > 0 && (
                    <span className="text-xs font-semibold text-amber-800 bg-amber-100 border border-amber-200 px-2.5 py-1 rounded-full">
                      {pendingCount} pending Pro request{pendingCount === 1 ? '' : 's'}
                    </span>
                  )}
                  <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer select-none">
                    <input type="checkbox" checked={showPendingOnly} onChange={e => setShowPendingOnly(e.target.checked)}
                      className="accent-[var(--color-primary)]" />
                    Show pending Pro requests only
                  </label>
                </div>
              );
            })()}
          </div>
          <div className="overflow-x-auto mt-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Email</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Role</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Plan</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Linked Client</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">First Login</th>
                  <th className="px-6 py-3" />
                </tr>
              </thead>
              <tbody>
                {users
                  .filter(u => !showPendingOnly || !!u.subscription?.requestedUpgradeAt)
                  .map(u => {
                    const tier = u.subscription?.tier ?? 'standard';
                    const pending = !!u.subscription?.requestedUpgradeAt;
                    const isFlipping = flippingId === u.id;
                    return (
                      <tr key={u.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-3 font-medium text-gray-900">{u.name} {u.surname}</td>
                        <td className="px-6 py-3 text-gray-600">{u.email}</td>
                        <td className="px-6 py-3">
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                            ROLE_BADGE_CLASSES[u.role] ?? 'bg-gray-100 text-gray-600'
                          }`}>
                            {roleLabel(u.role)}
                          </span>
                        </td>
                        <td className="px-6 py-3">
                          <div className="flex items-center gap-2">
                            {tier === 'pro' ? (
                              <span className="text-xs font-bold px-2 py-0.5 rounded-full text-white bg-gradient-to-r from-amber-500 to-yellow-600">
                                PRO
                              </span>
                            ) : (
                              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                                Standard
                              </span>
                            )}
                            {pending && (
                              <span className="text-[10px] font-semibold text-amber-800 bg-amber-100 border border-amber-200 px-1.5 py-0.5 rounded-full uppercase tracking-wide">
                                Requested
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-3 text-gray-600 text-xs">
                          {u.role === 'customer' ? clientName(u.linkedClientId) : '—'}
                        </td>
                        <td className="px-6 py-3 text-gray-500 text-xs">
                          {u.firstLoginAt ? new Date(u.firstLoginAt).toLocaleDateString() : 'Never'}
                        </td>
                        <td className="px-6 py-3">
                          <div className="flex gap-3 justify-end items-center">
                            {tier === 'standard' ? (
                              <button
                                onClick={() => handleFlipTier(u, 'pro')}
                                disabled={isFlipping}
                                className="text-xs font-semibold text-amber-700 hover:text-amber-900 disabled:opacity-50">
                                {isFlipping ? '...' : pending ? 'Approve Pro' : 'Upgrade to Pro'}
                              </button>
                            ) : (
                              <button
                                onClick={() => handleFlipTier(u, 'standard')}
                                disabled={isFlipping}
                                className="text-xs font-medium text-gray-500 hover:text-gray-700 disabled:opacity-50">
                                {isFlipping ? '...' : 'Downgrade'}
                              </button>
                            )}
                            <button onClick={() => openEdit(u)}
                              className="text-xs text-blue-600 hover:text-blue-800 font-medium">Edit</button>
                            <button onClick={() => handleDelete(u)}
                              className="text-xs text-red-500 hover:text-red-700 font-medium">Delete</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      {/* Edit Modal */}
      {editUser && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-base font-bold text-gray-900 mb-5">Edit User</h2>
            <form onSubmit={handleEdit} className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-gray-500 font-medium">First Name</label>
                  <input value={editName} onChange={e => setEditName(e.target.value)} required
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-gray-500 font-medium">Surname</label>
                  <input value={editSurname} onChange={e => setEditSurname(e.target.value)} required
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Email</label>
                <input type="email" value={editEmail} onChange={e => setEditEmail(e.target.value)} required
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Role</label>
                <select value={editRole} onChange={e => setEditRole(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]">
                  {roles.map(r => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>
              {editRole === 'customer' && (
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-gray-500 font-medium">Linked Client / Supplier</label>
                  <select value={editLinkedClient} onChange={e => setEditLinkedClient(e.target.value)}
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]">
                    <option value="">— Select a client —</option>
                    {clients.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">New Password <span className="text-gray-400 font-normal">(leave blank to keep current)</span></label>
                <div className="relative">
                  <input type={showEditPw ? 'text' : 'password'} value={editPw} onChange={e => setEditPw(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm pr-10 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                    placeholder="New password..." />
                  <button type="button" onClick={() => setShowEditPw(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs" tabIndex={-1}>
                    {showEditPw ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                {editPw && (
                  <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                    <input type="checkbox" checked={sendReset} onChange={e => setSendReset(e.target.checked)} className="accent-[var(--color-primary)]" />
                    Send password reset email
                  </label>
                )}
              </div>
              <div className="flex gap-3 pt-2">
                <button type="submit" disabled={editLoading}
                  className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white text-sm font-bold px-5 py-2 rounded-lg transition-colors">
                  {editLoading ? 'Saving...' : 'Save Changes'}
                </button>
                <button type="button" onClick={() => setEditUser(null)}
                  className="text-sm text-gray-600 hover:text-gray-900 px-4 py-2 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
