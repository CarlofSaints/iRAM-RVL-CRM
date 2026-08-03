import { NextRequest, NextResponse } from 'next/server';
import { loadControl } from '@/lib/controlData';
import { listLoads } from '@/lib/agedStockData';
import { findAllSlipsByDeliveryToken, updateSlipInRun } from '@/lib/pickSlipData';
import { buildRevertPatch } from '@/lib/pickSlipRevert';
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

  // Per-store confirmation. `deliveredSlipIds` lists the stores physically
  // handed over; anything else on the token was left behind. Omitting the field
  // entirely means "all delivered" so older clients keep working unchanged.
  const deliveredSlipIds: string[] | null = Array.isArray(body.deliveredSlipIds)
    ? body.deliveredSlipIds.filter((x: unknown) => typeof x === 'string')
    : null;
  const shortReasons: Record<string, string> =
    body.shortReasons && typeof body.shortReasons === 'object' ? body.shortReasons : {};

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

  // ── Split the delivery into what arrived and what didn't ──
  const deliveredSet = deliveredSlipIds ? new Set(deliveredSlipIds) : null;
  const delivered = deliveredSet ? results.filter(r => deliveredSet.has(r.slip.id)) : results;
  const short = deliveredSet ? results.filter(r => !deliveredSet.has(r.slip.id)) : [];

  // A sign-off with nothing delivered isn't a delivery — the release should be
  // cancelled instead, which is a different (code-authorised) flow.
  if (delivered.length === 0) {
    return NextResponse.json(
      { error: 'Tick at least one store. If nothing was delivered, cancel the release instead of signing for it.' },
      { status: 400 },
    );
  }

  // The signed paperwork covers only the stores actually handed over — so the
  // SharePoint folder and customer contacts must be resolved from a DELIVERED
  // slip, not from results[0], which may itself be one of the short stores.
  // (One supplier can span several client records sharing a name with
  // different vendor numbers, so these are not always interchangeable.)
  const isMulti = delivered.length > 1;
  const firstSlip = delivered[0].slip;
  const firstClientId = delivered[0].clientId;

  // ── Stores that WERE delivered ──
  for (const { slip, clientId, loadId } of delivered) {
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
      detail: `Delivery confirmed by vendor rep "${vendorName.trim()}" via QR code`
        + (isMulti ? ` (multi-slip: ${delivered.length} slips)` : '')
        + (short.length > 0 ? ` — ${short.length} store(s) on this delivery note were NOT delivered` : ''),
    });
  }

  // ── Stores that were NOT handed over ──
  // Roll each back to `captured` using the same field-clearing model as the
  // Reverse action, so it drops off this delivery note, loses the delivery
  // token, and reappears on the Release screen for a fresh release. Booking
  // and receipt data (including linked box labels) are untouched, so nothing
  // needs re-scanning or reprinting.
  for (const { slip, clientId, loadId } of short) {
    const reason = (shortReasons[slip.id] ?? '').trim();
    await updateSlipInRun(clientId, loadId, slip.id, {
      ...buildRevertPatch('captured'),
      deliveryShortAt: now,
      deliveryShortReason: reason || 'No reason given',
      deliveryShortSignedByName: vendorName.trim(),
      deliveryShortRepName: repName,
      deliveryShortToken: token,
      deliveryShortCount: (slip.deliveryShortCount ?? 0) + 1,
    });

    await logAudit({
      action: 'delivery_not_delivered',
      userId: releaseRepId,
      userName: repName,
      slipId: slip.id,
      clientId,
      detail: `NOT delivered — ${slip.siteName} (${slip.siteCode}), `
        + `${(slip.releaseBoxes ?? []).length} box(es). `
        + `Vendor rep "${vendorName.trim()}" signed for the rest of the delivery without it. `
        + `Reason: ${reason || 'none given'}. `
        + `Rolled back to Captured — stock retained, must be released again.`,
    });
  }

  // ── Generate signed delivery note PDF ──
  let signedPdfBuffer: Buffer | null = null;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://iram-rvl-crm.vercel.app';
  const qrUrl = `${siteUrl}/delivery/${token}`;

  // Use the multi-slip layout whenever anything was short, even for a single
  // delivered store — it is the only generator that can print the
  // NOT DELIVERED block, and that block has to be on the signed document.
  const useMultiPdf = isMulti || short.length > 0;

  try {
    if (useMultiPdf) {
      signedPdfBuffer = await generateMultiSlipDeliveryNotePdf({
        clientName: firstSlip.clientName,
        vendorNumber: [...new Set(delivered.map(r => r.slip.vendorNumber).filter(Boolean))].join(' / ') || firstSlip.vendorNumber,
        releaseRepName: firstSlip.releaseRepName ?? '',
        releasedAt: firstSlip.releasedAt ?? now,
        qrUrl,
        notDelivered: short.map(({ slip }) => ({
          pickSlipId: slip.id,
          siteName: slip.siteName,
          siteCode: slip.siteCode,
          boxCount: (slip.releaseBoxes ?? []).length,
          reason: (shortReasons[slip.id] ?? '').trim() || undefined,
        })),
        slips: delivered.map(({ slip }) => ({
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
          const last3s = delivered.map(r => r.slip.id.slice(-3)).join(', ');
          pdfFileName = `${firstSlip.clientName} - ${dateFmt} (${last3s}) - SIGNED.pdf`;
        } else {
          pdfFileName = `${firstSlip.siteName} ${firstSlip.siteCode} - DN-${firstSlip.id} - SIGNED.pdf`;
        }
        // Flag a short delivery in the filename so it stands out in SharePoint.
        if (short.length > 0) {
          pdfFileName = pdfFileName.replace(/ - SIGNED\.pdf$/, ` - SIGNED (${short.length} NOT DELIVERED).pdf`);
        }

        const uploaded = await uploadNewFile(resolved.driveId, signedFolder.id, pdfFileName, signedPdfBuffer, 'application/pdf');

        // Save signed URL on the DELIVERED slips only — a short store has had
        // its delivery-note fields cleared by the rollback and does not belong
        // to this signed note any more.
        for (const { slip, clientId, loadId } of delivered) {
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

      const slipRows = delivered.map(r =>
        `<tr><td style="padding:4px 12px 4px 0;font-size:13px;font-family:monospace;">${r.slip.id}</td><td style="font-size:13px;">${r.slip.siteName} (${r.slip.siteCode})</td><td style="font-size:13px;">${r.slip.totalQty}</td></tr>`
      ).join('');

      // Short stores get their own block so the customer can see immediately
      // what is still outstanding rather than reconciling the PDF by hand.
      const shortHtml = short.length === 0 ? '' : `
        <div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:6px;padding:14px 16px;margin-bottom:20px;">
          <p style="margin:0 0 8px;font-size:14px;font-weight:bold;color:#92400E;">
            ${short.length} store${short.length === 1 ? '' : 's'} on this delivery note ${short.length === 1 ? 'was' : 'were'} NOT delivered
          </p>
          <p style="margin:0 0 10px;font-size:13px;color:#92400E;">
            This stock has been retained and will be re-delivered on a separate delivery note.
          </p>
          <table style="width:100%;">
            ${short.map(r => `<tr>
              <td style="padding:3px 12px 3px 0;font-size:13px;font-family:monospace;">${r.slip.id}</td>
              <td style="font-size:13px;">${r.slip.siteName} (${r.slip.siteCode})</td>
              <td style="font-size:13px;">${(r.slip.releaseBoxes ?? []).length} box(es)</td>
              <td style="font-size:13px;color:#92400E;">${(shortReasons[r.slip.id] ?? '').trim() || 'No reason given'}</td>
            </tr>`).join('')}
          </table>
        </div>`;

      const bodyHtml = `
        <p style="margin:0 0 14px;font-size:14px;">Stock has been delivered and signed for. The signed delivery note is attached.</p>
        ${shortHtml}
        <table style="background:#f9f9f9;border:1px solid #eee;border-radius:6px;padding:14px 16px;width:100%;margin-bottom:20px;">
          ${isMulti ? `<tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Slips</td><td style="font-size:13px;"><strong>${delivered.length}</strong></td></tr>` : ''}
          ${isMulti
            ? `<tr><td colspan="2" style="padding:4px 0;"><table style="width:100%;">${slipRows}</table></td></tr>`
            : `<tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Pick Slip</td><td style="font-size:13px;font-family:monospace;"><strong>${firstSlip.id}</strong></td></tr>
               <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Store</td><td style="font-size:13px;">${firstSlip.siteName} (${firstSlip.siteCode})</td></tr>`
          }
          <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Warehouse</td><td style="font-size:13px;">${firstSlip.warehouse}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Total Qty</td><td style="font-size:13px;">${delivered.reduce((s, r) => s + r.slip.totalQty, 0)}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Collecting Rep</td><td style="font-size:13px;">${repName}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Received By</td><td style="font-size:13px;font-weight:bold;">${vendorName.trim()}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Confirmed At</td><td style="font-size:13px;">${confirmedAt}</td></tr>
        </table>
        <p style="margin:0;font-size:13px;color:#555;">Signed delivery note attached${signedPdfBuffer ? '' : ' (PDF generation failed — details above only)'}.</p>
      `;

      const attachments: Array<{ filename: string; content: Buffer }> = [];
      if (signedPdfBuffer) {
        const filename = isMulti
          ? `Delivery Note - ${delivered.length} slips - SIGNED.pdf`
          : `Delivery Note - ${firstSlip.id} - SIGNED.pdf`;
        attachments.push({ filename, content: signedPdfBuffer });
      }

      const shortTag = short.length > 0 ? ` — ${short.length} NOT DELIVERED` : '';
      const subject = (isMulti
        ? `Delivery Confirmed — ${delivered.length} slips — ${firstSlip.clientName}`
        : `Delivery Confirmed — ${firstSlip.id} — ${firstSlip.siteName} (${firstSlip.siteCode})`) + shortTag;

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

  return NextResponse.json(
    {
      ok: true,
      deliveredCount: delivered.length,
      notDelivered: short.map(({ slip }) => ({
        slipId: slip.id,
        siteName: slip.siteName,
        siteCode: slip.siteCode,
        boxCount: (slip.releaseBoxes ?? []).length,
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
