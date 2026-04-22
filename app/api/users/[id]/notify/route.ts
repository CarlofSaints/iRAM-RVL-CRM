import { NextRequest, NextResponse } from 'next/server';
import { loadUsers } from '@/lib/userData';
import { sendWelcomeEmail, sendPasswordResetEmail } from '@/lib/email';
import { requirePermission, loadRoles } from '@/lib/rolesData';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(req, 'manage_users');
  if (guard instanceof NextResponse) return guard;

  const { id } = await params;
  const { plainPassword, type, name: bodyName, email: bodyEmail } = await req.json();

  const user = (await loadUsers()).find(u => u.id === id);
  if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const name = (bodyName as string) || `${user.name} ${user.surname}`;
  const email = (bodyEmail as string) || user.email;

  if (!plainPassword) return NextResponse.json({ error: 'Missing password' }, { status: 400 });

  try {
    if (type === 'reset') {
      await sendPasswordResetEmail(email, name, plainPassword);
    } else {
      const roles = await loadRoles();
      const roleName = roles.find(r => r.id === user.role)?.name;
      await sendWelcomeEmail(email, name, plainPassword, roleName);
    }
  } catch (err) {
    console.error('[notify] Exception:', err);
    return NextResponse.json({ error: 'Email send failed', detail: String(err) }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
