import { NextRequest, NextResponse } from 'next/server';
import { promoContext, fullName } from '@/lib/promoScope';
import { listPromoKits, savePromoKits, nextKitReference, type PromoKit } from '@/lib/promoData';
import { logAudit } from '@/lib/auditLog';
import { randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';

/**
 * GET /api/promo/kits — every kit the caller's client scope allows.
 *
 * Returns the client NAME alongside the id so the grid, the filter and the
 * Excel export never have to join client-side (and so a client the caller
 * cannot see can never leak in through a name lookup).
 */
export async function GET(req: NextRequest) {
  const ctx = await promoContext(req, 'view_promo_kits');
  if (ctx instanceof NextResponse) return ctx;

  const kits = await listPromoKits();
  const visible = kits
    .filter(k => ctx.canSeeClient(k.clientId))
    .map(k => ({ ...k, clientName: ctx.clientName(k.clientId) }));

  return NextResponse.json(
    { kits: visible, scoped: ctx.visibleClientIds.size < ctx.clients.length },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/** POST /api/promo/kits — create an empty kit for a client. Body: { clientId, name, notes? } */
export async function POST(req: NextRequest) {
  const ctx = await promoContext(req, 'manage_promo_kits');
  if (ctx instanceof NextResponse) return ctx;

  const body = await req.json().catch(() => null) as
    | { clientId?: string; name?: string; notes?: string }
    | null;
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  const clientId = (body.clientId ?? '').trim();
  const name = (body.name ?? '').trim();
  if (!clientId) return NextResponse.json({ error: 'Pick a client' }, { status: 400 });
  if (!name) return NextResponse.json({ error: 'Give the kit a name' }, { status: 400 });
  if (!ctx.canSeeClient(clientId)) {
    return NextResponse.json({ error: 'You do not have access to that client' }, { status: 403 });
  }

  const kits = await listPromoKits();
  const dup = kits.find(
    k => k.clientId === clientId && k.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (dup) {
    return NextResponse.json(
      { error: `${ctx.clientName(clientId)} already has a kit called "${name}" (${dup.reference})` },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();
  const kit: PromoKit = {
    id: randomUUID(),
    reference: await nextKitReference(),
    clientId,
    name,
    notes: (body.notes ?? '').trim() || undefined,
    lines: [],
    status: 'home',
    createdAt: now,
    createdByName: fullName(ctx.me),
    updatedAt: now,
  };

  kits.push(kit);
  await savePromoKits(kits);
  await logAudit({
    action: 'promo-kit-create',
    userId: ctx.me.id,
    userName: fullName(ctx.me),
    clientId,
    detail: `Promo kit created: ${kit.reference} "${kit.name}" for ${ctx.clientName(clientId)}`,
  });

  return NextResponse.json({ kit: { ...kit, clientName: ctx.clientName(clientId) } });
}
