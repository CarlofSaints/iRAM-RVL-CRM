import { NextRequest, NextResponse } from 'next/server';
import { promoContext, fullName } from '@/lib/promoScope';
import {
  listPromoKits,
  savePromoKits,
  listPromoBookings,
  nextKitReference,
  outCopiesByKit,
  kitAvailability,
  bookingCopies,
  isOpenBooking,
  type PromoKit,
} from '@/lib/promoData';
import { logAudit } from '@/lib/auditLog';
import { randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';

/**
 * GET /api/promo/kits — every kit the caller's client scope allows.
 *
 * Returns the client NAME alongside the id so the grid, the filter and the
 * Excel export never have to join client-side (and so a client the caller
 * cannot see can never leak in through a name lookup).
 *
 * Availability (total / out / available) and the list of OPEN bookings are
 * derived here from the booking log rather than read off the kit, so the grid
 * can show who is holding which copies without a second round trip.
 */
export async function GET(req: NextRequest) {
  const ctx = await promoContext(req, 'view_promo_kits');
  if (ctx instanceof NextResponse) return ctx;

  const [kits, bookings] = await Promise.all([listPromoKits(), listPromoBookings()]);
  const outByKit = outCopiesByKit(bookings);

  const openByKit = new Map<string, typeof bookings>();
  for (const b of bookings) {
    if (!isOpenBooking(b)) continue;
    const list = openByKit.get(b.kitId) ?? [];
    list.push(b);
    openByKit.set(b.kitId, list);
  }

  const visible = kits
    .filter(k => ctx.canSeeClient(k.clientId))
    .map(k => ({
      ...k,
      clientName: ctx.clientName(k.clientId),
      availability: kitAvailability(k, outByKit),
      openBookings: (openByKit.get(k.id) ?? [])
        .sort((a, b) => a.bookedOutAt.localeCompare(b.bookedOutAt))
        .map(b => ({
          id: b.id,
          copies: bookingCopies(b),
          holderName: b.holder.name,
          holderEmail: b.holder.email,
          bookedOutAt: b.bookedOutAt,
          bookedOutByName: b.bookedOutByName,
        })),
    }));

  return NextResponse.json(
    { kits: visible, scoped: ctx.visibleClientIds.size < ctx.clients.length },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * POST /api/promo/kits — create an empty kit for a client.
 * Body: { clientId, name, totalQuantity?, notes? }
 */
export async function POST(req: NextRequest) {
  const ctx = await promoContext(req, 'manage_promo_kits');
  if (ctx instanceof NextResponse) return ctx;

  const body = await req.json().catch(() => null) as
    | { clientId?: string; name?: string; notes?: string; totalQuantity?: number }
    | null;
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  const clientId = (body.clientId ?? '').trim();
  const name = (body.name ?? '').trim();
  if (!clientId) return NextResponse.json({ error: 'Pick a client' }, { status: 400 });
  if (!name) return NextResponse.json({ error: 'Give the kit a name' }, { status: 400 });

  const totalQuantity = body.totalQuantity === undefined ? 1 : Math.floor(Number(body.totalQuantity));
  if (!Number.isFinite(totalQuantity) || totalQuantity < 1) {
    return NextResponse.json({ error: 'How many of this kit do you have? Enter 1 or more.' }, { status: 400 });
  }
  if (!ctx.canSeeClient(clientId)) {
    return NextResponse.json({ error: 'You do not have access to that client' }, { status: 403 });
  }

  const kits = await listPromoKits();
  const dup = kits.find(
    k => k.clientId === clientId && k.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (dup) {
    return NextResponse.json(
      { error: `${ctx.clientName(clientId)} already has a kit called "${name}" (${dup.reference})` },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();
  const kit: PromoKit = {
    id: randomUUID(),
    reference: await nextKitReference(),
    clientId,
    name,
    notes: (body.notes ?? '').trim() || undefined,
    totalQuantity,
    lines: [],
    createdAt: now,
    createdByName: fullName(ctx.me),
    updatedAt: now,
  };

  kits.push(kit);
  await savePromoKits(kits);
  await logAudit({
    action: 'promo-kit-create',
    userId: ctx.me.id,
    userName: fullName(ctx.me),
    clientId,
    detail: `Promo kit created: ${kit.reference} "${kit.name}" for ${ctx.clientName(clientId)}, ${totalQuantity} copy/copies`,
  });

  return NextResponse.json({
    kit: {
      ...kit,
      clientName: ctx.clientName(clientId),
      availability: { total: totalQuantity, out: 0, available: totalQuantity },
      openBookings: [],
    },
  });
}
