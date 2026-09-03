import { NextRequest, NextResponse } from 'next/server';
import { promoContext } from '@/lib/promoScope';
import { listPromoBookings } from '@/lib/promoData';

export const dynamic = 'force-dynamic';

/**
 * GET /api/promo/bookings — the booking log.
 *
 * Every out and in leg, with all its metadata: who gave the kit, who took it,
 * when, what was in it, what came back, who was emailed and whether that email
 * failed. Newest first. Scoped to the caller's clients like the kits are.
 */
export async function GET(req: NextRequest) {
  const ctx = await promoContext(req, 'view_promo_kits');
  if (ctx instanceof NextResponse) return ctx;

  const bookings = (await listPromoBookings())
    .filter(b => ctx.canSeeClient(b.clientId))
    .sort((a, b) => b.bookedOutAt.localeCompare(a.bookedOutAt));

  return NextResponse.json({ bookings }, { headers: { 'Cache-Control': 'no-store' } });
}
