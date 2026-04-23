import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { clientScopeFor, filterClientIdsByScope } from '@/lib/clientScope';
import { loadControl } from '@/lib/controlData';
import { listLoads } from '@/lib/agedStockData';
import { listAllPickSlipRuns } from '@/lib/pickSlipData';

export const dynamic = 'force-dynamic';

interface ClientRecord {
  id: string;
  name: string;
  vendorNumbers: string[];
}

/**
 * GET /api/scan/lookup-slip?slipId=PS-XXXX
 *
 * Validate a pick slip barcode for the scan screen.
 * Returns slip summary if valid and in a bookable status.
 */
export async function GET(req: NextRequest) {
  const guard = await requirePermission(req, 'scan_stock');
  if (guard instanceof NextResponse) return guard;

  const slipId = req.nextUrl.searchParams.get('slipId')?.trim();
  if (!slipId) {
    return NextResponse.json({ error: 'slipId query param is required' }, { status: 400 });
  }

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  if (!me) return NextResponse.json({ error: 'User not found' }, { status: 401 });

  const scope = clientScopeFor({
    role: me.role,
    permissions: guard.permissions,
    linkedClientId: me.linkedClientId,
    assignedClientIds: me.assignedClientIds,
  });

  const allClients = await loadControl<ClientRecord>('clients');
  const allClientIds = allClients.map(c => c.id);
  const scopedIds = filterClientIdsByScope(scope, allClientIds);

  if (scopedIds.length === 0) {
    return NextResponse.json(
      { found: false, error: 'No clients in scope' },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // Build warehouse resolver: raw value → canonical code
  // linkedWarehouse on stores is free-text, so it could be a code, name, or
  // partial match. Try: exact code → exact name → code-that-starts-with → name-that-starts-with.
  const warehouses = await loadControl<{ code: string; name: string }>('warehouses');
  const whCodeSet = new Set(warehouses.map(w => w.code.toUpperCase().trim()));
  const whNameToCode = new Map(warehouses.map(w => [w.name.toUpperCase().trim(), w.code.toUpperCase().trim()]));
  function resolveWarehouseCode(raw: string): string {
    const upper = raw.toUpperCase().trim();
    if (!upper) return '';
    // Exact code match
    if (whCodeSet.has(upper)) return upper;
    // Exact name match
    const byName = whNameToCode.get(upper);
    if (byName) return byName;
    // Fuzzy: find a warehouse whose name starts with the raw value, or vice versa
    for (const w of warehouses) {
      const wCode = w.code.toUpperCase().trim();
      const wName = w.name.toUpperCase().trim();
      if (wName.startsWith(upper) || upper.startsWith(wName)) return wCode;
      if (wCode.startsWith(upper) || upper.startsWith(wCode)) return wCode;
    }
    return upper;
  }

  const runs = await listAllPickSlipRuns(scopedIds, listLoads);

  // Search all runs for the slip
  for (const run of runs) {
    const slip = run.slips.find(s => s.id === slipId);
    if (slip) {
      // Only allow booking for pre-booked/receipted statuses
      const bookableStatuses = ['generated', 'sent', 'picked'];
      if (!bookableStatuses.includes(slip.status)) {
        return NextResponse.json(
          {
            found: true,
            bookable: false,
            error: `Pick slip is already "${slip.status}" — cannot book`,
            status: slip.status,
          },
          { headers: { 'Cache-Control': 'no-store' } },
        );
      }

      return NextResponse.json(
        {
          found: true,
          bookable: true,
          slip: {
            id: slip.id,
            loadId: slip.loadId,
            clientId: slip.clientId,
            clientName: slip.clientName,
            vendorNumber: slip.vendorNumber,
            siteCode: slip.siteCode,
            siteName: slip.siteName,
            warehouse: slip.warehouse,
            warehouseCode: resolveWarehouseCode(slip.warehouse || ''),
            totalQty: slip.totalQty,
            totalVal: slip.totalVal,
            status: slip.status,
          },
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
  }

  return NextResponse.json(
    { found: false, error: 'Pick slip not found' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
