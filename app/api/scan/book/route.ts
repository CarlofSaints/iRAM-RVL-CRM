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

interface SlipRef {
  slipId: string;
  clientId: string;
  loadId: string;
}

/**
 * POST /api/scan/book
 *
 * Book stock into a warehouse via the scan screen.
 * Links sticker barcodes to pick slip(s) and sets status to 'booked'.
 *
 * Accepts either:
 *   - Legacy single-slip: { slipId, clientId, loadId, repId, securityCode, boxes }
 *   - Multi-slip: { slips: [{ slipId, clientId, loadId }], repId, securityCode, boxes }
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'scan_stock');
  if (guard instanceof NextResponse) return guard;

  const body = await req.json();
  const { repId, securityCode, boxes } = body as {
    repId: string;
    securityCode: string;
    boxes: ReceiptBox[];
  };

  // Normalize to slips array — backward compat with single-slip format
  let slips: SlipRef[];
  if (body.slips && Array.isArray(body.slips)) {
    slips = body.slips;
  } else if (body.slipId && body.clientId && body.loadId) {
    slips = [{ slipId: body.slipId, clientId: body.clientId, loadId: body.loadId }];
  } else {
    return NextResponse.json({ error: 'slips array or slipId/clientId/loadId are required' }, { status: 400 });
  }

  if (slips.length === 0) {
    return NextResponse.json({ error: 'At least one slip is required' }, { status: 400 });
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

  // Validate all slips exist and are bookable BEFORE making changes
  const bookableStatuses = ['generated', 'sent'];
  for (const ref of slips) {
    const run = await getPickSlipRun(ref.clientId, ref.loadId);
    if (!run) {
      return NextResponse.json({ error: `Pick slip run not found for ${ref.slipId}` }, { status: 404 });
    }
    const slip = run.slips.find(s => s.id === ref.slipId);
    if (!slip) {
      return NextResponse.json({ error: `Pick slip ${ref.slipId} not found` }, { status: 404 });
    }
    if (!bookableStatuses.includes(slip.status)) {
      return NextResponse.json(
        { error: `Pick slip ${ref.slipId} is already "${slip.status}" — cannot book` },
        { status: 409 },
      );
    }
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

  // Link stickers to ALL pick slips (multi-link)
  const allSlipIds = slips.map(s => s.slipId);
  const linkErrors: string[] = [];
  for (const box of boxes) {
    for (const slipId of allSlipIds) {
      const result = await findAndLinkSticker(box.stickerBarcode, slipId);
      if (!result) {
        // Only report "not found" once per barcode, not per slip
        if (!linkErrors.some(e => e.includes(box.stickerBarcode))) {
          linkErrors.push(`Barcode ${box.stickerBarcode} not found`);
        }
      }
    }
  }

  // Get booking user info
  const bookingUser = users.find(u => u.id === guard.userId);
  const bookingUserName = bookingUser ? `${bookingUser.name} ${bookingUser.surname}`.trim() : guard.userId;
  const repName = match ? `${match.name} ${match.surname}`.trim() : repId;

  const isMulti = slips.length > 1;
  const slipIdsList = allSlipIds.join(', ');
  const updatedSlips = [];

  // Update each slip with booking data
  for (const ref of slips) {
    const updated = await updateSlipInRun(ref.clientId, ref.loadId, ref.slipId, {
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
      return NextResponse.json({ error: `Failed to update pick slip ${ref.slipId}` }, { status: 500 });
    }

    updatedSlips.push(updated);

    // Audit log per slip
    await logAudit({
      action: 'scan_book',
      userId: guard.userId,
      userName: bookingUserName,
      slipId: ref.slipId,
      clientId: ref.clientId,
      detail: isMulti
        ? `Multi-slip booking — ${boxes.length} box${boxes.length !== 1 ? 'es' : ''} scanned for ${ref.slipId} (booked with: ${slipIdsList}). Rep: ${repName}`
        : `Stock booked — ${boxes.length} box${boxes.length !== 1 ? 'es' : ''} scanned for ${ref.slipId}. Rep: ${repName}`,
    });
  }

  return NextResponse.json(
    {
      ok: true,
      slip: updatedSlips[0],  // backward compat
      slips: updatedSlips,
      linkErrors,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
