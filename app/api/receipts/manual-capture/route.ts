import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { getPickSlipRun, updateSlipInRun } from '@/lib/pickSlipData';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

/**
 * POST /api/receipts/manual-capture
 *
 * Saves the actual qty/val for each product on a manual pick slip after receipt.
 * Updates the slip rows and recalculates totalQty / totalVal.
 *
 * Body: { slipId, clientId, loadId, rows: Array<{ articleCode, description, qty, val }> }
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'receipt_stock');
  if (guard instanceof NextResponse) return guard;

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  if (!me) return NextResponse.json({ error: 'User not found' }, { status: 401 });

  let body: {
    slipId?: string;
    clientId?: string;
    loadId?: string;
    rows?: Array<{ articleCode: string; description: string; qty: number; val: number }>;
  };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const { slipId, clientId, loadId, rows } = body;
  if (!slipId || !clientId || !loadId || !Array.isArray(rows)) {
    return NextResponse.json({ error: 'slipId, clientId, loadId, and rows are required' }, { status: 400 });
  }

  // Read existing slip to preserve barcode/vendorProductCode
  const run = await getPickSlipRun(clientId, loadId);
  const existingSlip = run?.slips.find(s => s.id === slipId);
  const existingRowMap = new Map(
    (existingSlip?.rows ?? []).map(r => [r.articleCode, r])
  );

  // Build updated rows — preserve barcode + vendorProductCode from originals
  const updatedRows = rows.map(r => {
    const orig = existingRowMap.get(r.articleCode);
    return {
      barcode: orig?.barcode ?? '',
      articleCode: r.articleCode,
      vendorProductCode: orig?.vendorProductCode ?? '',
      description: r.description,
      qty: Math.max(0, Number(r.qty) || 0),
      val: Math.max(0, Number(r.val) || 0),
    };
  });

  const totalQty = updatedRows.reduce((s, r) => s + r.qty, 0);
  const totalVal = updatedRows.reduce((s, r) => s + r.val, 0);

  const updated = await updateSlipInRun(clientId, loadId, slipId, {
    rows: updatedRows,
    totalQty,
    totalVal,
    rowCount: updatedRows.filter(r => r.qty > 0).length,
  });

  if (!updated) {
    return NextResponse.json({ error: 'Pick slip not found' }, { status: 404 });
  }

  await logAudit({
    action: 'manual_stock_captured',
    userId: guard.userId,
    userName: me.name + ' ' + me.surname,
    slipId,
    clientId,
    detail: `Captured manual stock: ${totalQty} units, R ${totalVal.toFixed(2)} — ${updatedRows.filter(r => r.qty > 0).length} products with stock`,
  });

  return NextResponse.json({ ok: true, slip: updated }, { headers: { 'Cache-Control': 'no-store' } });
}
