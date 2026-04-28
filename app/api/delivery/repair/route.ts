import { NextRequest, NextResponse } from 'next/server';
import { loadControl } from '@/lib/controlData';
import { listLoads } from '@/lib/agedStockData';
import { findSlipByDeliveryToken, updateSlipInRun } from '@/lib/pickSlipData';

export const dynamic = 'force-dynamic';

/**
 * POST /api/delivery/repair
 *
 * One-time repair endpoint: restores a slip's status to 'in-transit'
 * when it was accidentally reset by the old Send DN bug.
 *
 * Body: { token: string, secret: string }
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { token, secret } = body as { token: string; secret: string };

  if (secret !== 'rvl-repair-2026') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!token) {
    return NextResponse.json({ error: 'token is required' }, { status: 400 });
  }

  const clients = await loadControl<{ id: string }>('clients');
  const clientIds = clients.map(c => c.id);
  const result = await findSlipByDeliveryToken(token, clientIds, listLoads);

  if (!result) {
    return NextResponse.json({ error: 'Slip not found for this token' }, { status: 404 });
  }

  const { slip, clientId, loadId } = result;

  // Only repair if status was incorrectly reset
  if (slip.status === 'in-transit' || slip.status === 'partial-release' || slip.status === 'delivered') {
    return NextResponse.json({ message: `No repair needed — status is already "${slip.status}"` });
  }

  // Must have release data to confirm it was actually released
  if (!slip.releasedAt || !slip.releaseRepId) {
    return NextResponse.json({ error: `Slip has no release data — cannot safely restore. Current status: ${slip.status}` }, { status: 400 });
  }

  await updateSlipInRun(clientId, loadId, slip.id, {
    status: 'in-transit',
  });

  return NextResponse.json({
    ok: true,
    slipId: slip.id,
    previousStatus: slip.status,
    newStatus: 'in-transit',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
