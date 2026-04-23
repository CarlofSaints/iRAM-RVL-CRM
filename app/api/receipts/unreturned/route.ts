import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { updateSlipInRun, getPickSlipRun, type UnreturnedStockRow } from '@/lib/pickSlipData';
import { logAudit } from '@/lib/auditLog';
import { sendUnreturnedSkipEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

/**
 * POST /api/receipts/unreturned
 *
 * Save unreturned stock capture data (reason codes per product),
 * or skip the capture with a notification email to managers.
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

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  const userName = me ? `${me.name} ${me.surname}` : guard.userId;

  // Fetch the current slip to read rows for validation
  const run = await getPickSlipRun(clientId, loadId);
  const slip = run?.slips.find(s => s.id === slipId);
  if (!slip) {
    return NextResponse.json({ error: 'Pick slip not found' }, { status: 404 });
  }

  // ── Skip flow ──
  if (body.skip === true) {
    const { skipRepId, skipRepName, skipReason } = body as {
      skipRepId: string;
      skipRepName: string;
      skipReason: string;
    };

    if (!skipRepId || !skipRepName) {
      return NextResponse.json({ error: 'skipRepId and skipRepName are required' }, { status: 400 });
    }

    const updated = await updateSlipInRun(clientId, loadId, slipId, {
      unreturnedSkipped: true,
      unreturnedSkipReason: skipReason || 'Rep did not return paperwork',
      unreturnedSkipRepId: skipRepId,
      unreturnedSkipRepName: skipRepName,
      unreturnedCapturedAt: new Date().toISOString(),
      unreturnedCapturedBy: guard.userId,
      unreturnedCapturedByName: userName,
    });

    // Send email to RVL Managers + Super Admins
    const adminEmails = users
      .filter(u => u.role === 'rvl-manager' || u.role === 'super-admin')
      .map(u => u.email)
      .filter(Boolean);

    if (adminEmails.length > 0) {
      try {
        await sendUnreturnedSkipEmail({
          toAdmins: adminEmails,
          skippedByName: userName,
          repName: skipRepName,
          storeName: slip.siteName,
          clientName: slip.clientName,
          pickSlipRef: slip.id,
          boxBarcodes: (slip.receiptBoxes ?? []).map(b => b.stickerBarcode),
          generatedAt: slip.generatedAt,
          bookedAt: slip.bookedAt,
          receiptedAt: slip.receiptedAt,
        });
      } catch (err) {
        console.error('[unreturned] Failed to send skip email:', err);
      }
    }

    await logAudit({
      action: 'unreturned_stock_skipped',
      userId: guard.userId,
      userName,
      slipId,
      clientId,
      detail: `Unreturned stock capture skipped for ${slipId}. Rep: ${skipRepName}. Reason: ${skipReason || 'Rep did not return paperwork'}`,
    });

    return NextResponse.json(
      { ok: true, slip: updated },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // ── Normal capture flow ──
  const { rows } = body as { rows: UnreturnedStockRow[] };
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: 'rows are required' }, { status: 400 });
  }

  // Validate each row: sum of reasons cannot exceed pickSlipQty
  for (const row of rows) {
    const sum = (row.display || 0) + (row.storeRefused || 0) + (row.notFound || 0) + (row.damaged || 0);
    if (sum > row.pickSlipQty) {
      return NextResponse.json(
        { error: `Reason totals exceed pick slip qty for ${row.description} (${sum} > ${row.pickSlipQty})` },
        { status: 400 },
      );
    }
  }

  const updated = await updateSlipInRun(clientId, loadId, slipId, {
    unreturnedStock: rows,
    unreturnedCapturedAt: new Date().toISOString(),
    unreturnedCapturedBy: guard.userId,
    unreturnedCapturedByName: userName,
  });

  await logAudit({
    action: 'unreturned_stock_captured',
    userId: guard.userId,
    userName,
    slipId,
    clientId,
    detail: `Unreturned stock captured for ${slipId} — ${rows.length} products`,
  });

  return NextResponse.json(
    { ok: true, slip: updated },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
