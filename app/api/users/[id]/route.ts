import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { loadUsers, saveUsers } from '@/lib/userData';
import { loadRoles, requirePermission } from '@/lib/rolesData';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const guard = await requirePermission(req, 'manage_users');
    if (guard instanceof NextResponse) return guard;

    const { id } = await params;
    const body = await req.json();
    const users = await loadUsers();
    const idx = users.findIndex(u => u.id === id);
    if (idx === -1) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    if (body.name !== undefined) users[idx].name = body.name;
    if (body.surname !== undefined) users[idx].surname = body.surname;
    if (body.email !== undefined) users[idx].email = body.email;
    if (body.role !== undefined) {
      const roles = await loadRoles();
      if (!roles.find(r => r.id === body.role)) {
        return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
      }
      users[idx].role = body.role;
      // Clear linkedClientId if user is no longer a customer
      if (body.role !== 'customer') users[idx].linkedClientId = undefined;
    }
    if (body.linkedClientId !== undefined) {
      // Only apply if the user is (or is being set to) a customer
      const finalRole = body.role ?? users[idx].role;
      if (finalRole === 'customer') users[idx].linkedClientId = body.linkedClientId || undefined;
    }
    if (body.password) {
      users[idx].password = await bcrypt.hash(body.password, 10);
      users[idx].forcePasswordChange = body.forcePasswordChange !== false;
    }
    await saveUsers(users);

    const { password: _p, ...safe } = users[idx];
    return NextResponse.json(safe);
  } catch (err) {
    console.error('[PATCH /api/users/[id]]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(req, 'manage_users');
  if (guard instanceof NextResponse) return guard;

  const { id } = await params;
  const users = await loadUsers();
  const filtered = users.filter(u => u.id !== id);
  if (filtered.length === users.length) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  await saveUsers(filtered);
  return NextResponse.json({ ok: true });
}
