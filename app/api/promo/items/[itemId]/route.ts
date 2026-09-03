import { NextRequest, NextResponse } from 'next/server';
import { promoContext, fullName } from '@/lib/promoScope';
import { listPromoItems, savePromoItems, listPromoKits } from '@/lib/promoData';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

/** PATCH /api/promo/items/[itemId] — edit a catalogue item. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ itemId: string }> },
) {
  const ctx = await promoContext(req, 'manage_promo_kits');
  if (ctx instanceof NextResponse) return ctx;

  const { itemId } = await params;
  const body = await req.json().catch(() => null) as
    | { code?: string; description?: string; category?: string; notes?: string }
    | null;
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  const items = await listPromoItems();
  const item = items.find(i => i.id === itemId);
  if (!item) return NextResponse.json({ error: 'Item not found' }, { status: 404 });

  const nextCode = (body.code ?? item.code).trim();
  if (!nextCode) return NextResponse.json({ error: 'Item Code cannot be blank' }, { status: 400 });
  const clash = items.find(i => i.id !== itemId && i.code.trim().toLowerCase() === nextCode.toLowerCase());
  if (clash) {
    return NextResponse.json({ error: `Item Code "${nextCode}" is already used by another item` }, { status: 409 });
  }

  const before = `${item.code} / ${item.description}`;
  item.code = nextCode;
  if (body.description !== undefined) item.description = body.description.trim() || item.description;
  if (body.category !== undefined) item.category = body.category.trim() || undefined;
  if (body.notes !== undefined) item.notes = body.notes.trim() || undefined;
  item.updatedAt = new Date().toISOString();

  await savePromoItems(items);
  await logAudit({
    action: 'promo-item-edit',
    userId: ctx.me.id,
    userName: fullName(ctx.me),
    detail: `Promo item edited: ${before} to ${item.code} / ${item.description}`,
  });

  return NextResponse.json({ item });
}

/**
 * DELETE /api/promo/items/[itemId]
 *
 * Refused while any kit still lists the item. Kit lines snapshot the code and
 * description, so a delete would not visibly break a kit — it would quietly
 * leave a line nobody can trace back to a catalogue entry. Better to say no and
 * name the kits.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ itemId: string }> },
) {
  const ctx = await promoContext(req, 'manage_promo_kits');
  if (ctx instanceof NextResponse) return ctx;

  const { itemId } = await params;
  const items = await listPromoItems();
  const item = items.find(i => i.id === itemId);
  if (!item) return NextResponse.json({ error: 'Item not found' }, { status: 404 });

  const kits = await listPromoKits();
  const inUse = kits.filter(k => k.lines.some(l => l.source === 'promo' && l.ref === itemId));
  if (inUse.length > 0) {
    const names = inUse.map(k => `${k.reference} ${k.name}`).join(', ');
    return NextResponse.json(
      { error: `"${item.description}" is still in ${inUse.length} kit(s): ${names}. Remove it from those kits first.` },
      { status: 409 },
    );
  }

  await savePromoItems(items.filter(i => i.id !== itemId));
  await logAudit({
    action: 'promo-item-delete',
    userId: ctx.me.id,
    userName: fullName(ctx.me),
    detail: `Promo item deleted: ${item.code} / ${item.description}`,
  });

  return NextResponse.json({ ok: true });
}
