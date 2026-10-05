import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { getBatch } from '@/lib/stickerData';
import { resolveWarehouseAccess, denyIfOutOfScope } from '@/lib/warehouseScopeServer';
import { generateStickerPdf } from '@/lib/stickerPdf';
import { loadSettings, resolveLayout, profileFor } from '@/lib/settingsData';
import { loadUsers } from '@/lib/userData';
import { loadControl } from '@/lib/controlData';
import { clientScopeFor, filterClientIdsByScope } from '@/lib/clientScope';
import { stickerFieldsForBarcodes } from '@/lib/stickerFields';

export const dynamic = 'force-dynamic';

/**
 * GET /api/stickers/[batchId] — Download sticker PDF for a batch.
 *
 * PDF is regenerated on demand (not stored in Blob — keeps storage lean).
 *
 * A label already on a pick slip prints FILLED (store, vendor, reference, rep,
 * box N of M), read back off the slip — a reprint of a booked roll must match
 * what was stuck on the boxes. Labels on no slip print as the blank template.
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

  // Warehouse scoping — otherwise anyone could print another warehouse's labels
  // straight from a batch id.
  const access = await resolveWarehouseAccess(guard.userId);
  const denied = denyIfOutOfScope(access, [batch.warehouseCode], 'Sticker download');
  if (denied) return denied;

  const settings = await loadSettings();

  // Format chosen at print time (?format=roll|a4sheet); falls back to the default.
  const layout = resolveLayout(settings, new URL(req.url).searchParams.get('format'));
  const profile = profileFor(settings, layout);

  // Client scope — a restricted user gets blank fields for stores they can't see.
  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  const scope = clientScopeFor({
    role: me?.role ?? '',
    permissions: guard.permissions,
    linkedClientId: me?.linkedClientId,
    assignedClientIds: me?.assignedClientIds,
  });
  const allClients = await loadControl<{ id: string; vendorNumbers?: string[] }>('clients');
  const allowed = new Set(filterClientIdsByScope(scope, allClients.map(c => c.id)));
  const fieldsByBarcode = await stickerFieldsForBarcodes(
    batch.stickers.map(s => s.barcodeValue),
    batch.stickers.flatMap(s => [...(s.linkedPickSlipIds ?? []), ...(s.linkedPickSlipId ? [s.linkedPickSlipId] : [])]),
    allClients.filter(c => allowed.has(c.id)),
  );

  const pdfBuffer = await generateStickerPdf({
    stickers: batch.stickers.map(s => ({
      barcodeValue: s.barcodeValue,
      fields: fieldsByBarcode.get(s.barcodeValue.toUpperCase().trim()),
    })),
    warehouseName: batch.warehouseName,
    stickerWidthMm: profile.widthMm,
    stickerHeightMm: profile.heightMm,
    layout,
    gapMm: profile.gapMm,
    marginTopMm: profile.marginTop,
    marginBottomMm: profile.marginBottom,
    marginLeftMm: profile.marginLeft,
    marginRightMm: profile.marginRight,
  });

  const dateStr = batch.createdAt.slice(0, 10); // YYYY-MM-DD
  const fmtTag = layout === 'a4sheet' ? 'A4' : 'Roll';
  const fileName = `Stickers - ${batch.warehouseCode} - ${dateStr} - ${batch.quantity}pcs - ${fmtTag}.pdf`;

  return new Response(new Uint8Array(pdfBuffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    },
  });
}
