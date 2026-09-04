import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { promoContext, fullName } from '@/lib/promoScope';
import {
  listPromoKits,
  savePromoKits,
  listPromoBookings,
  savePromoBookings,
  listPromoContacts,
  outCopiesByKit,
  kitAvailability,
  kitLineStock,
  applyLineShortfall,
  copiesLabel,
  unitsLabel,
  type PromoBooking,
  type PromoBookingLine,
  type PromoBookingStore,
  type PromoHolder,
} from '@/lib/promoData';
import { loadUsers } from '@/lib/userData';
import { loadControl } from '@/lib/controlData';
import { sendPromoKitOutEmail } from '@/lib/email';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

interface Rep { id: string; name: string; surname: string; email: string }

interface StoreRecord {
  id: string;
  name: string;
  siteCode?: string;
  channel?: string;
  region?: string;
  managerName?: string;
  managerPhone?: string;
  managerEmail?: string;
}

/**
 * POST /api/promo/kits/[kitId]/book-out
 *
 * Body: {
 *   holder: { type, id },            // who is accountable for bringing it back
 *   copies?,                          // how many copies of the kit are going
 *   storeId?, promoterName?,          // where it is being left, and who works it
 *   lines?: [{ lineId, quantity }],   // what is ACTUALLY going out, per line
 *   contentsConfirmed: true, note?, shortNote?
 * }
 *
 * The holder's NAME and EMAIL — and the store's — are re-read server-side from
 * the source record, so the booking (and the emails and the delivery note built
 * off it) can never be addressed to whatever the browser felt like sending.
 *
 * `lines` is the out-leg tick-list. Sending FEWER units than the kit should hold
 * means the item is not in the box, so the difference is recorded against the
 * kit as missing — the same shortfall the return leg records, through the same
 * helper. Sending MORE means the item has been replaced since it went missing,
 * and gives those units back. One control, both directions: an item found gone
 * at hand-over and an item that never came back are the same fact about the kit.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ kitId: string }> },
) {
  const ctx = await promoContext(req, 'book_promo_kits');
  if (ctx instanceof NextResponse) return ctx;

  const { kitId } = await params;
  const body = await req.json().catch(() => null) as
    | {
        holder?: { type?: string; id?: string };
        contentsConfirmed?: boolean;
        note?: string;
        shortNote?: string;
        copies?: number;
        storeId?: string;
        promoterName?: string;
        lines?: Array<{ lineId?: string; quantity?: number }>;
      }
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

  // ── What is ACTUALLY going out, line by line ───────────────────────────────
  //
  // `want` is a full set for these copies. `cap` is what the kit can currently
  // send: a line already short cannot magic units back into existence. The
  // screen defaults every line to `cap`, so anything BELOW that is an item the
  // person packing can see is not in the box.
  const stock = kitLineStock(kit, existingBookings);
  const requested = new Map<string, number>();
  for (const r of body.lines ?? []) {
    if (!r.lineId) continue;
    const q = Math.floor(Number(r.quantity));
    requested.set(r.lineId, Number.isFinite(q) && q > 0 ? q : 0);
  }

  const now = new Date().toISOString();
  const shortNote = (body.shortNote ?? '').trim();
  const outLines: PromoBookingLine[] = [];
  /** delta > 0 = units newly found missing, delta < 0 = units put back. */
  const adjustments: Array<{ lineId: string; code: string; description: string; delta: number }> = [];

  for (const line of kit.lines) {
    const st = stock.get(line.id);
    const want = line.quantity * copies;
    const cap = Math.min(want, st ? st.free : 0);
    const going = Math.max(0, Math.min(want, requested.has(line.id) ? requested.get(line.id)! : cap));
    if (going !== cap) {
      adjustments.push({ lineId: line.id, code: line.code, description: line.description, delta: cap - going });
    }
    outLines.push({
      lineId: line.id,
      source: line.source,
      code: line.code,
      description: line.description,
      quantity: going,
    });
  }

  const newlyMissing = adjustments.filter(a => a.delta > 0).map(a => ({ code: a.code, description: a.description, units: a.delta }));
  const restocked = adjustments.filter(a => a.delta < 0).map(a => ({ code: a.code, description: a.description, units: -a.delta }));

  const totalUnits = outLines.reduce((t, l) => t + l.quantity, 0);
  if (totalUnits === 0) {
    return NextResponse.json(
      { error: `Nothing would go out — every line is set to 0. Check the quantities before booking ${kit.reference} out.` },
      { status: 400 },
    );
  }
  // Writing stock off without saying why is how a kit quietly empties over a
  // year with nobody able to say what happened. Same gate as the return leg.
  if (newlyMissing.length > 0 && !shortNote) {
    return NextResponse.json(
      {
        error: `${newlyMissing.length} item(s) are not in the kit. Add a note saying what happened before booking it out.`,
        missing: newlyMissing,
      },
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

  // ── Resolve the store, if one was named ────────────────────────────────────
  // OPTIONAL on purpose: most kits are dropped at a store and left there, but a
  // rep taking one to a roadshow has no store, and forcing the field would only
  // teach people to invent one.
  let store: PromoBookingStore | undefined;
  const storeId = (body.storeId ?? '').trim();
  if (storeId) {
    const s = (await loadControl<StoreRecord>('stores')).find(x => x.id === storeId);
    if (!s) {
      return NextResponse.json({ error: 'That store is no longer on the store masterfile' }, { status: 404 });
    }
    store = {
      id: s.id,
      name: s.name,
      siteCode: s.siteCode || undefined,
      channel: s.channel || undefined,
      region: s.region || undefined,
      managerName: s.managerName || undefined,
      managerEmail: s.managerEmail || undefined,
      managerPhone: s.managerPhone || undefined,
    };
  }

  // ── Write the booking, then the kit ────────────────────────────────────────
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
    store,
    promoterName: (body.promoterName ?? '').trim() || undefined,
    contentsConfirmed: true,
    copies,
    // Kit line quantities are PER COPY; the booking records the physical count
    // that actually left, so the return tick-list needs no mental arithmetic.
    lines: outLines,
    outNote: (body.note ?? '').trim() || undefined,
  };

  const bookings = existingBookings;
  bookings.push(booking);
  await savePromoBookings(bookings);

  // How many COPIES are out stays derived from the open bookings and is never
  // stored on the kit. The kit is written only when this hand-over changed what
  // it physically holds — and it is written SECOND on purpose: a booking whose
  // shortfall did not save is a wrong number on a kit page, while a shortfall
  // whose booking did not save is stock written off against a hand-over that
  // never happened.
  if (adjustments.length > 0) {
    for (const a of adjustments) applyLineShortfall(kit, a.lineId, a.delta, shortNote, now);
    kit.updatedAt = now;
    await savePromoKits(kits);
  }

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
      storeName: store ? [store.name, store.siteCode].filter(Boolean).join(' - ') : undefined,
      storeManagerName: store?.managerName,
      promoterName: booking.promoterName,
      lines: booking.lines,
      note: booking.outNote,
      shortNote: newlyMissing.length > 0 ? shortNote : undefined,
      missing: newlyMissing,
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
      `${holder.name} <${holder.email}> by ${byName}. ` +
      (store ? `Left at ${store.name}${store.siteCode ? ` (${store.siteCode})` : ''}. ` : '') +
      (booking.promoterName ? `Promoter: ${booking.promoterName}. ` : '') +
      `${booking.lines.length} line(s), ${unitsLabel(totalUnits)}.` +
      (newlyMissing.length > 0
        ? ` NOT IN THE KIT: ${newlyMissing.map(m => `${m.code} x${m.units}`).join('; ')}. Note: ${shortNote}`
        : '') +
      (restocked.length > 0
        ? ` PUT BACK at hand-over: ${restocked.map(m => `${m.code} x${m.units}`).join('; ')}.`
        : '') +
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
    missing: newlyMissing,
    restocked,
    emailed: recipients,
    emailError: booking.outEmailError ?? null,
  });
}
