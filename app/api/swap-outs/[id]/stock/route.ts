import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { loadControl } from '@/lib/controlData';
import {
  getSwapOut,
  updateSwapOut,
  rollupMovements,
  unitCount,
  issuedCount,
  returnedCount,
  SWAPOUT_STAGES,
  type SwapOut,
  type SwapOutEvent,
  type SwapOutMovement,
  type SwapOutStatus,
} from '@/lib/swapOutData';

export const dynamic = 'force-dynamic';

interface RepRecord {
  id: string;
  name?: string;
  firstName?: string;
  surname?: string;
}

const repLabel = (r: RepRecord) =>
  r.name || `${r.firstName ?? ''} ${r.surname ?? ''}`.trim() || r.id;

/** Only ever move a swap-out forward through the lifecycle, never back. */
function advanceTo(current: SwapOutStatus, target: SwapOutStatus): SwapOutStatus {
  const a = SWAPOUT_STAGES.indexOf(current);
  const b = SWAPOUT_STAGES.indexOf(target);
  if (a === -1 || b === -1) return current;
  return b > a ? target : current;
}

/**
 * POST /api/swap-outs/[id]/stock — book stock out or back in.
 *
 * Body: {
 *   type: 'issue' | 'return',
 *   lines: [{ product, quantity }],   // quantity > 0
 *   repId?, warehouseId?, reference?, note?
 * }
 * or { reverseMovementId } to undo an earlier movement with a mirror entry.
 *
 *   issue  — good replacement stock booked OUT of the iRam warehouse. Capped at
 *            the quantity the store requested.
 *   return — faulty stock booked back IN against the good stock that went out.
 *            Capped at what was issued for that product: you cannot get faulty
 *            stock back for a unit you never sent.
 *
 * The ledger is append-only; per-line totals are recomputed from it every time.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(req, 'scan_stock');
  if (guard instanceof NextResponse) return guard;

  const { id } = await params;
  const rec = await getSwapOut(id);
  if (!rec) return NextResponse.json({ error: 'Swap-out not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const users = await loadUsers();
  const me = users.find((u) => u.id === guard.userId);
  const actorName = me ? `${me.name} ${me.surname}` : 'Unknown';

  const existing = rec.movements ?? [];
  const now = new Date().toISOString();
  let newMovements: SwapOutMovement[];
  let summaryNote: string;

  // --- Reversal -------------------------------------------------------------
  const reverseId = String(body.reverseMovementId ?? '').trim();
  if (reverseId) {
    const original = existing.find((m) => m.id === reverseId);
    if (!original) {
      return NextResponse.json({ error: 'That movement no longer exists' }, { status: 404 });
    }
    if (existing.some((m) => m.reference === `reversal:${reverseId}`)) {
      return NextResponse.json({ error: 'That movement has already been reversed' }, { status: 409 });
    }
    newMovements = [
      {
        id: randomUUID(),
        type: original.type,
        product: original.product,
        quantity: -original.quantity,
        at: now,
        byUserId: guard.userId,
        byName: actorName,
        reference: `reversal:${reverseId}`,
        note: body.note ? String(body.note) : 'Reversal',
      },
    ];
    summaryNote = `Reversed ${original.type === 'issue' ? 'good stock out' : 'faulty stock in'} — ${original.quantity} × ${original.product}`;
  } else {
    // --- Normal issue / return ---------------------------------------------
    const type = body.type === 'return' ? 'return' : body.type === 'issue' ? 'issue' : null;
    if (!type) {
      return NextResponse.json({ error: "type must be 'issue' or 'return'" }, { status: 400 });
    }

    const requested: Array<{ product: string; quantity: number }> = Array.isArray(body.lines)
      ? body.lines
          .map((l: { product?: string; quantity?: number }) => ({
            product: String(l?.product ?? '').trim(),
            quantity: Number(l?.quantity) || 0,
          }))
          .filter((l: { product: string; quantity: number }) => l.product && l.quantity > 0)
      : [];

    if (requested.length === 0) {
      return NextResponse.json({ error: 'Enter a quantity on at least one line' }, { status: 400 });
    }

    // Validate against the swap-out's own lines and what has already moved.
    const lineFor = new Map(rec.lines.map((l) => [l.product.trim().toUpperCase(), l]));
    const errors: string[] = [];
    for (const r of requested) {
      const key = r.product.toUpperCase();
      const line = lineFor.get(key);
      if (!line) {
        errors.push(`${r.product} is not on this swap-out.`);
        continue;
      }
      const alreadyIssued = line.issuedQty ?? 0;
      const alreadyBack = line.returnedQty ?? 0;
      if (type === 'issue') {
        const room = (line.quantity || 0) - alreadyIssued;
        if (r.quantity > room) {
          errors.push(
            `${r.product}: only ${room} of ${line.quantity} still to book out (${alreadyIssued} already out).`
          );
        }
      } else {
        const room = alreadyIssued - alreadyBack;
        if (alreadyIssued === 0) {
          errors.push(`${r.product}: no good stock booked out yet, so no faulty stock can come back.`);
        } else if (r.quantity > room) {
          errors.push(`${r.product}: only ${room} faulty unit(s) outstanding against stock issued.`);
        }
      }
    }
    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join(' '), errors }, { status: 400 });
    }

    let repId: string | undefined;
    let repName: string | undefined;
    if (body.repId !== undefined && String(body.repId).trim()) {
      repId = String(body.repId).trim();
      const reps = await loadControl<RepRecord>('reps');
      const rep = reps.find((r) => r.id === repId);
      repName = rep ? repLabel(rep) : repId;
    }

    newMovements = requested.map((r) => ({
      id: randomUUID(),
      type,
      product: r.product,
      quantity: r.quantity,
      at: now,
      byUserId: guard.userId,
      byName: actorName,
      repId,
      repName,
      warehouseId: body.warehouseId ? String(body.warehouseId).trim() : undefined,
      reference: body.reference ? String(body.reference).trim() : undefined,
      note: body.note ? String(body.note).trim() : undefined,
    }));

    const units = requested.reduce((t, r) => t + r.quantity, 0);
    summaryNote =
      type === 'issue'
        ? `Booked out ${units} good unit(s)${repName ? ` to ${repName}` : ''}`
        : `Booked in ${units} faulty unit(s)`;
  }

  const movements = [...existing, ...newMovements];
  const lines = rollupMovements(rec.lines, movements);
  const totals = { requested: unitCount({ lines }), out: issuedCount({ lines }), back: returnedCount({ lines }) };

  // Derive the lifecycle status from the physical position of the stock.
  let status = rec.status;
  if (status !== 'cancelled') {
    if (totals.out > 0) status = advanceTo(status, 'issued_rep');
    if (totals.out > 0 && totals.back >= totals.out) status = advanceTo(status, 'faulty_returned');
  }

  const updates: Partial<Omit<SwapOut, 'id'>> = { movements, lines };
  const events: SwapOutEvent[] = [
    {
      status,
      at: now,
      byUserId: guard.userId,
      byName: actorName,
      method: 'manual',
      note: summaryNote,
    },
  ];
  updates.status = status;
  updates.history = [...rec.history, ...events];

  // Booking stock out to a rep is also the moment that rep owns the consignment.
  const issuedRep = [...newMovements].reverse().find((m) => m.type === 'issue' && m.repId);
  if (issuedRep?.repId) {
    updates.assignedRepId = issuedRep.repId;
    updates.assignedRepName = issuedRep.repName;
  }

  const updated = await updateSwapOut(id, updates);
  return NextResponse.json(updated);
}
