import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadControl } from '@/lib/controlData';
import { listLoads } from '@/lib/agedStockData';
import { getPickSlipRun, getManualIndex } from '@/lib/pickSlipData';
import { listBatches } from '@/lib/stickerData';
import { getRecentMonths, getAuditEntries } from '@/lib/auditLog';
import type { ClientWithLinks } from '@/lib/spLinkData';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requirePermission(req, 'clear_data');
  if (guard instanceof NextResponse) return guard;

  const allClients = await loadControl<ClientWithLinks>('clients');

  // Build per-client inventory
  const clients: Array<{
    id: string;
    name: string;
    vendorNumbers: string[];
    loads: Array<{
      id: string;
      fileName: string;
      loadedAt: string;
      loadedByName: string;
      rowCount: number;
    }>;
    pickSlipRunCount: number;
  }> = [];

  for (const client of allClients) {
    const loads = await listLoads(client.id);
    if (loads.length === 0) continue;

    // Count pick slip runs for this client (load-based + manual)
    let pickSlipRunCount = 0;
    for (const load of loads) {
      const run = await getPickSlipRun(client.id, load.id);
      if (run && run.slips.length > 0) pickSlipRunCount++;
    }
    const manualIds = await getManualIndex(client.id);
    for (const manualLoadId of manualIds) {
      const run = await getPickSlipRun(client.id, manualLoadId);
      if (run && run.slips.length > 0) pickSlipRunCount++;
    }

    clients.push({
      id: client.id,
      name: client.name,
      vendorNumbers: client.vendorNumbers ?? [],
      loads: loads.map(l => ({
        id: l.id,
        fileName: l.fileName,
        loadedAt: l.loadedAt,
        loadedByName: l.loadedByName,
        rowCount: l.rowCount,
      })),
      pickSlipRunCount,
    });
  }

  // Sticker batch count
  const stickerBatches = await listBatches();
  const stickerBatchCount = stickerBatches.length;

  // Audit log — count months that actually have entries
  const recentMonths = getRecentMonths();
  let auditMonthCount = 0;
  for (const month of recentMonths) {
    const entries = await getAuditEntries(month);
    if (entries.length > 0) auditMonthCount++;
  }

  return NextResponse.json(
    { clients, stickerBatchCount, auditMonthCount },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
