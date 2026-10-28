import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { mutateTalBookings } from '@/lib/talData';
import { resolveWarehouseAccess, denyIfOutOfScope } from '@/lib/warehouseScopeServer';
import { parseApprovalText, TAL_STATUS_LABELS } from '@/lib/talShared';

export const dynamic = 'force-dynamic';

/**
 * POST /api/tal/approval { text, dryRun? }
 * Takealot's return approval email(s), pasted in: each RRN gets the Zendesk
 * ticket it is approved under, which unlocks Return to TAL for that unit.
 * dryRun returns what was read and matched, for checking before saving.
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'manage_pick_slips');
  if (guard instanceof NextResponse) return guard;
  const body = await req.json().catch(() => ({}));
  const text = String(body.text ?? '').slice(0, 200_000);
  const items = parseApprovalText(text);
  if (!items.length) {
    return NextResponse.json({ error: 'No ticket number with RRNs under it was found. Paste the whole approval email.' }, { status: 400 });
  }

  const me = (await loadUsers()).find((u) => u.id === guard.userId);
  const byName = me ? `${me.name} ${me.surname}` : 'Unknown';
  const access = await resolveWarehouseAccess(guard.userId);

  return mutateTalBookings<NextResponse>((all) => {
    const rows = items.map((it) => {
      const b = all.find((x) => x.units.some((u) => u.rrn === it.rrn));
      const u = b?.units.find((x) => x.rrn === it.rrn);
      let problem = '';
      if (!u) problem = 'Not in Flow';
      else if (u.status === 'returned_tal') problem = 'Already returned to TAL';
      else if (u.status === 'rejected_new') problem = TAL_STATUS_LABELS.rejected_new;
      return {
        ...it, brn: b?.brn, status: u?.status, warehouseName: u?.warehouseName,
        previousTicket: u?.returnTicket && u.returnTicket !== it.ticket ? u.returnTicket : undefined, problem,
      };
    });
    const usable = rows.filter((r) => !r.problem);
    if (body.dryRun || !usable.length) return { result: NextResponse.json({ rows }) };

    const denied = denyIfOutOfScope(access, usable.map((r) => r.warehouseName), 'Recording the Takealot approval');
    if (denied) return { result: denied };

    const now = new Date().toISOString();
    for (const b of all) {
      const mine = usable.filter((r) => r.brn === b.brn);
      if (!mine.length) continue;
      for (const r of mine) {
        const u = b.units.find((x) => x.rrn === r.rrn)!;
        u.returnTicket = r.ticket;
        if (r.description && !u.description) u.description = r.description;
        u.history.push({ at: now, byUserId: guard.userId, byName, note: `Takealot approval, Zendesk ticket ${r.ticket}${r.previousTicket ? ` (was ${r.previousTicket})` : ''}` });
      }
      const tickets = [...new Set(mine.map((r) => r.ticket))].join(', ');
      b.history.push({ at: now, byUserId: guard.userId, byName, note: `Takealot approval: ${mine.length} unit(s), Zendesk ticket ${tickets}` });
      b.updatedAt = now;
    }
    return { save: all, result: NextResponse.json({ rows, saved: usable.length }) };
  });
}
