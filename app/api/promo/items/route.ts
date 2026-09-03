import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { promoContext, fullName } from '@/lib/promoScope';
import { listPromoItems, savePromoItems, type PromoItem } from '@/lib/promoData';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

const codeKey = (s: string) => s.trim().toLowerCase();

/**
 * GET /api/promo/items — the manual promo-material catalogue.
 *
 * Deliberately NOT client-scoped: a gazebo, a branded t-shirt or a box of
 * balloons is iRam's own stock and can go into any client's kit. The kits
 * themselves are client-scoped; the catalogue is shared.
 */
export async function GET(req: NextRequest) {
  const ctx = await promoContext(req, 'view_promo_kits');
  if (ctx instanceof NextResponse) return ctx;

  const items = await listPromoItems();
  items.sort((a, b) => a.description.localeCompare(b.description));

  return NextResponse.json({ items }, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * POST /api/promo/items — add one item, or a batch from an Excel upload.
 * Body: { code, description, category?, notes? } or { items: [...] }
 * Existing codes are UPDATED in place rather than duplicated.
 */
export async function POST(req: NextRequest) {
  const ctx = await promoContext(req, 'manage_promo_kits');
  if (ctx instanceof NextResponse) return ctx;

  const body = await req.json().catch(() => null) as
    | { code?: string; description?: string; category?: string; notes?: string; items?: Array<{ code?: string; description?: string; category?: string; notes?: string }> }
    | null;
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  const incoming = Array.isArray(body.items) ? body.items : [body];
  const cleaned = incoming
    .map(r => ({
      code: (r.code ?? '').trim(),
      description: (r.description ?? '').trim(),
      category: (r.category ?? '').trim(),
      notes: (r.notes ?? '').trim(),
    }))
    .filter(r => r.code || r.description);

  if (cleaned.length === 0) {
    return NextResponse.json({ error: 'Give the item a code or a description' }, { status: 400 });
  }
  const missingCode = cleaned.filter(r => !r.code);
  if (missingCode.length > 0) {
    return NextResponse.json(
      { error: `${missingCode.length} row(s) have no Item Code. Every promo item needs a code so it can be ticked off on return.` },
      { status: 400 },
    );
  }

  const items = await listPromoItems();
  const byCode = new Map(items.map(i => [codeKey(i.code), i] as const));
  const now = new Date().toISOString();
  const byName = fullName(ctx.me);
  let added = 0;
  let updated = 0;

  for (const row of cleaned) {
    const existing = byCode.get(codeKey(row.code));
    if (existing) {
      existing.description = row.description || existing.description;
      if (row.category) existing.category = row.category;
      if (row.notes) existing.notes = row.notes;
      existing.updatedAt = now;
      updated++;
      continue;
    }
    const item: PromoItem = {
      id: randomUUID(),
      code: row.code,
      description: row.description || row.code,
      category: row.category || undefined,
      notes: row.notes || undefined,
      createdAt: now,
      createdByName: byName,
      updatedAt: now,
    };
    items.push(item);
    byCode.set(codeKey(item.code), item);
    added++;
  }

  await savePromoItems(items);
  await logAudit({
    action: 'promo-item-save',
    userId: ctx.me.id,
    userName: byName,
    detail: `Promo material catalogue: ${added} added, ${updated} updated`,
  });

  return NextResponse.json({ added, updated, items });
}
