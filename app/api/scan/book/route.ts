import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { loadControl } from '@/lib/controlData';
import { getPickSlipRun, updateSlipInRun, type ReceiptBox } from '@/lib/pickSlipData';
import { findAndLinkSticker } from '@/lib/stickerData';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

interface RepRecord {
  id: string;
  name: string;
  surname: string;
  releaseCode?: string;
}

/**
 * POST /api/scan/book
 *
 * Book stock into a warehouse via the scan screen.
 * Links sticker barcodes to the pick slip and sets status to 'booked'.
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'scan_stock');
  if (guard instanceof NextResponse) return guard;

  const body = await req.json();
  const { slipId, clientId, loadId, repId, securityCode, boxes } = body as {
    slipId: string;
    clientId: string;
    loadId: string;
    repId: string;
    securityCode: string;
    boxes: ReceiptBox[];
  };

  if (!slipId || !clientId || !loadId) {
    return NextResponse.json({ error: 'slipId, clientId, and loadId are required' }, { status: 400 });
  }
  if (!repId) {
    return NextResponse.json({ error: 'repId is required' }, { status: 400 });
  }
  if (!securityCode) {
    return NextResponse.json({ error: 'securityCode is required' }, { status: 400 });
  }
  if (!boxes || boxes.length === 0) {
    return NextResponse.json({ error: 'At least one box is required' }, { status: 400 });
  }

  // Validate slip exists and is in a bookable status
  const run = await getPickSlipRun(clientId, loadId);
  if (!run) {
    return NextResponse.json({ error: 'Pick slip run not found' }, { status: 404 });
  }
  const slip = run.slips.find(s => s.id === slipId);
  if (!slip) {
    return NextResponse.json({ error: 'Pick slip not found' }, { status: 404 });
  }

  const bookableStatuses = ['generated', 'sent', 'picked'];
  if (!bookableStatuses.includes(slip.status)) {
    return NextResponse.json(
      { error: `Pick slip is already "${slip.status}" — cannot book` },
      { status: 409 },
    );
  }

  // Validate rep/user exists and has a release code
  const reps = await loadControl<RepRecord>('reps');
  const users = await loadUsers();
  const rep = reps.find(r => r.id === repId);
  const user = users.find(u => u.id === repId);

  const match = rep || user;
  if (!match) {
    return NextResponse.json({ error: 'Rep/user not found' }, { status: 404 });
  }

  const matchReleaseCode = rep?.releaseCode ?? user?.releaseCode;
  if (!matchReleaseCode) {
    return NextResponse.json({ error: 'Selected rep/user does not have a release code' }, { status: 400 });
  }

  // Validate security code matches (case-insensitive)
  if (securityCode.toUpperCase() !== matchReleaseCode.toUpperCase()) {
    return NextResponse.json({ error: 'Security code does not match' }, { status: 403 });
  }

  // Link stickers to the pick slip
  const linkErrors: string[] = [];
  for (const box of boxes) {
    const result = await findAndLinkSticker(box.stickerBarcode, slipId);
    if (!result) {
      linkErrors.push(`Barcode ${box.stickerBarcode} not found`);
    } else if (result.linkedPickSlipId && result.linkedPickSlipId !== slipId) {
      linkErrors.push(`Barcode ${box.stickerBarcode} already linked to ${result.linkedPickSlipId}`);
    }
  }

  // Get the booking user's info
  const bookingUser = users.find(u => u.id === guard.userId);
  const bookingUserName = bookingUser ? `${bookingUser.name} ${bookingUser.surname}`.trim() : guard.userId;
  const repName = match ? `${match.name} ${match.surname}`.trim() : repId;

  // Update slip with booking data
  const updated = await updateSlipInRun(clientId, loadId, slipId, {
    status: 'booked',
    bookedAt: new Date().toISOString(),
    bookedBy: guard.userId,
    bookedByName: bookingUserName,
    bookedRepId: repId,
    bookedRepName: repName,
    receiptBoxes: boxes,
    receiptTotalBoxes: boxes.length,
  });

  if (!updated) {
    return NextResponse.json({ error: 'Failed to update pick slip' }, { status: 500 });
  }

  // Audit log
  await logAudit({
    action: 'scan_book',
    userId: guard.userId,
    userName: bookingUserName,
    slipId,
    clientId,
    detail: `Stock booked — ${boxes.length} box${boxes.length !== 1 ? 'es' : ''} scanned for ${slipId}. Rep: ${repName}`,
  });

  return NextResponse.json(
    { ok: true, slip: updated, linkErrors },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
