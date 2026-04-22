import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { loadControl } from '@/lib/controlData';
import { clientScopeFor, filterClientIdsByScope } from '@/lib/clientScope';
import { listLoads, getLoad } from '@/lib/agedStockData';
import { loadLinkProducts, type ClientWithLinks } from '@/lib/spLinkData';
import { listAllPickSlipRuns } from '@/lib/pickSlipData';

export const dynamic = 'force-dynamic';

/**
 * GET /api/dashboard/stats
 *
 * Single payload for the dashboard — control counts (with correct products
 * count aggregated from SP link caches), warehouse list, and aged stock
 * totals grouped by client (scoped to the caller's permissions).
 */
export async function GET(req: NextRequest) {
  const guard = await requirePermission(req, 'view_dashboard');
  if (guard instanceof NextResponse) return guard;

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  if (!me) return NextResponse.json({ error: 'User not found' }, { status: 401 });

  // ── Control counts ──────────────────────────────────────────────────────
  const clients = await loadControl<ClientWithLinks>('clients');
  const stores = await loadControl('stores');
  const reps = await loadControl('reps');
  const warehouses = await loadControl<{ code: string; name: string }>('warehouses');

  // Products: aggregate from SP link caches (not the empty legacy masterfile)
  let productsCount = 0;
  for (const client of clients) {
    for (const link of client.sharepointLinks ?? []) {
      if (link.lastRefreshedAt) {
        const prods = await loadLinkProducts(client.id, link.id);
        productsCount += prods.length;
      }
    }
  }

  const controlCounts = {
    clients: clients.length,
    stores: stores.length,
    products: productsCount,
    reps: reps.length,
    warehouses: warehouses.length,
  };

  // ── Aged stock totals (client-scoped) ───────────────────────────────────
  const scope = clientScopeFor({
    role: me.role,
    permissions: guard.permissions,
    linkedClientId: me.linkedClientId,
    assignedClientIds: me.assignedClientIds,
  });
  const scopedClientIds = filterClientIdsByScope(scope, clients.map(c => c.id));
  const clientsById = new Map(clients.map(c => [c.id, c]));

  let totalQty = 0;
  let totalVal = 0;
  const byClient: Array<{
    clientId: string;
    clientName: string;
    vendorNumbers: string[];
    totalQty: number;
    totalVal: number;
    warehouseQty: Record<string, number>;
    warehouseVal: Record<string, number>;
    inTransitQty: number;
    inTransitVal: number;
  }> = [];

  // Also aggregate warehouse stock from receipted pick slips
  const pickSlipRuns = await listAllPickSlipRuns(scopedClientIds, listLoads);
  // Build per-client warehouse + in-transit aggregations
  const clientWarehouseQty = new Map<string, Record<string, number>>();
  const clientWarehouseVal = new Map<string, Record<string, number>>();
  let warehouseTotalQty = 0;
  let warehouseTotalVal = 0;

  const clientInTransitQty = new Map<string, number>();
  const clientInTransitVal = new Map<string, number>();
  let inTransitTotalQty = 0;
  let inTransitTotalVal = 0;

  // Build lookup maps to resolve slip.warehouse (free-text) → warehouse code
  // Matches by code (exact) or name (case-insensitive), falls back to raw value
  const whCodeSet = new Set(warehouses.map(w => w.code.toUpperCase().trim()));
  const whNameToCode = new Map(warehouses.map(w => [w.name.toUpperCase().trim(), w.code.toUpperCase().trim()]));

  function resolveWarehouseCode(raw: string): string {
    const upper = raw.toUpperCase().trim();
    if (whCodeSet.has(upper)) return upper;          // already a valid code
    const byName = whNameToCode.get(upper);
    if (byName) return byName;                        // matched by name
    return upper;                                     // fallback — use raw
  }

  for (const run of pickSlipRuns) {
    for (const slip of run.slips) {
      if (slip.status === 'receipted') {
        const wh = resolveWarehouseCode(slip.warehouse || 'UNKNOWN');

        // Per-client warehouse qty
        if (!clientWarehouseQty.has(slip.clientId)) clientWarehouseQty.set(slip.clientId, {});
        const cWhQty = clientWarehouseQty.get(slip.clientId)!;
        cWhQty[wh] = (cWhQty[wh] ?? 0) + slip.totalQty;

        // Per-client warehouse val
        if (!clientWarehouseVal.has(slip.clientId)) clientWarehouseVal.set(slip.clientId, {});
        const cWhVal = clientWarehouseVal.get(slip.clientId)!;
        cWhVal[wh] = (cWhVal[wh] ?? 0) + slip.totalVal;

        warehouseTotalQty += slip.totalQty;
        warehouseTotalVal += slip.totalVal;
      } else if (slip.status === 'in-transit' || slip.status === 'partial-release') {
        // Per-client in-transit aggregation
        clientInTransitQty.set(slip.clientId, (clientInTransitQty.get(slip.clientId) ?? 0) + slip.totalQty);
        clientInTransitVal.set(slip.clientId, (clientInTransitVal.get(slip.clientId) ?? 0) + slip.totalVal);
        inTransitTotalQty += slip.totalQty;
        inTransitTotalVal += slip.totalVal;
      }
    }
  }

  for (const clientId of scopedClientIds) {
    const client = clientsById.get(clientId);
    if (!client) continue;

    const index = await listLoads(clientId);
    let cQty = 0;
    let cVal = 0;

    for (const meta of index) {
      const full = await getLoad(clientId, meta.id);
      if (!full) continue;
      for (const r of full.rows) {
        cQty += r.qty;
        cVal += r.val;
      }
    }

    if (cQty > 0 || cVal > 0 || clientWarehouseQty.has(clientId) || clientInTransitQty.has(clientId)) {
      byClient.push({
        clientId: client.id,
        clientName: client.name,
        vendorNumbers: client.vendorNumbers ?? [],
        totalQty: cQty,
        totalVal: cVal,
        warehouseQty: clientWarehouseQty.get(clientId) ?? {},
        warehouseVal: clientWarehouseVal.get(clientId) ?? {},
        inTransitQty: clientInTransitQty.get(clientId) ?? 0,
        inTransitVal: clientInTransitVal.get(clientId) ?? 0,
      });
      totalQty += cQty;
      totalVal += cVal;
    }
  }

  return NextResponse.json(
    {
      controlCounts,
      warehouses: warehouses.map(w => ({ code: w.code, name: w.name })),
      agedStock: { totalQty, totalVal, byClient },
      warehouseStock: { totalQty: warehouseTotalQty, totalVal: warehouseTotalVal },
      inTransitStock: { totalQty: inTransitTotalQty, totalVal: inTransitTotalVal },
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
