import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { denyIfOutOfScope } from '@/lib/warehouseScopeServer';
import { listTalBookings, mutateTalBookings } from '@/lib/talData';
import { resolveTalActor } from '@/lib/talActor';
import { applyUnitScans, talStage, normCode, type TalScan } from '@/lib/talShared';

export const dynamic = 'force-dynamic';

/**
 * POST /api/tal/scan { stage, scans: [{rrn} | {instructionNo, noRrn: true, description?}], repId?, securityCode?, warehouseId? }
 * Unit-by-unit steps across ALL bookings (Collected from BSC, Return to TAL):
 * BSC hands back units from many bookings at once.
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'scan_stock');
  if (guard instanceof NextResponse) return guard;
  const body = await req.json().catch(() => ({}));

  const stage = talStage(String(body.stage ?? ''));
  if (!stage?.anyBooking) return NextResponse.json({ error: 'Unknown scan stage' }, { status: 400 });
  const scans: TalScan[] = Array.isArray(body.scans) ? body.scans.slice(0, 2000) : [];

  const who = await resolveTalActor(guard, stage, body);
  if (who instanceof NextResponse) return who;
  const { actor, access } = who;

  return mutateTalBookings<NextResponse>((all) => {
    const r = applyUnitScans(all, stage, scans, actor);
    if (!r.ok) return { result: NextResponse.json({ errors: r.errors }, { status: 400 }) };
    // Units in a warehouse can only be moved by someone with access to it.
    const was = new Map(all.flatMap((b) => b.units.map((u) => [`${b.id}|${u.rrn}`, u.warehouseName] as const)));
    const denied = denyIfOutOfScope(access, r.moved.map((m) => was.get(`${m.bookingId}|${m.unit.rrn}`)), stage.label);
    if (denied) return { result: denied };
    const byId = new Map(r.all!.map((b) => [b.id, b]));
    const moved = r.moved.map((m) => ({ ...m, region: byId.get(m.bookingId)?.region, supplierName: byId.get(m.bookingId)?.supplierName }));
    return { save: r.all, result: NextResponse.json({ moved }) };
  });
}

/** GET /api/tal/scan?stage=&code= — check one scanned RRN before it goes on the list. */
export async function GET(req: NextRequest) {
  const guard = await requirePermission(req, 'scan_stock');
  if (guard instanceof NextResponse) return guard;
  const stage = talStage(req.nextUrl.searchParams.get('stage') ?? '');
  if (!stage?.anyBooking) return NextResponse.json({ error: 'Unknown scan stage' }, { status: 400 });
  const code = normCode(req.nextUrl.searchParams.get('code'));
  for (const b of await listTalBookings()) {
    const u = b.units.find((x) => x.rrn === code);
    if (u) return NextResponse.json({ bookingId: b.id, brn: b.brn, unit: u }, { headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.json({ error: `${code} is not on any booking` }, { status: 404 });
}
