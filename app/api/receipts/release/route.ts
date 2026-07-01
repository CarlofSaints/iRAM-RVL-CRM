import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { loadControl } from '@/lib/controlData';
import { updateSlipInRun, getPickSlipRun, type ReceiptBox, type PickSlipRecord } from '@/lib/pickSlipData';
import { listSpLinks } from '@/lib/spLinkData';
import { logAudit } from '@/lib/auditLog';
import { generateDeliveryNotePdf } from '@/lib/deliveryNotePdf';
import { generateMultiSlipDeliveryNotePdf } from '@/lib/deliveryNotePdf';
import { resolveSharedItem, createFolder, uploadNewFile } from '@/lib/graphIram';
import { sendDeliveryNoteEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

interface SlipPayload {
  slipId: string;
  clientId: string;
  loadId: string;
  releaseBoxes: ReceiptBox[];
}

/**
 * POST /api/receipts/release
 *
 * Release stock from warehouse for transit back to client/vendor.
 * Supports both single-slip (legacy) and multi-slip payloads.
 *
 * Single-slip body: { slipId, clientId, loadId, releaseRepId, releaseRepName, releaseBoxes, releaseCode }
 * Multi-slip body:  { slips: [{ slipId, clientId, loadId, releaseBoxes }], releaseRepId, releaseRepName, releaseCode }
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'receipt_stock');
  if (guard instanceof NextResponse) return guard;

  const body = await req.json();
  const {
    releaseRepId,
    releaseRepName,
    releaseCode,
    managerOverrideCode,
    managerOverrideRepId,
  } = body as {
    releaseRepId: string;
    releaseRepName: string;
    releaseCode: string;
    managerOverrideCode?: string;
    managerOverrideRepId?: string;
  };

  // Normalize: wrap single-slip into array
  let slipPayloads: SlipPayload[];
  if (Array.isArray(body.slips) && body.slips.length > 0) {
    slipPayloads = body.slips;
  } else if (body.slipId && body.clientId && body.loadId) {
    slipPayloads = [{
      slipId: body.slipId,
      clientId: body.clientId,
      loadId: body.loadId,
      releaseBoxes: body.releaseBoxes ?? [],
    }];
  } else {
    return NextResponse.json({ error: 'slips array or (slipId, clientId, loadId) are required' }, { status: 400 });
  }

  if (!releaseRepId) {
    return NextResponse.json({ error: 'releaseRepId is required' }, { status: 400 });
  }
  if (!releaseCode) {
    return NextResponse.json({ error: 'releaseCode is required' }, { status: 400 });
  }

  // Verify all slips exist and are releasable
  const resolvedSlips: Array<{ payload: SlipPayload; slip: PickSlipRecord }> = [];
  for (const sp of slipPayloads) {
    const run = await getPickSlipRun(sp.clientId, sp.loadId);
    if (!run) {
      return NextResponse.json({ error: `Pick slip run not found for ${sp.slipId}` }, { status: 404 });
    }
    const slip = run.slips.find(s => s.id === sp.slipId);
    if (!slip) {
      return NextResponse.json({ error: `Pick slip ${sp.slipId} not found` }, { status: 404 });
    }
    if (slip.status !== 'captured' && slip.status !== 'failed-release') {
      return NextResponse.json({ error: `Cannot release ${sp.slipId} with status "${slip.status}"` }, { status: 400 });
    }
    resolvedSlips.push({ payload: sp, slip });
  }

  // Client lock — a delivery note must never mix clients/suppliers, but
  // multiple vendor numbers belonging to the SAME client are allowed on one note.
  const firstClient = resolvedSlips[0].payload.clientId;
  const mixedClients = resolvedSlips.some(r => r.payload.clientId !== firstClient);
  if (mixedClients) {
    return NextResponse.json(
      { error: 'Cannot release stock from multiple clients/suppliers on one delivery note' },
      { status: 400 },
    );
  }

  // Load users — needed for rep lookup AND audit
  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);

  // Look up the rep's stored release code
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
    const isPartial = !!managerOverrideCode;

    if (isPartial && managerOverrideRepId) {
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
    const deliveryToken = randomUUID();
    const isMulti = resolvedSlips.length > 1;

    // Update all slips with shared delivery token
    const updatedSlips: PickSlipRecord[] = [];
    for (const { payload, slip } of resolvedSlips) {
      const updated = await updateSlipInRun(payload.clientId, payload.loadId, payload.slipId, {
        status: finalStatus,
        releaseRepId,
        releaseRepName,
        releaseBoxes: payload.releaseBoxes ?? [],
        releasedAt: now,
        releasedBy: guard.userId,
        releasedByName: userName,
        deliveryToken,
      });
      if (updated) updatedSlips.push(updated);

      await logAudit({
        action: isPartial ? 'partial_release' : 'release_complete',
        userId: guard.userId,
        userName,
        slipId: payload.slipId,
        clientId: payload.clientId,
        detail: isPartial
          ? `Partial release of ${(payload.releaseBoxes ?? []).length} boxes (manager override by ${managerOverrideRepId})`
          : `Stock released — ${(payload.releaseBoxes ?? []).length} boxes in transit. Rep: ${releaseRepName}${isMulti ? ` (multi-slip release, ${resolvedSlips.length} slips)` : ''}`,
      });
    }

    // ── Generate & upload delivery note PDF ──
    try {
      const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://iram-rvl-crm.vercel.app';
      const qrUrl = `${siteUrl}/delivery/${deliveryToken}`;

      let pdfBuffer: Buffer;
      let pdfFileName: string;

      // Use the first slip for client-level info (all slips share clientName/vendorNumber)
      const firstSlip = resolvedSlips[0].slip;
      const firstClientId = resolvedSlips[0].payload.clientId;

      if (isMulti) {
        // Multi-slip delivery note
        pdfBuffer = await generateMultiSlipDeliveryNotePdf({
          clientName: firstSlip.clientName,
          vendorNumber: firstSlip.vendorNumber,
          releaseRepName,
          releasedAt: now,
          qrUrl,
          slips: resolvedSlips.map(({ payload, slip }) => ({
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
            stickerBarcodes: (payload.releaseBoxes ?? []).map(b => b.stickerBarcode),
          })),
        });

        // Multi-slip filename: {clientName} - {YYYY-MM-DD} ({last3OfSlip1}, {last3OfSlip2}).pdf
        const dateStr = now.slice(0, 10);
        const last3s = resolvedSlips.map(({ slip }) => slip.id.slice(-3)).join(', ');
        pdfFileName = `${firstSlip.clientName} - ${dateStr} (${last3s}).pdf`;
      } else {
        // Single-slip delivery note (unchanged)
        const slip = firstSlip;
        const boxes = resolvedSlips[0].payload.releaseBoxes ?? [];
        pdfBuffer = await generateDeliveryNotePdf({
          pickSlipId: slip.id,
          clientName: slip.clientName,
          vendorNumber: slip.vendorNumber,
          siteName: slip.siteName,
          siteCode: slip.siteCode,
          warehouse: slip.warehouse,
          releaseRepName,
          releasedAt: now,
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
          boxCount: boxes.length,
          stickerBarcodes: boxes.map(b => b.stickerBarcode),
          qrUrl,
        });
        pdfFileName = `${slip.siteName} ${slip.siteCode} - DN-${slip.id}.pdf`;
      }

      // Upload to SP
      const spLinks = await listSpLinks(firstClientId);
      const dnLink = spLinks.find(l => l.deliveryNoteFolderUrl);
      let uploadedWebUrl: string | undefined;

      if (dnLink?.deliveryNoteFolderUrl) {
        const dateFolder = now.slice(0, 10).replace(/-/g, '');
        const resolved = await resolveSharedItem(dnLink.deliveryNoteFolderUrl);
        const folder = await createFolder(resolved.driveId, resolved.folderId, dateFolder);
        const uploaded = await uploadNewFile(resolved.driveId, folder.id, pdfFileName, pdfBuffer, 'application/pdf');
        uploadedWebUrl = uploaded.webUrl;
      } else {
        console.warn('[release] No SP link with deliveryNoteFolderUrl for client', firstClientId, '— delivery note not uploaded');
      }

      // Save delivery note URL on ALL slips (shared DN)
      for (const { payload } of resolvedSlips) {
        await updateSlipInRun(payload.clientId, payload.loadId, payload.slipId, {
          deliveryNoteSpWebUrl: uploadedWebUrl,
          deliveryNoteGeneratedAt: new Date().toISOString(),
        });
      }

      // Email delivery note to the release rep
      try {
        const repEmail = repUser?.email;
        if (repEmail) {
          const subject = isMulti
            ? `Delivery Note — ${resolvedSlips.length} slips — ${firstSlip.clientName}`
            : `Delivery Note — ${firstSlip.id} — ${firstSlip.siteName} (${firstSlip.siteCode})`;
          const totalBoxes = resolvedSlips.reduce((s, { payload }) => s + (payload.releaseBoxes ?? []).length, 0);
          const totalQty = resolvedSlips.reduce((s, { slip }) => s + slip.totalQty, 0);
          await sendDeliveryNoteEmail({
            to: [repEmail],
            subject,
            pickSlipId: isMulti ? resolvedSlips.map(({ slip }) => slip.id).join(', ') : firstSlip.id,
            siteName: isMulti ? `${resolvedSlips.length} stores` : firstSlip.siteName,
            siteCode: isMulti ? '' : firstSlip.siteCode,
            warehouse: firstSlip.warehouse,
            releaseRepName,
            releasedAt: now,
            boxCount: totalBoxes,
            totalQty,
            qrUrl,
            attachments: [{ filename: pdfFileName, content: pdfBuffer }],
          });
        } else {
          console.warn('[release] No email found for release rep', releaseRepId, '— delivery note email skipped');
        }
      } catch (emailErr) {
        console.error('[release] Failed to email delivery note to rep:', emailErr instanceof Error ? emailErr.message : emailErr);
      }
    } catch (err) {
      console.error('[release] Delivery note generation/upload failed:', err instanceof Error ? err.message : err);
    }

    return NextResponse.json(
      { ok: true, status: finalStatus, slip: updatedSlips[0] ?? null, slips: updatedSlips },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } else {
    // Mismatch — set ALL slips to failed-release
    const updatedSlips: PickSlipRecord[] = [];
    for (const { payload } of resolvedSlips) {
      const updated = await updateSlipInRun(payload.clientId, payload.loadId, payload.slipId, {
        status: 'failed-release',
        releaseRepId,
        releaseRepName,
        releaseBoxes: payload.releaseBoxes ?? [],
      });
      if (updated) updatedSlips.push(updated);

      await logAudit({
        action: 'failed_release',
        userId: guard.userId,
        userName,
        slipId: payload.slipId,
        clientId: payload.clientId,
        detail: `Release code mismatch for rep ${releaseRepName} (${releaseRepId})`,
      });
    }

    return NextResponse.json(
      { ok: false, status: 'failed-release', error: 'Release code does not match', slip: updatedSlips[0] ?? null, slips: updatedSlips },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
