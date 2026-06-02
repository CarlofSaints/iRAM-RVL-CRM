import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { getBatch } from '@/lib/stickerData';
import { generateStickerPdf } from '@/lib/stickerPdf';
import { loadSettings } from '@/lib/settingsData';

export const dynamic = 'force-dynamic';

/**
 * GET /api/stickers/[batchId] — Download sticker PDF for a batch.
 *
 * PDF is regenerated on demand (not stored in Blob — keeps storage lean).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ batchId: string }> }
) {
  const { batchId } = await params;
  const guard = await requirePermission(req, 'view_aged_stock');
  if (guard instanceof NextResponse) return guard;

  const batch = await getBatch(batchId);
  if (!batch) {
    return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
  }

  const settings = await loadSettings();

  const pdfBuffer = await generateStickerPdf({
    stickers: batch.stickers.map(s => ({ barcodeValue: s.barcodeValue })),
    warehouseName: batch.warehouseName,
    stickerWidthMm: settings.sticker.widthMm,
    stickerHeightMm: settings.sticker.heightMm,
    layout: settings.sticker.layout,
    marginTopMm: settings.sticker.marginTop,
    marginBottomMm: settings.sticker.marginBottom,
    marginLeftMm: settings.sticker.marginLeft,
    marginRightMm: settings.sticker.marginRight,
  });

  const dateStr = batch.createdAt.slice(0, 10); // YYYY-MM-DD
  const fileName = `Stickers - ${batch.warehouseCode} - ${dateStr} - ${batch.quantity}pcs.pdf`;

  return new Response(new Uint8Array(pdfBuffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    },
  });
}
