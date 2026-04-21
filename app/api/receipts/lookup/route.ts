import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { findStickerByBarcode } from '@/lib/stickerData';

export const dynamic = 'force-dynamic';

/**
 * GET /api/receipts/lookup?barcode=STK-GAU-0001
 *
 * Validate a scanned barcode — returns sticker info + whether it's
 * already linked to another pick slip.
 */
export async function GET(req: NextRequest) {
  const guard = await requirePermission(req, 'receipt_stock');
  if (guard instanceof NextResponse) return guard;

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
      linkedPickSlipId: sticker.linkedPickSlipId ?? null,
      linkedAt: sticker.linkedAt ?? null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
