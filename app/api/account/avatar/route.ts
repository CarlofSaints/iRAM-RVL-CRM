import { NextRequest, NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { loadUsers, saveUsers } from '@/lib/userData';
import { requireLogin } from '@/lib/rolesData';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);

/**
 * POST /api/account/avatar — upload a profile picture (multipart/form-data, field "file").
 * Stored in the project's private Vercel Blob store. Read back via the proxy
 * endpoint /api/account/avatar/[userId].
 */
export async function POST(req: NextRequest) {
  const guard = await requireLogin(req);
  if (guard instanceof NextResponse) return guard;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
  }

  if (!ALLOWED.has(file.type)) {
    return NextResponse.json({ error: 'Unsupported image type' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'Image must be 5 MB or less' }, { status: 400 });
  }

  const ext = file.type.split('/')[1].replace('jpeg', 'jpg');
  const now = new Date().toISOString();
  const key = `users/${guard.userId}/avatar-${Date.now()}.${ext}`;

  try {
    await put(key, file, {
      access: 'private',
      contentType: file.type,
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Upload failed: ${msg}` }, { status: 500 });
  }

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  if (!me) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  me.avatarKey = key;
  me.avatarUpdatedAt = now;
  await saveUsers(users);

  return NextResponse.json({ ok: true, avatarUpdatedAt: now });
}

/**
 * DELETE /api/account/avatar — clear the avatar (revert to initials).
 * Doesn't delete the underlying Blob — just removes the pointer from the user record.
 */
export async function DELETE(req: NextRequest) {
  const guard = await requireLogin(req);
  if (guard instanceof NextResponse) return guard;

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  if (!me) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  delete me.avatarKey;
  delete me.avatarUpdatedAt;
  await saveUsers(users);

  return NextResponse.json({ ok: true });
}
