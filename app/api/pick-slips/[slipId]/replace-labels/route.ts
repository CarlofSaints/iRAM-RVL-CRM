import { NextRequest, NextResponse } from 'next/server';
import { requireLogin } from '@/lib/rolesData';
import { getPickSlipRun, updateSlipInRun, type ReceiptBox } from '@/lib/pickSlipData';
import { resolveWarehouseAccess, denyIfOutOfScope } from '@/lib/warehouseScopeServer';
import {
  reserveStickerSequence,
  saveBatch,
  unlinkStickerFromSlip,
  type Sticker,
  type StickerBatch,
} from '@/lib/stickerData';
import { loadControl } from '@/lib/controlData';
import { generateStickerPdf, type StickerFieldData } from '@/lib/stickerPdf';
import { loadSettings, resolveLayout, profileFor } from '@/lib/settingsData';
import { loadUsers } from '@/lib/userData';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

interface Warehouse { id: string; name: string; code: string }

/**
 * POST /api/pick-slips/[slipId]/replace-labels
 *
 * Swap one or more of a slip's box labels for FRESH barcodes. The box is the
 * same physical box — only the number on the outside changes.
 *
 * Exists because a barcode can be poisoned while the box is perfectly real: the
 * 7 Aug 2026 sticker wipe reset barcode numbering, so 193 numbers ended up on
 * two slips each and a scan could not tell the two boxes apart. None of the
 * existing tools could fix that:
 *   - Adjust Boxes REMOVES a box, and refuses to remove a slip's only box;
 *   - Add Boxes only works on a `booked` slip, so a `captured` one cannot even
 *     be given a spare box first;
 *   - Reverse works, but undoes the booking AND wipes the GRN capture.
 * Replacing the label destroys nothing: the box record, its scan time and every
 * captured value stay exactly as they are.
 *
 * Body:  { clientId, loadId, barcodes: string[], reason }
 * Query: ?format=roll|a4sheet  (defaults to the configured sticker layout)
 * Returns: application/pdf — the new labels, to print and stick over the old.
 */
const REPLACEABLE_STATUSES = new Set(['booked', 'captured', 'failed-release']);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slipId: string }> },
) {
  const { slipId } = await params;

  const guard = await requireLogin(req);
  if (guard instanceof NextResponse) return guard;

  // Same gate as Adjust Boxes / Reverse — it rewrites the operative box record.
  const allowed = guard.userRole === 'super-admin' || guard.permissions.includes('revert_pick_slips');
  if (!allowed) {
    return NextResponse.json({ error: 'Forbidden — Super Admin only' }, { status: 403 });
  }

  let body: { clientId?: string; loadId?: string; barcodes?: unknown; reason?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
  const loadId = typeof body.loadId === 'string' ? body.loadId.trim() : '';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const barcodes = Array.isArray(body.barcodes)
    ? [...new Set(body.barcodes.filter((b): b is string => typeof b === 'string' && !!b.trim()).map(b => b.trim()))]
    : [];

  if (!clientId || !loadId) {
    return NextResponse.json({ error: 'clientId and loadId are required' }, { status: 400 });
  }
  if (barcodes.length === 0) {
    return NextResponse.json({ error: 'Select at least one label to replace' }, { status: 400 });
  }
  if (!reason) {
    return NextResponse.json({ error: 'A reason is required' }, { status: 400 });
  }

  const run = await getPickSlipRun(clientId, loadId);
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

  const slip = run.slips.find(s => s.id === slipId);
  if (!slip) return NextResponse.json({ error: 'Slip not found' }, { status: 404 });

  const whAccess = await resolveWarehouseAccess(guard.userId);
  const whDenied = denyIfOutOfScope(whAccess, [slip.warehouseCode || slip.warehouse], 'Label replacement');
  if (whDenied) return whDenied;

  if (!REPLACEABLE_STATUSES.has(slip.status)) {
    return NextResponse.json(
      {
        error:
          `Labels can only be replaced while a slip is Booked, Captured or Failed Release — ` +
          `this slip is "${slip.status}". Once released, the barcode is already on a delivery note.`,
      },
      { status: 409 },
    );
  }

  const currentBoxes: ReceiptBox[] = slip.receiptBoxes ?? [];
  const notOnSlip = barcodes.filter(b => !currentBoxes.some(box => box.stickerBarcode === b));
  if (notOnSlip.length > 0) {
    return NextResponse.json({ error: `Not on this slip: ${notOnSlip.join(', ')}` }, { status: 409 });
  }

  // ── Mint the replacements ────────────────────────────────────────────────
  // Reserve the block up front. The counter is monotonic and survives any data
  // clear, so a replacement can never collide with a number already in the wild
  // — which is the whole point of this endpoint.
  const primaryWh = slip.warehouseCode || 'WH';
  const warehouses = await loadControl<Warehouse>('warehouses');
  const whRecord = warehouses.find(w => w.code === primaryWh);
  const whName = whRecord?.name || slip.warehouse || primaryWh;

  let seq = await reserveStickerSequence(primaryWh, barcodes.length);
  const now = new Date().toISOString();
  const todayStr = new Date().toLocaleDateString('en-ZA', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  const myName = me ? `${me.name} ${me.surname}`.trim() : guard.userId;

  // Walk the slip's own box order so printed labels come out in the same
  // sequence as the boxes on the pallet.
  const replacements = new Map<string, string>(); // old barcode -> new barcode
  for (const box of currentBoxes) {
    if (!barcodes.includes(box.stickerBarcode)) continue;
    replacements.set(box.stickerBarcode, `STK-${primaryWh}-${String(seq).padStart(4, '0')}`);
    seq++;
  }

  const newStickers: Sticker[] = [];
  const pdfStickers: Array<{ barcodeValue: string; fields?: StickerFieldData }> = [];

  const newBoxes: ReceiptBox[] = currentBoxes.map((box, i) => {
    const fresh = replacements.get(box.stickerBarcode);
    if (!fresh) return box;

    newStickers.push({
      id: crypto.randomUUID(),
      barcodeValue: fresh,
      linkedPickSlipIds: [slipId],
      linkedPickSlipId: slipId,
      linkedAt: now,
    });
    pdfStickers.push({
      barcodeValue: fresh,
      fields: {
        siteCode: slip.siteCode,
        date: todayStr,
        storeName: slip.siteName,
        referenceNumber: slipId,
        vendorName: slip.clientName,
        vendorCode: slip.vendorNumber,
        repName: slip.bookedRepName || '',
        boxNumber: i + 1,
        totalBoxes: currentBoxes.length,
      },
    });

    // Same box, same scan time — only the number on the outside changes.
    return {
      ...box,
      stickerBarcode: fresh,
      replacedBarcode: box.stickerBarcode,
      replacedAt: now,
    };
  });

  // Keep any already-scanned release boxes pointing at the same physical boxes.
  const newReleaseBoxes = (slip.releaseBoxes ?? []).map(box => {
    const fresh = replacements.get(box.stickerBarcode);
    return fresh
      ? { ...box, stickerBarcode: fresh, replacedBarcode: box.stickerBarcode, replacedAt: now }
      : box;
  });

  // Register the new stickers BEFORE the slip points at them, so a failure
  // never leaves the slip referencing a barcode no registry knows about.
  const batch: StickerBatch = {
    id: crypto.randomUUID(),
    warehouseCode: primaryWh,
    warehouseName: whName,
    quantity: newStickers.length,
    createdAt: now,
    createdBy: guard.userId,
    createdByName: myName,
    stickers: newStickers,
  };
  await saveBatch(batch);

  const patch: Record<string, unknown> = { receiptBoxes: newBoxes };
  if (slip.releaseBoxes) patch.releaseBoxes = newReleaseBoxes;

  const updated = await updateSlipInRun(clientId, loadId, slipId, patch);
  if (!updated) {
    return NextResponse.json({ error: 'Failed to update pick slip' }, { status: 500 });
  }

  // Free the old barcodes from this slip. Done AFTER the swap: if this fails the
  // slip is already correct, and a stale link is recoverable where a lost one
  // is not.
  let stickersUnlinked = 0;
  for (const oldBarcode of replacements.keys()) {
    try {
      if (await unlinkStickerFromSlip(oldBarcode, slipId)) stickersUnlinked++;
    } catch (err) {
      console.error('[replace-labels] failed to unlink sticker', oldBarcode, err instanceof Error ? err.message : err);
    }
  }

  const pairs = [...replacements.entries()].map(([o, n]) => `${o} -> ${n}`).join(', ');
  logAudit({
    action: 'pick-slip-replace-labels',
    userId: guard.userId,
    userName: myName,
    slipId,
    clientId,
    detail:
      `Replaced ${replacements.size} box label${replacements.size !== 1 ? 's' : ''} on ${slipId} ` +
      `(${slip.siteName}): ${pairs}. Old barcodes unlinked: ${stickersUnlinked}. Reason: ${reason}`,
  }).catch(err => console.error('[replace-labels] audit log failed:', err));

  const settings = await loadSettings();
  const layout = resolveLayout(settings, new URL(req.url).searchParams.get('format'));
  const profile = profileFor(settings, layout);

  const pdfBuffer = await generateStickerPdf({
    stickers: pdfStickers,
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

  const fileName = `Replacement labels - ${slipId} - ${replacements.size}pcs.pdf`;

  return new Response(new Uint8Array(pdfBuffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
      // The UI has to tell the user which numbers were issued, and a PDF body
      // cannot carry JSON, so the mapping rides along in a header.
      'X-Label-Replacements': [...replacements.entries()].map(([o, n]) => `${o}=${n}`).join(','),
      'Access-Control-Expose-Headers': 'X-Label-Replacements',
    },
  });
}
