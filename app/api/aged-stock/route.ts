import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { clientScopeFor, filterClientIdsByScope } from '@/lib/clientScope';
import { loadControl } from '@/lib/controlData';
import type { ClientWithLinks } from '@/lib/spLinkData';
import { listLoads, getLoad } from '@/lib/agedStockData';

export const dynamic = 'force-dynamic';

/**
 * GET /api/aged-stock
 * Returns every committed aged-stock row for the clients the caller is
 * allowed to see. Rows are enriched with load metadata (loadId, loadedAt,
 * client name + vendor numbers) so the client can filter/sort without
 * fetching client records separately.
 */
export async function GET(req: NextRequest) {
  const guard = await requirePermission(req, 'view_aged_stock');
  if (guard instanceof NextResponse) return guard;

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  if (!me) return NextResponse.json({ error: 'User not found' }, { status: 401 });

  const clients = await loadControl<ClientWithLinks>('clients');
  const allIds = clients.map(c => c.id);
  const scope = clientScopeFor({
    role: me.role,
    permissions: guard.permissions,
    linkedClientId: me.linkedClientId,
    assignedClientIds: me.assignedClientIds,
  });
  const clientIds = filterClientIdsByScope(scope, allIds);
  const clientsById = new Map(clients.map(c => [c.id, c]));

  // Collect every committed row across every visible client + load.
  const rows: Array<{
    id: string;
    loadId: string;
    loadedAt: string;
    clientId: string;
    clientName: string;
    vendorNumbers: string[];
    fileName: string;
    siteCode: string;
    siteName: string;
    articleCode: string;
    description: string;
    barcode: string;
    vendorProductCode: string;
    qty: number;
    val: number;
  }> = [];

  const loadsByClient: Record<string, Array<{
    id: string; fileName: string; loadedAt: string; loadedByName: string;
    rowCount: number; selectedPeriodKeys: string[];
  }>> = {};

  for (const clientId of clientIds) {
    const client = clientsById.get(clientId);
    if (!client) continue;

    const index = await listLoads(clientId);
    loadsByClient[clientId] = index.map(l => ({
      id: l.id,
      fileName: l.fileName,
      loadedAt: l.loadedAt,
      loadedByName: l.loadedByName,
      rowCount: l.rowCount,
      selectedPeriodKeys: l.selectedPeriodKeys,
    }));

    for (const meta of index) {
      const full = await getLoad(clientId, meta.id);
      if (!full) continue;
      for (const r of full.rows) {
        rows.push({
          id: r.id,
          loadId: meta.id,
          loadedAt: meta.loadedAt,
          clientId: client.id,
          clientName: client.name,
          vendorNumbers: client.vendorNumbers ?? [],
          fileName: meta.fileName,
          siteCode: r.siteCode,
          siteName: r.siteName,
          articleCode: r.articleCode,
          description: r.description,
          barcode: r.barcode,
          vendorProductCode: r.vendorProductCode,
          qty: r.qty,
          val: r.val,
        });
      }
    }
  }

  return NextResponse.json(
    { ok: true, rows, loadsByClient },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
