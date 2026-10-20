import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { listTalBookings, mutateTalBookings } from '@/lib/talData';
import { resolveWarehouseAccess, denyIfOutOfScope } from '@/lib/warehouseScopeServer';
import { normCode, NOT_FIXED_REASONS, type NotFixedReason } from '@/lib/talShared';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(req, 'view_aged_stock');
  if (guard instanceof NextResponse) return guard;
  const { id } = await params;
  const booking = (await listTalBookings()).find((b) => b.id === id);
  if (!booking) return NextResponse.json({ error: 'Booking not found' }, { status: 404 });
  return NextResponse.json({ booking }, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * PATCH /api/tal/[id]
 *  { returnTicket } — Takealot's Zendesk ticket approving the return (unlocks Return to TAL).
 *  { unrepairable: string[], reason, note } — mark units BSC kept as Unrepairable.
 *    Units left behind stay "Receipted by BSC" until someone does this, because
 *    BSC may still release them on a later collection.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(req, 'manage_pick_slips');
  if (guard instanceof NextResponse) return guard;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const me = (await loadUsers()).find((u) => u.id === guard.userId);
  const byName = me ? `${me.name} ${me.surname}` : 'Unknown';

  if ('returnTicket' in body) {
    const ticket = String(body.returnTicket ?? '').trim().replace(/^#/, '');
    if (!/^[A-Za-z0-9-]{1,30}$/.test(ticket)) return NextResponse.json({ error: 'Enter the Zendesk ticket number (letters and digits only)' }, { status: 400 });
    return mutateTalBookings<NextResponse>((all) => {
      const b = all.find((x) => x.id === id);
      if (!b) return { result: NextResponse.json({ error: 'Booking not found' }, { status: 404 }) };
      const now = new Date().toISOString();
      b.history.push({ status: 'repaired_iram', at: now, byUserId: guard.userId, byName, note: `Zendesk ticket ${ticket} recorded${b.returnTicket ? ` (was ${b.returnTicket})` : ''}` });
      b.returnTicket = ticket;
      b.updatedAt = now;
      return { save: all, result: NextResponse.json({ booking: b }) };
    });
  }

  const reason = String(body.reason ?? '') as NotFixedReason;
  if (!Object.hasOwn(NOT_FIXED_REASONS, reason)) return NextResponse.json({ error: 'Choose why BSC did not fix the unit(s)' }, { status: 400 });
  const rrns = new Set<string>((Array.isArray(body.unrepairable) ? body.unrepairable : []).map(normCode));
  if (!rrns.size) return NextResponse.json({ error: 'Select at least one unit' }, { status: 400 });

  const note = String(body.note ?? '').trim().slice(0, 300) || undefined;
  const access = await resolveWarehouseAccess(guard.userId);

  return mutateTalBookings<NextResponse>((all) => {
    const b = all.find((x) => x.id === id);
    if (!b) return { result: NextResponse.json({ error: 'Booking not found' }, { status: 404 }) };
    const bad = [...rrns].filter((r) => b.units.find((u) => u.rrn === r)?.status !== 'receipted_bsc');
    if (bad.length) {
      return { result: NextResponse.json({ error: `Only units at BSC can be marked unrepairable: ${bad.join(', ')}` }, { status: 400 }) };
    }
    const picked = b.units.filter((u) => rrns.has(u.rrn));
    const denied = denyIfOutOfScope(access, picked.map((u) => u.warehouseName), 'Marking unrepairable');
    if (denied) return { result: denied };

    const now = new Date().toISOString();
    for (const u of picked) {
      u.status = 'unrepairable';
      u.statusAt = now;
      u.notFixedReason = reason;
      u.history.push({ status: 'unrepairable', at: now, byUserId: guard.userId, byName, note: [NOT_FIXED_REASONS[reason].label, note].filter(Boolean).join(': ') });
    }
    b.history.push({ status: 'unrepairable', at: now, byUserId: guard.userId, byName, note: `${rrns.size} unit(s) marked unrepairable, ${NOT_FIXED_REASONS[reason].label}${note ? `: ${note}` : ''}` });
    b.updatedAt = now;
    return { save: all, result: NextResponse.json({ booking: b }) };
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(req, 'manage_pick_slips');
  if (guard instanceof NextResponse) return guard;
  const { id } = await params;
  return mutateTalBookings<NextResponse>((all) => {
    const b = all.find((x) => x.id === id);
    if (!b) return { result: NextResponse.json({ error: 'Booking not found' }, { status: 404 }) };
    // Scanned units are a stock record, so only a booking nobody has scanned can go.
    if (b.units.length) return { result: NextResponse.json({ error: 'This booking has scanned units and cannot be deleted' }, { status: 400 }) };
    return { save: all.filter((x) => x.id !== id), result: NextResponse.json({ ok: true }) };
  });
}
