import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { loadUsers, saveUsers, User } from '@/lib/userData';
import { sendWelcomeEmail } from '@/lib/email';
import { loadRoles, requireLogin, requirePermission } from '@/lib/rolesData';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireLogin(req);
  if (guard instanceof NextResponse) return guard;

  const users = (await loadUsers()).map(({ password: _p, ...u }) => u);
  return NextResponse.json(users, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'manage_users');
  if (guard instanceof NextResponse) return guard;

  const { name, surname, email, password, role, linkedClientId, assignedClientIds, forcePasswordChange, sendWelcome } = await req.json();
  if (!name || !surname || !email || !password || !role) {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
  }

  // Validate role exists
  const roles = await loadRoles();
  if (!roles.find(r => r.id === role)) {
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
  }

  const users = await loadUsers();
  if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
    return NextResponse.json({ error: 'Email already exists' }, { status: 409 });
  }

  const hashed = await bcrypt.hash(password, 10);
  const user: User = {
    id: randomUUID(),
    name,
    surname,
    email,
    password: hashed,
    role,
    linkedClientId: role === 'customer' ? linkedClientId : undefined,
    assignedClientIds: role === 'customer'
      ? undefined
      : (Array.isArray(assignedClientIds) ? assignedClientIds.filter((x: unknown) => typeof x === 'string') : []),
    forcePasswordChange: forcePasswordChange !== false,
    firstLoginAt: null,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  await saveUsers(users);

  if (sendWelcome) {
    try {
      await sendWelcomeEmail(email, `${name} ${surname}`, password);
    } catch (err) {
      console.error('[users] Welcome email failed:', err);
    }
  }

  const { password: _p, ...safe } = user;
  return NextResponse.json(safe, { status: 201 });
}
