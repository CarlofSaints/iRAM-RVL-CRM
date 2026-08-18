import { NextRequest, NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { getClient } from '@/lib/spLinkData';
import { resolveSharedItem, createFolder, uploadNewFile } from '@/lib/graphIram';
import { sendSwapOutDeliveryNoteEmail } from '@/lib/email';
import {
  getSwapOutByDeliveryToken,
  updateSwapOut,
  returnedCount,
  type SwapOutEvent,
} from '@/lib/swapOutData';
import {
  generateSwapOutDeliveryNotePdf,
  signedSwapOutNoteFileName,
  type SwapOutDeliveryNoteRow,
} from '@/lib/swapOutDeliveryNotePdf';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * PUBLIC sign-off for a swap-out return leg. No login — the token in the URL is
 * the credential, exactly like the aged-stock /delivery/[token] route. The token
 * is a random UUID minted at release and only ever printed on that swap-out's
 * delivery note.
 *
 * Nothing here echoes anything the caller did not already have to know: a bad
 * token is a flat 404.
 */

const rowsFor = (lines: Array<{ product: string; description?: string; quantity: number; issuedQty?: number; returnedQty?: number }>): SwapOutDeliveryNoteRow[] =>
  lines.map((l) => ({
    product: l.product,
    description: l.description ?? '',
    requested: l.quantity || 0,
    issued: l.issuedQty || 0,
    returned: l.returnedQty || 0,
  }));

/** GET — what the supplier's collector sees before signing. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!token || token.length < 30) {
    return NextResponse.json({ error: 'Invalid link' }, { status: 400 });
  }

  const rec = await getSwapOutByDeliveryToken(token);
  if (!rec) {
    return NextResponse.json({ error: 'Delivery not found or link has expired' }, { status: 404 });
  }

  const client = await getClient(rec.clientId);

  return NextResponse.json(
    {
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
      lines: rowsFor(rec.lines ?? []),
      totalReturned: returnedCount(rec),
      // Already signed? The page shows the receipt rather than the pad.
      signed: Boolean(rec.deliverySignedAt),
      signedByName: rec.deliverySignedByName,
      signedAt: rec.deliverySignedAt,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

/** POST — record the signature, then produce, file and send the signed note. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!token || token.length < 30) {
    return NextResponse.json({ error: 'Invalid link' }, { status: 400 });
  }

  const rec = await getSwapOutByDeliveryToken(token);
  if (!rec) {
    return NextResponse.json({ error: 'Delivery not found or link has expired' }, { status: 404 });
  }
  if (rec.deliverySignedAt) {
    return NextResponse.json(
      { error: 'This return has already been signed for.', signedAt: rec.deliverySignedAt },
      { status: 409 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const signedByName = String(body.signedByName ?? '').trim();
  const signature = String(body.signature ?? '');

  if (!signedByName) {
    return NextResponse.json({ error: 'Please enter your name.' }, { status: 400 });
  }
  if (!signature.startsWith('data:image/')) {
    return NextResponse.json({ error: 'Please sign in the box before submitting.' }, { status: 400 });
  }

  const now = new Date().toISOString();
  const client = await getClient(rec.clientId);
  const clientName = client?.name ?? '';
  const vendorNumber = (client?.vendorNumbers ?? [])[0] ?? '';
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';

  // ── 1. Record the signature FIRST. ─────────────────────────────────────────
  // Filing and emailing can fail on someone else's infrastructure; the
  // signature itself must not be lost when they do. Everything after this point
  // is recoverable by re-running the dispatch from the swap-out page.
  const event: SwapOutEvent = {
    status: rec.status,
    at: now,
    byName: signedByName,
    method: 'manual',
    note: `Return signed for by ${signedByName}`,
  };
  await updateSwapOut(rec.id, {
    deliverySignature: signature,
    deliverySignedByName: signedByName,
    deliverySignedAt: now,
    history: [...rec.history, event],
  });

  // ── 2. Signed PDF ──────────────────────────────────────────────────────────
  const fileName = signedSwapOutNoteFileName({
    storeName: rec.storeName,
    storeCode: rec.storeCode,
    pickingNumber: rec.pickingNumber,
    swapOutId: rec.id,
  });

  let pdf: Buffer;
  try {
    pdf = await generateSwapOutDeliveryNotePdf({
      swapOutId: rec.id,
      pickingNumber: rec.pickingNumber,
      podNumber: rec.podNumber,
      clientName,
      vendorNumber,
      storeName: rec.storeName,
      storeCode: rec.storeCode,
      channel: rec.channel,
      region: rec.region,
      repName: rec.assignedRepName,
      releasedAt: rec.releasedToClientAt,
      releasedByName: rec.releasedToClientByName,
      releaseReference: rec.releaseReference,
      rows: rowsFor(rec.lines ?? []),
      qrUrl: `${siteUrl}/swap-out-delivery/${token}`,
      signature,
      signedByName,
      signedAt: now,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateSwapOut(rec.id, { deliveryDispatchError: `Signed PDF could not be generated: ${msg}` });
    return NextResponse.json({
      ok: true,
      signed: true,
      warning: 'Your signature was recorded, but the PDF could not be generated. iRam has been notified.',
    });
  }

  // Keep our own copy regardless of what SharePoint does.
  const blobKey = `swapouts/${rec.id}/signed-delivery-note.pdf`;
  try {
    await put(blobKey, pdf, {
      access: 'private',
      contentType: 'application/pdf',
      allowOverwrite: true,
      addRandomSuffix: false,
    });
  } catch (err) {
    console.error('[swap-out-delivery] blob store failed:', err instanceof Error ? err.message : err);
  }

  const problems: string[] = [];

  // ── 3. SharePoint: <swap-out folder>/YYYYMMDD/Signed/ ──────────────────────
  let spWebUrl: string | undefined;
  let spUploadedAt: string | undefined;
  try {
    const folderUrl = client?.swapOutFolderUrl;
    if (!folderUrl) {
      problems.push('No SharePoint swap-out folder is configured for this client.');
    } else {
      const resolved = await resolveSharedItem(folderUrl);
      const dateStr = (rec.releasedToClientAt ?? now).slice(0, 10).replace(/-/g, '');
      const dateFolder = await createFolder(resolved.driveId, resolved.folderId, dateStr);
      const signedFolder = await createFolder(resolved.driveId, dateFolder.id, 'Signed');
      const up = await uploadNewFile(resolved.driveId, signedFolder.id, fileName, pdf, 'application/pdf');
      spWebUrl = up.webUrl;
      spUploadedAt = new Date().toISOString();
    }
  } catch (err) {
    problems.push(`SharePoint upload failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 4. Email the client contacts who receive delivery notes ────────────────
  let emailedTo: string[] = [];
  let emailedAt: string | undefined;
  try {
    const recipients = (client?.contacts ?? [])
      .filter((c) => c.receiveDeliveryNotes && c.email)
      .map((c) => c.email!.trim())
      .filter(Boolean)
      .filter((e, i, a) => a.indexOf(e) === i);

    if (recipients.length === 0) {
      problems.push('No client contact is set to receive delivery notes, so nothing was emailed.');
    } else {
      await sendSwapOutDeliveryNoteEmail({
        to: recipients,
        subject: `Swap-Out Return Signed — ${rec.storeName}${rec.pickingNumber ? ` (${rec.pickingNumber})` : ''}`,
        pickingNumber: rec.pickingNumber,
        podNumber: rec.podNumber,
        clientName,
        storeName: rec.storeName,
        storeCode: rec.storeCode,
        totalReturned: returnedCount(rec),
        signedByName,
        signedAt: now,
        releaseReference: rec.releaseReference,
        attachments: [{ filename: fileName, content: pdf }],
      });
      emailedTo = recipients;
      emailedAt = new Date().toISOString();
    }
  } catch (err) {
    problems.push(`Email failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  await updateSwapOut(rec.id, {
    signedNoteBlobKey: blobKey,
    signedNoteFileName: fileName,
    signedNoteSpWebUrl: spWebUrl,
    signedNoteSpUploadedAt: spUploadedAt,
    deliveryEmailedTo: emailedTo.length ? emailedTo : undefined,
    deliveryEmailedAt: emailedAt,
    // Sticky, so a half-finished dispatch is visible on the swap-out page later
    // instead of vanishing with the response.
    deliveryDispatchError: problems.length ? problems.join(' ') : undefined,
  });

  return NextResponse.json({
    ok: true,
    signed: true,
    signedAt: now,
    emailedTo,
    spFiled: Boolean(spWebUrl),
    // The signer should never be shown our infrastructure problems as a failure —
    // their part is done. iRam sees the detail on the swap-out page.
    warning: problems.length
      ? 'Your signature was recorded. iRam will follow up on filing the paperwork.'
      : undefined,
  });
}
