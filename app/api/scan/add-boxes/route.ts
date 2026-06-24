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
import { loadSettings, resolveLayout, profileFor } from '@/lib/settingsData';
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

/**
 * POST /api/scan/add-boxes
 *
 * Add additional sticker labels to an ALREADY-BOOKED pick slip. Used when the
 * wrong box count was entered at book time and more boxes/stickers are needed.
 *
 * Generates the extra stickers (continuing the warehouse barcode sequence and
 * the box-number sequence), saves a new sticker batch linked to the slip,
 * appends the new boxes to the slip's `receiptBoxes`, bumps `receiptTotalBoxes`,
 * and returns a base64 PDF of ONLY the new stickers for printing.
 *
 * Only allowed while the slip is still "booked" (before receipt capture).
 *
 * Body: { slipId, clientId, loadId, additionalBoxes, repId, securityCode, format? }
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'scan_stock');
  if (guard instanceof NextResponse) return guard;

  const body = await req.json();
  const { slipId, clientId, loadId, repId, securityCode } = body as {
    slipId?: string;
    clientId?: string;
    loadId?: string;
    repId?: string;
    securityCode?: string;
  };
  const additionalBoxes =
    typeof body.additionalBoxes === 'number'
      ? body.additionalBoxes
      : parseInt(body.additionalBoxes, 10);

  if (!slipId || !clientId || !loadId) {
    return NextResponse.json({ error: 'slipId, clientId and loadId are required' }, { status: 400 });
  }
  if (!additionalBoxes || additionalBoxes < 1) {
    return NextResponse.json({ error: 'additionalBoxes must be at least 1' }, { status: 400 });
  }
  if (!repId) {
    return NextResponse.json({ error: 'repId is required' }, { status: 400 });
  }
  if (!securityCode) {
    return NextResponse.json({ error: 'securityCode is required' }, { status: 400 });
  }

  // Load the slip and confirm it can still take more boxes
  const run = await getPickSlipRun(clientId, loadId);
  if (!run) {
    return NextResponse.json({ error: `Pick slip run not found for ${slipId}` }, { status: 404 });
  }
  const slip = run.slips.find(s => s.id === slipId);
  if (!slip) {
    return NextResponse.json({ error: `Pick slip ${slipId} not found` }, { status: 404 });
  }
  if (slip.status !== 'booked') {
    return NextResponse.json(
      { error: `Pick slip ${slipId} is "${slip.status}" — boxes can only be added while it is Booked` },
      { status: 409 },
    );
  }
  if (slip.nothingToReturn) {
    return NextResponse.json(
      { error: `Pick slip ${slipId} was booked as "nothing to return" — there are no boxes to add` },
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
  if (securityCode.toUpperCase() !== matchReleaseCode.toUpperCase()) {
    return NextResponse.json({ error: 'Security code does not match' }, { status: 403 });
  }

  const bookingUser = users.find(u => u.id === guard.userId);
  const bookingUserName = bookingUser ? `${bookingUser.name} ${bookingUser.surname}`.trim() : guard.userId;
  const repName = `${match.name} ${match.surname}`.trim();
  const todayStr = new Date().toLocaleDateString('en-ZA', { day: '2-digit', month: '2-digit', year: 'numeric' });

  // Resolve warehouse + next barcode sequence
  const primaryWh = slip.warehouseCode || 'WH';
  const warehouses = await loadControl<Warehouse>('warehouses');
  const whRecord = warehouses.find(w => w.code === primaryWh);
  const whName = whRecord?.name || slip.warehouse || primaryWh;
  let seq = await nextStickerSequence(primaryWh);

  // Continue box numbering from the boxes already on the slip
  const existingBoxes: ReceiptBox[] = slip.receiptBoxes ?? [];
  const startBox = existingBoxes.length;          // boxes already printed
  const newTotal = startBox + additionalBoxes;    // new grand total

  const newStickers: Sticker[] = [];
  const pdfStickers: Array<{ barcodeValue: string; fields?: StickerFieldData }> = [];
  const newBoxes: ReceiptBox[] = [];

  for (let i = 1; i <= additionalBoxes; i++) {
    const seqStr = String(seq).padStart(4, '0');
    const barcodeValue = `STK-${primaryWh}-${seqStr}`;
    const stickerId = crypto.randomUUID();

    newStickers.push({
      id: stickerId,
      barcodeValue,
      linkedPickSlipIds: [slip.id],
      linkedPickSlipId: slip.id,
      linkedAt: new Date().toISOString(),
    });

    pdfStickers.push({
      barcodeValue,
      fields: {
        siteCode: slip.siteCode,
        date: todayStr,
        storeName: slip.siteName,
        referenceNumber: slip.id,
        vendorName: slip.clientName,
        vendorCode: slip.vendorNumber,
        repName,
        boxNumber: startBox + i,
        totalBoxes: newTotal,
      },
    });

    newBoxes.push({
      id: stickerId,
      stickerBarcode: barcodeValue,
      scannedAt: new Date().toISOString(),
    });

    seq++;
  }

  // Save the new sticker batch
  const batchId = crypto.randomUUID();
  const batch: StickerBatch = {
    id: batchId,
    warehouseCode: primaryWh,
    warehouseName: whName,
    quantity: newStickers.length,
    createdAt: new Date().toISOString(),
    createdBy: guard.userId,
    createdByName: bookingUserName,
    stickers: newStickers,
  };
  await saveBatch(batch);

  // Generate the PDF for the new stickers only
  const stickerSettings = await loadSettings();
  const layout = resolveLayout(stickerSettings, typeof body.format === 'string' ? body.format : null);
  const profile = profileFor(stickerSettings, layout);
  const pdfBuffer = await generateStickerPdf({
    stickers: pdfStickers,
    warehouseName: whName,
    stickerWidthMm: profile.widthMm,
    stickerHeightMm: profile.heightMm,
    layout,
    gapMm: profile.gapMm,
    marginTopMm: profile.marginTop,
    marginBottomMm: profile.marginBottom,
    marginLeftMm: profile.marginLeft,
    marginRightMm: profile.marginRight,
  });
  const pdfBase64 = pdfBuffer.toString('base64');

  // Append the new boxes to the slip and bump the total
  const updated = await updateSlipInRun(clientId, loadId, slip.id, {
    receiptBoxes: [...existingBoxes, ...newBoxes],
    receiptTotalBoxes: newTotal,
  });
  if (!updated) {
    return NextResponse.json({ error: `Failed to update pick slip ${slip.id}` }, { status: 500 });
  }

  await logAudit({
    action: 'scan_add_boxes',
    userId: guard.userId,
    userName: bookingUserName,
    slipId: slip.id,
    clientId,
    detail: `Added ${additionalBoxes} more box${additionalBoxes !== 1 ? 'es' : ''} to ${slip.id} (now ${newTotal} total). Rep: ${repName}`,
  });

  return NextResponse.json(
    {
      ok: true,
      slip: updated,
      addedBoxes: additionalBoxes,
      totalBoxes: newTotal,
      pdfBase64,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
