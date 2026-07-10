import { NextRequest, NextResponse } from 'next/server';
import { requireLogin } from '@/lib/rolesData';
import { getPickSlipRun, updateSlipInRun, type ReceiptBox } from '@/lib/pickSlipData';
import { unlinkStickerFromSlip } from '@/lib/stickerData';
import { loadUsers } from '@/lib/userData';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

/**
 * POST /api/pick-slips/[slipId]/adjust-boxes
 *
 * Super-admin only. Removes one or more box records from a slip's box list and
 * unlinks their stickers. Used to correct a slip that carries more box records
 * than physically exist — e.g. "Add Boxes" was run by mistake, so Release keeps
 * demanding boxes that were never printed.
 *
 * Only allowed BEFORE release (booked / captured / failed-release), while the
 * box list is still the operative record and no delivery note has been cut.
 *
 * Body: { clientId, loadId, removeBarcodes: string[], reason }
 */
const ADJUSTABLE_STATUSES = new Set(['booked', 'captured', 'failed-release']);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slipId: string }> },
) {
  const { slipId } = await params;

  const guard = await requireLogin(req);
  if (guard instanceof NextResponse) return guard;

  // Same gate as Reverse — a destructive correction reserved for Super Admin
  // (or the explicit revert permission).
  const allowed = guard.userRole === 'super-admin' || guard.permissions.includes('revert_pick_slips');
  if (!allowed) {
    return NextResponse.json({ error: 'Forbidden — Super Admin only' }, { status: 403 });
  }

  let body: { clientId?: string; loadId?: string; removeBarcodes?: unknown; reason?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
  const loadId = typeof body.loadId === 'string' ? body.loadId.trim() : '';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const removeBarcodes = Array.isArray(body.removeBarcodes)
    ? [...new Set(body.removeBarcodes.filter((b): b is string => typeof b === 'string' && !!b.trim()).map(b => b.trim()))]
    : [];

  if (!clientId || !loadId) {
    return NextResponse.json({ error: 'clientId and loadId are required' }, { status: 400 });
  }
  if (removeBarcodes.length === 0) {
    return NextResponse.json({ error: 'Select at least one box to remove' }, { status: 400 });
  }
  if (!reason) {
    return NextResponse.json({ error: 'A reason is required' }, { status: 400 });
  }

  const run = await getPickSlipRun(clientId, loadId);
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

  const slip = run.slips.find(s => s.id === slipId);
  if (!slip) return NextResponse.json({ error: 'Slip not found' }, { status: 404 });

  if (!ADJUSTABLE_STATUSES.has(slip.status)) {
    return NextResponse.json(
      { error: `Boxes can only be adjusted while a slip is Booked, Captured or Failed Release — this slip is "${slip.status}". Use Reverse instead.` },
      { status: 409 },
    );
  }

  const currentBoxes: ReceiptBox[] = slip.receiptBoxes ?? [];
  const removeSet = new Set(removeBarcodes);

  // Every barcode asked to remove must actually be on the slip.
  const notOnSlip = removeBarcodes.filter(b => !currentBoxes.some(box => box.stickerBarcode === b));
  if (notOnSlip.length > 0) {
    return NextResponse.json(
      { error: `Not on this slip: ${notOnSlip.join(', ')}` },
      { status: 409 },
    );
  }

  const newBoxes = currentBoxes.filter(box => !removeSet.has(box.stickerBarcode));
  if (newBoxes.length === 0) {
    return NextResponse.json(
      { error: 'Cannot remove every box — at least one must remain. To undo the whole booking, use Reverse.' },
      { status: 409 },
    );
  }

  // Also drop any matching release boxes (harmless pre-release, but keeps them in sync).
  const newReleaseBoxes = (slip.releaseBoxes ?? []).filter(box => !removeSet.has(box.stickerBarcode));

  // Unlink the removed stickers from this slip so their barcodes are free again.
  let stickersUnlinked = 0;
  for (const barcode of removeBarcodes) {
    try {
      if (await unlinkStickerFromSlip(barcode, slipId)) stickersUnlinked++;
    } catch (err) {
      console.error('[adjust-boxes] failed to unlink sticker', barcode, err instanceof Error ? err.message : err);
    }
  }

  const patch: Record<string, unknown> = { receiptBoxes: newBoxes };
  // Keep the "expected boxes" figure honest when it was previously set.
  if (typeof slip.receiptTotalBoxes === 'number') patch.receiptTotalBoxes = newBoxes.length;
  if (slip.releaseBoxes) patch.releaseBoxes = newReleaseBoxes;

  const updated = await updateSlipInRun(clientId, loadId, slipId, patch);
  if (!updated) {
    return NextResponse.json({ error: 'Failed to update pick slip' }, { status: 500 });
  }

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  const myName = me ? `${me.name} ${me.surname}`.trim() : guard.userId;

  logAudit({
    action: 'pick-slip-adjust-boxes',
    userId: guard.userId,
    userName: myName,
    slipId,
    clientId,
    detail:
      `Removed ${removeBarcodes.length} box${removeBarcodes.length !== 1 ? 'es' : ''} from ${slipId} ` +
      `(${currentBoxes.length} → ${newBoxes.length}). Removed: ${removeBarcodes.join(', ')}. ` +
      `Reason: ${reason}.` +
      (stickersUnlinked ? ` ${stickersUnlinked} sticker(s) unlinked.` : ''),
  }).catch(err => console.error('[adjust-boxes] audit log failed:', err));

  return NextResponse.json(
    { ok: true, slip: updated, removed: removeBarcodes, remaining: newBoxes.length, stickersUnlinked },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
