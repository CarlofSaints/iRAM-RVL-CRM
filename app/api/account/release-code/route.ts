import { NextRequest, NextResponse } from 'next/server';
import { requireLogin } from '@/lib/rolesData';
import { loadUsers, saveUsers } from '@/lib/userData';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

/**
 * PATCH /api/account/release-code
 * Allow the logged-in user to set or change their own 4-char release code.
 */
export async function PATCH(req: NextRequest) {
  const guard = await requireLogin(req);
  if (guard instanceof NextResponse) return guard;

  const body = await req.json();
  const { releaseCode } = body as { releaseCode: string };

  // Validate: 4 alphanumeric chars
  const cleaned = (releaseCode ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length !== 4) {
    return NextResponse.json(
      { error: 'Release code must be exactly 4 alphanumeric characters' },
      { status: 400 },
    );
  }

  const users = await loadUsers();
  const idx = users.findIndex(u => u.id === guard.userId);
  if (idx === -1) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const hadCode = !!users[idx].releaseCode;
  users[idx].releaseCode = cleaned;
  await saveUsers(users);

  await logAudit({
    action: 'release_code_changed',
    userId: guard.userId,
    userName: `${users[idx].name} ${users[idx].surname}`,
    detail: hadCode ? 'Release code updated' : 'Release code set for first time',
  });

  return NextResponse.json(
    { ok: true, releaseCode: cleaned },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
