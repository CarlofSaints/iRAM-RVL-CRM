import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { loadUsers, saveUsers } from '@/lib/userData';

export async function POST(req: NextRequest) {
  const { userId, currentPassword, newPassword } = await req.json();
  if (!userId || !currentPassword || !newPassword) {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
  }

  if (newPassword.length < 6) {
    return NextResponse.json({ error: 'Password must be at least 6 characters' }, { status: 400 });
  }

  const users = await loadUsers();
  const user = users.find(u => u.id === userId);
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const valid = await bcrypt.compare(currentPassword, user.password);
  if (!valid) {
    return NextResponse.json({ error: 'Current password is incorrect' }, { status: 401 });
  }

  user.password = await bcrypt.hash(newPassword, 10);
  user.forcePasswordChange = false;
  await saveUsers(users);

  return NextResponse.json({ ok: true });
}
