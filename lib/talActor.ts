/**
 * Who is scanning a Takealot step, shared by the per-booking and the
 * unit-by-unit scan routes. Warehouse receipts need the collecting rep's
 * release code (as on Book Stock into WH) and a warehouse the user can reach.
 */
import { NextResponse } from 'next/server';
import { loadUsers } from './userData';
import { loadControl } from './controlData';
import { verifyReleaseCode, masterCodeAuditNote } from './releaseCodeAuth';
import { resolveWarehouseAccess, denyIfOutOfScope } from './warehouseScopeServer';
import type { TalStage, TalActor } from './talShared';

interface Person { id: string; name?: string; surname?: string; releaseCode?: string }

export async function resolveTalActor(
  guard: { userId: string; userRole: string },
  stage: TalStage,
  body: { repId?: unknown; securityCode?: unknown; warehouseId?: unknown },
): Promise<{ actor: TalActor; access: Awaited<ReturnType<typeof resolveWarehouseAccess>> } | NextResponse> {
  const users = await loadUsers();
  const me = users.find((u) => u.id === guard.userId);
  const actor: TalActor = { byUserId: guard.userId, byName: me ? `${me.name} ${me.surname}` : 'Unknown' };
  const access = await resolveWarehouseAccess(guard.userId);
  if (!stage.needsRepAndWarehouse) return { actor, access };

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
  return { actor, access };
}
