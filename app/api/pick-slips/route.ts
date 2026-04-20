import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { clientScopeFor, filterClientIdsByScope } from '@/lib/clientScope';
import { listLoads } from '@/lib/agedStockData';
import { listAllPickSlipRuns, type PickSlipRecord } from '@/lib/pickSlipData';
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

  // Flatten all slips, enriching old ones missing clientName
  const slips: PickSlipRecord[] = [];
  for (const run of runs) {
    for (const slip of run.slips) {
      // Backward compat: fill defaults for old records
      const enriched: PickSlipRecord = {
        ...slip,
        status: slip.status || 'generated',
        clientName: slip.clientName || clientMap.get(slip.clientId)?.name || 'Unknown',
        rows: slip.rows || [],
      };
      slips.push(enriched);
    }
  }

  // Sort newest first
  slips.sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));

  return NextResponse.json({ slips }, { headers: { 'Cache-Control': 'no-store' } });
}
