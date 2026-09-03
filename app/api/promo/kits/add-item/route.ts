import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { promoContext, fullName } from '@/lib/promoScope';
import { listSpLinks, loadLinkProducts } from '@/lib/spLinkData';
import {
  listPromoKits,
  savePromoKits,
  listPromoItems,
  lineKey,
  normArticle,
  type PromoKitLine,
  type PromoLineSource,
} from '@/lib/promoData';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

/**
 * POST /api/promo/kits/add-item — add ONE item to ONE OR MANY kits in a single call.
 *
 * This is the whole point of the "Add to Kits" screen: adding the same banner
 * to five kits one kit at a time is the thing the module exists to avoid. The
 * single-kit "Add item" button on a kit page posts here too with one kit id, so
 * there is only one code path that can put a line into a kit.
 *
 * Body: { source: 'sku' | 'promo', ref, quantity, kitIds: string[] }
 *
 * The code/description are resolved SERVER-side (catalogue for 'promo', the
 * client's product control file for 'sku') and snapshotted onto the line — the
 * browser never gets to name what an item is.
 */
export async function POST(req: NextRequest) {
  const ctx = await promoContext(req, 'manage_promo_kits');
  if (ctx instanceof NextResponse) return ctx;

  const body = await req.json().catch(() => null) as
    | { source?: string; ref?: string; quantity?: number; kitIds?: string[] }
    | null;
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  const source = body.source as PromoLineSource;
  if (source !== 'sku' && source !== 'promo') {
    return NextResponse.json({ error: 'source must be "sku" or "promo"' }, { status: 400 });
  }
  const ref = (body.ref ?? '').trim();
  if (!ref) return NextResponse.json({ error: 'No item selected' }, { status: 400 });

  const quantity = Math.floor(Number(body.quantity));
  if (!Number.isFinite(quantity) || quantity < 1) {
    return NextResponse.json({ error: 'Quantity must be 1 or more' }, { status: 400 });
  }

  const kitIds = (body.kitIds ?? []).filter(Boolean);
  if (kitIds.length === 0) return NextResponse.json({ error: 'Pick at least one kit' }, { status: 400 });

  const kits = await listPromoKits();
  const targets = kits.filter(k => kitIds.includes(k.id));
  if (targets.length === 0) return NextResponse.json({ error: 'None of those kits exist' }, { status: 404 });

  const denied = targets.filter(k => !ctx.canSeeClient(k.clientId));
  if (denied.length > 0) {
    return NextResponse.json(
      { error: `You do not have access to the client on ${denied.map(k => k.reference).join(', ')}` },
      { status: 403 },
    );
  }
  // Copies already out do NOT block an edit: each booking snapshots the list
  // that left with it and the return tick-list is built from the booking, so
  // the copies on the road come back against what they went out on. Blocking
  // would mean a kit with one copy permanently on tour could never be edited.

  // ── Resolve what the item actually is ──────────────────────────────────────
  let code = '';
  let description = '';
  const warnings: string[] = [];

  if (source === 'promo') {
    const item = (await listPromoItems()).find(i => i.id === ref);
    if (!item) return NextResponse.json({ error: 'That promo item no longer exists' }, { status: 404 });
    code = item.code;
    description = item.description;
  } else {
    // Resolve the article number against each distinct client's product control
    // file. A kit whose client does not stock it is still allowed — it just says
    // so, rather than blocking the other four kits in the batch.
    const wanted = normArticle(ref);
    const distinctClientIds = [...new Set(targets.map(k => k.clientId))];
    const missingFor: string[] = [];

    for (const clientId of distinctClientIds) {
      let found: { articleNumber: string; description: string } | null = null;
      for (const link of await listSpLinks(clientId)) {
        for (const p of await loadLinkProducts(clientId, link.id)) {
          if (normArticle(p.articleNumber) === wanted) {
            found = { articleNumber: p.articleNumber, description: p.description || '' };
            break;
          }
        }
        if (found) break;
      }
      if (found) {
        if (!code) {
          code = found.articleNumber;
          description = found.description;
        }
      } else {
        missingFor.push(ctx.clientName(clientId));
      }
    }

    if (!code) {
      return NextResponse.json(
        { error: `Article ${ref} is not in the product control file for any of the selected kits' clients.` },
        { status: 404 },
      );
    }
    if (missingFor.length > 0) {
      warnings.push(
        `Added, but ${ref} is not on the product control file for ${missingFor.join(', ')}. Check it is the right item.`,
      );
    }
  }

  // ── Add or merge into each kit ─────────────────────────────────────────────
  const now = new Date().toISOString();
  const byName = fullName(ctx.me);
  const key = lineKey(source, ref);
  const addedTo: string[] = [];
  const mergedIn: string[] = [];

  for (const kit of targets) {
    const existing = kit.lines.find(l => lineKey(l.source, l.ref) === key);
    if (existing) {
      // Same item twice would leave two indistinguishable rows on the return
      // tick-list, so quantities merge instead.
      existing.quantity += quantity;
      existing.description = description || existing.description;
      mergedIn.push(kit.reference);
    } else {
      const line: PromoKitLine = {
        id: randomUUID(),
        source,
        ref,
        code,
        description,
        quantity,
        addedAt: now,
        addedByName: byName,
      };
      kit.lines.push(line);
      addedTo.push(kit.reference);
    }
    kit.updatedAt = now;
  }

  await savePromoKits(kits);
  await logAudit({
    action: 'promo-kit-add-item',
    userId: ctx.me.id,
    userName: byName,
    detail:
      `${code} x${quantity} added to ${targets.length} kit(s): ` +
      `${addedTo.length ? `new on ${addedTo.join(', ')}` : ''}` +
      `${addedTo.length && mergedIn.length ? '; ' : ''}` +
      `${mergedIn.length ? `quantity increased on ${mergedIn.join(', ')}` : ''}`,
  });

  return NextResponse.json({
    ok: true,
    code,
    description,
    addedTo,
    mergedIn,
    kitCount: targets.length,
    warnings,
  });
}
