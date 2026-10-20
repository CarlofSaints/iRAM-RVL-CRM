import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { loadControl } from '@/lib/controlData';
import { listTalBookings, mutateTalBookings, findBookingByCode } from '@/lib/talData';
import { normCode, type TalBooking, type TalInstruction } from '@/lib/talShared';

export const dynamic = 'force-dynamic';

/** GET /api/tal[?code=] — list bookings, or find the one a scanned BRN / IN / RRN belongs to. */
export async function GET(req: NextRequest) {
  const guard = await requirePermission(req, 'view_aged_stock');
  if (guard instanceof NextResponse) return guard;

  const all = await listTalBookings();
  const code = req.nextUrl.searchParams.get('code');
  if (code !== null) {
    const booking = findBookingByCode(all, code);
    if (!booking) return NextResponse.json({ error: `Nothing found for ${normCode(code)}` }, { status: 404 });
    return NextResponse.json({ booking }, { headers: { 'Cache-Control': 'no-store' } });
  }
  all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return NextResponse.json({ bookings: all }, { headers: { 'Cache-Control': 'no-store' } });
}

/** POST /api/tal — save a checked Booking Confirmation as "Booking received". */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'import_excel');
  if (guard instanceof NextResponse) return guard;

  const body = await req.json().catch(() => ({}));
  const brn = normCode(body.brn);
  if (!/^[A-Z0-9]{6,40}$/.test(brn)) {
    return NextResponse.json({ error: 'Booking Reference Number is missing or not valid' }, { status: 400 });
  }
  const bookingDate = String(body.bookingDate ?? '').trim();
  if (bookingDate && !/^\d{4}-\d{2}-\d{2}$/.test(bookingDate)) {
    return NextResponse.json({ error: 'Date of booking must be YYYY-MM-DD' }, { status: 400 });
  }
  const timeSlot = String(body.timeSlot ?? '').trim();
  if (timeSlot && !/^\d{1,2}:\d{2}$/.test(timeSlot)) {
    return NextResponse.json({ error: 'Time slot must be HH:MM' }, { status: 400 });
  }

  const region = body.region;
  if (region !== 'GAU' && region !== 'CPT') return NextResponse.json({ error: 'Choose the Takealot DC (GAU or CPT)' }, { status: 400 });

  const instructions: TalInstruction[] = [];
  for (const raw of Array.isArray(body.instructions) ? body.instructions : []) {
    const instructionNo = normCode(raw?.instructionNo);
    const qty = Number(raw?.qty);
    if (!/^\d{4,20}$/.test(instructionNo)) {
      return NextResponse.json({ error: `Instruction number "${instructionNo}" must be digits only` }, { status: 400 });
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) {
      return NextResponse.json({ error: `Quantity for ${instructionNo} must be a whole number from 1 to 999` }, { status: 400 });
    }
    if (instructions.some((i) => i.instructionNo === instructionNo)) {
      return NextResponse.json({ error: `Instruction ${instructionNo} is listed twice` }, { status: 400 });
    }
    instructions.push({ instructionNo, qty });
  }
  if (!instructions.length) return NextResponse.json({ error: 'Add at least one instruction number' }, { status: 400 });

  const me = (await loadUsers()).find((u) => u.id === guard.userId);
  const byName = me ? `${me.name} ${me.surname}` : 'Unknown';
  const clients = await loadControl<{ id: string; name: string }>('clients');
  const bosch = clients.find((c) => /BOSCH/i.test(c.name));
  const now = new Date().toISOString();
  const rec: TalBooking = {
    id: randomUUID(),
    brn,
    clientId: bosch?.id,
    supplierName: String(body.supplierName ?? '').trim().slice(0, 120) || undefined,
    bookingDate: bookingDate || undefined,
    timeSlot: timeSlot || undefined,
    region,
    instructions,
    units: [],
    history: [{ status: 'booking_received', at: now, byUserId: guard.userId, byName, note: 'Booking Confirmation loaded' }],
    sourceFileName: String(body.sourceFileName ?? '').trim().slice(0, 200) || undefined,
    createdAt: now,
    updatedAt: now,
  };
  // Duplicate checks run inside the write so two uploads of the same PDF can't both land.
  return mutateTalBookings<NextResponse>((all) => {
    if (all.some((b) => b.brn === brn)) {
      return { result: NextResponse.json({ error: `Booking ${brn} is already loaded` }, { status: 409 }) };
    }
    const taken = instructions.find((i) => all.some((b) => b.instructions.some((x) => x.instructionNo === i.instructionNo)));
    if (taken) {
      return { result: NextResponse.json({ error: `Instruction ${taken.instructionNo} is already on another booking` }, { status: 409 }) };
    }
    return { save: [...all, rec], result: NextResponse.json({ booking: rec }) };
  });
}
