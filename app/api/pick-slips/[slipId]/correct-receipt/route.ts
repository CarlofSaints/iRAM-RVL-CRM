import { NextRequest, NextResponse } from 'next/server';
import { requireLogin } from '@/lib/rolesData';
import { getPickSlipRun, updateSlipInRun } from '@/lib/pickSlipData';
import { loadUsers } from '@/lib/userData';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

/**
 * POST /api/pick-slips/[slipId]/correct-receipt
 *
 * Correct the captured GRN/GRV details (value, store references, GRN date) on a
 * pick slip whose receipt has already been captured — including slips that have
 * since been released or delivered, where the receipt capture screen is locked
 * read-only. Status and all release/delivery data are left untouched; this is a
 * data correction, not a stage change (use Reverse for that).
 *
 * Gated by the `edit_captured_pick_slips` permission (or super-admin). Every
 * change is written to the audit log with old → new values and a reason.
 *
 * Body: { clientId, loadId, value, storeRefs?, grnDate?, reason }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slipId: string }> }
) {
  const { slipId } = await params;

  const guard = await requireLogin(req);
  if (guard instanceof NextResponse) return guard;

  const allowed =
    guard.userRole === 'super-admin' ||
    guard.permissions.includes('edit_captured_pick_slips');
  if (!allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: {
    clientId?: string;
    loadId?: string;
    value?: string;
    storeRefs?: string[];
    grnDate?: string;
    reason?: string;
  };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
  const loadId = typeof body.loadId === 'string' ? body.loadId.trim() : '';
  const value = typeof body.value === 'string' ? body.value.trim() : '';
  const grnDate = typeof body.grnDate === 'string' ? body.grnDate.trim() : '';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const storeRefs = Array.isArray(body.storeRefs)
    ? body.storeRefs.map(r => (typeof r === 'string' ? r.trim() : '')).filter(Boolean)
    : undefined;

  if (!clientId || !loadId) {
    return NextResponse.json({ error: 'clientId and loadId are required' }, { status: 400 });
  }
  if (!reason) {
    return NextResponse.json({ error: 'A reason is required' }, { status: 400 });
  }

  const run = await getPickSlipRun(clientId, loadId);
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

  const slip = run.slips.find(s => s.id === slipId);
  if (!slip) return NextResponse.json({ error: 'Slip not found' }, { status: 404 });

  // Only meaningful once a receipt has actually been captured.
  if (!slip.receiptedAt) {
    return NextResponse.json(
      { error: 'This slip has no captured receipt to correct' },
      { status: 409 }
    );
  }

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  const myName = me ? `${me.name} ${me.surname}`.trim() : guard.userId;

  // Snapshot old values for the audit trail.
  const oldValue = slip.receiptValue ?? '';
  const oldRefs = slip.receiptStoreRefs ?? [];
  const oldGrnDate = slip.receiptGrnDate ?? '';

  const now = new Date().toISOString();
  const patch: Parameters<typeof updateSlipInRun>[3] = {
    receiptValue: value,
    receiptValueCorrectedAt: now,
    receiptValueCorrectedBy: guard.userId,
    receiptValueCorrectedByName: myName,
  };
  // Store refs / GRN date are optional — only overwrite when supplied so a
  // value-only correction leaves them intact.
  if (storeRefs !== undefined) patch.receiptStoreRefs = storeRefs;
  if (body.grnDate !== undefined) patch.receiptGrnDate = grnDate || undefined;

  const updated = await updateSlipInRun(clientId, loadId, slipId, patch);
  if (!updated) {
    return NextResponse.json({ error: 'Failed to update pick slip' }, { status: 500 });
  }

  // Build a change summary — only mention fields that actually changed.
  const changes: string[] = [];
  if (oldValue !== value) changes.push(`Value "${oldValue || '—'}" → "${value || '—'}"`);
  if (storeRefs !== undefined && oldRefs.join(', ') !== storeRefs.join(', ')) {
    changes.push(`Refs "${oldRefs.join(', ') || '—'}" → "${storeRefs.join(', ') || '—'}"`);
  }
  if (body.grnDate !== undefined && oldGrnDate !== grnDate) {
    changes.push(`GRN date "${oldGrnDate || '—'}" → "${grnDate || '—'}"`);
  }

  logAudit({
    action: 'receipt-value-correction',
    userId: guard.userId,
    userName: myName,
    slipId,
    clientId,
    detail:
      `Corrected GRN/GRV on ${slipId} (status "${slip.status}"). ` +
      `${changes.length ? changes.join('; ') : 'No field values changed'}. Reason: ${reason}.`,
  }).catch(err => console.error('[correct-receipt] audit log failed:', err));

  return NextResponse.json(
    { ok: true, slip: updated, changes },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
