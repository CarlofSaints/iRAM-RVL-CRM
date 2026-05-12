import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { getPickSlipRun, findAllSlipsByDeliveryToken } from '@/lib/pickSlipData';
import { loadControl } from '@/lib/controlData';
import { listLoads } from '@/lib/agedStockData';
import { generateDeliveryNotePdf, generateMultiSlipDeliveryNotePdf } from '@/lib/deliveryNotePdf';
import { sendDeliveryNoteEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

/**
 * POST /api/pick-slips/send-dn — Re-generate and email a delivery note PDF.
 *
 * Multi-slip aware: finds all slips sharing the same deliveryToken.
 * If >1, uses multi-slip PDF. If 1, uses existing single-slip generator.
 *
 * Body: { slipId, clientId, loadId, to: string[], cc?: string[], bcc?: string[] }
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'manage_pick_slips');
  if (guard instanceof NextResponse) return guard;

  let body: {
    slipId?: string;
    clientId?: string;
    loadId?: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
  };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const { slipId, clientId, loadId } = body;
  const to = Array.isArray(body.to) ? body.to.filter(Boolean) : [];

  if (!slipId || !clientId || !loadId) {
    return NextResponse.json({ error: 'slipId, clientId, and loadId are required' }, { status: 400 });
  }
  if (to.length === 0) {
    return NextResponse.json({ error: 'At least one TO email is required' }, { status: 400 });
  }

  // Load the slip
  const run = await getPickSlipRun(clientId, loadId);
  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }
  const slip = run.slips.find(s => s.id === slipId);
  if (!slip) {
    return NextResponse.json({ error: 'Pick slip not found' }, { status: 404 });
  }

  if (!slip.deliveryToken) {
    return NextResponse.json({ error: 'No delivery token — stock has not been released yet' }, { status: 400 });
  }

  // Build QR URL
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
  const qrUrl = `${baseUrl}/delivery/${slip.deliveryToken}`;

  // Find ALL slips sharing this delivery token (multi-slip check)
  const clients = await loadControl<{ id: string; name: string }>('clients');
  const clientIds = clients.map(c => c.id);
  const allTokenSlips = await findAllSlipsByDeliveryToken(slip.deliveryToken, clientIds, listLoads);
  const isMulti = allTokenSlips.length > 1;

  try {
    let pdfBuffer: Buffer;
    let filename: string;

    if (isMulti) {
      // Multi-slip delivery note
      pdfBuffer = await generateMultiSlipDeliveryNotePdf({
        clientName: slip.clientName,
        vendorNumber: slip.vendorNumber,
        releaseRepName: slip.releaseRepName ?? 'Unknown',
        releasedAt: slip.releasedAt ?? new Date().toISOString(),
        qrUrl,
        slips: allTokenSlips.map(({ slip: s }) => ({
          pickSlipId: s.id,
          siteName: s.siteName,
          siteCode: s.siteCode,
          warehouse: s.warehouse,
          storeRefs: s.receiptStoreRefs ?? [],
          receiptGrnDate: s.receiptGrnDate,
          manual: s.manual,
          rows: (s.rows ?? []).map(r => ({
            articleCode: r.articleCode,
            description: r.description,
            qty: r.qty,
            val: r.val,
          })),
          stickerBarcodes: (s.releaseBoxes ?? []).map(b => b.stickerBarcode),
        })),
        signature: slip.deliverySignature,
        signedByName: slip.deliverySignedByName,
        deliveredAt: slip.deliveredAt,
      });

      const dateFmt = (slip.releasedAt ?? new Date().toISOString()).slice(0, 10);
      const last3s = allTokenSlips.map(r => r.slip.id.slice(-3)).join(', ');
      filename = `DN - ${slip.clientName} - ${dateFmt} (${last3s}).pdf`;
    } else {
      // Single-slip delivery note (existing behavior)
      const storeRefs: string[] = slip.receiptStoreRefs ?? [];
      if (storeRefs.length === 0) {
        for (const key of ['receiptStoreRef1', 'receiptStoreRef2', 'receiptStoreRef3', 'receiptStoreRef4'] as const) {
          const v = slip[key];
          if (v) storeRefs.push(v);
        }
      }

      const dnRows = (slip.rows ?? []).map(r => ({
        articleCode: r.articleCode,
        description: r.description,
        qty: r.qty,
        val: r.val,
      }));

      const boxCount = slip.releaseBoxes?.length ?? slip.receiptTotalBoxes ?? 0;
      const stickerBarcodes = slip.releaseBoxes?.map(b => b.stickerBarcode).filter(Boolean) ?? [];

      pdfBuffer = await generateDeliveryNotePdf({
        pickSlipId: slip.id,
        clientName: slip.clientName,
        vendorNumber: slip.vendorNumber,
        siteName: slip.siteName,
        siteCode: slip.siteCode,
        warehouse: slip.warehouse,
        releaseRepName: slip.releaseRepName ?? 'Unknown',
        releasedAt: slip.releasedAt ?? new Date().toISOString(),
        storeRefs,
        manual: slip.manual,
        rows: dnRows,
        boxCount,
        stickerBarcodes,
        qrUrl,
        signature: slip.deliverySignature,
        signedByName: slip.deliverySignedByName,
        deliveredAt: slip.deliveredAt,
      });

      filename = `DN-${slip.id}.pdf`;
    }

    // Send via email
    const totalBoxes = isMulti
      ? allTokenSlips.reduce((s, r) => s + (r.slip.releaseBoxes?.length ?? 0), 0)
      : (slip.releaseBoxes?.length ?? slip.receiptTotalBoxes ?? 0);
    const totalQty = isMulti
      ? allTokenSlips.reduce((s, r) => s + r.slip.totalQty, 0)
      : slip.totalQty;

    const subject = isMulti
      ? `Delivery Note — ${allTokenSlips.length} slips — ${slip.clientName}`
      : `Delivery Note ${slip.id} — ${slip.clientName} — ${slip.siteName} (${slip.siteCode})`;

    await sendDeliveryNoteEmail({
      to,
      subject,
      pickSlipId: isMulti ? allTokenSlips.map(r => r.slip.id).join(', ') : slip.id,
      siteName: isMulti ? `${allTokenSlips.length} stores` : slip.siteName,
      siteCode: isMulti ? '' : slip.siteCode,
      warehouse: slip.warehouse,
      releaseRepName: slip.releaseRepName ?? 'Unknown',
      releasedAt: slip.releasedAt ?? '',
      boxCount: totalBoxes,
      totalQty,
      qrUrl,
      attachments: [{ filename, content: pdfBuffer }],
    });

    return NextResponse.json(
      { ok: true },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    console.error('[send-dn] Failed:', err);
    return NextResponse.json(
      { error: `Failed to send delivery note: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
