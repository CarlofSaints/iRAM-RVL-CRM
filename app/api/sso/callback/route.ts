import { NextRequest, NextResponse } from 'next/server';
import { verifySSOToken } from '@/lib/sso';
import { loadUsers, saveUsers, type User } from '@/lib/userData';
import { resolvePermissionsForRole, loadRoles } from '@/lib/rolesData';
import { loadPermissions } from '@/lib/rolesData';

export async function POST(req: NextRequest) {
  const { token } = (await req.json()) as { token?: string };
  if (!token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 400 });
  }

  const secret = process.env.IRAM_SSO_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'SSO not configured' }, { status: 500 });
  }

  const payload = verifySSOToken(token, secret);
  if (!payload) {
    return NextResponse.json({ error: 'Invalid or expired SSO token' }, { status: 401 });
  }

  // Check module access
  if (!payload.modules.includes('rvl')) {
    return NextResponse.json(
      { error: 'You do not have access to iRam Flow' },
      { status: 403 },
    );
  }

  const users = await loadUsers();

  // Find existing user by email (case-insensitive)
  let user = users.find(u => u.email.toLowerCase() === payload.email.toLowerCase());

  if (!user) {
    // Create new user with default role 'rep'
    user = {
      id: crypto.randomUUID(),
      name: payload.name,
      surname: payload.surname,
      email: payload.email,
      password: '', // No password — SSO-only user
      role: 'rep',
      forcePasswordChange: false,
      firstLoginAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    } satisfies User;

    users.push(user);
    await saveUsers(users);
  }

  // Resolve role name + permissions
  const roles = await loadRoles();
  const role = roles.find(r => r.id === user.role);
  const permissions = await resolvePermissionsForRole(user.role);
  const allPermissions = await loadPermissions();
  const proPermissions = allPermissions.filter(p => p.proOnly).map(p => p.key);

  // Return session matching rvl_session format
  return NextResponse.json({
    id: user.id,
    name: user.name,
    surname: user.surname,
    email: user.email,
    role: user.role,
    roleName: role?.name ?? user.role,
    permissions,
    proPermissions,
    linkedClientId: user.linkedClientId,
    assignedClientIds: user.assignedClientIds ?? [],
    avatarUpdatedAt: user.avatarUpdatedAt,
    subscriptionTier: user.subscription?.tier ?? 'standard',
  });
}
