import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import {
  listSwapOuts,
  createSwapOuts,
  type SwapOut,
  type SwapOutLine,
} from '@/lib/swapOutData';

export const dynamic = 'force-dynamic';

const PICKING_RE = /^[A-Za-z]\d{5,}$/;

/** GET /api/swap-outs[?clientId=] — list swap-outs (optionally for one client). */
export async function GET(req: NextRequest) {
  const guard = await requirePermission(req, 'view_aged_stock');
  if (guard instanceof NextResponse) return guard;

  const clientId = req.nextUrl.searchParams.get('clientId');
  let all = await listSwapOuts();
  if (clientId) all = all.filter((s) => s.clientId === clientId);
  all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return NextResponse.json({ swapOuts: all }, { headers: { 'Cache-Control': 'no-store' } });
}

/** POST /api/swap-outs — manually create a single swap-out consignment. */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'scan_stock');
  if (guard instanceof NextResponse) return guard;

  const body = await req.json().catch(() => ({}));
  const clientId = String(body.clientId ?? '').trim();
  const storeName = String(body.storeName ?? '').trim();
  const pickingRaw = String(body.pickingNumber ?? '').trim();
  const lines: SwapOutLine[] = Array.isArray(body.lines)
    ? body.lines
        .filter((l: { product?: string }) => l && String(l.product ?? '').trim())
        .map((l: { product: string; description?: string; quantity?: number }) => ({
          product: String(l.product).trim(),
          description: l.description ? String(l.description).trim() : undefined,
          quantity: Number(l.quantity) || 0,
        }))
    : [];

  if (!clientId || !storeName) {
    return NextResponse.json({ error: 'clientId and storeName are required' }, { status: 400 });
  }

  const users = await loadUsers();
  const me = users.find((u) => u.id === guard.userId);
  const actorName = me ? `${me.name} ${me.surname}` : 'Unknown';

  const validPicking = PICKING_RE.test(pickingRaw);
  const now = new Date().toISOString();
  const rec: SwapOut = {
    id: randomUUID(),
    clientId,
    pickingNumber: validPicking ? pickingRaw : '',
    requestDate: body.requestDate ? String(body.requestDate) : undefined,
    channel: body.channel ? String(body.channel).trim() : undefined,
    storeName,
    storeCode: body.storeCode ? String(body.storeCode).trim() : undefined,
    region: body.region ? String(body.region).trim() : undefined,
    lines,
    status: validPicking ? 'picking_assigned' : 'requested',
    history: [
      {
        status: validPicking ? 'picking_assigned' : 'requested',
        at: now,
        byUserId: guard.userId,
        byName: actorName,
        method: 'manual',
        note: 'Created manually',
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  await createSwapOuts([rec]);
  return NextResponse.json(rec, { status: 201 });
}
