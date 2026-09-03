import { NextRequest, NextResponse } from 'next/server';
import { promoContext, fullName } from '@/lib/promoScope';
import {
  listPromoKits,
  listPromoBookings,
  savePromoBookings,
  outCopiesByKit,
  kitAvailability,
  bookingCopies,
  copiesLabel,
  isOpenBooking,
} from '@/lib/promoData';
import { sendPromoKitReturnEmail } from '@/lib/email';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

/**
 * POST /api/promo/kits/[kitId]/book-in
 *
 * Body: { bookingId, returned: Array<{ lineId, quantity }>, note? }
 *
 * `bookingId` is REQUIRED because a kit can have several copies out with
 * several people at once. Returning "the" booking would be a coin toss the
 * moment a second copy goes out.
 *
 * `returned` is the tick-list from the screen: one entry per line that went
 * out, carrying how many came back. A short return still puts the copies back
 * in stock — they are physically on the shelf whether or not every item is in
 * them — but the booking is flagged short and both emails name what is missing.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ kitId: string }> },
) {
  const ctx = await promoContext(req, 'book_promo_kits');
  if (ctx instanceof NextResponse) return ctx;

  const { kitId } = await params;
  const body = await req.json().catch(() => null) as
    | { bookingId?: string; returned?: Array<{ lineId?: string; quantity?: number }>; note?: string }
    | null;
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  const [kits, bookings] = await Promise.all([listPromoKits(), listPromoBookings()]);
  const kit = kits.find(k => k.id === kitId);
  if (!kit) return NextResponse.json({ error: 'Kit not found' }, { status: 404 });
  if (!ctx.canSeeClient(kit.clientId)) {
    return NextResponse.json({ error: 'You do not have access to that client' }, { status: 403 });
  }

  const open = bookings.filter(b => b.kitId === kitId && isOpenBooking(b));
  if (open.length === 0) {
    return NextResponse.json({ error: `${kit.reference} is not out with anyone.` }, { status: 409 });
  }

  // Only fall back to "the" booking when there is genuinely one. With several
  // copies out, an unnamed booking is ambiguous and must be refused rather than
  // guessed — closing the wrong person's booking is not recoverable by a retry.
  const bookingId = (body.bookingId ?? '').trim();
  let booking = bookingId ? bookings.find(b => b.id === bookingId) : open.length === 1 ? open[0] : undefined;
  if (!booking && !bookingId) {
    return NextResponse.json(
      {
        error: `${kit.reference} has ${open.length} bookings out. Say which one is coming back.`,
        openBookings: open.map(b => ({
          id: b.id,
          copies: bookingCopies(b),
          holderName: b.holder.name,
          bookedOutAt: b.bookedOutAt,
        })),
      },
      { status: 409 },
    );
  }
  if (!booking || booking.kitId !== kitId) {
    return NextResponse.json({ error: 'That booking does not belong to this kit' }, { status: 404 });
  }
  if (booking.returnedAt) {
    return NextResponse.json({ error: 'That booking has already been returned' }, { status: 409 });
  }

  // Map the tick-list onto the lines that actually went out. A line the screen
  // did not send back counts as NOT returned rather than silently complete.
  const ticked = new Map<string, number>();
  for (const r of body.returned ?? []) {
    if (!r.lineId) continue;
    const q = Math.floor(Number(r.quantity));
    ticked.set(r.lineId, Number.isFinite(q) && q > 0 ? q : 0);
  }

  for (const line of booking.lines) {
    const back = Math.min(ticked.get(line.lineId) ?? 0, line.quantity);
    line.returnedQuantity = back;
  }

  const missing = booking.lines.filter(l => (l.returnedQuantity ?? 0) < l.quantity);
  const complete = missing.length === 0;
  const note = (body.note ?? '').trim();
  if (!complete && !note) {
    return NextResponse.json(
      {
        error: `${missing.length} item(s) did not come back. Add a note saying what happened before checking the kit in.`,
        missing: missing.map(l => ({ code: l.code, description: l.description, out: l.quantity, back: l.returnedQuantity ?? 0 })),
      },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  const byName = fullName(ctx.me);

  booking.returnedAt = now;
  booking.returnedByUserId = ctx.me.id;
  booking.returnedByName = byName;
  booking.returnedByEmail = ctx.me.email;
  booking.returnedComplete = complete;
  booking.returnNote = note || undefined;
  await savePromoBookings(bookings);
  // The kit record is untouched: closing this booking is what puts its copies
  // back on the shelf, because availability is derived from the open bookings.

  const recipients = [...new Set([ctx.me.email, booking.holder.email, booking.bookedOutByEmail].filter(Boolean))];
  try {
    await sendPromoKitReturnEmail({
      to: recipients,
      kitReference: booking.kitReference,
      kitName: booking.kitName,
      clientName: booking.clientName,
      bookedOutAt: booking.bookedOutAt,
      returnedAt: now,
      givenByName: booking.bookedOutByName,
      takenByName: booking.holder.name,
      takenByEmail: booking.holder.email,
      receivedByName: byName,
      complete,
      copies: bookingCopies(booking),
      lines: booking.lines,
      note: booking.returnNote,
    });
    booking.returnEmailTo = recipients;
    booking.returnEmailAt = new Date().toISOString();
  } catch (err) {
    booking.returnEmailError = err instanceof Error ? err.message : String(err);
    console.error('[promo book-in] email failed:', booking.returnEmailError);
  }
  await savePromoBookings(bookings);

  await logAudit({
    action: 'promo-kit-in',
    userId: ctx.me.id,
    userName: byName,
    clientId: kit.clientId,
    detail:
      `${kit.reference} "${kit.name}" (${booking.clientName}): ${copiesLabel(bookingCopies(booking))} returned by ` +
      `${booking.holder.name} <${booking.holder.email}>, received by ${byName}. ` +
      (complete
        ? 'All items returned.'
        : `SHORT: ${missing.map(l => `${l.code} ${l.returnedQuantity ?? 0} of ${l.quantity}`).join('; ')}. Note: ${note}`) +
      (booking.returnEmailError ? ` EMAIL FAILED: ${booking.returnEmailError}` : ` Emailed ${recipients.join(', ')}.`),
  });

  return NextResponse.json({
    booking,
    kit: {
      ...kit,
      clientName: booking.clientName,
      availability: kitAvailability(kit, outCopiesByKit(bookings)),
    },
    copies: bookingCopies(booking),
    complete,
    missing: missing.map(l => ({ code: l.code, description: l.description, out: l.quantity, back: l.returnedQuantity ?? 0 })),
    emailed: recipients,
    emailError: booking.returnEmailError ?? null,
  });
}
