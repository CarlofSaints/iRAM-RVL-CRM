import { NextRequest, NextResponse } from 'next/server';
import { loadUsers, saveUsers } from '@/lib/userData';
import { requireLogin, loadRoles } from '@/lib/rolesData';
import { sendUpgradeRequestEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

/**
 * POST /api/account/upgrade — record a Pro upgrade request and notify super-admins.
 * Idempotent — repeat clicks just refresh the requestedUpgradeAt timestamp.
 */
export async function POST(req: NextRequest) {
  const guard = await requireLogin(req);
  if (guard instanceof NextResponse) return guard;

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  if (!me) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  // No-op if already on Pro
  if (me.subscription?.tier === 'pro') {
    return NextResponse.json({ ok: true, alreadyPro: true });
  }

  const now = new Date().toISOString();
  me.subscription = {
    ...(me.subscription ?? { tier: 'standard' }),
    requestedUpgradeAt: now,
  };
  await saveUsers(users);

  // Notify all super-admins
  const roles = await loadRoles();
  const superAdminRole = roles.find(r => r.id === 'super-admin');
  const adminEmails = users
    .filter(u => u.role === (superAdminRole?.id ?? 'super-admin'))
    .map(u => u.email);

  try {
    await sendUpgradeRequestEmail(adminEmails, {
      name: `${me.name} ${me.surname}`.trim(),
      email: me.email,
      role: me.role,
    });
  } catch (err) {
    // Don't fail the request just because email failed — log and continue
    console.error('[upgrade] email failed:', err instanceof Error ? err.message : err);
  }

  return NextResponse.json({ ok: true, requestedUpgradeAt: now });
}
