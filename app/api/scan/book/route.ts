import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { loadControl } from '@/lib/controlData';
import { getPickSlipRun, updateSlipInRun, type ReceiptBox } from '@/lib/pickSlipData';
import {
  saveBatch,
  nextStickerSequence,
  type StickerBatch,
  type Sticker,
} from '@/lib/stickerData';
import { generateStickerPdf, type StickerFieldData } from '@/lib/stickerPdf';
import { loadSettings } from '@/lib/settingsData';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

interface RepRecord {
  id: string;
  name: string;
  surname: string;
  releaseCode?: string;
}

interface Warehouse {
  id: string;
  name: string;
  code: string;
}

interface SlipRef {
  slipId: string;
  clientId: string;
  loadId: string;
  boxCount: number;
}

/**
 * POST /api/scan/book
 *
 * Book stock into a warehouse via the scan screen.
 * Generates pre-filled sticker labels on the fly, creates a batch,
 * links them to the pick slip(s), books the stock, and returns a
 * base64 PDF for printing.
 *
 * Body: { slips: [{ slipId, clientId, loadId, boxCount }], repId, securityCode }
 *       OR nothingToReturn mode: { slips: [...], repId, securityCode, nothingToReturn: true }
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'scan_stock');
  if (guard instanceof NextResponse) return guard;

  const body = await req.json();
  const { repId, securityCode } = body as {
    repId: string;
    securityCode: string;
  };

  // Normalize to slips array
  let slips: SlipRef[];
  if (body.slips && Array.isArray(body.slips)) {
    slips = body.slips;
  } else if (body.slipId && body.clientId && body.loadId) {
    slips = [{
      slipId: body.slipId,
      clientId: body.clientId,
      loadId: body.loadId,
      boxCount: typeof body.boxCount === 'number' ? body.boxCount : 0,
    }];
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

  const nothingToReturn = body.nothingToReturn === true;

  if (!nothingToReturn) {
    for (const ref of slips) {
      if (!ref.boxCount || ref.boxCount < 1) {
        return NextResponse.json({ error: `Box count is required for slip ${ref.slipId}` }, { status: 400 });
      }
    }
  }

  // Validate all slips exist and are bookable BEFORE making changes
  const bookableStatuses = ['generated', 'sent'];
  interface SlipDetail {
    ref: SlipRef;
    clientName: string;
    vendorNumber: string;
    siteCode: string;
    siteName: string;
    warehouseCode: string;
    warehouseName: string;
  }
  const slipDetails: SlipDetail[] = [];

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
    slipDetails.push({
      ref,
      clientName: slip.clientName || '',
      vendorNumber: slip.vendorNumber || '',
      siteCode: slip.siteCode || '',
      siteName: slip.siteName || '',
      warehouseCode: slip.warehouseCode || '',
      warehouseName: slip.warehouse || '',
    });
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

  // Get booking user info
  const bookingUser = users.find(u => u.id === guard.userId);
  const bookingUserName = bookingUser ? `${bookingUser.name} ${bookingUser.surname}`.trim() : guard.userId;
  const repName = match ? `${match.name} ${match.surname}`.trim() : repId;

  const todayStr = new Date().toLocaleDateString('en-ZA', { day: '2-digit', month: '2-digit', year: 'numeric' });

  // ── Generate stickers (skip when nothing to return) ──

  let pdfBase64: string | undefined;
  const allGeneratedBoxes: ReceiptBox[] = [];

  if (!nothingToReturn) {
    // Determine warehouse code for barcode prefix — use first slip's warehouse
    const primaryWh = slipDetails[0].warehouseCode || 'WH';

    // Resolve warehouse name for batch metadata
    const warehouses = await loadControl<Warehouse>('warehouses');
    const whRecord = warehouses.find(w => w.code === primaryWh);
    const whName = whRecord?.name || slipDetails[0].warehouseName || primaryWh;

    // Get the next sequence number for this warehouse
    let seq = await nextStickerSequence(primaryWh);

    const allStickers: Sticker[] = [];
    const pdfStickers: Array<{ barcodeValue: string; fields?: StickerFieldData }> = [];

    for (const detail of slipDetails) {
      const boxCount = detail.ref.boxCount;

      for (let box = 1; box <= boxCount; box++) {
        const seqStr = String(seq).padStart(4, '0');
        const barcodeValue = `STK-${primaryWh}-${seqStr}`;
        const stickerId = crypto.randomUUID();

        // Create sticker with pre-linked slip
        allStickers.push({
          id: stickerId,
          barcodeValue,
          linkedPickSlipIds: [detail.ref.slipId],
          linkedPickSlipId: detail.ref.slipId,
          linkedAt: new Date().toISOString(),
        });

        // PDF sticker with pre-filled fields
        pdfStickers.push({
          barcodeValue,
          fields: {
            siteCode: detail.siteCode,
            date: todayStr,
            storeName: detail.siteName,
            referenceNumber: detail.ref.slipId,
            vendorName: detail.clientName,
            vendorCode: detail.vendorNumber,
            repName,
            boxNumber: box,
            totalBoxes: boxCount,
          },
        });

        // Build receipt box entries for the slip update
        allGeneratedBoxes.push({
          id: stickerId,
          stickerBarcode: barcodeValue,
          scannedAt: new Date().toISOString(),
        });

        seq++;
      }
    }

    // Save sticker batch
    const batchId = crypto.randomUUID();
    const batch: StickerBatch = {
      id: batchId,
      warehouseCode: primaryWh,
      warehouseName: whName,
      quantity: allStickers.length,
      createdAt: new Date().toISOString(),
      createdBy: guard.userId,
      createdByName: bookingUserName,
      stickers: allStickers,
    };
    await saveBatch(batch);

    // Generate PDF
    const stickerSettings = await loadSettings();
    const pdfBuffer = await generateStickerPdf({
      stickers: pdfStickers,
      warehouseName: whName,
      stickerWidthMm: stickerSettings.sticker.widthMm,
      stickerHeightMm: stickerSettings.sticker.heightMm,
    });
    pdfBase64 = pdfBuffer.toString('base64');
  }

  // ── Update each slip with booking data ──

  const isMulti = slips.length > 1;
  const allSlipIds = slips.map(s => s.slipId);
  const slipIdsList = allSlipIds.join(', ');
  const updatedSlips = [];

  // Track which boxes belong to which slip for per-slip receiptBoxes
  let boxOffset = 0;

  for (const detail of slipDetails) {
    const boxCount = nothingToReturn ? 0 : detail.ref.boxCount;
    const slipBoxes = allGeneratedBoxes.slice(boxOffset, boxOffset + boxCount);
    boxOffset += boxCount;

    const updated = await updateSlipInRun(detail.ref.clientId, detail.ref.loadId, detail.ref.slipId, {
      status: 'booked',
      bookedAt: new Date().toISOString(),
      bookedBy: guard.userId,
      bookedByName: bookingUserName,
      bookedRepId: repId,
      bookedRepName: repName,
      receiptBoxes: slipBoxes,
      receiptTotalBoxes: boxCount,
    });

    if (!updated) {
      return NextResponse.json({ error: `Failed to update pick slip ${detail.ref.slipId}` }, { status: 500 });
    }

    updatedSlips.push(updated);

    // Audit log per slip
    await logAudit({
      action: 'scan_book',
      userId: guard.userId,
      userName: bookingUserName,
      slipId: detail.ref.slipId,
      clientId: detail.ref.clientId,
      detail: nothingToReturn
        ? `Stock booked (nothing to return) for ${detail.ref.slipId}. Rep: ${repName}`
        : isMulti
        ? `Multi-slip booking — ${boxCount} sticker${boxCount !== 1 ? 's' : ''} generated for ${detail.ref.slipId} (booked with: ${slipIdsList}). Rep: ${repName}`
        : `Stock booked — ${boxCount} sticker${boxCount !== 1 ? 's' : ''} generated for ${detail.ref.slipId}. Rep: ${repName}`,
    });
  }

  return NextResponse.json(
    {
      ok: true,
      slip: updatedSlips[0],  // backward compat
      slips: updatedSlips,
      ...(pdfBase64 ? { pdfBase64 } : {}),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
