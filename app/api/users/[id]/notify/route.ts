import { NextRequest, NextResponse } from 'next/server';
import { loadUsers } from '@/lib/userData';
import { sendWelcomeEmail, sendPasswordResetEmail } from '@/lib/email';
import { requirePermission } from '@/lib/rolesData';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(req, 'manage_users');
  if (guard instanceof NextResponse) return guard;

  const { id } = await params;
  const { plainPassword, type, name: bodyName, email: bodyEmail } = await req.json();

  let name = bodyName as string | undefined;
  let email = bodyEmail as string | undefined;

  if (!name || !email) {
    const user = (await loadUsers()).find(u => u.id === id);
    if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    name = `${user.name} ${user.surname}`;
    email = user.email;
  }

  if (!plainPassword) return NextResponse.json({ error: 'Missing password' }, { status: 400 });

  try {
    if (type === 'reset') {
      await sendPasswordResetEmail(email as string, name as string, plainPassword);
    } else {
      await sendWelcomeEmail(email as string, name as string, plainPassword);
    }
  } catch (err) {
    console.error('[notify] Exception:', err);
    return NextResponse.json({ error: 'Email send failed', detail: String(err) }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
