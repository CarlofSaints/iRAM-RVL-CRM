import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { loadUsers, saveUsers } from '@/lib/userData';
import { sendPasswordResetEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < 10; i++) {
    pw += chars[Math.floor(Math.random() * chars.length)];
  }
  return pw;
}

export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();
    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    }

    const users = await loadUsers();
    const idx = users.findIndex(u => u.email.toLowerCase() === email.toLowerCase().trim());

    // Always return success to prevent email enumeration
    if (idx === -1) {
      return NextResponse.json({ ok: true });
    }

    const user = users[idx];
    const tempPassword = generateTempPassword();

    users[idx].password = await bcrypt.hash(tempPassword, 10);
    users[idx].forcePasswordChange = true;
    await saveUsers(users);

    await sendPasswordResetEmail(
      user.email,
      `${user.name} ${user.surname}`,
      tempPassword,
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[forgot-password] Error:', err);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
