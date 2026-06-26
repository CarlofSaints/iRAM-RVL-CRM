import { NextRequest, NextResponse } from 'next/server';
import { requireLogin } from '@/lib/rolesData';
import { getPickSlipRun, updateSlipInRun } from '@/lib/pickSlipData';
import { unlinkStickerFromSlip } from '@/lib/stickerData';
import { loadUsers } from '@/lib/userData';
import { logAudit } from '@/lib/auditLog';
import {
  isValidRevertTarget,
  buildRevertPatch,
  revertUndoesBooking,
  clearedStageDescriptions,
  STATUS_LABELS,
} from '@/lib/pickSlipRevert';

export const dynamic = 'force-dynamic';

/**
 * POST /api/pick-slips/[slipId]/revert
 *
 * Super-admin only. Rolls a pick slip back to an earlier status, clearing every
 * field written after the target stage and unlinking booking stickers when the
 * booking stage is undone. Used to reverse a mistake (e.g. a GRN captured
 * against the wrong store).
 *
 * Body: { clientId, loadId, targetStatus, reason }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slipId: string }> }
) {
  const { slipId } = await params;

  const guard = await requireLogin(req);
  if (guard instanceof NextResponse) return guard;

  // Reverse is a destructive admin action — Super Admin role, or the explicit
  // revert permission (super-admin gets it via seed, but the role check keeps it
  // working before a re-seed and locks everyone else out).
  const allowed = guard.userRole === 'super-admin' || guard.permissions.includes('revert_pick_slips');
  if (!allowed) {
    return NextResponse.json({ error: 'Forbidden — Super Admin only' }, { status: 403 });
  }

  let body: { clientId?: string; loadId?: string; targetStatus?: string; reason?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
  const loadId = typeof body.loadId === 'string' ? body.loadId.trim() : '';
  const targetStatus = typeof body.targetStatus === 'string' ? body.targetStatus.trim() : '';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

  if (!clientId || !loadId) {
    return NextResponse.json({ error: 'clientId and loadId are required' }, { status: 400 });
  }
  if (!targetStatus) {
    return NextResponse.json({ error: 'targetStatus is required' }, { status: 400 });
  }
  if (!reason) {
    return NextResponse.json({ error: 'A reason is required' }, { status: 400 });
  }

  const run = await getPickSlipRun(clientId, loadId);
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

  const slip = run.slips.find(s => s.id === slipId);
  if (!slip) return NextResponse.json({ error: 'Slip not found' }, { status: 404 });

  const fromStatus = slip.status;

  if (!isValidRevertTarget(slip, targetStatus)) {
    return NextResponse.json(
      { error: `Cannot reverse a "${STATUS_LABELS[fromStatus] ?? fromStatus}" slip back to "${STATUS_LABELS[targetStatus] ?? targetStatus}"` },
      { status: 409 }
    );
  }

  // ── Side effect: unlink booking stickers when the booking stage is undone ──
  let stickersUnlinked = 0;
  if (revertUndoesBooking(targetStatus)) {
    const barcodes = new Set<string>();
    for (const b of slip.receiptBoxes ?? []) if (b.stickerBarcode) barcodes.add(b.stickerBarcode);
    for (const b of slip.releaseBoxes ?? []) if (b.stickerBarcode) barcodes.add(b.stickerBarcode);
    for (const barcode of barcodes) {
      try {
        if (await unlinkStickerFromSlip(barcode, slipId)) stickersUnlinked++;
      } catch (err) {
        console.error('[revert] failed to unlink sticker', barcode, err instanceof Error ? err.message : err);
      }
    }
  }

  // ── Clear fields written after the target stage + set the new status ──
  const patch = buildRevertPatch(targetStatus);
  const updated = await updateSlipInRun(clientId, loadId, slipId, patch);
  if (!updated) {
    return NextResponse.json({ error: 'Failed to update pick slip' }, { status: 500 });
  }

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  const myName = me ? `${me.name} ${me.surname}`.trim() : guard.userId;

  const cleared = clearedStageDescriptions(fromStatus, targetStatus);
  logAudit({
    action: 'pick-slip-revert',
    userId: guard.userId,
    userName: myName,
    slipId,
    clientId,
    detail:
      `Reversed ${slipId} from "${STATUS_LABELS[fromStatus] ?? fromStatus}" to ` +
      `"${STATUS_LABELS[targetStatus] ?? targetStatus}". Reason: ${reason}. ` +
      `Cleared: ${cleared.join('; ') || 'none'}.` +
      (stickersUnlinked ? ` ${stickersUnlinked} sticker(s) unlinked.` : ''),
  }).catch(err => console.error('[revert] audit log failed:', err));

  return NextResponse.json(
    { ok: true, slip: updated, fromStatus, targetStatus, stickersUnlinked, cleared },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
