import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { loadControl } from '@/lib/controlData';
import { updateSlipInRun, getPickSlipRun, type ReceiptBox } from '@/lib/pickSlipData';
import { listSpLinks } from '@/lib/spLinkData';
import { logAudit } from '@/lib/auditLog';
import { generateDeliveryNotePdf } from '@/lib/deliveryNotePdf';
import { resolveSharedItem, createFolder, uploadNewFile } from '@/lib/graphIram';

export const dynamic = 'force-dynamic';

/**
 * POST /api/receipts/release
 *
 * Release stock from warehouse for transit back to client/vendor.
 * Validates the rep's release code — match → in-transit, mismatch → failed-release.
 * On successful release, generates a delivery note PDF with QR code and uploads to SP.
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'receipt_stock');
  if (guard instanceof NextResponse) return guard;

  const body = await req.json();
  const {
    slipId,
    clientId,
    loadId,
    releaseRepId,
    releaseRepName,
    releaseBoxes,
    releaseCode,
    managerOverrideCode,
    managerOverrideRepId,
  } = body as {
    slipId: string;
    clientId: string;
    loadId: string;
    releaseRepId: string;
    releaseRepName: string;
    releaseBoxes: ReceiptBox[];
    releaseCode: string;
    managerOverrideCode?: string;
    managerOverrideRepId?: string;
  };

  if (!slipId || !clientId || !loadId) {
    return NextResponse.json({ error: 'slipId, clientId, and loadId are required' }, { status: 400 });
  }
  if (!releaseRepId) {
    return NextResponse.json({ error: 'releaseRepId is required' }, { status: 400 });
  }
  if (!releaseCode) {
    return NextResponse.json({ error: 'releaseCode is required' }, { status: 400 });
  }

  // Verify the slip exists and is in a releasable status
  const run = await getPickSlipRun(clientId, loadId);
  if (!run) {
    return NextResponse.json({ error: 'Pick slip run not found' }, { status: 404 });
  }
  const slip = run.slips.find(s => s.id === slipId);
  if (!slip) {
    return NextResponse.json({ error: 'Pick slip not found' }, { status: 404 });
  }
  if (slip.status !== 'receipted' && slip.status !== 'failed-release') {
    return NextResponse.json({ error: `Cannot release a slip with status "${slip.status}"` }, { status: 400 });
  }

  // Load users first — needed for rep lookup AND audit
  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);

  // Look up the rep's stored release code — check both control reps AND users
  const reps = await loadControl<{ id: string; releaseCode?: string }>('reps');
  const rep = reps.find(r => r.id === releaseRepId);
  const repUser = users.find(u => u.id === releaseRepId);
  const storedCode = rep?.releaseCode || repUser?.releaseCode;
  if (!rep && !repUser) {
    return NextResponse.json({ error: 'Rep/user not found' }, { status: 404 });
  }
  if (!storedCode) {
    return NextResponse.json({ error: 'This rep/user does not have a release code configured' }, { status: 400 });
  }
  const userName = me ? `${me.name} ${me.surname}` : guard.userId;

  // Compare release codes (case-insensitive)
  const codeMatch = releaseCode.toUpperCase().trim() === storedCode.toUpperCase().trim();

  if (codeMatch) {
    // Check if this is a manager-authorized partial release
    const isPartial = !!managerOverrideCode;

    if (isPartial && managerOverrideRepId) {
      // Validate manager's release code
      const manager = users.find(u => u.id === managerOverrideRepId);
      if (!manager || !manager.releaseCode) {
        return NextResponse.json(
          { ok: false, error: 'Manager does not have a release code configured' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } },
        );
      }
      const managerValid = managerOverrideCode.toUpperCase().trim() === manager.releaseCode.toUpperCase().trim();
      if (!managerValid) {
        return NextResponse.json(
          { ok: false, error: 'Manager release code does not match' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } },
        );
      }
    }

    const finalStatus = isPartial ? 'partial-release' : 'in-transit';
    const now = new Date().toISOString();

    // Generate delivery token
    const deliveryToken = randomUUID();

    const updated = await updateSlipInRun(clientId, loadId, slipId, {
      status: finalStatus,
      releaseRepId,
      releaseRepName,
      releaseBoxes: releaseBoxes ?? [],
      releasedAt: now,
      releasedBy: guard.userId,
      releasedByName: userName,
      deliveryToken,
    });

    await logAudit({
      action: isPartial ? 'partial_release' : 'release_complete',
      userId: guard.userId,
      userName,
      slipId,
      clientId,
      detail: isPartial
        ? `Partial release of ${(releaseBoxes ?? []).length} boxes (manager override by ${managerOverrideRepId})`
        : `Stock released — ${(releaseBoxes ?? []).length} boxes in transit. Rep: ${releaseRepName}`,
    });

    // ── Generate & upload delivery note PDF (non-blocking on failure) ──
    try {
      const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://iram-rvl-crm.vercel.app';
      const qrUrl = `${siteUrl}/delivery/${deliveryToken}`;

      const pdfBuffer = await generateDeliveryNotePdf({
        pickSlipId: slipId,
        clientName: slip.clientName,
        vendorNumber: slip.vendorNumber,
        siteName: slip.siteName,
        siteCode: slip.siteCode,
        warehouse: slip.warehouse,
        releaseRepName,
        releasedAt: now,
        storeRefs: slip.receiptStoreRefs ?? [],
        manual: slip.manual,
        rows: (slip.rows ?? []).map(r => ({
          articleCode: r.articleCode,
          description: r.description,
          qty: r.qty,
          val: r.val,
        })),
        boxCount: (releaseBoxes ?? []).length,
        stickerBarcodes: (releaseBoxes ?? []).map(b => b.stickerBarcode),
        qrUrl,
      });

      // Upload to SP — find link with deliveryNoteFolderUrl
      const spLinks = await listSpLinks(clientId);
      const dnLink = spLinks.find(l => l.deliveryNoteFolderUrl);

      if (dnLink?.deliveryNoteFolderUrl) {
        const dateStr = now.slice(0, 10).replace(/-/g, '');
        const resolved = await resolveSharedItem(dnLink.deliveryNoteFolderUrl);
        const folder = await createFolder(resolved.driveId, resolved.folderId, dateStr);
        const pdfFileName = `${slip.siteName} ${slip.siteCode} - DN-${slipId}.pdf`;
        const uploaded = await uploadNewFile(resolved.driveId, folder.id, pdfFileName, pdfBuffer, 'application/pdf');

        // Save delivery note SP URL on slip
        await updateSlipInRun(clientId, loadId, slipId, {
          deliveryNoteSpWebUrl: uploaded.webUrl,
          deliveryNoteGeneratedAt: new Date().toISOString(),
        });
      } else {
        console.warn('[release] No SP link with deliveryNoteFolderUrl for client', clientId, '— delivery note not uploaded');
        // Still save the generation timestamp (PDF was generated, just not uploaded)
        await updateSlipInRun(clientId, loadId, slipId, {
          deliveryNoteGeneratedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      // Delivery note generation is non-blocking — log warning but don't fail the release
      console.error('[release] Delivery note generation/upload failed:', err instanceof Error ? err.message : err);
    }

    return NextResponse.json(
      { ok: true, status: finalStatus, slip: updated },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } else {
    // Mismatch — set to failed-release
    const updated = await updateSlipInRun(clientId, loadId, slipId, {
      status: 'failed-release',
      releaseRepId,
      releaseRepName,
      releaseBoxes: releaseBoxes ?? [],
    });

    await logAudit({
      action: 'failed_release',
      userId: guard.userId,
      userName,
      slipId,
      clientId,
      detail: `Release code mismatch for rep ${releaseRepName} (${releaseRepId})`,
    });

    return NextResponse.json(
      { ok: false, status: 'failed-release', error: 'Release code does not match', slip: updated },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
