import { NextRequest, NextResponse } from 'next/server';
import { loadRoles, saveRoles, loadPermissions, requireLogin, requirePermission } from '@/lib/rolesData';
import { Role } from '@/lib/roles';

export const dynamic = 'force-dynamic';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

export async function GET(req: NextRequest) {
  // Any logged-in user can read roles (needed to display role dropdowns etc.)
  const guard = await requireLogin(req);
  if (guard instanceof NextResponse) return guard;

  const roles = await loadRoles();
  return NextResponse.json(roles, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'manage_roles');
  if (guard instanceof NextResponse) return guard;

  const { name, description, permissionKeys } = await req.json();
  if (!name || typeof name !== 'string') {
    return NextResponse.json({ error: 'Missing role name' }, { status: 400 });
  }

  const roles = await loadRoles();

  // Generate a unique ID from the name (slugified)
  const baseId = slugify(name) || `role-${Date.now()}`;
  let id = baseId;
  let n = 2;
  while (roles.find(r => r.id === id)) {
    id = `${baseId}-${n}`;
    n++;
  }

  // Validate permission keys exist
  const perms = await loadPermissions();
  const permSet = new Set(perms.map(p => p.key));
  const filteredKeys = Array.isArray(permissionKeys)
    ? permissionKeys.filter((k: string) => typeof k === 'string' && permSet.has(k))
    : [];

  const role: Role = {
    id,
    name: name.trim(),
    description: (description ?? '').toString(),
    permissionKeys: filteredKeys,
    isSystem: false,
    createdAt: new Date().toISOString(),
  };

  roles.push(role);
  await saveRoles(roles);
  return NextResponse.json(role, { status: 201 });
}
