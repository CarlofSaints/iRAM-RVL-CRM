import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { loadControl } from '@/lib/controlData';
import { verifyReleaseCode, masterCodeAuditNote } from '@/lib/releaseCodeAuth';
import { resolveWarehouseAccess, denyIfOutOfScope } from '@/lib/warehouseScopeServer';
import { listTalBookings, saveTalBookings } from '@/lib/talData';
import { applyScan, talStage, type TalScan } from '@/lib/talShared';

export const dynamic = 'force-dynamic';

interface Person { id: string; name?: string; surname?: string; releaseCode?: string }
interface Warehouse { id: string; name: string; code?: string }

/**
 * POST /api/tal/[id]/scan { stage, scans: [{instructionNo, rrn, serial}], repId?, securityCode?, warehouseId?, dryRun? }
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

  const all = await listTalBookings();
  const b = all.find((x) => x.id === id);
  if (!b) return NextResponse.json({ error: 'Booking not found' }, { status: 404 });

  const users = await loadUsers();
  const me = users.find((u) => u.id === guard.userId);
  const actor: Parameters<typeof applyScan>[4] = { byUserId: guard.userId, byName: me ? `${me.name} ${me.surname}` : 'Unknown' };

  // Warehouse receipts: the collecting rep proves it with their release code, as on Book Stock into WH.
  if (stage.needsRepAndWarehouse) {
    const wh = (await loadControl<Warehouse>('warehouses')).find((w) => w.id === body.warehouseId);
    if (!wh) return NextResponse.json({ error: 'Choose the receiving warehouse' }, { status: 400 });
    const denied = denyIfOutOfScope(await resolveWarehouseAccess(guard.userId), [wh.code || wh.name], 'Receipting');
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

  const elsewhere = new Set(all.filter((x) => x.id !== id).flatMap((x) => x.units.map((u) => u.rrn)));
  const result = applyScan(b, stage, scans, elsewhere, actor);
  if (!result.ok || body.dryRun) {
    return NextResponse.json({ errors: result.errors, missing: result.missing }, { status: result.ok ? 200 : 400 });
  }
  await saveTalBookings(all.map((x) => (x.id === id ? result.booking! : x)));
  return NextResponse.json({ booking: result.booking, missing: result.missing });
}
