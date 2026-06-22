import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { buildClientOmitMatcher } from '@/lib/agedStockOmit';
import { listLoads, getLoad, saveLoad, deleteLoad } from '@/lib/agedStockData';

export const dynamic = 'force-dynamic';

/**
 * POST /api/aged-stock/reapply-omissions
 * JSON body: { clientId: string }
 *
 * Re-runs the client's current omission rules against every EXISTING aged-stock
 * load, stripping rows whose site is now omitted. A load that ends up empty is
 * deleted. Returns how many rows were removed and how many loads were affected.
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'manage_clients');
  if (guard instanceof NextResponse) return guard;

  let body: { clientId?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
  if (!clientId) return NextResponse.json({ error: 'clientId is required' }, { status: 400 });

  const isOmitted = await buildClientOmitMatcher(clientId);

  let rowsRemoved = 0;
  let loadsAffected = 0;
  let loadsDeleted = 0;

  const index = await listLoads(clientId);
  for (const meta of index) {
    const full = await getLoad(clientId, meta.id);
    if (!full) continue;

    const before = full.rows.length;
    const kept = full.rows.filter(r => !isOmitted(r.siteCode));
    const removed = before - kept.length;
    if (removed === 0) continue;

    rowsRemoved += removed;
    loadsAffected++;

    if (kept.length === 0) {
      await deleteLoad(clientId, meta.id);
      loadsDeleted++;
    } else {
      full.rows = kept;
      full.rowCount = kept.length;
      await saveLoad(full);
    }
  }

  return NextResponse.json(
    { ok: true, rowsRemoved, loadsAffected, loadsDeleted },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
