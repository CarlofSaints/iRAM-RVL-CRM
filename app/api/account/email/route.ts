import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { loadUsers, saveUsers } from '@/lib/userData';
import { requireLogin } from '@/lib/rolesData';

export const dynamic = 'force-dynamic';

/**
 * POST /api/account/email — change the current user's email.
 * Requires { newEmail, currentPassword }. Verifies password before saving.
 */
export async function POST(req: NextRequest) {
  const guard = await requireLogin(req);
  if (guard instanceof NextResponse) return guard;

  const { newEmail, currentPassword } = await req.json();
  if (!newEmail || !currentPassword) {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
  }

  // Basic shape check — full RFC validation isn't worth the complexity here
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    return NextResponse.json({ error: 'Invalid email format' }, { status: 400 });
  }

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  if (!me) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const valid = await bcrypt.compare(currentPassword, me.password);
  if (!valid) return NextResponse.json({ error: 'Current password is incorrect' }, { status: 401 });

  const normalised = newEmail.trim().toLowerCase();
  if (normalised === me.email.toLowerCase()) {
    return NextResponse.json({ error: 'New email is the same as current' }, { status: 400 });
  }

  const taken = users.find(u => u.id !== me.id && u.email.toLowerCase() === normalised);
  if (taken) return NextResponse.json({ error: 'Email is already in use' }, { status: 409 });

  me.email = normalised;
  await saveUsers(users);

  return NextResponse.json({ ok: true, email: me.email });
}
