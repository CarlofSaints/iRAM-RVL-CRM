import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { deleteSwapOuts } from '@/lib/swapOutData';

export const dynamic = 'force-dynamic';

/**
 * POST /api/swap-outs/bulk-delete — delete the selected swap-outs in one pass.
 *
 * Body: { ids: string[] }
 *
 * Gated on `manage_pick_slips`, the same permission the single-record DELETE
 * uses — no new permission key, so this needs no re-seed. One read + one write
 * for the whole batch (see deleteSwapOuts).
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'manage_pick_slips');
  if (guard instanceof NextResponse) return guard;

  const body = await req.json().catch(() => null);
  const ids: string[] = Array.isArray(body?.ids)
    ? body.ids.map((v: unknown) => String(v ?? '').trim()).filter(Boolean)
    : [];

  if (ids.length === 0) {
    return NextResponse.json({ error: 'No swap-outs selected' }, { status: 400 });
  }

  let deleted: string[];
  try {
    deleted = await deleteSwapOuts(ids);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Delete failed: ${msg}` }, { status: 500 });
  }

  // Say when fewer went than were asked for — someone else may have deleted
  // them, or the list on screen is stale.
  const missing = ids.filter((id) => !deleted.includes(id));
  return NextResponse.json({
    deleted: deleted.length,
    requested: ids.length,
    missing,
  });
}
