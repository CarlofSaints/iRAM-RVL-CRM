import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { verifyReleaseCode, masterCodeAuditNote } from '@/lib/releaseCodeAuth';
import { updateSlipInRun, getPickSlipRun, type PickSlipRecord } from '@/lib/pickSlipData';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

interface SlipRef {
  slipId: string;
  clientId: string;
  loadId: string;
}

/**
 * POST /api/receipts/cancel-release
 *
 * Cancel an already-released delivery (in-transit / partial-release) when the
 * rep can no longer do the return. Reverts every slip in the delivery group
 * back to "captured" (in the warehouse, ready to release again) and clears the
 * release fields + delivery token so the cancelled delivery can't be confirmed
 * via the old QR link.
 *
 * Requires a MANAGER/ADMIN release code (non-rep) — abuse protection so a rep
 * can't cancel their own release. Always written to the audit log.
 *
 * Body: { deliveryToken, slips: [{ slipId, clientId, loadId }], managerId, managerName, securityCode }
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'receipt_stock');
  if (guard instanceof NextResponse) return guard;

  const body = await req.json();
  const {
    deliveryToken,
    managerId,
    managerName,
    securityCode,
  } = body as {
    deliveryToken: string;
    managerId: string;
    managerName: string;
    securityCode: string;
  };

  const slipRefs: SlipRef[] = Array.isArray(body.slips) ? body.slips : [];

  if (!deliveryToken) {
    return NextResponse.json({ ok: false, error: 'deliveryToken is required' }, { status: 400 });
  }
  if (slipRefs.length === 0) {
    return NextResponse.json({ ok: false, error: 'slips array is required' }, { status: 400 });
  }
  if (!managerId) {
    return NextResponse.json({ ok: false, error: 'managerId is required' }, { status: 400 });
  }
  if (!securityCode) {
    return NextResponse.json({ ok: false, error: 'securityCode is required' }, { status: 400 });
  }

  // ── Verify each slip exists, is cancellable, and belongs to this delivery ──
  const resolvedSlips: Array<{ ref: SlipRef; slip: PickSlipRecord }> = [];
  for (const ref of slipRefs) {
    const run = await getPickSlipRun(ref.clientId, ref.loadId);
    if (!run) {
      return NextResponse.json({ ok: false, error: `Pick slip run not found for ${ref.slipId}` }, { status: 404 });
    }
    const slip = run.slips.find(s => s.id === ref.slipId);
    if (!slip) {
      return NextResponse.json({ ok: false, error: `Pick slip ${ref.slipId} not found` }, { status: 404 });
    }
    if (slip.status !== 'in-transit' && slip.status !== 'partial-release') {
      return NextResponse.json(
        { ok: false, error: `Cannot cancel ${ref.slipId} with status "${slip.status}" — only in-transit releases can be cancelled` },
        { status: 400 },
      );
    }
    if (slip.deliveryToken !== deliveryToken) {
      return NextResponse.json(
        { ok: false, error: `Pick slip ${ref.slipId} does not belong to this delivery` },
        { status: 400 },
      );
    }
    resolvedSlips.push({ ref, slip });
  }

  // ── Verify the authorising manager/admin (non-rep) and their release code ──
  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  const actorName = me ? `${me.name} ${me.surname}` : guard.userId;

  const manager = users.find(u => u.id === managerId);
  if (!manager) {
    return NextResponse.json({ ok: false, error: 'Authorising manager not found' }, { status: 404 });
  }
  if (manager.role === 'rep') {
    return NextResponse.json({ ok: false, error: 'A manager or admin must authorise a cancellation — a rep cannot' }, { status: 403 });
  }

  // Verify the code — the selected manager's own code, or a Super Admin master code.
  const codeCheck = verifyReleaseCode(securityCode, manager.releaseCode, me, guard.userRole);
  if (!codeCheck.matched && !manager.releaseCode) {
    return NextResponse.json({ ok: false, error: 'The selected manager does not have a release code configured' }, { status: 400 });
  }
  if (!codeCheck.matched) {
    await logAudit({
      action: 'cancel_release_failed',
      userId: guard.userId,
      userName: actorName,
      slipId: resolvedSlips.map(r => r.slip.id).join(', '),
      clientId: resolvedSlips[0].ref.clientId,
      detail: `Release code mismatch attempting to cancel release (authoriser ${managerName || managerId})`,
    });
    return NextResponse.json(
      { ok: false, error: 'Security code does not match the selected manager' },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  // A Super Admin authorising the cancellation with their own code — flagged in the audit trail.
  const masterNote = codeCheck.viaMaster
    ? masterCodeAuditNote(actorName, `authoriser ${manager.name} ${manager.surname}`.trim())
    : '';

  // ── Revert every slip in the group back to "captured" ──
  const updatedSlips: PickSlipRecord[] = [];
  for (const { ref, slip } of resolvedSlips) {
    const prevRepName = slip.releaseRepName || '(unassigned)';
    const updated = await updateSlipInRun(ref.clientId, ref.loadId, ref.slipId, {
      status: 'captured',
      releaseRepId: undefined,
      releaseRepName: undefined,
      releaseBoxes: [],
      releasedAt: undefined,
      releasedBy: undefined,
      releasedByName: undefined,
      deliveryToken: undefined,
      deliveryNoteSpWebUrl: undefined,
      deliveryNoteGeneratedAt: undefined,
    });
    if (updated) updatedSlips.push(updated);

    await logAudit({
      action: 'cancel_release',
      userId: guard.userId,
      userName: actorName,
      slipId: ref.slipId,
      clientId: ref.clientId,
      detail: `Release cancelled — reverted to captured (rep was ${prevRepName}). Authorised by ${manager.name} ${manager.surname}.` + masterNote,
    });
  }

  return NextResponse.json(
    { ok: true, slips: updatedSlips },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
