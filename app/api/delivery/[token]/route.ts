import { NextRequest, NextResponse } from 'next/server';
import { loadControl } from '@/lib/controlData';
import { listLoads } from '@/lib/agedStockData';
import { findAllSlipsByDeliveryToken, updateSlipInRun } from '@/lib/pickSlipData';
import { getClient, listSpLinks } from '@/lib/spLinkData';
import { loadUsers } from '@/lib/userData';
import { logAudit } from '@/lib/auditLog';
import { generateDeliveryNotePdf, generateMultiSlipDeliveryNotePdf } from '@/lib/deliveryNotePdf';
import { resolveSharedItem, createFolder, uploadNewFile } from '@/lib/graphIram';
import { sendPickSlipEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

/**
 * GET /api/delivery/[token]
 *
 * Public — no auth required. The unguessable UUID token IS the auth.
 * Returns pick slip summary for the delivery confirmation page.
 * Multi-slip aware: returns backward-compat fields from first slip + `slips` array.
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

  const results = await findAllSlipsByDeliveryToken(token, clientIds, listLoads);
  if (results.length === 0) {
    return NextResponse.json({ error: 'Delivery not found or link has expired' }, { status: 404 });
  }

  const first = results[0];
  const { slip, clientId } = first;

  // Load contacts who receive delivery notes
  let contacts: Array<{ name: string; surname: string }> = [];
  try {
    const client = await getClient(clientId);
    const allContacts = (client as { contacts?: Array<{ name?: string; surname?: string; email?: string; receiveDeliveryNotes?: boolean }> })?.contacts ?? [];
    contacts = allContacts
      .filter(c => c.receiveDeliveryNotes && c.name)
      .map(c => ({ name: c.name || '', surname: c.surname || '' }));
  } catch { /* non-blocking */ }

  // Aggregate totals across all slips
  const totalQty = results.reduce((s, r) => s + r.slip.totalQty, 0);
  const totalVal = results.reduce((s, r) => s + r.slip.totalVal, 0);
  const boxCount = results.reduce((s, r) => s + (r.slip.releaseBoxes ?? []).length, 0);

  // Build per-slip breakdown
  const slipsArray = results.map(r => ({
    slipId: r.slip.id,
    siteName: r.slip.siteName,
    siteCode: r.slip.siteCode,
    warehouse: r.slip.warehouse,
    totalQty: r.slip.totalQty,
    totalVal: r.slip.totalVal,
    boxCount: (r.slip.releaseBoxes ?? []).length,
    status: r.slip.status,
    manual: r.slip.manual ?? false,
  }));

  return NextResponse.json({
    // Backward-compat fields from first slip
    slipId: slip.id,
    clientName: slip.clientName,
    vendorNumber: slip.vendorNumber,
    siteName: slip.siteName,
    siteCode: slip.siteCode,
    warehouse: slip.warehouse,
    status: slip.status,
    releaseRepName: slip.releaseRepName ?? '',
    releasedAt: slip.releasedAt ?? '',
    totalQty,
    totalVal,
    boxCount,
    manual: slip.manual ?? false,
    contacts,
    deliveredAt: slip.deliveredAt,
    deliverySignedByName: slip.deliverySignedByName,
    // Multi-slip array
    slips: slipsArray,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * POST /api/delivery/[token]
 *
 * Public — confirms delivery. Rep enters security code, vendor signs.
 * Updates ALL slips sharing the token to 'delivered'.
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

  // Find ALL slips with this token
  const clients = await loadControl<{ id: string; name: string }>('clients');
  const clientIds = clients.map(c => c.id);
  const results = await findAllSlipsByDeliveryToken(token, clientIds, listLoads);

  if (results.length === 0) {
    return NextResponse.json({ error: 'Delivery not found or link has expired' }, { status: 404 });
  }

  // Validate ALL slips are in a deliverable status
  for (const { slip } of results) {
    if (slip.status !== 'in-transit' && slip.status !== 'partial-release') {
      if (slip.status === 'delivered') {
        return NextResponse.json({ error: 'This delivery has already been confirmed' }, { status: 400 });
      }
      return NextResponse.json({ error: `Cannot confirm delivery for slip ${slip.id} with status "${slip.status}"` }, { status: 400 });
    }
  }

  // Validate security code — match against the release rep's stored release code (use first slip)
  const releaseRepId = results[0].slip.releaseRepId;
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

  const repName = results[0].slip.releaseRepName || 'Unknown Rep';
  const now = new Date().toISOString();
  const isMulti = results.length > 1;
  const firstSlip = results[0].slip;
  const firstClientId = results[0].clientId;

  // Update ALL slips to delivered
  for (const { slip, clientId, loadId } of results) {
    await updateSlipInRun(clientId, loadId, slip.id, {
      status: 'delivered',
      deliveredAt: now,
      deliverySignedByName: vendorName.trim(),
      deliverySignature: signature,
      deliveredByRepId: releaseRepId,
      deliveredByRepName: repName,
    });

    await logAudit({
      action: 'delivery_confirmed',
      userId: releaseRepId,
      userName: repName,
      slipId: slip.id,
      clientId,
      detail: `Delivery confirmed by vendor rep "${vendorName.trim()}" via QR code${isMulti ? ` (multi-slip: ${results.length} slips)` : ''}`,
    });
  }

  // ── Generate signed delivery note PDF ──
  let signedPdfBuffer: Buffer | null = null;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://iram-rvl-crm.vercel.app';
  const qrUrl = `${siteUrl}/delivery/${token}`;

  try {
    if (isMulti) {
      signedPdfBuffer = await generateMultiSlipDeliveryNotePdf({
        clientName: firstSlip.clientName,
        vendorNumber: firstSlip.vendorNumber,
        releaseRepName: firstSlip.releaseRepName ?? '',
        releasedAt: firstSlip.releasedAt ?? now,
        qrUrl,
        slips: results.map(({ slip }) => ({
          pickSlipId: slip.id,
          siteName: slip.siteName,
          siteCode: slip.siteCode,
          warehouse: slip.warehouse,
          storeRefs: slip.receiptStoreRefs ?? [],
          receiptGrnDate: slip.receiptGrnDate,
          receiptValue: slip.receiptValue,
          manual: slip.manual,
          rows: (slip.rows ?? []).map(r => ({
            articleCode: r.articleCode,
            description: r.description,
            qty: r.qty,
            val: r.val,
          })),
          stickerBarcodes: (slip.releaseBoxes ?? []).map(b => b.stickerBarcode),
        })),
        signature,
        signedByName: vendorName.trim(),
        deliveredAt: now,
      });
    } else {
      signedPdfBuffer = await generateDeliveryNotePdf({
        pickSlipId: firstSlip.id,
        clientName: firstSlip.clientName,
        vendorNumber: firstSlip.vendorNumber,
        siteName: firstSlip.siteName,
        siteCode: firstSlip.siteCode,
        warehouse: firstSlip.warehouse,
        releaseRepName: firstSlip.releaseRepName ?? '',
        releasedAt: firstSlip.releasedAt ?? now,
        storeRefs: firstSlip.receiptStoreRefs ?? [],
        receiptGrnDate: firstSlip.receiptGrnDate,
        receiptValue: firstSlip.receiptValue,
        manual: firstSlip.manual,
        rows: (firstSlip.rows ?? []).map(r => ({
          articleCode: r.articleCode,
          description: r.description,
          qty: r.qty,
          val: r.val,
        })),
        boxCount: (firstSlip.releaseBoxes ?? []).length,
        stickerBarcodes: (firstSlip.releaseBoxes ?? []).map(b => b.stickerBarcode),
        qrUrl,
        signature,
        signedByName: vendorName.trim(),
        deliveredAt: now,
      });
    }

    // Upload signed PDF to SP — under a "Signed" subfolder
    const spLinks = await listSpLinks(firstClientId);
    const dnLink = spLinks.find(l => l.deliveryNoteFolderUrl);

    if (dnLink?.deliveryNoteFolderUrl && signedPdfBuffer) {
      try {
        const dateStr = (firstSlip.releasedAt ?? now).slice(0, 10).replace(/-/g, '');
        const resolved = await resolveSharedItem(dnLink.deliveryNoteFolderUrl);
        const dateFolder = await createFolder(resolved.driveId, resolved.folderId, dateStr);
        const signedFolder = await createFolder(resolved.driveId, dateFolder.id, 'Signed');

        let pdfFileName: string;
        if (isMulti) {
          const dateFmt = now.slice(0, 10);
          const last3s = results.map(r => r.slip.id.slice(-3)).join(', ');
          pdfFileName = `${firstSlip.clientName} - ${dateFmt} (${last3s}) - SIGNED.pdf`;
        } else {
          pdfFileName = `${firstSlip.siteName} ${firstSlip.siteCode} - DN-${firstSlip.id} - SIGNED.pdf`;
        }

        const uploaded = await uploadNewFile(resolved.driveId, signedFolder.id, pdfFileName, signedPdfBuffer, 'application/pdf');

        // Save signed URL on ALL slips
        for (const { slip, clientId, loadId } of results) {
          await updateSlipInRun(clientId, loadId, slip.id, {
            deliveryNoteSignedSpWebUrl: uploaded.webUrl,
          });
        }
      } catch (spErr) {
        console.error('[delivery] Failed to upload signed PDF to SP:', spErr instanceof Error ? spErr.message : spErr);
      }
    }
  } catch (pdfErr) {
    console.error('[delivery] Failed to generate signed delivery note PDF:', pdfErr instanceof Error ? pdfErr.message : pdfErr);
  }

  // ── Email customer contacts with signed PDF attached ──
  try {
    const client = await getClient(firstClientId);
    const clientContacts = (client as { contacts?: Array<{ email: string; receiveDeliveryNotes?: boolean; name?: string; surname?: string }> })?.contacts ?? [];
    const dnContacts = clientContacts.filter(c => c.receiveDeliveryNotes && c.email);

    if (dnContacts.length > 0 && process.env.RESEND_API_KEY) {
      const toAddresses = dnContacts.map(c => c.email);
      const confirmedAt = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Johannesburg' });

      const slipRows = results.map(r =>
        `<tr><td style="padding:4px 12px 4px 0;font-size:13px;font-family:monospace;">${r.slip.id}</td><td style="font-size:13px;">${r.slip.siteName} (${r.slip.siteCode})</td><td style="font-size:13px;">${r.slip.totalQty}</td></tr>`
      ).join('');

      const bodyHtml = `
        <p style="margin:0 0 14px;font-size:14px;">Stock has been delivered and signed for. The signed delivery note is attached.</p>
        <table style="background:#f9f9f9;border:1px solid #eee;border-radius:6px;padding:14px 16px;width:100%;margin-bottom:20px;">
          ${isMulti ? `<tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Slips</td><td style="font-size:13px;"><strong>${results.length}</strong></td></tr>` : ''}
          ${isMulti
            ? `<tr><td colspan="2" style="padding:4px 0;"><table style="width:100%;">${slipRows}</table></td></tr>`
            : `<tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Pick Slip</td><td style="font-size:13px;font-family:monospace;"><strong>${firstSlip.id}</strong></td></tr>
               <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Store</td><td style="font-size:13px;">${firstSlip.siteName} (${firstSlip.siteCode})</td></tr>`
          }
          <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Warehouse</td><td style="font-size:13px;">${firstSlip.warehouse}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Total Qty</td><td style="font-size:13px;">${results.reduce((s, r) => s + r.slip.totalQty, 0)}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Collecting Rep</td><td style="font-size:13px;">${repName}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Received By</td><td style="font-size:13px;font-weight:bold;">${vendorName.trim()}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Confirmed At</td><td style="font-size:13px;">${confirmedAt}</td></tr>
        </table>
        <p style="margin:0;font-size:13px;color:#555;">Signed delivery note attached${signedPdfBuffer ? '' : ' (PDF generation failed — details above only)'}.</p>
      `;

      const attachments: Array<{ filename: string; content: Buffer }> = [];
      if (signedPdfBuffer) {
        const filename = isMulti
          ? `Delivery Note - ${results.length} slips - SIGNED.pdf`
          : `Delivery Note - ${firstSlip.id} - SIGNED.pdf`;
        attachments.push({ filename, content: signedPdfBuffer });
      }

      const subject = isMulti
        ? `Delivery Confirmed — ${results.length} slips — ${firstSlip.clientName}`
        : `Delivery Confirmed — ${firstSlip.id} — ${firstSlip.siteName} (${firstSlip.siteCode})`;

      await sendPickSlipEmail({
        to: toAddresses,
        subject,
        bodyHtml,
        attachments,
      });
    }
  } catch (err) {
    console.error('[delivery] Failed to email customer contacts:', err instanceof Error ? err.message : err);
  }

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
