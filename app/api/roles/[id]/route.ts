import { NextRequest, NextResponse } from 'next/server';
import { loadRoles, saveRoles, loadPermissions, requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(req, 'manage_roles');
  if (guard instanceof NextResponse) return guard;

  try {
    const { id } = await params;
    const body = await req.json();

    const roles = await loadRoles();
    const idx = roles.findIndex(r => r.id === id);
    if (idx === -1) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    if (body.name !== undefined) roles[idx].name = String(body.name).trim();
    if (body.description !== undefined) roles[idx].description = String(body.description);
    if (Array.isArray(body.permissionKeys)) {
      const perms = await loadPermissions();
      const permSet = new Set(perms.map(p => p.key));
      roles[idx].permissionKeys = body.permissionKeys
        .filter((k: unknown) => typeof k === 'string' && permSet.has(k));
    }

    await saveRoles(roles);
    return NextResponse.json(roles[idx]);
  } catch (err) {
    console.error('[PATCH /api/roles/[id]]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(req, 'manage_roles');
  if (guard instanceof NextResponse) return guard;

  const { id } = await params;
  const roles = await loadRoles();
  const role = roles.find(r => r.id === id);
  if (!role) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (role.isSystem) {
    return NextResponse.json({ error: 'Cannot delete a system role' }, { status: 400 });
  }

  // Safety: refuse deletion if any users still reference this role
  const users = await loadUsers();
  const inUse = users.filter(u => u.role === id);
  if (inUse.length > 0) {
    return NextResponse.json({
      error: `Cannot delete — ${inUse.length} user(s) still assigned to this role. Reassign them first.`,
    }, { status: 400 });
  }

  const filtered = roles.filter(r => r.id !== id);
  await saveRoles(filtered);
  return NextResponse.json({ ok: true });
}
