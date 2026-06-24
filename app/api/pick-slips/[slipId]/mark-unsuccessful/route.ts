import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { getPickSlipRun, updateSlipInRun } from '@/lib/pickSlipData';
import { loadSettings } from '@/lib/settingsData';
import { loadUsers } from '@/lib/userData';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

/**
 * POST /api/pick-slips/[slipId]/mark-unsuccessful
 *
 * Admin-only. Moves a pick slip from 'sent' → 'unsuccessful' with a reason
 * (e.g. the upliftment couldn't be completed at the store), so it stays visible
 * and can be re-sent to the same or a new rep rather than being forgotten in
 * "Sent".
 *
 * Body: { clientId, loadId, reason }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slipId: string }> }
) {
  const { slipId } = await params;
  const guard = await requirePermission(req, 'manage_pick_slips');
  if (guard instanceof NextResponse) return guard;

  let body: { clientId?: string; loadId?: string; reason?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
  const loadId = typeof body.loadId === 'string' ? body.loadId.trim() : '';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

  if (!clientId || !loadId) {
    return NextResponse.json({ error: 'clientId and loadId are required' }, { status: 400 });
  }
  if (!reason) {
    return NextResponse.json({ error: 'A reason is required' }, { status: 400 });
  }

  // Reason must be one of the configured reasons (case-insensitive).
  const settings = await loadSettings();
  const match = settings.upliftFailureReasons.find(r => r.toLowerCase() === reason.toLowerCase());
  if (!match) {
    return NextResponse.json({ error: 'Reason is not a configured upliftment-failure reason' }, { status: 400 });
  }

  const run = await getPickSlipRun(clientId, loadId);
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

  const slip = run.slips.find(s => s.id === slipId);
  if (!slip) return NextResponse.json({ error: 'Slip not found' }, { status: 404 });

  // Only a sent slip can be marked unsuccessful.
  if (slip.status !== 'sent') {
    return NextResponse.json(
      { error: `Only a 'Sent' pick slip can be marked Unsuccessful (current status: ${slip.status})` },
      { status: 409 }
    );
  }

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  const myName = me ? `${me.name} ${me.surname}`.trim() : guard.userId;

  const now = new Date().toISOString();
  const updated = await updateSlipInRun(clientId, loadId, slipId, {
    status: 'unsuccessful',
    unsuccessfulReason: match,
    unsuccessfulAt: now,
    unsuccessfulBy: guard.userId,
    unsuccessfulByName: myName,
  });

  logAudit({
    action: 'pick-slip-unsuccessful',
    userId: guard.userId,
    userName: myName,
    slipId,
    clientId,
    detail: `Marked ${slipId} Unsuccessful — ${match}`,
  }).catch(err => console.error('[mark-unsuccessful] audit log failed:', err));

  return NextResponse.json({ ok: true, slip: updated }, { headers: { 'Cache-Control': 'no-store' } });
}
