import { NextRequest, NextResponse } from 'next/server';
import { promoContext, fullName } from '@/lib/promoScope';
import {
  listPromoKits,
  savePromoKits,
  listPromoBookings,
  PROMO_KIT_STATUS_LABELS,
} from '@/lib/promoData';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

/** GET /api/promo/kits/[kitId] — one kit plus its booking history. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ kitId: string }> },
) {
  const ctx = await promoContext(req, 'view_promo_kits');
  if (ctx instanceof NextResponse) return ctx;

  const { kitId } = await params;
  const kits = await listPromoKits();
  const kit = kits.find(k => k.id === kitId);
  if (!kit) return NextResponse.json({ error: 'Kit not found' }, { status: 404 });
  if (!ctx.canSeeClient(kit.clientId)) {
    return NextResponse.json({ error: 'You do not have access to that client' }, { status: 403 });
  }

  const bookings = (await listPromoBookings())
    .filter(b => b.kitId === kitId)
    .sort((a, b) => b.bookedOutAt.localeCompare(a.bookedOutAt));

  return NextResponse.json(
    { kit: { ...kit, clientName: ctx.clientName(kit.clientId) }, bookings },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * PATCH /api/promo/kits/[kitId] — rename, re-note, or edit the contents.
 *
 * Contents may not be edited while the kit is OUT: the booking record holds the
 * list both parties agreed to at hand-over, and the return tick-list is built
 * from it. Letting someone add a line mid-loan would mean the kit comes back
 * "short" on an item that never left.
 *
 * Body: { name?, notes?, lines?: [{ id, quantity }], removeLineIds?: string[] }
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ kitId: string }> },
) {
  const ctx = await promoContext(req, 'manage_promo_kits');
  if (ctx instanceof NextResponse) return ctx;

  const { kitId } = await params;
  const body = await req.json().catch(() => null) as
    | { name?: string; notes?: string; lines?: Array<{ id: string; quantity: number }>; removeLineIds?: string[] }
    | null;
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  const kits = await listPromoKits();
  const kit = kits.find(k => k.id === kitId);
  if (!kit) return NextResponse.json({ error: 'Kit not found' }, { status: 404 });
  if (!ctx.canSeeClient(kit.clientId)) {
    return NextResponse.json({ error: 'You do not have access to that client' }, { status: 403 });
  }

  const touchesContents = (body.lines?.length ?? 0) > 0 || (body.removeLineIds?.length ?? 0) > 0;
  if (touchesContents && kit.status === 'out') {
    return NextResponse.json(
      { error: `${kit.reference} is ${PROMO_KIT_STATUS_LABELS.out.toLowerCase()}. Book it back in before changing what is in it.` },
      { status: 409 },
    );
  }

  const changes: string[] = [];

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return NextResponse.json({ error: 'Give the kit a name' }, { status: 400 });
    const dup = kits.find(
      k => k.id !== kit.id && k.clientId === kit.clientId && k.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (dup) {
      return NextResponse.json({ error: `That client already has a kit called "${name}" (${dup.reference})` }, { status: 409 });
    }
    if (name !== kit.name) changes.push(`renamed "${kit.name}" to "${name}"`);
    kit.name = name;
  }

  if (body.notes !== undefined) {
    kit.notes = body.notes.trim() || undefined;
  }

  for (const edit of body.lines ?? []) {
    const line = kit.lines.find(l => l.id === edit.id);
    if (!line) continue;
    const qty = Math.floor(Number(edit.quantity));
    if (!Number.isFinite(qty) || qty < 1) {
      return NextResponse.json({ error: `Quantity for ${line.code} must be 1 or more` }, { status: 400 });
    }
    if (qty !== line.quantity) changes.push(`${line.code} qty ${line.quantity} to ${qty}`);
    line.quantity = qty;
  }

  if (body.removeLineIds?.length) {
    const removing = new Set(body.removeLineIds);
    const removed = kit.lines.filter(l => removing.has(l.id));
    kit.lines = kit.lines.filter(l => !removing.has(l.id));
    if (removed.length) changes.push(`removed ${removed.map(l => l.code).join(', ')}`);
  }

  kit.updatedAt = new Date().toISOString();
  await savePromoKits(kits);

  if (changes.length) {
    await logAudit({
      action: 'promo-kit-edit',
      userId: ctx.me.id,
      userName: fullName(ctx.me),
      clientId: kit.clientId,
      detail: `Promo kit ${kit.reference}: ${changes.join('; ')}`,
    });
  }

  return NextResponse.json({ kit: { ...kit, clientName: ctx.clientName(kit.clientId) } });
}

/** DELETE /api/promo/kits/[kitId] — refused while the kit is out with someone. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ kitId: string }> },
) {
  const ctx = await promoContext(req, 'manage_promo_kits');
  if (ctx instanceof NextResponse) return ctx;

  const { kitId } = await params;
  const kits = await listPromoKits();
  const kit = kits.find(k => k.id === kitId);
  if (!kit) return NextResponse.json({ error: 'Kit not found' }, { status: 404 });
  if (!ctx.canSeeClient(kit.clientId)) {
    return NextResponse.json({ error: 'You do not have access to that client' }, { status: 403 });
  }
  if (kit.status === 'out') {
    return NextResponse.json(
      { error: `${kit.reference} is out with someone. Book it back in before deleting it.` },
      { status: 409 },
    );
  }

  await savePromoKits(kits.filter(k => k.id !== kitId));
  // The booking log is deliberately left intact — it snapshots the kit
  // reference, name and client, so the history still reads correctly.
  await logAudit({
    action: 'promo-kit-delete',
    userId: ctx.me.id,
    userName: fullName(ctx.me),
    clientId: kit.clientId,
    detail: `Promo kit deleted: ${kit.reference} "${kit.name}" (${kit.lines.length} line(s)). Booking history kept.`,
  });

  return NextResponse.json({ ok: true });
}
