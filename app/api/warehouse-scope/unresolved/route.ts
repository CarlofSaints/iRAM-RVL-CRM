import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadControl } from '@/lib/controlData';
import { listLoads } from '@/lib/agedStockData';
import { listAllPickSlipRuns } from '@/lib/pickSlipData';
import { makeWarehouseResolver, type WarehouseRecord } from '@/lib/warehouseScope';

export const dynamic = 'force-dynamic';

interface StoreRecord {
  id: string;
  name: string;
  siteCode: string;
  linkedWarehouse?: string;
}

interface ClientRecord {
  id: string;
}

interface UnresolvedEntry {
  /** The raw free-text value as stored. */
  value: string;
  count: number;
  /** A few examples so the value can actually be found and fixed. */
  samples: string[];
}

/**
 * GET /api/warehouse-scope/unresolved
 *
 * Data-quality report behind per-user warehouse scoping.
 *
 * Warehouse linkage in this app is free text, not a foreign key: a store holds
 * `linkedWarehouse` as a typed-in name and a pick slip holds a denormalized
 * `warehouse` string. Scoping resolves those to a canonical warehouse code, and
 * anything that does NOT resolve is treated as out-of-scope for a restricted
 * user — i.e. silently hidden from them.
 *
 * This endpoint lists exactly those values so they can be corrected instead of
 * quietly disappearing. Run it BEFORE restricting anyone, and after any bulk
 * store import.
 *
 * Returns no client or commercial data — only warehouse strings and counts.
 */
export async function GET(req: NextRequest) {
  const guard = await requirePermission(req, 'manage_warehouses');
  if (guard instanceof NextResponse) return guard;

  const warehouses = await loadControl<WarehouseRecord>('warehouses');
  const resolve = makeWarehouseResolver(warehouses);

  const tally = (
    map: Map<string, UnresolvedEntry>,
    raw: string | undefined | null,
    sample: string,
  ) => {
    const value = (raw ?? '').trim();
    // A blank warehouse is its own problem, reported under the "(blank)" key
    // rather than skipped — a store with no warehouse is invisible to every
    // restricted user too.
    const key = value === '' ? '(blank)' : value.toUpperCase();
    if (value !== '' && resolve(value)) return;

    const existing = map.get(key);
    if (existing) {
      existing.count++;
      if (existing.samples.length < 5 && !existing.samples.includes(sample)) {
        existing.samples.push(sample);
      }
    } else {
      map.set(key, { value: value === '' ? '(blank)' : value, count: 1, samples: [sample] });
    }
  };

  // ── Stores ────────────────────────────────────────────────────────────
  const stores = await loadControl<StoreRecord>('stores');
  const storeMap = new Map<string, UnresolvedEntry>();
  for (const s of stores) {
    tally(storeMap, s.linkedWarehouse, `${s.siteCode || '?'} ${s.name || ''}`.trim());
  }

  // ── Pick slips ────────────────────────────────────────────────────────
  const clients = await loadControl<ClientRecord>('clients');
  const runs = await listAllPickSlipRuns(clients.map(c => c.id), listLoads);
  const slipMap = new Map<string, UnresolvedEntry>();
  let slipsChecked = 0;
  for (const run of runs) {
    for (const slip of run.slips) {
      slipsChecked++;
      // warehouseCode is the canonical field when present; fall back to the name.
      tally(slipMap, slip.warehouseCode || slip.warehouse, slip.id);
    }
  }

  const byCountDesc = (a: UnresolvedEntry, b: UnresolvedEntry) => b.count - a.count;
  const storeIssues = Array.from(storeMap.values()).sort(byCountDesc);
  const slipIssues = Array.from(slipMap.values()).sort(byCountDesc);

  return NextResponse.json(
    {
      warehouses: warehouses.map(w => ({ id: w.id, name: w.name, code: w.code })),
      stores: {
        total: stores.length,
        affected: storeIssues.reduce((n, e) => n + e.count, 0),
        unresolved: storeIssues,
      },
      pickSlips: {
        total: slipsChecked,
        affected: slipIssues.reduce((n, e) => n + e.count, 0),
        unresolved: slipIssues,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
