import { NextRequest, NextResponse } from 'next/server';
import { get } from '@vercel/blob';
import { loadUsers } from '@/lib/userData';
import { requireLogin } from '@/lib/rolesData';

export const dynamic = 'force-dynamic';

/**
 * GET /api/account/avatar/[userId] — stream the user's avatar from the private Blob store.
 * Any logged-in user can read any other user's avatar (same trust model as the user list).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const guard = await requireLogin(req);
  if (guard instanceof NextResponse) return guard;

  const { userId } = await params;
  const users = await loadUsers();
  const user = users.find(u => u.id === userId);
  if (!user || !user.avatarKey) {
    return NextResponse.json({ error: 'No avatar' }, { status: 404 });
  }

  try {
    const result = await get(user.avatarKey, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) {
      return NextResponse.json({ error: 'Avatar not found' }, { status: 404 });
    }
    const contentType =
      result.headers.get('content-type') ??
      result.blob?.contentType ??
      'application/octet-stream';
    return new Response(result.stream, {
      headers: {
        'Content-Type': contentType,
        // Browsers re-fetch when ?t= changes anyway, so we can cache aggressively
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Read failed: ${msg}` }, { status: 500 });
  }
}
