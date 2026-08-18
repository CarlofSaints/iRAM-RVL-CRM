import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { getClient } from '@/lib/spLinkData';
import { getSwapOut } from '@/lib/swapOutData';
import {
  generateSwapOutDeliveryNotePdf,
  signedSwapOutNoteFileName,
} from '@/lib/swapOutDeliveryNotePdf';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/swap-outs/[id]/delivery-note — the swap-out return delivery note.
 *
 * Rendered live rather than served from storage, so it always reflects the
 * current line quantities. Unsigned it carries the QR to the public sign-off
 * page; once signed it renders the signature block instead.
 *
 * Opens inline (a new tab) rather than downloading, matching the pick-slip
 * print behaviour.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(req, 'view_aged_stock');
  if (guard instanceof NextResponse) return guard;

  const { id } = await params;
  const rec = await getSwapOut(id);
  if (!rec) return NextResponse.json({ error: 'Swap-out not found' }, { status: 404 });
  if (!rec.deliveryToken) {
    return NextResponse.json(
      { error: 'Release the damaged stock first — the delivery note is created at release.' },
      { status: 409 }
    );
  }

  const client = await getClient(rec.clientId);
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';

  let pdf: Buffer;
  try {
    pdf = await generateSwapOutDeliveryNotePdf({
      swapOutId: rec.id,
      pickingNumber: rec.pickingNumber,
      podNumber: rec.podNumber,
      clientName: client?.name ?? '',
      vendorNumber: (client?.vendorNumbers ?? [])[0] ?? '',
      storeName: rec.storeName,
      storeCode: rec.storeCode,
      channel: rec.channel,
      region: rec.region,
      repName: rec.assignedRepName,
      releasedAt: rec.releasedToClientAt,
      releasedByName: rec.releasedToClientByName,
      releaseReference: rec.releaseReference,
      rows: (rec.lines ?? []).map((l) => ({
        product: l.product,
        description: l.description ?? '',
        requested: l.quantity || 0,
        issued: l.issuedQty || 0,
        returned: l.returnedQty || 0,
      })),
      qrUrl: `${siteUrl}/swap-out-delivery/${rec.deliveryToken}`,
      signature: rec.deliverySignature,
      signedByName: rec.deliverySignedByName,
      signedAt: rec.deliverySignedAt,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Delivery note could not be generated: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }

  const fileName = rec.deliverySignedAt
    ? signedSwapOutNoteFileName({
        storeName: rec.storeName,
        storeCode: rec.storeCode,
        pickingNumber: rec.pickingNumber,
        swapOutId: rec.id,
      })
    : `${rec.storeName} - SWAPOUT-${rec.pickingNumber || rec.id.slice(0, 8)}.pdf`.replace(/[\\/:*?"<>|]/g, '-');

  return new Response(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    },
  });
}
