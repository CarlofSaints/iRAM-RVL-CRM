import { NextRequest, NextResponse } from 'next/server';
import { promoContext } from '@/lib/promoScope';
import {
  listPromoKits,
  listPromoBookings,
  bookingCopies,
  kitTotal,
} from '@/lib/promoData';
import { generatePromoDeliveryNotePdf } from '@/lib/promoDeliveryNotePdf';

export const dynamic = 'force-dynamic';

/**
 * GET /api/promo/bookings/[bookingId]/delivery-note
 *
 * The signable proof that a promo kit was dropped at a store. Built from the
 * BOOKING, never from the kit: the booking snapshots the store, the promoter,
 * the holder and the exact line list that physically left, so a note reprinted
 * six weeks later still shows what was handed over that day rather than what
 * the kit happens to hold now.
 *
 * Returned inline so the browser opens its PDF viewer ready to print. The
 * caller must fetch it with the app's auth header and open the blob — a plain
 * `<a href>` cannot send `x-user-id` and would land on a 401.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ bookingId: string }> },
) {
  const ctx = await promoContext(req, 'view_promo_kits');
  if (ctx instanceof NextResponse) return ctx;

  const { bookingId } = await params;
  const bookings = await listPromoBookings();
  const booking = bookings.find(b => b.id === bookingId);
  if (!booking) return NextResponse.json({ error: 'Booking not found' }, { status: 404 });
  if (!ctx.canSeeClient(booking.clientId)) {
    return NextResponse.json({ error: 'You do not have access to that client' }, { status: 403 });
  }

  // The kit is read only for its total copy count, which is a live number and
  // deliberately not snapshotted. A kit deleted since simply falls back to the
  // copies on the booking rather than refusing to print the history.
  const kit = (await listPromoKits()).find(k => k.id === booking.kitId);
  const copies = bookingCopies(booking);

  const pdf = await generatePromoDeliveryNotePdf({
    kitReference: booking.kitReference,
    kitName: booking.kitName,
    clientName: booking.clientName,
    copies,
    totalCopies: kit ? kitTotal(kit) : copies,
    storeName: booking.store?.name,
    storeCode: booking.store?.siteCode,
    channel: booking.store?.channel,
    region: booking.store?.region,
    storeManagerName: booking.store?.managerName,
    storeManagerPhone: booking.store?.managerPhone,
    promoterName: booking.promoterName,
    takenByName: booking.holder.name,
    takenByEmail: booking.holder.email,
    bookedOutAt: booking.bookedOutAt,
    bookedOutByName: booking.bookedOutByName,
    rows: booking.lines.map(l => ({ code: l.code, description: l.description, quantity: l.quantity })),
    note: booking.outNote,
  });

  // HTTP headers are LATIN-1. A kit named with an em dash or any non-ASCII
  // character would throw "ByteString > 255" on the way out, so the filename is
  // stripped to ASCII rather than trusting whatever the kit is called.
  const safe = `${booking.kitReference}-delivery-note`
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'promo-delivery-note';

  return new Response(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${safe}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}
