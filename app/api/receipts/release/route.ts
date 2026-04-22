import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { loadControl } from '@/lib/controlData';
import { updateSlipInRun, getPickSlipRun, type ReceiptBox } from '@/lib/pickSlipData';

export const dynamic = 'force-dynamic';

/**
 * POST /api/receipts/release
 *
 * Release stock from warehouse for transit back to client/vendor.
 * Validates the rep's release code — match → in-transit, mismatch → failed-release.
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'receipt_stock');
  if (guard instanceof NextResponse) return guard;

  const body = await req.json();
  const {
    slipId,
    clientId,
    loadId,
    releaseRepId,
    releaseRepName,
    releaseBoxes,
    releaseCode,
  } = body as {
    slipId: string;
    clientId: string;
    loadId: string;
    releaseRepId: string;
    releaseRepName: string;
    releaseBoxes: ReceiptBox[];
    releaseCode: string;
  };

  if (!slipId || !clientId || !loadId) {
    return NextResponse.json({ error: 'slipId, clientId, and loadId are required' }, { status: 400 });
  }
  if (!releaseRepId) {
    return NextResponse.json({ error: 'releaseRepId is required' }, { status: 400 });
  }
  if (!releaseCode) {
    return NextResponse.json({ error: 'releaseCode is required' }, { status: 400 });
  }

  // Verify the slip exists and is in a releasable status
  const run = await getPickSlipRun(clientId, loadId);
  if (!run) {
    return NextResponse.json({ error: 'Pick slip run not found' }, { status: 404 });
  }
  const slip = run.slips.find(s => s.id === slipId);
  if (!slip) {
    return NextResponse.json({ error: 'Pick slip not found' }, { status: 404 });
  }
  if (slip.status !== 'receipted' && slip.status !== 'failed-release') {
    return NextResponse.json({ error: `Cannot release a slip with status "${slip.status}"` }, { status: 400 });
  }

  // Look up the rep's stored release code
  const reps = await loadControl<{ id: string; releaseCode?: string }>('reps');
  const rep = reps.find(r => r.id === releaseRepId);
  if (!rep) {
    return NextResponse.json({ error: 'Rep not found' }, { status: 404 });
  }
  if (!rep.releaseCode) {
    return NextResponse.json({ error: 'This rep does not have a release code configured' }, { status: 400 });
  }

  // Resolve user name for audit
  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  const userName = me ? `${me.name} ${me.surname}` : guard.userId;

  // Compare release codes (case-insensitive)
  const codeMatch = releaseCode.toUpperCase().trim() === rep.releaseCode.toUpperCase().trim();

  if (codeMatch) {
    // Success — set to in-transit
    const updated = await updateSlipInRun(clientId, loadId, slipId, {
      status: 'in-transit',
      releaseRepId,
      releaseRepName,
      releaseBoxes: releaseBoxes ?? [],
      releasedAt: new Date().toISOString(),
      releasedBy: guard.userId,
      releasedByName: userName,
    });

    return NextResponse.json(
      { ok: true, status: 'in-transit', slip: updated },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } else {
    // Mismatch — set to failed-release
    const updated = await updateSlipInRun(clientId, loadId, slipId, {
      status: 'failed-release',
      releaseRepId,
      releaseRepName,
      releaseBoxes: releaseBoxes ?? [],
    });

    return NextResponse.json(
      { ok: false, status: 'failed-release', error: 'Release code does not match', slip: updated },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
