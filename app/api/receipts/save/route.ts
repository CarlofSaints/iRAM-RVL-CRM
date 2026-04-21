import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { updateSlipInRun, getPickSlipRun, type ReceiptBox } from '@/lib/pickSlipData';
import { findAndLinkSticker, unlinkSticker } from '@/lib/stickerData';

export const dynamic = 'force-dynamic';

/**
 * POST /api/receipts/save
 *
 * Save receipt fields + boxes for a pick slip. Links/unlinks stickers as needed.
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'receipt_stock');
  if (guard instanceof NextResponse) return guard;

  const body = await req.json();
  const { slipId, clientId, loadId, date, value, upliftedById, upliftedByName, storeRef1, storeRef2, storeRef3, storeRef4, boxes } = body as {
    slipId: string;
    clientId: string;
    loadId: string;
    date?: string;
    value?: string;
    upliftedById?: string;
    upliftedByName?: string;
    storeRef1?: string;
    storeRef2?: string;
    storeRef3?: string;
    storeRef4?: string;
    boxes?: ReceiptBox[];
  };

  if (!slipId || !clientId || !loadId) {
    return NextResponse.json({ error: 'slipId, clientId, and loadId are required' }, { status: 400 });
  }

  // Read current slip to determine which stickers to unlink
  const run = await getPickSlipRun(clientId, loadId);
  if (!run) {
    return NextResponse.json({ error: 'Pick slip run not found' }, { status: 404 });
  }
  const currentSlip = run.slips.find(s => s.id === slipId);
  if (!currentSlip) {
    return NextResponse.json({ error: 'Pick slip not found' }, { status: 404 });
  }

  // Determine removed boxes — unlink their stickers
  const newBarcodes = new Set((boxes ?? []).map(b => b.stickerBarcode));
  const oldBoxes = currentSlip.receiptBoxes ?? [];
  for (const old of oldBoxes) {
    if (!newBarcodes.has(old.stickerBarcode)) {
      await unlinkSticker(old.stickerBarcode);
    }
  }

  // Link new stickers
  const linkErrors: string[] = [];
  for (const box of (boxes ?? [])) {
    const existing = oldBoxes.find(o => o.stickerBarcode === box.stickerBarcode);
    if (existing) continue; // already linked from previous save
    const result = await findAndLinkSticker(box.stickerBarcode, slipId);
    if (!result) {
      linkErrors.push(`Barcode ${box.stickerBarcode} not found`);
    } else if (result.linkedPickSlipId && result.linkedPickSlipId !== slipId) {
      linkErrors.push(`Barcode ${box.stickerBarcode} already linked to ${result.linkedPickSlipId}`);
    }
  }

  // Persist receipt data on the pick slip
  const updated = await updateSlipInRun(clientId, loadId, slipId, {
    receiptDate: date,
    receiptValue: value,
    receiptUpliftedById: upliftedById,
    receiptUpliftedByName: upliftedByName,
    receiptStoreRef1: storeRef1,
    receiptStoreRef2: storeRef2,
    receiptStoreRef3: storeRef3,
    receiptStoreRef4: storeRef4,
    receiptBoxes: boxes ?? [],
  });

  if (!updated) {
    return NextResponse.json({ error: 'Failed to update pick slip' }, { status: 500 });
  }

  return NextResponse.json(
    { ok: true, linkErrors, slip: updated },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
