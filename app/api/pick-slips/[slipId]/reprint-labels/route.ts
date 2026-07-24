import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { getPickSlipRun, type ReceiptBox } from '@/lib/pickSlipData';
import { generateStickerPdf } from '@/lib/stickerPdf';
import { loadSettings, resolveLayout, profileFor } from '@/lib/settingsData';
import { loadUsers } from '@/lib/userData';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

/**
 * POST /api/pick-slips/[slipId]/reprint-labels
 *
 * Regenerate a sticker PDF for one or more of a slip's existing box labels —
 * for when a physical sticker is lost or damaged and needs a fresh copy with
 * the *same* barcode. Non-destructive: it does not touch the box records or
 * their sticker links, so it's allowed in any status (unlike Adjust/Remove).
 *
 * Reprints reproduce the original blank-field sticker (barcode + ruled fields),
 * so the reprint is a true like-for-like replacement of the printed label.
 *
 * Body:  { clientId, loadId, barcodes: string[] }
 * Query: ?format=roll|a4sheet  (defaults to the configured sticker layout;
 *        the UI sends `roll` — one label per page — for individual reprints)
 * Returns: application/pdf
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slipId: string }> },
) {
  const { slipId } = await params;

  // Non-destructive — same gate as downloading a sticker batch PDF.
  const guard = await requirePermission(req, 'view_aged_stock');
  if (guard instanceof NextResponse) return guard;

  let body: { clientId?: string; loadId?: string; barcodes?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
  const loadId = typeof body.loadId === 'string' ? body.loadId.trim() : '';
  const barcodes = Array.isArray(body.barcodes)
    ? [...new Set(body.barcodes.filter((b): b is string => typeof b === 'string' && !!b.trim()).map(b => b.trim()))]
    : [];

  if (!clientId || !loadId) {
    return NextResponse.json({ error: 'clientId and loadId are required' }, { status: 400 });
  }
  if (barcodes.length === 0) {
    return NextResponse.json({ error: 'Select at least one label to reprint' }, { status: 400 });
  }

  const run = await getPickSlipRun(clientId, loadId);
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

  const slip = run.slips.find(s => s.id === slipId);
  if (!slip) return NextResponse.json({ error: 'Slip not found' }, { status: 404 });

  const currentBoxes: ReceiptBox[] = slip.receiptBoxes ?? [];

  // Every barcode asked for must actually be a box on this slip. Emit the PDF in
  // the slip's box order so a multi-label reprint matches the physical sequence.
  const notOnSlip = barcodes.filter(b => !currentBoxes.some(box => box.stickerBarcode === b));
  if (notOnSlip.length > 0) {
    return NextResponse.json({ error: `Not on this slip: ${notOnSlip.join(', ')}` }, { status: 409 });
  }
  const orderedBarcodes = currentBoxes
    .map(box => box.stickerBarcode)
    .filter(bc => barcodes.includes(bc));

  const settings = await loadSettings();
  const layout = resolveLayout(settings, new URL(req.url).searchParams.get('format'));
  const profile = profileFor(settings, layout);

  const pdfBuffer = await generateStickerPdf({
    stickers: orderedBarcodes.map(barcodeValue => ({ barcodeValue })),
    warehouseName: slip.warehouse,
    stickerWidthMm: profile.widthMm,
    stickerHeightMm: profile.heightMm,
    layout,
    gapMm: profile.gapMm,
    marginTopMm: profile.marginTop,
    marginBottomMm: profile.marginBottom,
    marginLeftMm: profile.marginLeft,
    marginRightMm: profile.marginRight,
  });

  // Light audit trail — who reprinted which labels, and for which slip.
  loadUsers()
    .then(users => {
      const me = users.find(u => u.id === guard.userId);
      const myName = me ? `${me.name} ${me.surname}`.trim() : guard.userId;
      return logAudit({
        action: 'pick-slip-reprint-labels',
        userId: guard.userId,
        userName: myName,
        slipId,
        clientId,
        detail:
          `Reprinted ${orderedBarcodes.length} label${orderedBarcodes.length !== 1 ? 's' : ''} for ${slipId} ` +
          `(${layout}): ${orderedBarcodes.join(', ')}.`,
      });
    })
    .catch(err => console.error('[reprint-labels] audit log failed:', err));

  const fmtTag = layout === 'a4sheet' ? 'A4' : 'Roll';
  const fileName = `Reprint - ${slipId} - ${orderedBarcodes.length}pcs - ${fmtTag}.pdf`;

  return new Response(new Uint8Array(pdfBuffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    },
  });
}
