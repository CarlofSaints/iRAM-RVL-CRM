import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { listTalBookings, mutateTalBookings } from '@/lib/talData';
import { resolveWarehouseAccess, denyIfOutOfScope } from '@/lib/warehouseScopeServer';
import { normCode, unitLabel, NOT_FIXED_REASONS, TAL_STATUS_LABELS, type NotFixedReason } from '@/lib/talShared';

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
 *  { unitTicket: { rrn, ticket } } — set one unit's Zendesk ticket by hand.
 *  { unrepairable: string[], reason, note } — mark units BSC kept as Unrepairable.
 *    Units left behind stay "Receipted by BSC" until someone does this, because
 *    BSC may still release them on a later collection.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(req, 'manage_pick_slips');
  if (guard instanceof NextResponse) return guard;
  const { id } = await params;
  const raw = await req.json().catch(() => null);
  const body: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const me = (await loadUsers()).find((u) => u.id === guard.userId);
  const byName = me ? `${me.name} ${me.surname}` : 'Unknown';

  // A no-RRN unit (or one an approval email failed to name) gets its ticket by hand.
  if ('unitTicket' in body) {
    const ut = (body.unitTicket ?? {}) as { rrn?: unknown; ticket?: unknown };
    const rrn = normCode(ut.rrn);
    const ticket = normCode(ut.ticket).replace(/^#/, '');
    if (!/^\d{4,20}$/.test(ticket)) return NextResponse.json({ error: 'Enter the Zendesk ticket number (digits only)' }, { status: 400 });
    const access = await resolveWarehouseAccess(guard.userId);
    return mutateTalBookings<NextResponse>((all) => {
      const b = all.find((x) => x.id === id);
      const u = b?.units.find((x) => x.rrn === rrn);
      if (!b || !u) return { result: NextResponse.json({ error: 'Unit not found on this booking' }, { status: 404 }) };
      if (u.status === 'returned_tal' || u.status === 'rejected_new') {
        return { result: NextResponse.json({ error: `This unit is "${TAL_STATUS_LABELS[u.status]}"` }, { status: 400 }) };
      }
      const denied = denyIfOutOfScope(access, [u.warehouseName], 'Recording the Zendesk ticket');
      if (denied) return { result: denied };
      const now = new Date().toISOString();
      const note = `Zendesk ticket ${ticket} set by hand${u.returnTicket ? ` (was ${u.returnTicket})` : ''}`;
      u.history.push({ at: now, byUserId: guard.userId, byName, note });
      b.history.push({ at: now, byUserId: guard.userId, byName, note: `${unitLabel(u)}: ${note}` });
      u.returnTicket = ticket;
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
