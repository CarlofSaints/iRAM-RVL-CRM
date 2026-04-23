import { NextRequest, NextResponse } from 'next/server';
import { loadControl } from '@/lib/controlData';
import { listLoads } from '@/lib/agedStockData';
import { findSlipByDeliveryToken, updateSlipInRun } from '@/lib/pickSlipData';
import { getClient } from '@/lib/spLinkData';
import { loadUsers } from '@/lib/userData';
import { logAudit } from '@/lib/auditLog';
import { Resend } from 'resend';

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

  const { slip } = result;

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

  // ── Email customer contacts who have receiveDeliveryNotes enabled ──
  try {
    const client = await getClient(clientId);
    const contacts = (client as { contacts?: Array<{ email: string; receiveDeliveryNotes?: boolean; name?: string; surname?: string }> })?.contacts ?? [];
    const dnContacts = contacts.filter(c => c.receiveDeliveryNotes && c.email);

    if (dnContacts.length > 0 && process.env.RESEND_API_KEY) {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const toAddresses = dnContacts.map(c => c.email);

      await resend.emails.send({
        from: 'iRam RVL <noreply@outerjoin.co.za>',
        to: toAddresses,
        subject: `Delivery Confirmed — ${slip.id} — ${slip.siteName} (${slip.siteCode})`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #7CC042; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
              <h2 style="margin: 0;">Delivery Confirmed</h2>
            </div>
            <div style="padding: 20px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
              <p>Stock has been delivered and signed for. Details below:</p>
              <table style="width: 100%; font-size: 14px; border-collapse: collapse;">
                <tr><td style="padding: 6px 0; color: #666;">Pick Slip</td><td style="padding: 6px 0; font-weight: bold;">${slip.id}</td></tr>
                <tr><td style="padding: 6px 0; color: #666;">Store</td><td style="padding: 6px 0;">${slip.siteName} (${slip.siteCode})</td></tr>
                <tr><td style="padding: 6px 0; color: #666;">Warehouse</td><td style="padding: 6px 0;">${slip.warehouse}</td></tr>
                <tr><td style="padding: 6px 0; color: #666;">Total Qty</td><td style="padding: 6px 0;">${slip.totalQty}</td></tr>
                <tr><td style="padding: 6px 0; color: #666;">Collecting Rep</td><td style="padding: 6px 0;">${repName}</td></tr>
                <tr><td style="padding: 6px 0; color: #666;">Received By</td><td style="padding: 6px 0; font-weight: bold;">${vendorName.trim()}</td></tr>
                <tr><td style="padding: 6px 0; color: #666;">Confirmed At</td><td style="padding: 6px 0;">${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Johannesburg' })}</td></tr>
              </table>
              ${slip.deliveryNoteSpWebUrl ? `<p style="margin-top: 16px;"><a href="${slip.deliveryNoteSpWebUrl}" style="color: #7CC042; font-weight: bold;">View Delivery Note PDF</a></p>` : ''}
              <hr style="margin: 20px 0; border: none; border-top: 1px solid #e5e7eb;" />
              <p style="font-size: 12px; color: #999;">This is an automated notification from iRam RVL CRM. Powered by OuterJoin.</p>
            </div>
          </div>
        `,
      });
    }
  } catch (err) {
    // Email is non-blocking
    console.error('[delivery] Failed to email customer contacts:', err instanceof Error ? err.message : err);
  }

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
