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
 * Denormalized product-level row with all filterable dimensions.
 * Client-side does all filtering + aggregation from this flat array.
 */
export interface DashboardRow {
  clientId: string;
  clientName: string;
  vendorNumber: string;
  storeName: string;
  storeCode: string;
  warehouse: string;
  product: string;
  articleCode: string;
  repName: string;
  pickSlipRef: string;
  qty: number;
  val: number;
  date: string;
  category: 'aged' | 'warehouse' | 'transit' | 'delivered' | 'display' | 'store-refused' | 'not-found' | 'damaged' | 'collected';
  manual: boolean;
}

/**
 * GET /api/dashboard/stats
 *
 * Returns control counts, warehouse list, and denormalized rows for the
 * dashboard — scoped to the caller's permissions.
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

  // ── Client scope ──────────────────────────────────────────────────────
  const scope = clientScopeFor({
    role: me.role,
    permissions: guard.permissions,
    linkedClientId: me.linkedClientId,
    assignedClientIds: me.assignedClientIds,
  });
  const scopedClientIds = filterClientIdsByScope(scope, clients.map(c => c.id));
  const clientsById = new Map(clients.map(c => [c.id, c]));

  // Warehouse code resolver (fuzzy — linkedWarehouse is free-text)
  const whCodeSet = new Set(warehouses.map(w => w.code.toUpperCase().trim()));
  const whNameToCode = new Map(warehouses.map(w => [w.name.toUpperCase().trim(), w.code.toUpperCase().trim()]));
  function resolveWarehouseCode(raw: string): string {
    const upper = raw.toUpperCase().trim();
    if (!upper) return '';
    if (whCodeSet.has(upper)) return upper;
    const byName = whNameToCode.get(upper);
    if (byName) return byName;
    for (const w of warehouses) {
      const wCode = w.code.toUpperCase().trim();
      const wName = w.name.toUpperCase().trim();
      if (wName.startsWith(upper) || upper.startsWith(wName)) return wCode;
      if (wCode.startsWith(upper) || upper.startsWith(wCode)) return wCode;
    }
    return upper;
  }

  // ── Build denormalized rows ───────────────────────────────────────────
  const rows: DashboardRow[] = [];

  // 1. Aged stock loads → category 'aged'
  for (const clientId of scopedClientIds) {
    const client = clientsById.get(clientId);
    if (!client) continue;

    const index = await listLoads(clientId);
    for (const meta of index) {
      const full = await getLoad(clientId, meta.id);
      if (!full) continue;
      const clientVendors = (client as ClientWithLinks).vendorNumbers ?? [];
      for (const r of full.rows) {
        rows.push({
          clientId: client.id,
          clientName: client.name,
          vendorNumber: (r as { vendorNumber?: string }).vendorNumber || clientVendors[0] || '',
          storeName: r.siteName,
          storeCode: r.siteCode,
          warehouse: '',
          product: r.description,
          articleCode: r.articleCode,
          repName: meta.loadedByName,
          pickSlipRef: '',
          qty: r.qty,
          val: r.val,
          date: meta.loadedAt,
          category: 'aged',
          manual: false,
        });
      }
    }
  }

  // 2. Pick slips → category 'warehouse' or 'transit'
  const pickSlipRuns = await listAllPickSlipRuns(scopedClientIds, listLoads);
  for (const run of pickSlipRuns) {
    for (const slip of run.slips) {
      const client = clientsById.get(slip.clientId);
      if (!client) continue;

      let category: 'warehouse' | 'transit' | 'delivered';
      if (slip.status === 'captured' || slip.status === 'booked') {
        category = 'warehouse';
      } else if (slip.status === 'in-transit' || slip.status === 'partial-release') {
        category = 'transit';
      } else if (slip.status === 'delivered') {
        category = 'delivered';
      } else {
        continue; // generated/sent/picked/etc. — not counted on dashboard
      }

      const wh = category === 'warehouse' ? resolveWarehouseCode(slip.warehouse || 'UNKNOWN') : '';

      for (const pr of slip.rows) {
        rows.push({
          clientId: client.id,
          clientName: client.name,
          vendorNumber: slip.vendorNumber || '',
          storeName: slip.siteName,
          storeCode: slip.siteCode,
          warehouse: wh,
          product: pr.description,
          articleCode: pr.articleCode,
          repName: slip.bookedRepName || '',
          pickSlipRef: slip.id,
          qty: pr.qty,
          val: pr.val,
          date: slip.generatedAt,
          category,
          manual: !!slip.manual,
        });
      }

      // 3. Unreturned stock breakdown rows (from captured data)
      if (slip.unreturnedStock && !slip.unreturnedSkipped) {
        for (const ur of slip.unreturnedStock) {
          const unitCost = ur.pickSlipQty > 0
            ? (slip.rows.find(r => r.articleCode === ur.articleCode)?.val ?? 0) / ur.pickSlipQty
            : 0;
          const base = {
            clientId: client.id,
            clientName: client.name,
            vendorNumber: slip.vendorNumber || '',
            storeName: slip.siteName,
            storeCode: slip.siteCode,
            warehouse: wh,
            product: ur.description,
            articleCode: ur.articleCode,
            repName: slip.bookedRepName || '',
            pickSlipRef: slip.id,
            date: slip.generatedAt,
            manual: !!slip.manual,
          };
          if (ur.display > 0) rows.push({ ...base, qty: ur.display, val: ur.display * unitCost, category: 'display' });
          if (ur.storeRefused > 0) rows.push({ ...base, qty: ur.storeRefused, val: ur.storeRefused * unitCost, category: 'store-refused' });
          if (ur.notFound > 0) rows.push({ ...base, qty: ur.notFound, val: ur.notFound * unitCost, category: 'not-found' });
          if (ur.damaged > 0) rows.push({ ...base, qty: ur.damaged, val: ur.damaged * unitCost, category: 'damaged' });
          const collectedQty = ur.pickSlipQty - (ur.display + ur.storeRefused + ur.notFound + ur.damaged);
          if (collectedQty > 0) rows.push({ ...base, qty: collectedQty, val: collectedQty * unitCost, category: 'collected' });
        }
      }
    }
  }

  return NextResponse.json(
    {
      controlCounts,
      warehouses: warehouses.map(w => ({ code: w.code, name: w.name })),
      rows,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
