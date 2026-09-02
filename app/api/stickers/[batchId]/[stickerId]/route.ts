import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { loadControl } from '@/lib/controlData';
import { clientScopeFor, filterClientIdsByScope } from '@/lib/clientScope';
import {
  getBatch,
  findBarcodeClash,
  updateStickerRecord,
  deleteSticker,
} from '@/lib/stickerData';
import { resolveSlipsForBarcode, type StickerSlipRef } from '@/lib/stickerLookup';
import {
  getPickSlipRun,
  updateSlipInRun,
  type PickSlipRecord,
  type ReceiptBox,
} from '@/lib/pickSlipData';
import { resolveWarehouseAccess, denyIfOutOfScope } from '@/lib/warehouseScopeServer';
import { verifyReleaseCode, masterCodeAuditNote } from '@/lib/releaseCodeAuth';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

interface ClientRecord { id: string; name: string }

const BARCODE_RE = /^[A-Z0-9][A-Z0-9-]{2,49}$/;

/** Scoped client ids for the caller — the same narrowing the slip screens use. */
async function scopedClientIds(
  userId: string,
  permissions: string[],
): Promise<{ clientIds: string[]; userName: string }> {
  const users = await loadUsers();
  const me = users.find(u => u.id === userId);
  const scope = clientScopeFor({
    role: me?.role ?? '',
    permissions,
    linkedClientId: me?.linkedClientId,
    assignedClientIds: me?.assignedClientIds,
  });
  const allClients = await loadControl<ClientRecord>('clients');
  return {
    clientIds: filterClientIdsByScope(scope, allClients.map(c => c.id)),
    userName: me ? `${me.name} ${me.surname}` : 'Unknown',
  };
}

/** Rewrite one barcode to another everywhere it appears in a box list. */
function renameBoxes(
  boxes: ReceiptBox[] | undefined,
  from: string,
  to: string,
  at: string,
): ReceiptBox[] | undefined {
  if (!boxes) return boxes;
  return boxes.map(b =>
    (b.stickerBarcode ?? '').toUpperCase().trim() === from
      ? { ...b, stickerBarcode: to, replacedBarcode: from, replacedAt: at }
      : b,
  );
}

/**
 * PATCH /api/stickers/[batchId]/[stickerId]
 *
 * Edit one box label: its number, and which pick slips it is linked to.
 *
 * Body: { barcodeValue?, linkedPickSlipIds?, reason }
 *
 * Renaming cascades into the pick slip's own box list, because THAT is the copy
 * a release reads — the registry is only an index built from it. A number
 * already printed on a delivery note is refused: the paper cannot be edited,
 * and the 26 Aug 2026 incident was exactly a screen releasing against a number
 * the database had quietly moved on from.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ batchId: string; stickerId: string }> },
) {
  const { batchId, stickerId } = await params;

  const guard = await requirePermission(req, 'load_aged_stock');
  if (guard instanceof NextResponse) return guard;

  let body: { barcodeValue?: string; linkedPickSlipIds?: unknown; reason?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    return NextResponse.json({ error: 'A reason is required' }, { status: 400 });
  }

  const batch = await getBatch(batchId);
  if (!batch) return NextResponse.json({ error: 'Sticker batch not found' }, { status: 404 });
  const sticker = batch.stickers.find(s => s.id === stickerId);
  if (!sticker) return NextResponse.json({ error: 'Sticker not found' }, { status: 404 });

  const access = await resolveWarehouseAccess(guard.userId);
  const denied = denyIfOutOfScope(access, [batch.warehouseCode], 'Sticker edit');
  if (denied) return denied;

  const oldBarcode = (sticker.barcodeValue ?? '').toUpperCase().trim();
  const newBarcode = typeof body.barcodeValue === 'string'
    ? body.barcodeValue.toUpperCase().replace(/\s+/g, '').trim()
    : oldBarcode;

  const wantsRename = !!newBarcode && newBarcode !== oldBarcode;

  if (wantsRename && !BARCODE_RE.test(newBarcode)) {
    return NextResponse.json(
      { error: 'Sticker number must be 3-50 characters: letters, digits and hyphens only' },
      { status: 400 },
    );
  }

  const { clientIds, userName } = await scopedClientIds(guard.userId, guard.permissions);

  const registryLinks = sticker.linkedPickSlipIds
    ?? (sticker.linkedPickSlipId ? [sticker.linkedPickSlipId] : []);

  // Who currently carries the old number — needed for the cascade, and to know
  // whether the number is already out on paper.
  const currentSlips = await resolveSlipsForBarcode(oldBarcode, registryLinks, clientIds);

  if (wantsRename) {
    const clash = await findBarcodeClash(newBarcode, stickerId);
    if (clash) {
      return NextResponse.json(
        {
          error: `${newBarcode} is already issued (${clash.warehouseName || clash.warehouseCode}). ` +
            'A barcode is printed on a physical box, so two records can never share one.',
        },
        { status: 409 },
      );
    }

    const onPaper = currentSlips.filter(s => s.onRelease || s.onDelivered);
    if (onPaper.length > 0) {
      return NextResponse.json(
        {
          error: `${oldBarcode} is already printed on a delivery note for ` +
            `${onPaper.map(s => s.siteName || s.siteCode).join(', ')}. ` +
            'The number cannot be changed once it is on paper — cancel or reverse that release first.',
        },
        { status: 409 },
      );
    }
  }

  // Validate any pick slip ids the caller wants linked — a typo would otherwise
  // create a link pointing at nothing.
  let nextLinks: string[] | undefined;
  if (Array.isArray(body.linkedPickSlipIds)) {
    const requested = [...new Set(
      body.linkedPickSlipIds
        .filter((v): v is string => typeof v === 'string' && !!v.trim())
        .map(v => v.trim().toUpperCase()),
    )];
    const known = new Set(currentSlips.map(s => s.id));
    const unknown = requested.filter(id => !known.has(id));
    if (unknown.length > 0) {
      const found = await resolveSlipsForBarcode('', unknown, clientIds);
      const stillMissing = unknown.filter(id => !found.some(s => s.id === id));
      if (stillMissing.length > 0) {
        return NextResponse.json(
          { error: `Pick slip not found (or outside your access): ${stillMissing.join(', ')}` },
          { status: 404 },
        );
      }
    }
    nextLinks = requested;
  }

  // Cascade the rename into the slips' own box lists BEFORE the registry moves,
  // so a failure halfway leaves the registry still pointing at the boxes.
  const cascaded: string[] = [];
  if (wantsRename) {
    const at = new Date().toISOString();
    for (const ref of currentSlips) {
      if (!ref.onReceipt && !ref.onOutstanding) continue;
      const run = await getPickSlipRun(ref.clientId, ref.loadId);
      const slip = run?.slips.find(s => s.id === ref.id);
      if (!slip) continue;

      const patch: Partial<PickSlipRecord> = {};
      if (slip.receiptBoxes) {
        patch.receiptBoxes = renameBoxes(slip.receiptBoxes, oldBarcode, newBarcode, at);
      }
      if (slip.outstandingBoxes) {
        patch.outstandingBoxes = renameBoxes(slip.outstandingBoxes, oldBarcode, newBarcode, at);
      }
      if (Object.keys(patch).length === 0) continue;

      await updateSlipInRun(ref.clientId, ref.loadId, ref.id, patch);
      cascaded.push(ref.id);
    }
  }

  const updated = await updateStickerRecord(batchId, stickerId, {
    ...(wantsRename ? { barcodeValue: newBarcode } : {}),
    ...(nextLinks ? { linkedPickSlipIds: nextLinks } : {}),
  });
  if (!updated) {
    return NextResponse.json({ error: 'Sticker disappeared while saving' }, { status: 409 });
  }

  const changes: string[] = [];
  if (wantsRename) {
    changes.push(`number ${oldBarcode} -> ${newBarcode}`);
    if (cascaded.length) changes.push(`box list rewritten on ${cascaded.join(', ')}`);
  }
  if (nextLinks) {
    changes.push(`links [${registryLinks.join(', ')}] -> [${nextLinks.join(', ')}]`);
  }

  await logAudit({
    action: 'sticker-edit',
    userId: guard.userId,
    userName,
    detail: `Edited sticker ${oldBarcode} (${batch.warehouseName || batch.warehouseCode}): ` +
      `${changes.length ? changes.join('; ') : 'no field changed'}. Reason: ${reason}`,
  });

  return NextResponse.json(
    { ok: true, sticker: updated, cascadedSlipIds: cascaded },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * DELETE /api/stickers/[batchId]/[stickerId]
 *
 * Remove one label from the registry. Gated by the caller's own release code
 * (a Super Admin's master code also stands), a reason, and — when a slip still
 * carries the label — an explicit acknowledgement.
 *
 * Body: { code, reason, acknowledgeLinked? }
 *
 * Deleting the record does NOT peel the label off the box and does NOT free the
 * number: `stickers/sequence.json` is untouched, and no pick slip is modified.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ batchId: string; stickerId: string }> },
) {
  const { batchId, stickerId } = await params;

  const guard = await requirePermission(req, 'load_aged_stock');
  if (guard instanceof NextResponse) return guard;

  let body: { code?: string; reason?: string; acknowledgeLinked?: boolean };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

  if (!reason) return NextResponse.json({ error: 'A reason is required' }, { status: 400 });
  if (!code) return NextResponse.json({ error: 'Your security code is required' }, { status: 400 });

  const batch = await getBatch(batchId);
  if (!batch) return NextResponse.json({ error: 'Sticker batch not found' }, { status: 404 });
  const sticker = batch.stickers.find(s => s.id === stickerId);
  if (!sticker) return NextResponse.json({ error: 'Sticker not found' }, { status: 404 });

  const access = await resolveWarehouseAccess(guard.userId);
  const denied = denyIfOutOfScope(access, [batch.warehouseCode], 'Sticker delete');
  if (denied) return denied;

  const me = access.user;
  if (!me?.releaseCode) {
    return NextResponse.json(
      { error: 'You have no security code set. Set one under My Account -> Release Code, then try again.' },
      { status: 400 },
    );
  }

  const check = verifyReleaseCode(code, me.releaseCode, me, guard.userRole);
  if (!check.matched) {
    return NextResponse.json({ error: 'Security code does not match' }, { status: 403 });
  }

  const barcode = (sticker.barcodeValue ?? '').toUpperCase().trim();
  const { clientIds, userName } = await scopedClientIds(guard.userId, guard.permissions);
  const slips: StickerSlipRef[] = await resolveSlipsForBarcode(
    barcode,
    sticker.linkedPickSlipIds ?? (sticker.linkedPickSlipId ? [sticker.linkedPickSlipId] : []),
    clientIds,
  );

  if (slips.length > 0 && !body.acknowledgeLinked) {
    return NextResponse.json(
      {
        error: 'This label is still on a pick slip. Deleting the record does not remove the box.',
        needsAcknowledgement: true,
        slips,
      },
      { status: 409 },
    );
  }

  const result = await deleteSticker(batchId, stickerId);
  if (!result) {
    return NextResponse.json({ error: 'Sticker disappeared while deleting' }, { status: 409 });
  }

  const stillCarried = slips.length
    ? ` Still carried by ${slips.map(s => `${s.id} (${s.siteName || s.siteCode})`).join(', ')} — the box was NOT removed.`
    : '';

  await logAudit({
    action: 'sticker-delete',
    userId: guard.userId,
    userName,
    detail: `Deleted sticker ${barcode} from ${batch.warehouseName || batch.warehouseCode}` +
      `${result.batchDeleted ? ' (last label in its batch, batch removed)' : ''}. ` +
      `Reason: ${reason}.${stillCarried}` +
      (check.viaMaster ? masterCodeAuditNote(userName, userName) : ''),
  });

  return NextResponse.json(
    { ok: true, barcode, batchDeleted: result.batchDeleted, stillCarriedBy: slips.map(s => s.id) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
