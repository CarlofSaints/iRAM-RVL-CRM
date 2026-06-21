import { NextRequest, NextResponse } from 'next/server';
import { requirePermission, requireLogin } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { loadControl } from '@/lib/controlData';
import {
  getSwapOut,
  updateSwapOut,
  deleteSwapOut,
  SWAPOUT_STATUS_LABELS,
  type SwapOut,
  type SwapOutEvent,
  type SwapOutStatus,
} from '@/lib/swapOutData';

export const dynamic = 'force-dynamic';

interface RepRecord {
  id: string;
  name?: string;
  firstName?: string;
  surname?: string;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireLogin(req);
  if (guard instanceof NextResponse) return guard;
  const { id } = await params;
  const rec = await getSwapOut(id);
  if (!rec) return NextResponse.json({ error: 'Swap-out not found' }, { status: 404 });
  return NextResponse.json(rec, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * PATCH /api/swap-outs/[id] — update status (with history), assign a rep, set the
 * picking number, or edit fields.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(req, 'scan_stock');
  if (guard instanceof NextResponse) return guard;
  const { id } = await params;
  const rec = await getSwapOut(id);
  if (!rec) return NextResponse.json({ error: 'Swap-out not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const users = await loadUsers();
  const me = users.find((u) => u.id === guard.userId);
  const actorName = me ? `${me.name} ${me.surname}` : 'Unknown';

  const updates: Partial<Omit<SwapOut, 'id'>> = {};

  // Assign / change rep
  if (body.assignedRepId !== undefined) {
    const repId = String(body.assignedRepId ?? '').trim();
    if (!repId) {
      updates.assignedRepId = undefined;
      updates.assignedRepName = undefined;
    } else {
      const reps = await loadControl<RepRecord>('reps');
      const rep = reps.find((r) => r.id === repId);
      updates.assignedRepId = repId;
      updates.assignedRepName = rep
        ? rep.name || `${rep.firstName ?? ''} ${rep.surname ?? ''}`.trim() || repId
        : repId;
    }
  }

  // Set / correct picking number
  if (body.pickingNumber !== undefined) {
    updates.pickingNumber = String(body.pickingNumber ?? '').trim();
  }
  if (body.storeId !== undefined) updates.storeId = String(body.storeId ?? '').trim() || undefined;
  if (body.storeCode !== undefined) updates.storeCode = String(body.storeCode ?? '').trim() || undefined;

  // Status transition (append a history event)
  if (body.status !== undefined) {
    const status = String(body.status) as SwapOutStatus;
    if (!(status in SWAPOUT_STATUS_LABELS)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }
    updates.status = status;
    const event: SwapOutEvent = {
      status,
      at: new Date().toISOString(),
      byUserId: guard.userId,
      byName: actorName,
      method: body.method === 'scan' ? 'scan' : 'manual',
      note: body.note ? String(body.note) : undefined,
    };
    updates.history = [...rec.history, event];
  }

  const updated = await updateSwapOut(id, updates);
  return NextResponse.json(updated);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(req, 'manage_pick_slips');
  if (guard instanceof NextResponse) return guard;
  const { id } = await params;
  await deleteSwapOut(id);
  return NextResponse.json({ ok: true });
}
