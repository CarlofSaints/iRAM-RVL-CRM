import { NextRequest, NextResponse } from 'next/server';
import { loadPermissions, savePermissions, loadRoles, saveRoles, requirePermission } from '@/lib/rolesData';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const guard = await requirePermission(req, 'manage_roles');
  if (guard instanceof NextResponse) return guard;

  try {
    const { key } = await params;
    const body = await req.json();
    const perms = await loadPermissions();
    const idx = perms.findIndex(p => p.key === key);
    if (idx === -1) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    if (body.name !== undefined) perms[idx].name = String(body.name).trim();
    if (body.description !== undefined) perms[idx].description = String(body.description);
    if (body.category !== undefined) perms[idx].category = String(body.category);

    await savePermissions(perms);
    return NextResponse.json(perms[idx]);
  } catch (err) {
    console.error('[PATCH /api/permissions/[key]]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const guard = await requirePermission(req, 'manage_roles');
  if (guard instanceof NextResponse) return guard;

  const { key } = await params;
  const perms = await loadPermissions();
  const perm = perms.find(p => p.key === key);
  if (!perm) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (perm.isSystem) {
    return NextResponse.json({ error: 'Cannot delete a system permission' }, { status: 400 });
  }

  // Remove this permission from all roles that reference it
  const roles = await loadRoles();
  let rolesChanged = false;
  for (const r of roles) {
    if (r.permissionKeys.includes(key)) {
      r.permissionKeys = r.permissionKeys.filter(k => k !== key);
      rolesChanged = true;
    }
  }
  if (rolesChanged) await saveRoles(roles);

  const filtered = perms.filter(p => p.key !== key);
  await savePermissions(filtered);
  return NextResponse.json({ ok: true });
}
