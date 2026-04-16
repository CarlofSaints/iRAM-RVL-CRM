import { NextRequest, NextResponse } from 'next/server';
import { loadPermissions, savePermissions, requireLogin, requirePermission } from '@/lib/rolesData';
import { PermissionDef } from '@/lib/roles';

export const dynamic = 'force-dynamic';

function normaliseKey(key: string): string {
  return key.toLowerCase().trim().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_');
}

export async function GET(req: NextRequest) {
  const guard = await requireLogin(req);
  if (guard instanceof NextResponse) return guard;

  const perms = await loadPermissions();
  return NextResponse.json(perms, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'manage_roles');
  if (guard instanceof NextResponse) return guard;

  const { key, name, description, category } = await req.json();
  if (!key || typeof key !== 'string') {
    return NextResponse.json({ error: 'Missing key' }, { status: 400 });
  }
  if (!name || typeof name !== 'string') {
    return NextResponse.json({ error: 'Missing name' }, { status: 400 });
  }

  const normalised = normaliseKey(key);
  if (!normalised) {
    return NextResponse.json({ error: 'Invalid key' }, { status: 400 });
  }

  const perms = await loadPermissions();
  if (perms.find(p => p.key === normalised)) {
    return NextResponse.json({ error: 'Permission key already exists' }, { status: 409 });
  }

  const perm: PermissionDef = {
    key: normalised,
    name: name.trim(),
    description: (description ?? '').toString(),
    category: (category ?? 'Custom').toString(),
    isSystem: false,
    createdAt: new Date().toISOString(),
  };

  perms.push(perm);
  await savePermissions(perms);
  return NextResponse.json(perm, { status: 201 });
}
