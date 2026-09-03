import { NextRequest, NextResponse } from 'next/server';
import { promoContext, fullName } from '@/lib/promoScope';
import {
  listPromoKits,
  savePromoKits,
  listPromoBookings,
  outCopiesByKit,
  kitAvailability,
  bookingCopies,
  isOpenBooking,
  kitTotal,
} from '@/lib/promoData';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

/** GET /api/promo/kits/[kitId] — one kit, its availability, and its booking history. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ kitId: string }> },
) {
  const ctx = await promoContext(req, 'view_promo_kits');
  if (ctx instanceof NextResponse) return ctx;

  const { kitId } = await params;
  const [kits, allBookings] = await Promise.all([listPromoKits(), listPromoBookings()]);
  const kit = kits.find(k => k.id === kitId);
  if (!kit) return NextResponse.json({ error: 'Kit not found' }, { status: 404 });
  if (!ctx.canSeeClient(kit.clientId)) {
    return NextResponse.json({ error: 'You do not have access to that client' }, { status: 403 });
  }

  const bookings = allBookings
    .filter(b => b.kitId === kitId)
    .sort((a, b) => b.bookedOutAt.localeCompare(a.bookedOutAt))
    .map(b => ({ ...b, copies: bookingCopies(b) }));

  return NextResponse.json(
    {
      kit: {
        ...kit,
        clientName: ctx.clientName(kit.clientId),
        availability: kitAvailability(kit, outCopiesByKit(allBookings)),
      },
      bookings,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * PATCH /api/promo/kits/[kitId] — rename, re-note, change how many copies exist,
 * or edit the contents.
 *
 * Contents may be edited even while copies are out. Each booking SNAPSHOTS the
 * list that left, and the return tick-list is built from the booking, so an
 * edit cannot corrupt an open hand-over — the copies still out simply come back
 * against the list they went out on. Freezing instead would mean a kit with one
 * copy permanently on the road could never be edited at all.
 *
 * Body: { name?, notes?, totalQuantity?, lines?: [{ id, quantity }], removeLineIds?: string[] }
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ kitId: string }> },
) {
  const ctx = await promoContext(req, 'manage_promo_kits');
  if (ctx instanceof NextResponse) return ctx;

  const { kitId } = await params;
  const body = await req.json().catch(() => null) as
    | {
        name?: string;
        notes?: string;
        totalQuantity?: number;
        lines?: Array<{ id: string; quantity: number }>;
        removeLineIds?: string[];
      }
    | null;
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  const kits = await listPromoKits();
  const kit = kits.find(k => k.id === kitId);
  if (!kit) return NextResponse.json({ error: 'Kit not found' }, { status: 404 });
  if (!ctx.canSeeClient(kit.clientId)) {
    return NextResponse.json({ error: 'You do not have access to that client' }, { status: 403 });
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

  if (body.totalQuantity !== undefined) {
    const next = Math.floor(Number(body.totalQuantity));
    if (!Number.isFinite(next) || next < 1) {
      return NextResponse.json({ error: 'How many of this kit do you have? Enter 1 or more.' }, { status: 400 });
    }
    // Cannot own fewer copies than are currently out with people.
    const out = outCopiesByKit(await listPromoBookings()).get(kit.id) ?? 0;
    if (next < out) {
      return NextResponse.json(
        { error: `${out} cop${out === 1 ? 'y is' : 'ies are'} out with someone, so you cannot set the total below ${out}. Book them back in first.` },
        { status: 409 },
      );
    }
    const before = kitTotal(kit);
    if (next !== before) changes.push(`total copies ${before} to ${next}`);
    kit.totalQuantity = next;
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

  const outByKit = outCopiesByKit(await listPromoBookings());
  return NextResponse.json({
    kit: {
      ...kit,
      clientName: ctx.clientName(kit.clientId),
      availability: kitAvailability(kit, outByKit),
    },
  });
}

/** DELETE /api/promo/kits/[kitId] — refused while any copy is out with someone. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ kitId: string }> },
) {
  const ctx = await promoContext(req, 'manage_promo_kits');
  if (ctx instanceof NextResponse) return ctx;

  const { kitId } = await params;
  const [kits, bookings] = await Promise.all([listPromoKits(), listPromoBookings()]);
  const kit = kits.find(k => k.id === kitId);
  if (!kit) return NextResponse.json({ error: 'Kit not found' }, { status: 404 });
  if (!ctx.canSeeClient(kit.clientId)) {
    return NextResponse.json({ error: 'You do not have access to that client' }, { status: 403 });
  }

  const open = bookings.filter(b => b.kitId === kitId && isOpenBooking(b));
  if (open.length > 0) {
    const holders = open.map(b => `${b.holder.name} (${bookingCopies(b)})`).join(', ');
    return NextResponse.json(
      { error: `${kit.reference} still has copies out with ${holders}. Book them back in before deleting it.` },
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
    detail: `Promo kit deleted: ${kit.reference} "${kit.name}" (${kitTotal(kit)} copy/copies, ${kit.lines.length} line(s)). Booking history kept.`,
  });

  return NextResponse.json({ ok: true });
}
