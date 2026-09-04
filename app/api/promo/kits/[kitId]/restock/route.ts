import { NextRequest, NextResponse } from 'next/server';
import { promoContext, fullName } from '@/lib/promoScope';
import {
  listPromoKits,
  savePromoKits,
  listPromoBookings,
  outCopiesByKit,
  kitAvailability,
  kitLineStock,
  applyLineShortfall,
  kitTotal,
  lineMissing,
  unitsLabel,
} from '@/lib/promoData';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

/**
 * POST /api/promo/kits/[kitId]/restock
 *
 * Body: { lineId, quantity?, note? }
 *
 * The other half of the shortfall. An item written off when it was lost or not
 * returned stays written off until somebody physically replaces it, and this is
 * how they say so — the ball is back in the box, the kit counts it again, and
 * the next book-out sends it.
 *
 * `quantity` is how many units are being put back; omitted means all of them,
 * which is the common case (one thing went missing, one thing was replaced).
 * It only ever REDUCES the shortfall: the line's own quantity — the spec for
 * what a full kit holds — is edited on the kit page, not here, so a fat finger
 * on this screen cannot silently redefine the kit.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ kitId: string }> },
) {
  const ctx = await promoContext(req, 'manage_promo_kits');
  if (ctx instanceof NextResponse) return ctx;

  const { kitId } = await params;
  const body = await req.json().catch(() => null) as
    | { lineId?: string; quantity?: number; note?: string }
    | null;
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  const kits = await listPromoKits();
  const kit = kits.find(k => k.id === kitId);
  if (!kit) return NextResponse.json({ error: 'Kit not found' }, { status: 404 });
  if (!ctx.canSeeClient(kit.clientId)) {
    return NextResponse.json({ error: 'You do not have access to that client' }, { status: 403 });
  }

  const lineId = (body.lineId ?? '').trim();
  const line = kit.lines.find(l => l.id === lineId);
  if (!line) return NextResponse.json({ error: 'That item is not on this kit' }, { status: 404 });

  const short = lineMissing(line, kitTotal(kit));
  if (short === 0) {
    return NextResponse.json(
      { error: `${line.code} is not short — there is nothing to put back.` },
      { status: 409 },
    );
  }

  const asked = body.quantity === undefined ? short : Math.floor(Number(body.quantity));
  if (!Number.isFinite(asked) || asked < 1) {
    return NextResponse.json({ error: 'How many are being put back? Enter 1 or more.' }, { status: 400 });
  }
  if (asked > short) {
    return NextResponse.json(
      {
        error: `Only ${unitsLabel(short)} of ${line.code} are missing, so you cannot put ${asked} back. ` +
          `To increase what a full kit holds, change the quantity on the kit contents instead.`,
      },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();
  const note = (body.note ?? '').trim();
  // Negative delta = units coming back. Same helper as both booking legs, so
  // the clamping rules can never drift between putting stock back and taking it.
  const applied = -applyLineShortfall(kit, line.id, -asked, note || undefined, now);
  if (applied <= 0) {
    return NextResponse.json({ error: 'Nothing changed. Refresh the kit and try again.' }, { status: 409 });
  }

  kit.updatedAt = now;
  await savePromoKits(kits);

  const stillShort = lineMissing(line, kitTotal(kit));
  await logAudit({
    action: 'promo-kit-restock',
    userId: ctx.me.id,
    userName: fullName(ctx.me),
    clientId: kit.clientId,
    detail:
      `${kit.reference} "${kit.name}" (${ctx.clientName(kit.clientId)}): ${unitsLabel(applied)} of ` +
      `${line.code} ${line.description} put back into the kit by ${fullName(ctx.me)}. ` +
      (stillShort > 0 ? `Still short ${unitsLabel(stillShort)}.` : 'The line is complete again.') +
      (note ? ` Note: ${note}` : ''),
  });

  const bookings = await listPromoBookings();
  const stock = kitLineStock(kit, bookings);
  return NextResponse.json({
    kit: {
      ...kit,
      clientName: ctx.clientName(kit.clientId),
      availability: kitAvailability(kit, outCopiesByKit(bookings)),
      lines: kit.lines.map(l => ({ ...l, stock: stock.get(l.id) })),
    },
    restocked: applied,
    stillShort,
  });
}
