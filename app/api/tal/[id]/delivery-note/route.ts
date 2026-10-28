import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { listTalBookings } from '@/lib/talData';
import { generateTalDeliveryNotePdf } from '@/lib/talDeliveryNotePdf';
import { TAL_REGIONS, regionOf } from '@/lib/talShared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/tal/[id]/delivery-note[?at=ISO] — delivery note for one BSC Drop-off
 * (the latest when `at` is left out). Rendered live from the booking, opened
 * inline like the swap-out note.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(req, 'view_aged_stock');
  if (guard instanceof NextResponse) return guard;
  const { id } = await params;
  const b = (await listTalBookings()).find((x) => x.id === id);
  if (!b) return NextResponse.json({ error: 'Booking not found' }, { status: 404 });

  const drops = b.history.filter((h) => h.status === 'receipted_bsc');
  const at = req.nextUrl.searchParams.get('at');
  const drop = at ? drops.find((h) => h.at === at) : drops[drops.length - 1];
  if (!drop) return NextResponse.json({ error: 'Nothing on this booking has been dropped off at BSC yet' }, { status: 404 });
  const units = b.units.filter((u) => u.history.some((h) => h.status === 'receipted_bsc' && h.at === drop.at));

  const region = TAL_REGIONS[regionOf(b)];
  let pdf: Buffer;
  try {
    pdf = await generateTalDeliveryNotePdf({
      brn: b.brn, supplierName: b.supplierName, bscName: region.bsc, bscAddress: region.bscAddress,
      droppedAt: drop.at, droppedByName: drop.byName, units,
    });
  } catch (err) {
    return NextResponse.json({ error: `Delivery note could not be generated: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  }
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${b.brn} - BSC drop-off.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}
