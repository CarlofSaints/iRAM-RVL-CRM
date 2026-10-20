import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { loadControl } from '@/lib/controlData';
import { verifyReleaseCode, masterCodeAuditNote } from '@/lib/releaseCodeAuth';
import { resolveWarehouseAccess, denyIfOutOfScope } from '@/lib/warehouseScopeServer';
import { mutateTalBookings } from '@/lib/talData';
import { applyScan, talStage, normCode, type TalScan } from '@/lib/talShared';

export const dynamic = 'force-dynamic';

interface Person { id: string; name?: string; surname?: string; releaseCode?: string }

/**
 * POST /api/tal/[id]/scan { stage, scans: [{instructionNo, rrn}], repId?, securityCode?, warehouseId?, dryRun? }
 * Moves the scanned units to the stage's next status. Every check runs here,
 * not only on the scan screen. dryRun returns problems + what is missing without saving.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(req, 'scan_stock');
  if (guard instanceof NextResponse) return guard;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const stage = talStage(String(body.stage ?? ''));
  if (!stage) return NextResponse.json({ error: 'Unknown scan stage' }, { status: 400 });
  const scans: TalScan[] = Array.isArray(body.scans) ? body.scans.slice(0, 2000) : [];

  const users = await loadUsers();
  const me = users.find((u) => u.id === guard.userId);
  const actor: Parameters<typeof applyScan>[4] = { byUserId: guard.userId, byName: me ? `${me.name} ${me.surname}` : 'Unknown' };

  // Warehouse receipts: the collecting rep proves it with their release code, as on Book Stock into WH.
  const access = await resolveWarehouseAccess(guard.userId);
  if (stage.needsRepAndWarehouse) {
    const wh = access.warehouses.find((w) => w.id === body.warehouseId);
    if (!wh) return NextResponse.json({ error: 'Choose the receiving warehouse' }, { status: 400 });
    const denied = denyIfOutOfScope(access, [wh.code || wh.name], 'Receipting');
    if (denied) return denied;

    const rep: Person | undefined =
      (await loadControl<Person>('reps')).find((r) => r.id === body.repId) ?? users.find((u) => u.id === body.repId);
    if (!rep) return NextResponse.json({ error: 'Choose the collecting rep' }, { status: 400 });
    const repName = `${rep.name ?? ''} ${rep.surname ?? ''}`.trim();
    const check = verifyReleaseCode(String(body.securityCode ?? ''), rep.releaseCode, me, guard.userRole);
    if (!check.matched) {
      return NextResponse.json(
        { error: rep.releaseCode ? 'Security code does not match' : 'Selected rep has no release code' },
        { status: rep.releaseCode ? 403 : 400 },
      );
    }
    actor.repName = repName + (check.viaMaster ? masterCodeAuditNote(actor.byName ?? '', repName) : '');
    actor.warehouseId = wh.id;
    actor.warehouseName = wh.name;
  }

  return mutateTalBookings<NextResponse>((all) => {
    const b = all.find((x) => x.id === id);
    if (!b) return { result: NextResponse.json({ error: 'Booking not found' }, { status: 404 }) };
    // Units already in a warehouse can only be moved by someone with access to it.
    const scanned = new Set(scans.map((s) => normCode(s.rrn)));
    const held = b.units.filter((u) => scanned.has(u.rrn) && u.warehouseName).map((u) => u.warehouseName);
    const denied = denyIfOutOfScope(access, held, stage.label);
    if (denied) return { result: denied };

    const elsewhere = new Set(all.filter((x) => x.id !== id).flatMap((x) => x.units.map((u) => u.rrn)));
    const r = applyScan(b, stage, scans, elsewhere, actor);
    if (!r.ok || body.dryRun) {
      return { result: NextResponse.json({ errors: r.errors, missing: r.missing }, { status: r.ok ? 200 : 400 }) };
    }
    return {
      save: all.map((x) => (x.id === id ? r.booking! : x)),
      result: NextResponse.json({ booking: r.booking, missing: r.missing }),
    };
  });
}
