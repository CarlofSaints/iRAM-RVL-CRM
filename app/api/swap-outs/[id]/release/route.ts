import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import {
  getSwapOut,
  updateSwapOut,
  returnedCount,
  type SwapOutEvent,
} from '@/lib/swapOutData';

export const dynamic = 'force-dynamic';

/**
 * POST /api/swap-outs/[id]/release — release the FAULTY stock out of the iRam
 * warehouse back to the supplier. The last leg of the swap-out.
 *
 * Body: { reference?: string, note?: string }
 *
 * Hard gate: the supplier POD for the good replacement stock must have been
 * captured first. The POD is what proves iRam actually received the swap stock,
 * so releasing the damaged units before it is captured breaks the chain of
 * custody — there would be nothing tying the two halves of the swap together.
 *
 * Gated on `scan_stock`, the permission every other swap-out stock action uses —
 * no new permission key, so no re-seed.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(req, 'scan_stock');
  if (guard instanceof NextResponse) return guard;

  const { id } = await params;
  const rec = await getSwapOut(id);
  if (!rec) return NextResponse.json({ error: 'Swap-out not found' }, { status: 404 });

  if (rec.status === 'cancelled') {
    return NextResponse.json({ error: 'This swap-out is cancelled.' }, { status: 409 });
  }
  if (!rec.podNumber) {
    return NextResponse.json(
      {
        error:
          'Scan the supplier POD for the good replacement stock before releasing the damaged stock back to the client.',
        reason: 'pod-required',
      },
      { status: 409 }
    );
  }
  if (rec.releasedToClientAt) {
    return NextResponse.json(
      {
        error: `Already released to the client on ${new Date(rec.releasedToClientAt).toLocaleString('en-GB')}${rec.releasedToClientByName ? ` by ${rec.releasedToClientByName}` : ''}.`,
        reason: 'already-released',
      },
      { status: 409 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const reference = String(body.reference ?? '').trim();
  const note = String(body.note ?? '').trim();

  const users = await loadUsers();
  const me = users.find((u) => u.id === guard.userId);
  const actorName = me ? `${me.name} ${me.surname}` : 'Unknown';
  const now = new Date().toISOString();

  // Releasing with nothing booked back in is legal but almost always a mistake,
  // so it is reported rather than blocked — the call is the warehouse's, not ours.
  const backIn = returnedCount(rec);

  const event: SwapOutEvent = {
    status: 'returned_client',
    at: now,
    byUserId: guard.userId,
    byName: actorName,
    method: 'manual',
    note:
      [
        `Damaged stock released to client (POD ${rec.podNumber})`,
        reference ? `ref ${reference}` : '',
        backIn === 0 ? 'NO faulty units were booked in against this swap-out' : `${backIn} faulty unit${backIn === 1 ? '' : 's'}`,
        note,
      ]
        .filter(Boolean)
        .join(' · '),
  };

  // Mint the sign-off token here so the delivery note carries a working QR the
  // moment it is printed. Re-releasing never re-mints — a token already in the
  // supplier's hands must keep working.
  const deliveryToken = rec.deliveryToken ?? randomUUID();

  const updated = await updateSwapOut(id, {
    status: 'returned_client',
    releasedToClientAt: now,
    releasedToClientBy: guard.userId,
    releasedToClientByName: actorName,
    releaseReference: reference || undefined,
    deliveryToken,
    history: [...rec.history, event],
  });

  return NextResponse.json({
    ok: true,
    swapOut: updated,
    deliveryToken,
    faultyUnitsReleased: backIn,
    warnings:
      backIn === 0
        ? ['No faulty units were booked in against this swap-out — nothing physically left the warehouse.']
        : [],
  });
}
