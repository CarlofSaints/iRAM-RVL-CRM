'use client';

import { useAuth, authFetch } from '@/lib/useAuth';
import Sidebar from '@/components/Sidebar';
import { Toast, ToastData } from '@/components/Toast';
import { useEffect, useMemo, useState } from 'react';
import { Role, PermissionDef } from '@/lib/roles';

type Tab = 'roles' | 'permissions';

export default function RolesAdminPage() {
  const { session, loading, logout } = useAuth('manage_roles');

  const [tab, setTab] = useState<Tab>('roles');
  const [roles, setRoles] = useState<Role[]>([]);
  const [perms, setPerms] = useState<PermissionDef[]>([]);
  const [toast, setToast] = useState<ToastData | null>(null);

  // Role modal
  const [roleModal, setRoleModal] = useState<{ mode: 'create' | 'edit'; role?: Role } | null>(null);
  const [roleName, setRoleName] = useState('');
  const [roleDesc, setRoleDesc] = useState('');
  const [rolePerms, setRolePerms] = useState<Set<string>>(new Set());
  const [roleSaving, setRoleSaving] = useState(false);

  // Permission modal
  const [permModal, setPermModal] = useState<{ mode: 'create' | 'edit'; perm?: PermissionDef } | null>(null);
  const [permKey, setPermKey] = useState('');
  const [permName, setPermName] = useState('');
  const [permDesc, setPermDesc] = useState('');
  const [permCategory, setPermCategory] = useState('Custom');
  const [permSaving, setPermSaving] = useState(false);

  const notify = (message: string, type: 'success' | 'error' = 'success') => setToast({ message, type });

  async function refresh() {
    const [rRes, pRes] = await Promise.all([
      authFetch('/api/roles', { cache: 'no-store' }),
      authFetch('/api/permissions', { cache: 'no-store' }),
    ]);
    if (rRes.ok) setRoles(await rRes.json());
    if (pRes.ok) setPerms(await pRes.json());
  }

  useEffect(() => { if (session) refresh(); }, [session]);

  // Group permissions by category for the role modal checkbox grid
  const permsByCategory = useMemo(() => {
    const groups: Record<string, PermissionDef[]> = {};
    for (const p of perms) {
      (groups[p.category] ??= []).push(p);
    }
    return groups;
  }, [perms]);

  // === Role actions ===
  function openCreateRole() {
    setRoleName('');
    setRoleDesc('');
    setRolePerms(new Set());
    setRoleModal({ mode: 'create' });
  }

  function openEditRole(role: Role) {
    setRoleName(role.name);
    setRoleDesc(role.description);
    setRolePerms(new Set(role.permissionKeys));
    setRoleModal({ mode: 'edit', role });
  }

  function togglePerm(key: string) {
    setRolePerms(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function saveRole(e: React.FormEvent) {
    e.preventDefault();
    if (!roleModal) return;
    setRoleSaving(true);
    try {
      const body = {
        name: roleName,
        description: roleDesc,
        permissionKeys: Array.from(rolePerms),
      };
      const url = roleModal.mode === 'create' ? '/api/roles' : `/api/roles/${roleModal.role!.id}`;
      const method = roleModal.mode === 'create' ? 'POST' : 'PATCH';
      const res = await authFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json();
        notify(data.error || 'Failed to save role', 'error');
        return;
      }
      notify(roleModal.mode === 'create' ? 'Role created' : 'Role updated');
      setRoleModal(null);
      refresh();
    } finally {
      setRoleSaving(false);
    }
  }

  async function deleteRole(role: Role) {
    if (role.isSystem) return;
    if (!confirm(`Delete role "${role.name}"? This cannot be undone.`)) return;
    const res = await authFetch(`/api/roles/${role.id}`, { method: 'DELETE' });
    if (res.ok) { notify('Role deleted'); refresh(); }
    else {
      const data = await res.json();
      notify(data.error || 'Failed to delete role', 'error');
    }
  }

  // === Permission actions ===
  function openCreatePerm() {
    setPermKey('');
    setPermName('');
    setPermDesc('');
    setPermCategory('Custom');
    setPermModal({ mode: 'create' });
  }

  function openEditPerm(perm: PermissionDef) {
    setPermKey(perm.key);
    setPermName(perm.name);
    setPermDesc(perm.description);
    setPermCategory(perm.category);
    setPermModal({ mode: 'edit', perm });
  }

  async function savePerm(e: React.FormEvent) {
    e.preventDefault();
    if (!permModal) return;
    setPermSaving(true);
    try {
      if (permModal.mode === 'create') {
        const res = await authFetch('/api/permissions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: permKey, name: permName, description: permDesc, category: permCategory }),
        });
        if (!res.ok) {
          const data = await res.json();
          notify(data.error || 'Failed to create permission', 'error');
          return;
        }
        notify('Permission created — remember to wire it in code');
      } else {
        const res = await authFetch(`/api/permissions/${permModal.perm!.key}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: permName, description: permDesc, category: permCategory }),
        });
        if (!res.ok) {
          const data = await res.json();
          notify(data.error || 'Failed to update permission', 'error');
          return;
        }
        notify('Permission updated');
      }
      setPermModal(null);
      refresh();
    } finally {
      setPermSaving(false);
    }
  }

  async function deletePerm(perm: PermissionDef) {
    if (perm.isSystem) return;
    if (!confirm(`Delete permission "${perm.name}"? It will also be removed from any roles that reference it.`)) return;
    const res = await authFetch(`/api/permissions/${perm.key}`, { method: 'DELETE' });
    if (res.ok) { notify('Permission deleted'); refresh(); }
    else {
      const data = await res.json();
      notify(data.error || 'Failed to delete permission', 'error');
    }
  }

  if (loading || !session) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      <Sidebar session={session} onLogout={logout} />
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}

      <main className="ml-64 px-8 py-8 flex flex-col gap-6">
        <div className="bg-white rounded-xl shadow-sm border-l-4 border-[var(--color-primary)] px-6 py-4">
          <h1 className="text-xl font-bold text-gray-900">Roles & Permissions</h1>
          <p className="text-sm text-gray-500 mt-0.5">Manage who can do what in the RVL system</p>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 border-b border-gray-200">
          <button
            onClick={() => setTab('roles')}
            className={`px-5 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
              tab === 'roles'
                ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Roles ({roles.length})
          </button>
          <button
            onClick={() => setTab('permissions')}
            className={`px-5 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
              tab === 'permissions'
                ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Permissions ({perms.length})
          </button>
        </div>

        {tab === 'roles' && (
          <section className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="flex items-center justify-between p-6 pb-4">
              <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">All Roles</h2>
              <button onClick={openCreateRole}
                className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white text-sm font-bold px-4 py-2 rounded-lg transition-colors">
                + New Role
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                    <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Description</th>
                    <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide"># Permissions</th>
                    <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Type</th>
                    <th className="px-6 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {roles.map(r => (
                    <tr key={r.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-3 font-medium text-gray-900">{r.name}</td>
                      <td className="px-6 py-3 text-gray-600 text-xs">{r.description}</td>
                      <td className="px-6 py-3 text-gray-700">{r.permissionKeys.length}</td>
                      <td className="px-6 py-3">
                        {r.isSystem
                          ? <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">System</span>
                          : <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">Custom</span>}
                      </td>
                      <td className="px-6 py-3">
                        <div className="flex gap-2 justify-end">
                          <button onClick={() => openEditRole(r)} className="text-xs text-blue-600 hover:text-blue-800 font-medium">Edit</button>
                          <button onClick={() => deleteRole(r)} disabled={r.isSystem}
                            className="text-xs text-red-500 hover:text-red-700 font-medium disabled:text-gray-300 disabled:cursor-not-allowed">
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === 'permissions' && (
          <section className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="flex items-center justify-between p-6 pb-4">
              <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">All Permissions</h2>
              <button onClick={openCreatePerm}
                className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white text-sm font-bold px-4 py-2 rounded-lg transition-colors">
                + New Permission
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Key</th>
                    <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                    <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Category</th>
                    <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Type</th>
                    <th className="px-6 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {perms.map(p => (
                    <tr key={p.key} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-3 font-mono text-xs text-gray-700">{p.key}</td>
                      <td className="px-6 py-3 font-medium text-gray-900">{p.name}</td>
                      <td className="px-6 py-3 text-gray-600">{p.category}</td>
                      <td className="px-6 py-3">
                        {p.isSystem
                          ? <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">System</span>
                          : <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">Custom</span>}
                      </td>
                      <td className="px-6 py-3">
                        <div className="flex gap-2 justify-end">
                          <button onClick={() => openEditPerm(p)} className="text-xs text-blue-600 hover:text-blue-800 font-medium">Edit</button>
                          <button onClick={() => deletePerm(p)} disabled={p.isSystem}
                            className="text-xs text-red-500 hover:text-red-700 font-medium disabled:text-gray-300 disabled:cursor-not-allowed">
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>

      {/* Role Modal */}
      {roleModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6">
            <h2 className="text-base font-bold text-gray-900 mb-5">
              {roleModal.mode === 'create' ? 'Create Role' : `Edit Role — ${roleModal.role?.name}`}
            </h2>
            <form onSubmit={saveRole} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Name</label>
                <input value={roleName} onChange={e => setRoleName(e.target.value)} required
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Description</label>
                <textarea value={roleDesc} onChange={e => setRoleDesc(e.target.value)} rows={2}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-xs text-gray-500 font-medium">Permissions</label>
                <div className="border border-gray-200 rounded-lg p-3 max-h-80 overflow-y-auto flex flex-col gap-4">
                  {Object.entries(permsByCategory).map(([cat, list]) => (
                    <div key={cat}>
                      <div className="text-xs font-bold text-gray-700 uppercase tracking-wide mb-2">{cat}</div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                        {list.map(p => (
                          <label key={p.key} className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer hover:bg-gray-50 rounded px-2 py-1">
                            <input type="checkbox" checked={rolePerms.has(p.key)} onChange={() => togglePerm(p.key)}
                              className="accent-[var(--color-primary)] mt-0.5" />
                            <div className="flex flex-col">
                              <span className="font-medium">{p.name}</span>
                              <span className="text-xs text-gray-400 font-mono">{p.key}</span>
                            </div>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex gap-3 pt-2">
                <button type="submit" disabled={roleSaving}
                  className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white text-sm font-bold px-5 py-2 rounded-lg transition-colors">
                  {roleSaving ? 'Saving...' : 'Save'}
                </button>
                <button type="button" onClick={() => setRoleModal(null)}
                  className="text-sm text-gray-600 hover:text-gray-900 px-4 py-2 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Permission Modal */}
      {permModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-base font-bold text-gray-900 mb-5">
              {permModal.mode === 'create' ? 'Create Permission' : `Edit Permission — ${permModal.perm?.key}`}
            </h2>

            {permModal.mode === 'create' && (
              <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-lg px-3 py-2 mb-4">
                <strong>Heads up:</strong> New permission keys must be referenced in code (e.g. <code className="font-mono">useAuth(&apos;your_key&apos;)</code> or <code className="font-mono">requirePermission</code>) to actually gate anything. Creating a key here on its own does nothing.
              </div>
            )}

            <form onSubmit={savePerm} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Key <span className="text-gray-400">(lowercase, underscores — cannot change after create)</span></label>
                <input value={permKey} onChange={e => setPermKey(e.target.value)}
                  required disabled={permModal.mode === 'edit'}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono disabled:bg-gray-50 disabled:text-gray-500 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                  placeholder="e.g. export_reports" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Display Name</label>
                <input value={permName} onChange={e => setPermName(e.target.value)} required
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                  placeholder="e.g. Export Reports" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Description</label>
                <input value={permDesc} onChange={e => setPermDesc(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500 font-medium">Category</label>
                <input value={permCategory} onChange={e => setPermCategory(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                  placeholder="e.g. Dashboard, Admin, Custom" />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="submit" disabled={permSaving}
                  className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] disabled:opacity-50 text-white text-sm font-bold px-5 py-2 rounded-lg transition-colors">
                  {permSaving ? 'Saving...' : 'Save'}
                </button>
                <button type="button" onClick={() => setPermModal(null)}
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
