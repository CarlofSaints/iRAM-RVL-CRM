import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { clientScopeFor, filterClientIdsByScope } from '@/lib/clientScope';
import { listLoads, getLoad, type AgedStockLoadMeta } from '@/lib/agedStockData';
import { provinceName } from '@/lib/region';
import { parsePickSlipQuery, type PickSlipQuery } from '@/lib/pickSlipQuery';
import {
  listAllPickSlipRuns,
  savePickSlipRun,
  type PickSlipRecord,
  type PickSlipRunIndex,
} from '@/lib/pickSlipData';
import { loadControl } from '@/lib/controlData';
import {
  makeWarehouseResolver,
  makeLenientWarehouseResolver,
  warehouseScopeFor,
  isWarehouseAllowed,
  type WarehouseRecord,
} from '@/lib/warehouseScope';

export const dynamic = 'force-dynamic';

interface ClientRecord {
  id: string;
  name: string;
  vendorNumbers: string[];
}

interface StoreRecord {
  id: string;
  siteCode?: string;
  name?: string;
  region?: string;
}

/** Every status a slip can hold, for the status filter. */
const ALL_STATUSES = [
  'generated', 'printed', 'sent', 'unsuccessful', 'booked', 'captured',
  'failed-release', 'partial-release', 'in-transit', 'delivered',
];

/**
 * GET /api/pick-slips
 *
 * Three modes (see lib/pickSlipQuery.ts):
 *   mode=facets   filter option lists only — reads NO pick-slip run blobs
 *   mode=summary  matching slips without product rows (default; what a grid needs)
 *   mode=full     matching slips including rows (what a report needs)
 *
 * Filters narrow which run blobs are read, not just what is returned. Each run
 * is a separate blob, so a query scoped to one client and one load reads one
 * blob instead of several hundred.
 *
 * No arguments still returns everything, so existing callers are unaffected.
 */
export async function GET(req: NextRequest) {
  const guard = await requirePermission(req, 'view_aged_stock');
  if (guard instanceof NextResponse) return guard;

  const q = parsePickSlipQuery(req.nextUrl.searchParams);

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  if (!me) return NextResponse.json({ error: 'User not found' }, { status: 401 });

  const scope = clientScopeFor({
    role: me.role,
    permissions: guard.permissions,
    linkedClientId: me.linkedClientId,
    assignedClientIds: me.assignedClientIds,
  });

  // Get all client IDs
  const allClients = await loadControl<ClientRecord>('clients');
  const allClientIds = allClients.map(c => c.id);
  const scopedIds = filterClientIdsByScope(scope, allClientIds);

  if (scopedIds.length === 0) {
    return NextResponse.json(
      q.mode === 'facets'
        ? { clients: [], batches: [], provinces: [], statuses: ALL_STATUSES, warehouses: [] }
        : { slips: [] },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // Build client name lookup for backward compat
  const clientMap = new Map(allClients.map(c => [c.id, c]));

  // Honour the requested clients, but never widen past the user's own scope.
  const requestedIds = q.clientIds.length
    ? scopedIds.filter(id => q.clientIds.includes(id))
    : scopedIds;

  // Site code → canonical province, for the province filter. Stores are one
  // cheap control-file read; pick slips carry no region of their own.
  const stores = await loadControl<StoreRecord>('stores');
  const provinceBySite = new Map<string, string>();
  for (const s of stores) {
    const code = (s.siteCode ?? '').trim().toUpperCase();
    if (code) provinceBySite.set(code, provinceName(s.region ?? ''));
  }
  const provinceOf = (siteCode: string) =>
    provinceBySite.get((siteCode ?? '').trim().toUpperCase()) ?? '';

  // ── facets ────────────────────────────────────────────────────────────────
  // Built entirely from control files and the per-client load INDEX. No run
  // blob is touched, so the filter bar renders immediately.
  if (q.mode === 'facets') {
    const batches: Array<{
      loadId: string; clientId: string; clientName: string;
      vendorNumbers: string[]; fileName: string; loadedAt: string; rowCount: number;
    }> = [];

    const perClient = await Promise.all(
      requestedIds.map(async (clientId): Promise<[string, AgedStockLoadMeta[]]> => {
        try { return [clientId, await listLoads(clientId)]; }
        catch { return [clientId, []]; }
      })
    );
    for (const [clientId, loads] of perClient) {
      for (const l of loads) {
        batches.push({
          loadId: l.id,
          clientId,
          clientName: l.clientName || clientMap.get(clientId)?.name || 'Unknown',
          vendorNumbers: l.vendorNumbers ?? [],
          fileName: l.fileName ?? '',
          loadedAt: l.loadedAt,
          rowCount: l.rowCount ?? 0,
        });
      }
    }
    batches.sort((a, b) => (a.loadedAt < b.loadedAt ? 1 : -1));

    const warehouses = await loadControl<WarehouseRecord>('warehouses');
    const whScopeF = warehouseScopeFor(
      { role: me.role, assignedWarehouseIds: me.assignedWarehouseIds },
      warehouses,
    );

    return NextResponse.json(
      {
        clients: allClients
          .filter(c => scopedIds.includes(c.id))
          .map(c => ({ id: c.id, name: c.name, vendorNumbers: c.vendorNumbers ?? [] }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        batches,
        provinces: [...new Set([...provinceBySite.values()].filter(Boolean))].sort(),
        // Stores come off the control file, so the picker offers every store
        // rather than only ones that happen to have a slip — the user is
        // choosing what to look for, not browsing what exists.
        stores: stores
          .filter((s) => (s.siteCode ?? '').trim())
          .map((s) => ({
            siteCode: (s.siteCode ?? '').trim(),
            name: s.name ?? '',
            province: provinceName(s.region ?? ''),
          }))
          .sort((a, b) => a.name.localeCompare(b.name) || a.siteCode.localeCompare(b.siteCode)),
        statuses: ALL_STATUSES,
        warehouses: warehouses
          .filter(w => whScopeF.all || whScopeF.codes.includes((w.code ?? '').toUpperCase()))
          .map(w => ({ id: w.id, code: w.code, name: w.name })),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // Warehouse resolver: raw value → canonical code. The lenient variant keeps
  // the previous behaviour for the display/backfill path (unknown value echoes
  // back); the strict one is what the access check uses.
  const warehouses = await loadControl<WarehouseRecord>('warehouses');
  const resolveWarehouseCode = makeLenientWarehouseResolver(warehouses);
  const resolveStrict = makeWarehouseResolver(warehouses);
  const whScope = warehouseScopeFor(
    { role: me.role, assignedWarehouseIds: me.assignedWarehouseIds },
    warehouses,
  );

  // `q.from` also narrows which run blobs are read, not just which slips are
  // returned — that is where the page-load latency actually goes.
  const runs = await listAllPickSlipRuns(requestedIds, listLoads, q.loadIds, q.from || undefined);

  // Backfill old slips missing `rows` by reading from load data.
  // Tracks which runs were modified so we can persist the backfill.
  const runsToSave: PickSlipRunIndex[] = [];

  for (const run of runs) {
    let runDirty = false;
    for (let i = 0; i < run.slips.length; i++) {
      const slip = run.slips[i];
      // Backfill defaults
      if (!slip.status) { slip.status = 'generated'; runDirty = true; }
      if (!slip.clientName) {
        slip.clientName = clientMap.get(slip.clientId)?.name || 'Unknown';
        runDirty = true;
      }

      // Backfill warehouseCode from warehouse control table
      if (!slip.warehouseCode && slip.warehouse) {
        slip.warehouseCode = resolveWarehouseCode(slip.warehouse);
        runDirty = true;
      }

      // Backfill rows from load data if empty. Skipped entirely in summary
      // mode — the rows are stripped from the response anyway, and this is a
      // whole extra load-blob read per slip that lacks them.
      if (q.mode === 'full' && (!slip.rows || slip.rows.length === 0)) {
        try {
          const load = await getLoad(slip.clientId, slip.loadId);
          if (load) {
            const siteRows = load.rows.filter(r => r.siteCode === slip.siteCode);
            slip.rows = siteRows
              .map(r => ({
                barcode: r.barcode,
                articleCode: r.articleCode,
                vendorProductCode: r.vendorProductCode,
                description: r.description,
                qty: r.qty,
                val: r.val,
              }))
              .filter(r => r.qty > 0 || r.val > 0);
            runDirty = true;
          }
        } catch {
          slip.rows = [];
        }
      }
    }
    if (runDirty) runsToSave.push(run);
  }

  // Persist backfilled runs (fire-and-forget, don't block response)
  for (const run of runsToSave) {
    savePickSlipRun(run).catch(err =>
      console.error('[pick-slips] backfill save failed:', err instanceof Error ? err.message : err)
    );
  }

  // Flatten all slips, excluding blanks (0 qty AND 0 value) unless manual
  const slips: PickSlipRecord[] = [];
  for (const run of runs) {
    for (const slip of run.slips) {
      // Manual slips start with 0 qty/val — always include them
      if (!slip.manual && slip.totalQty <= 0 && slip.totalVal <= 0) continue;
      // Warehouse scoping — drop slips outside the user's warehouses. Check the
      // canonical code first, falling back to the raw name for slips whose
      // warehouseCode was never backfilled.
      if (!isWarehouseAllowed(whScope, slip.warehouseCode || slip.warehouse, resolveStrict)) continue;
      if (!matchesQuery(slip, q, provinceOf)) continue;
      slips.push(slip);
    }
  }

  // Sort newest first
  slips.sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));

  // `deliverySignature` is a base64 PNG of the customer's signature written
  // onto every delivered slip. Measured on live-shaped data it was 1.9MB of a
  // 2.6MB response — 75% of this endpoint's payload — and NOTHING that lists
  // slips renders it; only a single-slip detail view does. So it is opt-in.
  const withSignatures = req.nextUrl.searchParams.get('withSignatures') === '1';

  // Summary mode also drops the product rows. The grid needs the distinct
  // product count off the back of them, so that is sent as a number rather
  // than making the client count an array it has no other use for.
  const payload = slips.map(slip => {
    const { rows, unreturnedStock, deliverySignature, ...rest } = slip;
    // A pick slip carries no region of its own — it comes off the store control
    // record. Resolved here so every consumer gets the same canonical province
    // rather than each re-deriving it from a free-text region code.
    const base: Record<string, unknown> = { ...rest, province: provinceOf(slip.siteCode) };
    if (withSignatures && deliverySignature) base.deliverySignature = deliverySignature;
    if (q.mode === 'summary') {
      base.productCount = new Set((rows ?? []).map(r => r.articleCode || r.barcode)).size;
    } else {
      base.rows = rows;
      base.unreturnedStock = unreturnedStock;
    }
    return base;
  });

  return NextResponse.json(
    { slips: payload, mode: q.mode, count: payload.length },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

/** Apply the user's filters to one slip. Empty filter list ⇒ no constraint. */
function matchesQuery(
  slip: PickSlipRecord,
  q: PickSlipQuery,
  provinceOf: (siteCode: string) => string
): boolean {
  if (q.slipIds.length && !q.slipIds.includes(slip.id)) return false;
  if (q.vendorNumbers.length && !q.vendorNumbers.includes(slip.vendorNumber)) return false;
  if (q.statuses.length && !q.statuses.includes(slip.status)) return false;
  if (q.siteCodes.length && !q.siteCodes.includes(slip.siteCode)) return false;

  if (q.warehouseCodes.length) {
    const wh = (slip.warehouseCode || slip.warehouse || '').toUpperCase();
    if (!q.warehouseCodes.some(c => c.toUpperCase() === wh)) return false;
  }

  if (q.provinces.length && !q.provinces.includes(provinceOf(slip.siteCode))) return false;

  // Date range is inclusive on both ends and compares yyyy-mm-dd prefixes, so a
  // timezone never shifts a slip out of the day the user picked.
  if (q.from || q.to) {
    const day = (slip.generatedAt ?? '').slice(0, 10);
    if (!day) return false;
    if (q.from && day < q.from) return false;
    if (q.to && day > q.to) return false;
  }

  return true;
}
