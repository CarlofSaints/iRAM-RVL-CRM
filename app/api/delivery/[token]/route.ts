import { NextRequest, NextResponse } from 'next/server';
import { loadControl } from '@/lib/controlData';
import { listLoads } from '@/lib/agedStockData';
import { findSlipByDeliveryToken, updateSlipInRun } from '@/lib/pickSlipData';
import { getClient, listSpLinks } from '@/lib/spLinkData';
import { loadUsers } from '@/lib/userData';
import { logAudit } from '@/lib/auditLog';
import { generateDeliveryNotePdf } from '@/lib/deliveryNotePdf';
import { resolveSharedItem, createFolder, uploadNewFile } from '@/lib/graphIram';
import { sendPickSlipEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

/**
 * GET /api/delivery/[token]
 *
 * Public — no auth required. The unguessable UUID token IS the auth.
 * Returns pick slip summary for the delivery confirmation page.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  if (!token || token.length < 30) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 400 });
  }

  // Load all client IDs
  const clients = await loadControl<{ id: string; name: string }>('clients');
  const clientIds = clients.map(c => c.id);

  const result = await findSlipByDeliveryToken(token, clientIds, listLoads);
  if (!result) {
    return NextResponse.json({ error: 'Delivery not found or link has expired' }, { status: 404 });
  }

  const { slip, clientId } = result;

  // Load contacts who receive delivery notes (name+surname only — no emails on public page)
  let contacts: Array<{ name: string; surname: string }> = [];
  try {
    const client = await getClient(clientId);
    const allContacts = (client as { contacts?: Array<{ name?: string; surname?: string; email?: string; receiveDeliveryNotes?: boolean }> })?.contacts ?? [];
    contacts = allContacts
      .filter(c => c.receiveDeliveryNotes && c.name)
      .map(c => ({ name: c.name || '', surname: c.surname || '' }));
  } catch { /* non-blocking */ }

  return NextResponse.json({
    slipId: slip.id,
    clientName: slip.clientName,
    vendorNumber: slip.vendorNumber,
    siteName: slip.siteName,
    siteCode: slip.siteCode,
    warehouse: slip.warehouse,
    status: slip.status,
    releaseRepName: slip.releaseRepName ?? '',
    releasedAt: slip.releasedAt ?? '',
    totalQty: slip.totalQty,
    totalVal: slip.totalVal,
    boxCount: (slip.releaseBoxes ?? []).length,
    manual: slip.manual ?? false,
    contacts,
    // If already delivered, include delivery info
    deliveredAt: slip.deliveredAt,
    deliverySignedByName: slip.deliverySignedByName,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * POST /api/delivery/[token]
 *
 * Public — confirms delivery. Rep enters security code, vendor signs.
 * Updates slip status to 'delivered'.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  if (!token || token.length < 30) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 400 });
  }

  const body = await req.json();
  const { securityCode, vendorName, signature } = body as {
    securityCode: string;
    vendorName: string;
    signature: string; // base64 PNG
  };

  if (!securityCode?.trim()) {
    return NextResponse.json({ error: 'Security code is required' }, { status: 400 });
  }
  if (!vendorName?.trim()) {
    return NextResponse.json({ error: 'Vendor representative name is required' }, { status: 400 });
  }
  if (!signature) {
    return NextResponse.json({ error: 'Signature is required' }, { status: 400 });
  }

  // Find the slip
  const clients = await loadControl<{ id: string; name: string }>('clients');
  const clientIds = clients.map(c => c.id);
  const result = await findSlipByDeliveryToken(token, clientIds, listLoads);

  if (!result) {
    return NextResponse.json({ error: 'Delivery not found or link has expired' }, { status: 404 });
  }

  const { slip, clientId, loadId } = result;

  // Validate slip is in a deliverable status
  if (slip.status !== 'in-transit' && slip.status !== 'partial-release') {
    if (slip.status === 'delivered') {
      return NextResponse.json({ error: 'This delivery has already been confirmed' }, { status: 400 });
    }
    return NextResponse.json({ error: `Cannot confirm delivery for a slip with status "${slip.status}"` }, { status: 400 });
  }

  // Validate security code — match against the release rep's stored release code
  const releaseRepId = slip.releaseRepId;
  if (!releaseRepId) {
    return NextResponse.json({ error: 'No release rep found on this slip' }, { status: 400 });
  }

  const reps = await loadControl<{ id: string; releaseCode?: string }>('reps');
  const users = await loadUsers();
  const rep = reps.find(r => r.id === releaseRepId);
  const repUser = users.find(u => u.id === releaseRepId);
  const storedCode = rep?.releaseCode || repUser?.releaseCode;

  if (!storedCode) {
    return NextResponse.json({ error: 'Release rep does not have a security code configured' }, { status: 400 });
  }

  if (securityCode.toUpperCase().trim() !== storedCode.toUpperCase().trim()) {
    return NextResponse.json({ error: 'Incorrect security code' }, { status: 403 });
  }

  // Resolve rep name for audit
  const repName = slip.releaseRepName || 'Unknown Rep';

  // Update slip to delivered
  await updateSlipInRun(clientId, loadId, slip.id, {
    status: 'delivered',
    deliveredAt: new Date().toISOString(),
    deliverySignedByName: vendorName.trim(),
    deliverySignature: signature,
    deliveredByRepId: releaseRepId,
    deliveredByRepName: repName,
  });

  // Audit log
  await logAudit({
    action: 'delivery_confirmed',
    userId: releaseRepId,
    userName: repName,
    slipId: slip.id,
    clientId,
    detail: `Delivery confirmed by vendor rep "${vendorName.trim()}" via QR code`,
  });

  // ── Generate signed delivery note PDF, upload to SP, email to contacts ──
  const now = new Date().toISOString();
  let signedPdfBuffer: Buffer | null = null;

  try {
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://iram-rvl-crm.vercel.app';
    const qrUrl = `${siteUrl}/delivery/${token}`;

    signedPdfBuffer = await generateDeliveryNotePdf({
      pickSlipId: slip.id,
      clientName: slip.clientName,
      vendorNumber: slip.vendorNumber,
      siteName: slip.siteName,
      siteCode: slip.siteCode,
      warehouse: slip.warehouse,
      releaseRepName: slip.releaseRepName ?? '',
      releasedAt: slip.releasedAt ?? now,
      storeRefs: slip.receiptStoreRefs ?? [],
      manual: slip.manual,
      rows: (slip.rows ?? []).map(r => ({
        articleCode: r.articleCode,
        description: r.description,
        qty: r.qty,
        val: r.val,
      })),
      boxCount: (slip.releaseBoxes ?? []).length,
      stickerBarcodes: (slip.releaseBoxes ?? []).map(b => b.stickerBarcode),
      qrUrl,
      signature,
      signedByName: vendorName.trim(),
      deliveredAt: now,
    });

    // Upload signed PDF to SP — under a "Signed" subfolder
    const spLinks = await listSpLinks(clientId);
    const dnLink = spLinks.find(l => l.deliveryNoteFolderUrl);

    if (dnLink?.deliveryNoteFolderUrl && signedPdfBuffer) {
      try {
        const dateStr = (slip.releasedAt ?? now).slice(0, 10).replace(/-/g, '');
        const resolved = await resolveSharedItem(dnLink.deliveryNoteFolderUrl);
        const dateFolder = await createFolder(resolved.driveId, resolved.folderId, dateStr);
        const signedFolder = await createFolder(resolved.driveId, dateFolder.id, 'Signed');
        const pdfFileName = `${slip.siteName} ${slip.siteCode} - DN-${slip.id} - SIGNED.pdf`;
        const uploaded = await uploadNewFile(resolved.driveId, signedFolder.id, pdfFileName, signedPdfBuffer, 'application/pdf');

        await updateSlipInRun(clientId, loadId, slip.id, {
          deliveryNoteSignedSpWebUrl: uploaded.webUrl,
        });
      } catch (spErr) {
        console.error('[delivery] Failed to upload signed PDF to SP:', spErr instanceof Error ? spErr.message : spErr);
      }
    }
  } catch (pdfErr) {
    console.error('[delivery] Failed to generate signed delivery note PDF:', pdfErr instanceof Error ? pdfErr.message : pdfErr);
  }

  // ── Email customer contacts with signed PDF attached ──
  try {
    const client = await getClient(clientId);
    const contacts = (client as { contacts?: Array<{ email: string; receiveDeliveryNotes?: boolean; name?: string; surname?: string }> })?.contacts ?? [];
    const dnContacts = contacts.filter(c => c.receiveDeliveryNotes && c.email);

    if (dnContacts.length > 0 && process.env.RESEND_API_KEY) {
      const toAddresses = dnContacts.map(c => c.email);
      const confirmedAt = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Johannesburg' });
      const bodyHtml = `
        <p style="margin:0 0 14px;font-size:14px;">Stock has been delivered and signed for. The signed delivery note is attached.</p>
        <table style="background:#f9f9f9;border:1px solid #eee;border-radius:6px;padding:14px 16px;width:100%;margin-bottom:20px;">
          <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Pick Slip</td><td style="font-size:13px;font-family:monospace;"><strong>${slip.id}</strong></td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Store</td><td style="font-size:13px;">${slip.siteName} (${slip.siteCode})</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Warehouse</td><td style="font-size:13px;">${slip.warehouse}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Total Qty</td><td style="font-size:13px;">${slip.totalQty}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Collecting Rep</td><td style="font-size:13px;">${repName}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Received By</td><td style="font-size:13px;font-weight:bold;">${vendorName.trim()}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Confirmed At</td><td style="font-size:13px;">${confirmedAt}</td></tr>
        </table>
        <p style="margin:0;font-size:13px;color:#555;">Signed delivery note attached${signedPdfBuffer ? '' : ' (PDF generation failed — details above only)'}.</p>
      `;

      const attachments: Array<{ filename: string; content: Buffer }> = [];
      if (signedPdfBuffer) {
        attachments.push({
          filename: `Delivery Note - ${slip.id} - SIGNED.pdf`,
          content: signedPdfBuffer,
        });
      }

      await sendPickSlipEmail({
        to: toAddresses,
        subject: `Delivery Confirmed — ${slip.id} — ${slip.siteName} (${slip.siteCode})`,
        bodyHtml,
        attachments,
      });
    }
  } catch (err) {
    // Email is non-blocking
    console.error('[delivery] Failed to email customer contacts:', err instanceof Error ? err.message : err);
  }

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
