import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { loadControl } from '@/lib/controlData';
import { updateSlipInRun, getPickSlipRun, type PickSlipRecord } from '@/lib/pickSlipData';
import { listSpLinks } from '@/lib/spLinkData';
import { logAudit } from '@/lib/auditLog';
import { generateDeliveryNotePdf, generateMultiSlipDeliveryNotePdf } from '@/lib/deliveryNotePdf';
import { resolveSharedItem, createFolder, uploadNewFile } from '@/lib/graphIram';
import { sendDeliveryNoteEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

interface SlipRef {
  slipId: string;
  clientId: string;
  loadId: string;
}

/**
 * POST /api/receipts/reassign
 *
 * Re-assign an already-released slip (or multi-slip delivery group) to a
 * different collecting rep, regenerate the delivery note with the new rep's
 * name, re-upload it to SharePoint, and resend the delivery-note email to the
 * new rep. The delivery token (and therefore the QR confirmation link) is
 * preserved so existing links keep working.
 *
 * Body: { deliveryToken, slips: [{ slipId, clientId, loadId }], newRepId, newRepName, releaseCode }
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'receipt_stock');
  if (guard instanceof NextResponse) return guard;

  const body = await req.json();
  const {
    deliveryToken,
    newRepId,
    newRepName,
    releaseCode,
  } = body as {
    deliveryToken: string;
    newRepId: string;
    newRepName: string;
    releaseCode: string;
  };

  const slipRefs: SlipRef[] = Array.isArray(body.slips) ? body.slips : [];

  if (!deliveryToken) {
    return NextResponse.json({ ok: false, error: 'deliveryToken is required' }, { status: 400 });
  }
  if (slipRefs.length === 0) {
    return NextResponse.json({ ok: false, error: 'slips array is required' }, { status: 400 });
  }
  if (!newRepId) {
    return NextResponse.json({ ok: false, error: 'newRepId is required' }, { status: 400 });
  }
  if (!releaseCode) {
    return NextResponse.json({ ok: false, error: 'releaseCode is required' }, { status: 400 });
  }

  // ── Verify each slip exists, is reassignable, and belongs to this delivery token ──
  const resolvedSlips: Array<{ ref: SlipRef; slip: PickSlipRecord }> = [];
  for (const ref of slipRefs) {
    const run = await getPickSlipRun(ref.clientId, ref.loadId);
    if (!run) {
      return NextResponse.json({ ok: false, error: `Pick slip run not found for ${ref.slipId}` }, { status: 404 });
    }
    const slip = run.slips.find(s => s.id === ref.slipId);
    if (!slip) {
      return NextResponse.json({ ok: false, error: `Pick slip ${ref.slipId} not found` }, { status: 404 });
    }
    if (slip.status !== 'in-transit' && slip.status !== 'partial-release') {
      return NextResponse.json(
        { ok: false, error: `Cannot reassign ${ref.slipId} with status "${slip.status}" — only in-transit releases can be reassigned` },
        { status: 400 },
      );
    }
    if (slip.deliveryToken !== deliveryToken) {
      return NextResponse.json(
        { ok: false, error: `Pick slip ${ref.slipId} does not belong to this delivery` },
        { status: 400 },
      );
    }
    resolvedSlips.push({ ref, slip });
  }

  // ── Verify the new rep's release code ──
  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  const userName = me ? `${me.name} ${me.surname}` : guard.userId;

  const reps = await loadControl<{ id: string; releaseCode?: string }>('reps');
  const rep = reps.find(r => r.id === newRepId);
  const repUser = users.find(u => u.id === newRepId);
  if (!rep && !repUser) {
    return NextResponse.json({ ok: false, error: 'Rep/user not found' }, { status: 404 });
  }
  const storedCode = rep?.releaseCode || repUser?.releaseCode;
  if (!storedCode) {
    return NextResponse.json({ ok: false, error: 'This rep/user does not have a release code configured' }, { status: 400 });
  }
  const codeMatch = releaseCode.toUpperCase().trim() === storedCode.toUpperCase().trim();
  if (!codeMatch) {
    await logAudit({
      action: 'reassign_rep_failed',
      userId: guard.userId,
      userName,
      slipId: resolvedSlips.map(r => r.slip.id).join(', '),
      clientId: resolvedSlips[0].ref.clientId,
      detail: `Release code mismatch reassigning to ${newRepName} (${newRepId})`,
    });
    return NextResponse.json(
      { ok: false, error: 'Release code does not match the selected rep' },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const isMulti = resolvedSlips.length > 1;
  const firstSlip = resolvedSlips[0].slip;
  const firstClientId = resolvedSlips[0].ref.clientId;
  // Preserve the original release timestamp; fall back to now for legacy slips.
  const releasedAt = firstSlip.releasedAt || new Date().toISOString();

  // ── Update rep on all slips in the group ──
  const updatedSlips: PickSlipRecord[] = [];
  for (const { ref, slip } of resolvedSlips) {
    const prevRepName = slip.releaseRepName || '(unassigned)';
    const updated = await updateSlipInRun(ref.clientId, ref.loadId, ref.slipId, {
      releaseRepId: newRepId,
      releaseRepName: newRepName,
    });
    if (updated) updatedSlips.push(updated);

    await logAudit({
      action: 'reassign_rep',
      userId: guard.userId,
      userName,
      slipId: ref.slipId,
      clientId: ref.clientId,
      detail: `Reassigned collecting rep from ${prevRepName} to ${newRepName}${isMulti ? ` (multi-slip release, ${resolvedSlips.length} slips)` : ''}`,
    });
  }

  // ── Regenerate delivery note, re-upload, and resend email ──
  let emailSent = false;
  let emailError: string | undefined;
  let dnError: string | undefined;

  try {
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://iram-rvl-crm.vercel.app';
    const qrUrl = `${siteUrl}/delivery/${deliveryToken}`;

    let pdfBuffer: Buffer;
    let pdfFileName: string;

    if (isMulti) {
      pdfBuffer = await generateMultiSlipDeliveryNotePdf({
        clientName: firstSlip.clientName,
        vendorNumber: [...new Set(resolvedSlips.map(r => r.slip.vendorNumber).filter(Boolean))].join(' / ') || firstSlip.vendorNumber,
        releaseRepName: newRepName,
        releasedAt,
        qrUrl,
        slips: resolvedSlips.map(({ slip }) => ({
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
      });
      const dateStr = releasedAt.slice(0, 10);
      const last3s = resolvedSlips.map(({ slip }) => slip.id.slice(-3)).join(', ');
      pdfFileName = `${firstSlip.clientName} - ${dateStr} (${last3s}).pdf`;
    } else {
      const slip = firstSlip;
      const boxes = slip.releaseBoxes ?? [];
      pdfBuffer = await generateDeliveryNotePdf({
        pickSlipId: slip.id,
        clientName: slip.clientName,
        vendorNumber: slip.vendorNumber,
        siteName: slip.siteName,
        siteCode: slip.siteCode,
        warehouse: slip.warehouse,
        releaseRepName: newRepName,
        releasedAt,
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

    // Upload regenerated DN to SP
    const spLinks = await listSpLinks(firstClientId);
    const dnLink = spLinks.find(l => l.deliveryNoteFolderUrl);
    let uploadedWebUrl: string | undefined;

    if (dnLink?.deliveryNoteFolderUrl) {
      const dateFolder = releasedAt.slice(0, 10).replace(/-/g, '');
      const resolved = await resolveSharedItem(dnLink.deliveryNoteFolderUrl);
      const folder = await createFolder(resolved.driveId, resolved.folderId, dateFolder);
      const uploaded = await uploadNewFile(resolved.driveId, folder.id, pdfFileName, pdfBuffer, 'application/pdf');
      uploadedWebUrl = uploaded.webUrl;
    } else {
      console.warn('[reassign] No SP link with deliveryNoteFolderUrl for client', firstClientId, '— delivery note not re-uploaded');
    }

    // Save regenerated DN URL on all slips
    for (const { ref } of resolvedSlips) {
      await updateSlipInRun(ref.clientId, ref.loadId, ref.slipId, {
        deliveryNoteSpWebUrl: uploadedWebUrl,
        deliveryNoteGeneratedAt: new Date().toISOString(),
      });
    }

    // Resend delivery note email to the NEW rep
    const repEmail = repUser?.email;
    if (repEmail) {
      try {
        const subject = isMulti
          ? `Delivery Note (Reassigned) — ${resolvedSlips.length} slips — ${firstSlip.clientName}`
          : `Delivery Note (Reassigned) — ${firstSlip.id} — ${firstSlip.siteName} (${firstSlip.siteCode})`;
        const totalBoxes = resolvedSlips.reduce((s, { slip }) => s + (slip.releaseBoxes ?? []).length, 0);
        const totalQty = resolvedSlips.reduce((s, { slip }) => s + slip.totalQty, 0);
        await sendDeliveryNoteEmail({
          to: [repEmail],
          subject,
          pickSlipId: isMulti ? resolvedSlips.map(({ slip }) => slip.id).join(', ') : firstSlip.id,
          siteName: isMulti ? `${resolvedSlips.length} stores` : firstSlip.siteName,
          siteCode: isMulti ? '' : firstSlip.siteCode,
          warehouse: firstSlip.warehouse,
          releaseRepName: newRepName,
          releasedAt,
          boxCount: totalBoxes,
          totalQty,
          qrUrl,
          attachments: [{ filename: pdfFileName, content: pdfBuffer }],
        });
        emailSent = true;
      } catch (err) {
        emailError = err instanceof Error ? err.message : 'Failed to send email';
        console.error('[reassign] Failed to email delivery note to new rep:', emailError);
      }
    } else {
      emailError = 'No email address on file for the selected rep';
      console.warn('[reassign] No email for new rep', newRepId, '— delivery note email skipped');
    }
  } catch (err) {
    dnError = err instanceof Error ? err.message : 'Delivery note regeneration failed';
    console.error('[reassign] Delivery note generation/upload failed:', dnError);
  }

  return NextResponse.json(
    {
      ok: true,
      slips: updatedSlips,
      emailSent,
      emailError,
      dnError,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
