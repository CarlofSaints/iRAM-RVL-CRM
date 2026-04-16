import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { clientScopeFor } from '@/lib/clientScope';
import { listSpLinks, loadLinkProducts } from '@/lib/spLinkData';
import {
  loadDraft, deleteDraft, saveLoad,
  type AgedStockRow, type AgedStockLoadFull,
} from '@/lib/agedStockData';

export const dynamic = 'force-dynamic';

/**
 * Lowercase-alphanumeric normalization for article codes. Handles the cases
 * where one file uses `0000000000000719735` and another uses `719735` (or
 * different capitalization) — we want them to match when looking up a
 * barcode from the product control file.
 */
function normArticle(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, '').replace(/^0+/, '').toLowerCase();
}

/**
 * POST /api/aged-stock/commit
 * JSON body: { draftId: string, selectedPeriodKeys: string[] }
 *
 * Aggregates qty+val across selected periods, fills in missing barcodes /
 * vendor product codes from the client's product control files, persists a
 * new LOAD, deletes the draft. Returns the load summary.
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'load_aged_stock');
  if (guard instanceof NextResponse) return guard;

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  if (!me) return NextResponse.json({ error: 'User not found' }, { status: 401 });

  let body: { draftId?: unknown; selectedPeriodKeys?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const draftId = typeof body.draftId === 'string' ? body.draftId.trim() : '';
  const selected = Array.isArray(body.selectedPeriodKeys)
    ? (body.selectedPeriodKeys as unknown[]).filter((k): k is string => typeof k === 'string')
    : [];

  if (!draftId) return NextResponse.json({ error: 'draftId is required' }, { status: 400 });
  if (selected.length === 0) {
    return NextResponse.json({ error: 'Pick at least one period to load' }, { status: 400 });
  }

  const draft = await loadDraft(guard.userId, draftId);
  if (!draft) return NextResponse.json({ error: 'Draft not found or expired' }, { status: 404 });

  // Scope check — must still have access to the draft's client
  const scope = clientScopeFor({
    role: me.role,
    permissions: guard.permissions,
    linkedClientId: me.linkedClientId,
    assignedClientIds: me.assignedClientIds,
  });
  if (!scope.all && !scope.ids.includes(draft.clientId)) {
    return NextResponse.json({ error: 'You do not have access to this client' }, { status: 403 });
  }

  // Validate selected period keys exist on the draft
  const periodKeysOnDraft = new Set(draft.periods.map(p => p.key));
  const unknownSelected = selected.filter(k => !periodKeysOnDraft.has(k));
  if (unknownSelected.length > 0) {
    return NextResponse.json(
      { error: `Unknown period key(s): ${unknownSelected.join(', ')}` },
      { status: 400 }
    );
  }

  // Build a merged product lookup from all SpLinks for this client. First match
  // wins — so if the same article appears across channels with different
  // barcodes, the earliest link takes precedence.
  const productLookup = new Map<string, { barcode: string; vendorProductCode: string }>();
  const links = await listSpLinks(draft.clientId);
  for (const link of links) {
    const products = await loadLinkProducts(draft.clientId, link.id);
    for (const p of products) {
      const k = normArticle(p.articleNumber);
      if (!k) continue;
      if (!productLookup.has(k)) {
        productLookup.set(k, {
          barcode: p.barcode ?? '',
          vendorProductCode: p.vendorProductCode ?? '',
        });
      }
    }
  }

  // Aggregate draft rows across selected periods
  const loadId = randomUUID();
  const rows: AgedStockRow[] = [];
  for (const r of draft.rows) {
    let qty = 0;
    let val = 0;
    for (const k of selected) {
      const p = r.periods[k];
      if (!p) continue;
      qty += p.qty;
      val += p.val;
    }
    // Barcode / vendor code — prefer what was in the file, fall back to lookup
    let barcode = r.barcode || '';
    let vendorProductCode = r.vendorProductCode || '';
    if (!barcode || !vendorProductCode) {
      const hit = productLookup.get(normArticle(r.articleCode));
      if (hit) {
        if (!barcode) barcode = hit.barcode;
        if (!vendorProductCode) vendorProductCode = hit.vendorProductCode;
      }
    }

    rows.push({
      id: randomUUID(),
      loadId,
      clientId: draft.clientId,
      siteCode: r.siteCode,
      siteName: r.siteName,
      articleCode: r.articleCode,
      description: r.description,
      barcode,
      vendorProductCode,
      qty,
      val,
    });
  }

  const full: AgedStockLoadFull = {
    id: loadId,
    clientId: draft.clientId,
    clientName: draft.clientName,
    vendorNumbers: draft.vendorNumbers,
    fileName: draft.fileName,
    format: draft.format,
    periodsAll: draft.periods,
    selectedPeriodKeys: selected,
    loadedAt: new Date().toISOString(),
    loadedBy: guard.userId,
    loadedByName: `${me.name} ${me.surname}`.trim(),
    rowCount: rows.length,
    rows,
  };

  try {
    await saveLoad(full);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to save load: ${msg}` }, { status: 500 });
  }

  // Best-effort draft cleanup — don't fail the request if deletion hiccups
  try { await deleteDraft(guard.userId, draftId); }
  catch (err) { console.error('[commit] draft cleanup:', err instanceof Error ? err.message : err); }

  return NextResponse.json({
    ok: true,
    loadId: full.id,
    rowCount: full.rowCount,
    loadedAt: full.loadedAt,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
