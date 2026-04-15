'use client';

import { useAuth } from '@/lib/useAuth';
import { Role, ROLE_LABELS } from '@/lib/roles';
import Sidebar from '@/components/Sidebar';
import { Toast, ToastData } from '@/components/Toast';
import { useEffect, useState } from 'react';

interface User {
  id: string;
  name: string;
  surname: string;
  email: string;
  role: Role;
  forcePasswordChange: boolean;
  firstLoginAt: string | null;
  createdAt: string;
}

export default function AdminUsersPage() {
  const { session, loading, logout } = useAuth('super-user');
  const [users, setUsers] = useState<User[]>([]);
  const [toast, setToast] = useState<ToastData | null>(null);

  // Add user form
  const [addName, setAddName] = useState('');
  const [addSurname, setAddSurname] = useState('');
  const [addEmail, setAddEmail] = useState('');
  const [addPw, setAddPw] = useState('');
  const [addRole, setAddRole] = useState<Role>('admin');
  const [addForcePwChange, setAddForcePwChange] = useState(true);
  const [showAddPw, setShowAddPw] = useState(false);
  const [sendWelcome, setSendWelcome] = useState(true);
  const [addLoading, setAddLoading] = useState(false);

  // Edit modal
  const [editUser, setEditUser] = useState<User | null>(null);
  const [editName, setEditName] = useState('');
  const [editSurname, setEditSurname] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editRole, setEditRole] = useState<Role>('admin');
  const [editPw, setEditPw] = useState('');
  const [showEditPw, setShowEditPw] = useState(false);
  const [sendReset, setSendReset] = useState(false);
  const [editLoading, setEditLoading] = useState(false);

  const notify = (message: string, type: 'success' | 'error' = 'success') =>
    setToast({ message, type });

  async function fetchUsers() {
    const res = await fetch('/api/users', { cache: 'no-store' });
    if (res.ok) setUsers(await res.json());
  }

  useEffect(() => { if (session) fetchUsers(); }, [session]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAddLoading(true);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: addName, surname: addSurname, email: addEmail,
          password: addPw, role: addRole, forcePasswordChange: addForcePwChange,
          sendWelcome,
        }),
      });
      const data = await res.json();
      if (!res.ok) { notify(data.error || 'Failed to create user', 'error'); return; }

      if (sendWelcome) {
        await fetch(`/api/users/${data.id}/notify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plainPassword: addPw, type: 'welcome', name: `${addName} ${addSurname}`, email: addEmail }),
        });
      }
      notify(`User ${addName} ${addSurname} created${sendWelcome ? ' — welcome email sent' : ''}`);
      setAddName(''); setAddSurname(''); setAddEmail(''); setAddPw('');
      setAddRole('admin'); setAddForcePwChange(true); setSendWelcome(true);
      fetchUsers();
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
    setEditPw('');
    setShowEditPw(false);
    setSendReset(false);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editUser) return;
    setEditLoading(true);
    try {
      const body: Record<string, unknown> = {
        name: editName, surname: editSurname, email: editEmail, role: editRole,
      };
      if (editPw) body.password = editPw;

      const res = await fetch(`/api/users/${editUser.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { notify('Failed to update user', 'error'); return; }

      if (editPw && sendReset) {
        await fetch(`/api/users/${editUser.id}/notify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plainPassword: editPw, type: 'reset', name: `${editName} ${editSurname}`, email: editEmail }),
        });
      }
      notify(`User updated${editPw && sendReset ? ' — reset email sent' : ''}`);
      setEditUser(null);
      fetchUsers();
    } finally {
      setEditLoading(false);
    }
  }

  async function handleDelete(user: User) {
    if (!confirm(`Delete user ${user.name} ${user.surname}? This cannot be undone.`)) return;
    const res = await fetch(`/api/users/${user.id}`, { method: 'DELETE' });
    if (res.ok) { notify('User deleted'); fetchUsers(); }
    else notify('Failed to delete user', 'error');
  }

  if (loading || !session) return null;

  const roles: Role[] = ['super-user', 'supervisor', 'admin'];

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
              <select value={addRole} onChange={e => setAddRole(e.target.value as Role)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]">
                {roles.map(r => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-3 justify-end">
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
          <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide p-6 pb-0">All Users</h2>
          <div className="overflow-x-auto mt-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Email</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Role</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">First Login</th>
                  <th className="px-6 py-3" />
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-3 font-medium text-gray-900">{u.name} {u.surname}</td>
                    <td className="px-6 py-3 text-gray-600">{u.email}</td>
                    <td className="px-6 py-3">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                        u.role === 'super-user' ? 'bg-purple-100 text-purple-700' :
                        u.role === 'supervisor' ? 'bg-blue-100 text-blue-700' :
                        'bg-gray-100 text-gray-600'
                      }`}>
                        {ROLE_LABELS[u.role]}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-gray-500 text-xs">
                      {u.firstLoginAt ? new Date(u.firstLoginAt).toLocaleDateString() : 'Never'}
                    </td>
                    <td className="px-6 py-3">
                      <div className="flex gap-2 justify-end">
                        <button onClick={() => openEdit(u)}
                          className="text-xs text-blue-600 hover:text-blue-800 font-medium">Edit</button>
                        <button onClick={() => handleDelete(u)}
                          className="text-xs text-red-500 hover:text-red-700 font-medium">Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
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
                <select value={editRole} onChange={e => setEditRole(e.target.value as Role)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]">
                  {roles.map(r => (
                    <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                  ))}
                </select>
              </div>
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
