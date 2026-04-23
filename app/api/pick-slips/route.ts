import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { clientScopeFor, filterClientIdsByScope } from '@/lib/clientScope';
import { listLoads, getLoad } from '@/lib/agedStockData';
import {
  listAllPickSlipRuns,
  savePickSlipRun,
  type PickSlipRecord,
  type PickSlipRunIndex,
} from '@/lib/pickSlipData';
import { loadControl } from '@/lib/controlData';

export const dynamic = 'force-dynamic';

interface ClientRecord {
  id: string;
  name: string;
  vendorNumbers: string[];
}

/**
 * GET /api/pick-slips — List all pick slips scoped to the user's clients.
 */
export async function GET(req: NextRequest) {
  const guard = await requirePermission(req, 'view_aged_stock');
  if (guard instanceof NextResponse) return guard;

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
    return NextResponse.json({ slips: [] }, { headers: { 'Cache-Control': 'no-store' } });
  }

  // Build client name lookup for backward compat
  const clientMap = new Map(allClients.map(c => [c.id, c]));

  const runs = await listAllPickSlipRuns(scopedIds, listLoads);

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

      // Backfill rows from load data if empty
      if (!slip.rows || slip.rows.length === 0) {
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
      slips.push(slip);
    }
  }

  // Sort newest first
  slips.sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));

  return NextResponse.json({ slips }, { headers: { 'Cache-Control': 'no-store' } });
}
