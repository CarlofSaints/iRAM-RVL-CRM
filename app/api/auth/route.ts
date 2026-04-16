import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { loadUsers, saveUsers } from '@/lib/userData';
import { loadRoles, resolvePermissionsForRole } from '@/lib/rolesData';

export async function POST(req: NextRequest) {
  const { email, password } = await req.json();
  if (!email || !password) {
    return NextResponse.json({ error: 'Missing credentials' }, { status: 400 });
  }

  const users = await loadUsers();
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  if (!user.firstLoginAt) {
    user.firstLoginAt = new Date().toISOString();
    await saveUsers(users);
  }

  // Resolve role → permissions + human-readable name
  const roles = await loadRoles();
  const role = roles.find(r => r.id === user.role);
  const permissions = await resolvePermissionsForRole(user.role);

  return NextResponse.json({
    id: user.id,
    name: user.name,
    surname: user.surname,
    email: user.email,
    role: user.role,
    roleName: role?.name ?? user.role,
    permissions,
    linkedClientId: user.linkedClientId,
    avatarUpdatedAt: user.avatarUpdatedAt,
    subscriptionTier: user.subscription?.tier ?? 'standard',
    forcePasswordChange: user.forcePasswordChange,
  });
}
