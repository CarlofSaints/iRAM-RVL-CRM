import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { updateSlipInRun } from '@/lib/pickSlipData';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

/**
 * POST /api/receipts/complete
 *
 * Finalize the receipt — sets status to 'receipted' with timestamp.
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'receipt_stock');
  if (guard instanceof NextResponse) return guard;

  const body = await req.json();
  const { slipId, clientId, loadId } = body as {
    slipId: string;
    clientId: string;
    loadId: string;
  };

  if (!slipId || !clientId || !loadId) {
    return NextResponse.json({ error: 'slipId, clientId, and loadId are required' }, { status: 400 });
  }

  // Resolve user name for audit
  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  const userName = me ? `${me.name} ${me.surname}` : guard.userId;

  const updated = await updateSlipInRun(clientId, loadId, slipId, {
    status: 'receipted',
    receiptedAt: new Date().toISOString(),
    receiptedBy: guard.userId,
    receiptedByName: userName,
  });

  if (!updated) {
    return NextResponse.json({ error: 'Pick slip not found' }, { status: 404 });
  }

  await logAudit({
    action: 'receipt_complete',
    userId: guard.userId,
    userName,
    slipId,
    clientId,
    detail: `Receipt completed for pick slip ${slipId}`,
  });

  return NextResponse.json(
    { ok: true, slip: updated },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
