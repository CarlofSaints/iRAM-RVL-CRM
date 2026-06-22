import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { clientScopeFor, filterClientIdsByScope } from '@/lib/clientScope';
import { getClient, listSpLinks, loadLinkProducts } from '@/lib/spLinkData';
import { sendMissingSkuEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Same normalization the commit route uses (strip non-alphanumerics + leading zeros). */
function normArticle(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, '').replace(/^0+/, '').toLowerCase();
}

/**
 * POST /api/aged-stock/missing-skus
 * JSON body: { clientIds: string[], fileName: string, skus: [{articleCode, description}] }
 *
 * Checks the file's SKUs against the selected clients' product control files and
 * emails the loader any SKU found in NONE of them (so they can add it + reload).
 * If any selected client has no product control file (it loads everything), there
 * are no "missing" SKUs. Returns the missing list + whether an email was sent.
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'load_aged_stock');
  if (guard instanceof NextResponse) return guard;

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  if (!me) return NextResponse.json({ error: 'User not found' }, { status: 401 });

  let body: { clientIds?: unknown; fileName?: unknown; skus?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const rawIds = Array.isArray(body.clientIds)
    ? (body.clientIds as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const fileName = typeof body.fileName === 'string' ? body.fileName : 'aged-stock.xlsx';
  const skusIn = Array.isArray(body.skus) ? body.skus as { articleCode?: unknown; description?: unknown }[] : [];

  // Scope the client ids to what the caller may see
  const scope = clientScopeFor({
    role: me.role,
    permissions: guard.permissions,
    linkedClientId: me.linkedClientId,
    assignedClientIds: me.assignedClientIds,
  });
  const clientIds = filterClientIdsByScope(scope, rawIds);
  if (clientIds.length === 0) {
    return NextResponse.json({ ok: true, missing: [], emailed: false });
  }

  // De-dupe incoming SKUs by normalized article code, keeping the first description.
  const skuByKey = new Map<string, { articleCode: string; description: string }>();
  for (const s of skusIn) {
    const articleCode = String(s.articleCode ?? '').trim();
    const key = normArticle(articleCode);
    if (!key || skuByKey.has(key)) continue;
    skuByKey.set(key, { articleCode, description: String(s.description ?? '').trim() });
  }

  // Build the combined set of articles the selected clients' control files cover.
  // If any selected client has no control file, it loads everything → nothing is "missing".
  const covered = new Set<string>();
  const clientNames: string[] = [];
  let anyClientLacksControlFile = false;
  for (const clientId of clientIds) {
    const client = await getClient(clientId);
    if (client) clientNames.push(client.name);
    const links = await listSpLinks(clientId);
    let count = 0;
    for (const link of links) {
      const products = await loadLinkProducts(clientId, link.id);
      for (const p of products) {
        const k = normArticle(p.articleNumber);
        if (k) { covered.add(k); count++; }
      }
    }
    if (count === 0) anyClientLacksControlFile = true;
  }

  const missing = anyClientLacksControlFile
    ? []
    : [...skuByKey.entries()].filter(([key]) => !covered.has(key)).map(([, v]) => v);

  let emailed = false;
  if (missing.length > 0 && me.email) {
    try {
      await sendMissingSkuEmail({
        to: me.email,
        loaderName: `${me.name} ${me.surname}`.trim() || me.email,
        fileName,
        clientNames: Array.from(new Set(clientNames)),
        missing,
      });
      emailed = true;
    } catch (err) {
      console.error('[missing-skus] email failed:', err instanceof Error ? err.message : err);
    }
  }

  return NextResponse.json(
    { ok: true, missing, emailed },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
