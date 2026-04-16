import { NextRequest, NextResponse } from 'next/server';
import { get } from '@vercel/blob';
import { loadUsers } from '@/lib/userData';

export const dynamic = 'force-dynamic';

/**
 * GET /api/account/avatar/[userId] — stream the user's avatar from the private Blob store.
 *
 * No auth header required: <img src=...> tags can't send custom headers, so gating this
 * with requireLogin() would make every avatar render as a broken image. Access still
 * requires knowing the user ID. Same trust model as GitHub/Slack avatars.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
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
