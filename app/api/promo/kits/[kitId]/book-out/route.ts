import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { promoContext, fullName } from '@/lib/promoScope';
import {
  listPromoKits,
  listPromoBookings,
  savePromoBookings,
  listPromoContacts,
  outCopiesByKit,
  kitAvailability,
  copiesLabel,
  type PromoBooking,
  type PromoHolder,
} from '@/lib/promoData';
import { loadUsers } from '@/lib/userData';
import { loadControl } from '@/lib/controlData';
import { sendPromoKitOutEmail } from '@/lib/email';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

interface Rep { id: string; name: string; surname: string; email: string }

/**
 * POST /api/promo/kits/[kitId]/book-out
 *
 * Body: { holder: { type, id }, contentsConfirmed: true, note? }
 *
 * The holder's NAME and EMAIL are re-read server-side from the source record so
 * the booking (and the emails sent off it) cannot be addressed to whatever the
 * browser felt like sending.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ kitId: string }> },
) {
  const ctx = await promoContext(req, 'book_promo_kits');
  if (ctx instanceof NextResponse) return ctx;

  const { kitId } = await params;
  const body = await req.json().catch(() => null) as
    | { holder?: { type?: string; id?: string }; contentsConfirmed?: boolean; note?: string; copies?: number }
    | null;
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  const [kits, existingBookings] = await Promise.all([listPromoKits(), listPromoBookings()]);
  const kit = kits.find(k => k.id === kitId);
  if (!kit) return NextResponse.json({ error: 'Kit not found' }, { status: 404 });
  if (!ctx.canSeeClient(kit.clientId)) {
    return NextResponse.json({ error: 'You do not have access to that client' }, { status: 403 });
  }

  // How many copies are being taken, and are there that many on the shelf?
  // Availability is derived from the open bookings, so two people booking the
  // last copy at the same moment cannot both succeed on a re-read.
  const availability = kitAvailability(kit, outCopiesByKit(existingBookings));
  const copies = body.copies === undefined ? 1 : Math.floor(Number(body.copies));
  if (!Number.isFinite(copies) || copies < 1) {
    return NextResponse.json({ error: 'How many copies are going out? Enter 1 or more.' }, { status: 400 });
  }
  if (availability.available === 0) {
    return NextResponse.json(
      {
        error: availability.total === 1
          ? `${kit.reference} is already out.`
          : `All ${availability.total} copies of ${kit.reference} are already out.`,
      },
      { status: 409 },
    );
  }
  if (copies > availability.available) {
    return NextResponse.json(
      { error: `Only ${availability.available} of ${availability.total} cop${availability.available === 1 ? 'y is' : 'ies are'} on the shelf.` },
      { status: 409 },
    );
  }

  if (kit.lines.length === 0) {
    return NextResponse.json(
      { error: `${kit.reference} has nothing in it. Add items before booking it out.` },
      { status: 409 },
    );
  }
  if (body.contentsConfirmed !== true) {
    return NextResponse.json(
      { error: 'Confirm every item is in the kit before booking it out' },
      { status: 400 },
    );
  }

  // ── Resolve the holder from the source of truth ────────────────────────────
  const holderType = body.holder?.type;
  const holderId = (body.holder?.id ?? '').trim();
  if (!holderId || (holderType !== 'user' && holderType !== 'rep' && holderType !== 'contact')) {
    return NextResponse.json({ error: 'Select the person taking the kit' }, { status: 400 });
  }

  let holder: PromoHolder | null = null;
  if (holderType === 'user') {
    const u = (await loadUsers()).find(x => x.id === holderId);
    if (u?.email) holder = { type: 'user', id: u.id, name: fullName(u) || u.email, email: u.email };
  } else if (holderType === 'rep') {
    const r = (await loadControl<Rep>('reps')).find(x => x.id === holderId);
    if (r?.email) {
      holder = { type: 'rep', id: r.id, name: [r.name, r.surname].filter(Boolean).join(' ').trim() || r.email, email: r.email };
    }
  } else {
    const c = (await listPromoContacts()).find(x => x.id === holderId);
    if (c) holder = { type: 'contact', id: c.id, name: c.name, email: c.email };
  }
  if (!holder) {
    return NextResponse.json({ error: 'That person no longer has an email address on record' }, { status: 404 });
  }

  // ── Write the booking, then the kit ────────────────────────────────────────
  const now = new Date().toISOString();
  const byName = fullName(ctx.me);
  const clientName = ctx.clientName(kit.clientId);

  const booking: PromoBooking = {
    id: randomUUID(),
    kitId: kit.id,
    kitReference: kit.reference,
    kitName: kit.name,
    clientId: kit.clientId,
    clientName,
    bookedOutAt: now,
    bookedOutByUserId: ctx.me.id,
    bookedOutByName: byName,
    bookedOutByEmail: ctx.me.email,
    holder,
    contentsConfirmed: true,
    copies,
    // Kit line quantities are PER COPY; the booking records the physical count
    // that actually left, so the return tick-list needs no mental arithmetic.
    lines: kit.lines.map(l => ({
      lineId: l.id,
      source: l.source,
      code: l.code,
      description: l.description,
      quantity: l.quantity * copies,
    })),
    outNote: (body.note ?? '').trim() || undefined,
  };

  const bookings = existingBookings;
  bookings.push(booking);
  await savePromoBookings(bookings);
  // The kit record itself is untouched — how many copies are out is derived
  // from the open bookings, never stored twice.

  // ── Email both parties. A failure is recorded, never swallowed. ────────────
  const recipients = [...new Set([ctx.me.email, holder.email].filter(Boolean))];
  try {
    await sendPromoKitOutEmail({
      to: recipients,
      kitReference: kit.reference,
      kitName: kit.name,
      clientName,
      bookedOutAt: now,
      givenByName: byName,
      takenByName: holder.name,
      takenByEmail: holder.email,
      copies,
      totalCopies: availability.total,
      lines: booking.lines,
      note: booking.outNote,
    });
    booking.outEmailTo = recipients;
    booking.outEmailAt = new Date().toISOString();
  } catch (err) {
    booking.outEmailError = err instanceof Error ? err.message : String(err);
    console.error('[promo book-out] email failed:', booking.outEmailError);
  }
  // Second write: the email result. The kit is already out either way — a dead
  // mail server must not undo a hand-over that physically happened.
  await savePromoBookings(bookings);

  await logAudit({
    action: 'promo-kit-out',
    userId: ctx.me.id,
    userName: byName,
    clientId: kit.clientId,
    detail:
      `${kit.reference} "${kit.name}" (${clientName}): ${copiesLabel(copies)} of ${availability.total} booked out to ` +
      `${holder.name} <${holder.email}> by ${byName}. ${booking.lines.length} line(s), ` +
      `${booking.lines.reduce((t, l) => t + l.quantity, 0)} unit(s).` +
      (booking.outEmailError ? ` EMAIL FAILED: ${booking.outEmailError}` : ` Emailed ${recipients.join(', ')}.`),
  });

  return NextResponse.json({
    booking,
    kit: {
      ...kit,
      clientName,
      availability: kitAvailability(kit, outCopiesByKit(bookings)),
    },
    copies,
    emailed: recipients,
    emailError: booking.outEmailError ?? null,
  });
}
