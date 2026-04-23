import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { findStickerByBarcode } from '@/lib/stickerData';

export const dynamic = 'force-dynamic';

/**
 * GET /api/receipts/lookup?barcode=STK-GAU-0001
 *
 * Validate a scanned barcode — returns sticker info + whether it's
 * already linked to pick slip(s).
 *
 * Gated by `receipt_stock` OR `scan_stock` — the scan screen also
 * needs to validate barcodes before booking.
 */
export async function GET(req: NextRequest) {
  // Allow either receipt_stock or scan_stock
  let guard = await requirePermission(req, 'receipt_stock');
  if (guard instanceof NextResponse) {
    guard = await requirePermission(req, 'scan_stock');
    if (guard instanceof NextResponse) return guard;
  }

  const barcode = req.nextUrl.searchParams.get('barcode')?.trim();
  if (!barcode) {
    return NextResponse.json({ error: 'barcode query param is required' }, { status: 400 });
  }

  const sticker = await findStickerByBarcode(barcode);
  if (!sticker) {
    return NextResponse.json(
      { found: false, barcode },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return NextResponse.json(
    {
      found: true,
      barcode: sticker.barcodeValue,
      stickerId: sticker.id,
      batchId: sticker.batchId,
      warehouseCode: sticker.warehouseCode,
      warehouseName: sticker.warehouseName,
      linkedPickSlipId: sticker.linkedPickSlipIds[0] ?? null, // backward compat
      linkedPickSlipIds: sticker.linkedPickSlipIds,            // new: full array
      linkedAt: sticker.linkedAt ?? null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
