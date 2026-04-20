import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadControl } from '@/lib/controlData';
import { loadUsers } from '@/lib/userData';
import {
  listBatches,
  saveBatch,
  nextStickerSequence,
  type StickerBatch,
  type Sticker,
} from '@/lib/stickerData';

export const dynamic = 'force-dynamic';

interface Warehouse {
  id: string;
  name: string;
  code: string;
}

/**
 * GET /api/stickers — List all sticker batches.
 */
export async function GET(req: NextRequest) {
  const guard = await requirePermission(req, 'view_aged_stock');
  if (guard instanceof NextResponse) return guard;

  const batches = await listBatches();
  return NextResponse.json({ batches }, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * POST /api/stickers — Generate a new sticker batch.
 *
 * Body: { warehouseId: string, quantity: number }
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'load_aged_stock');
  if (guard instanceof NextResponse) return guard;

  let body: { warehouseId?: string; quantity?: number };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const warehouseId = typeof body.warehouseId === 'string' ? body.warehouseId.trim() : '';
  const quantity = typeof body.quantity === 'number' ? Math.round(body.quantity) : 0;

  if (!warehouseId) {
    return NextResponse.json({ error: 'warehouseId is required' }, { status: 400 });
  }
  if (quantity < 1 || quantity > 500) {
    return NextResponse.json({ error: 'quantity must be between 1 and 500' }, { status: 400 });
  }

  // Resolve warehouse
  const warehouses = await loadControl<Warehouse>('warehouses');
  const warehouse = warehouses.find(w => w.id === warehouseId);
  if (!warehouse) {
    return NextResponse.json({ error: 'Warehouse not found' }, { status: 404 });
  }

  // Resolve user
  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  const userName = me ? `${me.name} ${me.surname}` : 'Unknown';

  // Build barcode values
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
  const startSeq = await nextStickerSequence(warehouse.code, dateStr);

  const stickers: Sticker[] = [];
  for (let i = 0; i < quantity; i++) {
    const seq = startSeq + i;
    const seqStr = String(seq).padStart(4, '0');
    stickers.push({
      id: crypto.randomUUID(),
      barcodeValue: `STK-${warehouse.code}-${dateStr}-${seqStr}`,
    });
  }

  const batchId = crypto.randomUUID();
  const batch: StickerBatch = {
    id: batchId,
    warehouseCode: warehouse.code,
    warehouseName: warehouse.name,
    quantity,
    createdAt: now.toISOString(),
    createdBy: guard.userId,
    createdByName: userName,
    stickers,
  };

  await saveBatch(batch);

  return NextResponse.json({
    ok: true,
    batchId,
    quantity,
    warehouseCode: warehouse.code,
  });
}
