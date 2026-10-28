import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { denyIfOutOfScope } from '@/lib/warehouseScopeServer';
import { mutateTalBookings } from '@/lib/talData';
import { resolveTalActor } from '@/lib/talActor';
import { applyScan, talStage, normCode, type TalScan } from '@/lib/talShared';

export const dynamic = 'force-dynamic';

/**
 * POST /api/tal/[id]/scan { stage, scans: [{instructionNo, rrn, noRrn?, description?, rejected?}], repId?, securityCode?, warehouseId?, dryRun? }
 * Per-booking steps (Collected from TAL, BSC Drop-off). Every check runs here,
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

  const who = await resolveTalActor(guard, stage, body);
  if (who instanceof NextResponse) return who;
  const { actor, access } = who;

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
