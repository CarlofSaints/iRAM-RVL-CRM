import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { loadControl } from '@/lib/controlData';
import { updateSlipInRun, getPickSlipRun, type ReceiptBox } from '@/lib/pickSlipData';
import { logAudit } from '@/lib/auditLog';

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
    managerOverrideCode,
    managerOverrideRepId,
  } = body as {
    slipId: string;
    clientId: string;
    loadId: string;
    releaseRepId: string;
    releaseRepName: string;
    releaseBoxes: ReceiptBox[];
    releaseCode: string;
    managerOverrideCode?: string;
    managerOverrideRepId?: string;
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

  // Load users first — needed for rep lookup AND audit
  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);

  // Look up the rep's stored release code — check both control reps AND users
  const reps = await loadControl<{ id: string; releaseCode?: string }>('reps');
  const rep = reps.find(r => r.id === releaseRepId);
  const repUser = users.find(u => u.id === releaseRepId);
  const storedCode = rep?.releaseCode || repUser?.releaseCode;
  if (!rep && !repUser) {
    return NextResponse.json({ error: 'Rep/user not found' }, { status: 404 });
  }
  if (!storedCode) {
    return NextResponse.json({ error: 'This rep/user does not have a release code configured' }, { status: 400 });
  }
  const userName = me ? `${me.name} ${me.surname}` : guard.userId;

  // Compare release codes (case-insensitive)
  const codeMatch = releaseCode.toUpperCase().trim() === storedCode.toUpperCase().trim();

  if (codeMatch) {
    // Check if this is a manager-authorized partial release
    const isPartial = !!managerOverrideCode;
    let managerValid = true;

    if (isPartial && managerOverrideRepId) {
      // Validate manager's release code
      const manager = users.find(u => u.id === managerOverrideRepId);
      if (!manager || !manager.releaseCode) {
        return NextResponse.json(
          { ok: false, error: 'Manager does not have a release code configured' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } },
        );
      }
      managerValid = managerOverrideCode.toUpperCase().trim() === manager.releaseCode.toUpperCase().trim();
      if (!managerValid) {
        return NextResponse.json(
          { ok: false, error: 'Manager release code does not match' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } },
        );
      }
    }

    const finalStatus = isPartial ? 'partial-release' : 'in-transit';

    const updated = await updateSlipInRun(clientId, loadId, slipId, {
      status: finalStatus,
      releaseRepId,
      releaseRepName,
      releaseBoxes: releaseBoxes ?? [],
      releasedAt: new Date().toISOString(),
      releasedBy: guard.userId,
      releasedByName: userName,
    });

    await logAudit({
      action: isPartial ? 'partial_release' : 'release_complete',
      userId: guard.userId,
      userName,
      slipId,
      clientId,
      detail: isPartial
        ? `Partial release of ${(releaseBoxes ?? []).length} boxes (manager override by ${managerOverrideRepId})`
        : `Stock released — ${(releaseBoxes ?? []).length} boxes in transit. Rep: ${releaseRepName}`,
    });

    return NextResponse.json(
      { ok: true, status: finalStatus, slip: updated },
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

    await logAudit({
      action: 'failed_release',
      userId: guard.userId,
      userName,
      slipId,
      clientId,
      detail: `Release code mismatch for rep ${releaseRepName} (${releaseRepId})`,
    });

    return NextResponse.json(
      { ok: false, status: 'failed-release', error: 'Release code does not match', slip: updated },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
