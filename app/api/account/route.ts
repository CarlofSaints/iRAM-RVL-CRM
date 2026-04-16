import { NextRequest, NextResponse } from 'next/server';
import { loadUsers } from '@/lib/userData';
import { requireLogin } from '@/lib/rolesData';

export const dynamic = 'force-dynamic';

/**
 * GET /api/account — return the current user's profile (without password hash).
 */
export async function GET(req: NextRequest) {
  const guard = await requireLogin(req);
  if (guard instanceof NextResponse) return guard;

  const users = await loadUsers();
  const user = users.find(u => u.id === guard.userId);
  if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json(
    {
      id: user.id,
      name: user.name,
      surname: user.surname,
      email: user.email,
      role: user.role,
      linkedClientId: user.linkedClientId,
      avatarUpdatedAt: user.avatarUpdatedAt,
      hasAvatar: !!user.avatarKey,
      subscription: user.subscription ?? { tier: 'standard' },
      createdAt: user.createdAt,
      firstLoginAt: user.firstLoginAt,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
