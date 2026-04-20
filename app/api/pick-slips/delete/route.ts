import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { bulkRemoveSlips, getPickSlipRun } from '@/lib/pickSlipData';
import { deleteFile } from '@/lib/graphIram';

export const dynamic = 'force-dynamic';

/**
 * POST /api/pick-slips/delete — Bulk delete pick slips.
 *
 * Body: { items: Array<{ clientId, loadId, slipId }> }
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'manage_pick_slips');
  if (guard instanceof NextResponse) return guard;

  let body: { items?: Array<{ clientId?: string; loadId?: string; slipId?: string }> };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const items = (body.items ?? []).filter(
    (i): i is { clientId: string; loadId: string; slipId: string } =>
      typeof i.clientId === 'string' && typeof i.loadId === 'string' && typeof i.slipId === 'string'
  );

  if (items.length === 0) {
    return NextResponse.json({ error: 'No valid items provided' }, { status: 400 });
  }

  // Try to delete SP files for each slip before removing from the index
  const spErrors: string[] = [];
  for (const item of items) {
    try {
      const run = await getPickSlipRun(item.clientId, item.loadId);
      if (!run) continue;
      const slip = run.slips.find(s => s.id === item.slipId);
      if (slip?.spDriveId && slip?.spFileId) {
        await deleteFile(slip.spDriveId, slip.spFileId);
      }
    } catch (err) {
      spErrors.push(`${item.slipId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const deleted = await bulkRemoveSlips(items);

  return NextResponse.json(
    { deleted, ...(spErrors.length > 0 ? { spErrors } : {}) },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
