import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { clientScopeFor, filterClientIdsByScope } from '@/lib/clientScope';
import { loadControl } from '@/lib/controlData';
import { listLoads } from '@/lib/agedStockData';
import { listAllPickSlipRuns } from '@/lib/pickSlipData';
import { findStickerByBarcode } from '@/lib/stickerData';

export const dynamic = 'force-dynamic';

interface ClientRecord {
  id: string;
  name: string;
  vendorNumbers: string[];
}

/**
 * GET /api/receipts/related-grn?slipId=PS-001
 *
 * Look up GRN (store references) from related pick slips that share
 * sticker barcodes with the given slip. Used for auto-filling GRN
 * on the receipt capture page.
 *
 * Returns:
 *   { storeRefs: string[], relatedSlipId: string } — if a related slip has GRN data
 *   { storeRefs: null } — if no related GRN found
 */
export async function GET(req: NextRequest) {
  let guard = await requirePermission(req, 'receipt_stock');
  if (guard instanceof NextResponse) {
    guard = await requirePermission(req, 'scan_stock');
    if (guard instanceof NextResponse) return guard;
  }

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
      { storeRefs: null },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // Find the target slip
  const runs = await listAllPickSlipRuns(scopedIds, listLoads);
  let targetSlip: { receiptBoxes?: Array<{ stickerBarcode: string }>; receiptStoreRefs?: string[] } | null = null;

  for (const run of runs) {
    const found = run.slips.find(s => s.id === slipId);
    if (found) {
      targetSlip = found;
      break;
    }
  }

  if (!targetSlip || !targetSlip.receiptBoxes || targetSlip.receiptBoxes.length === 0) {
    return NextResponse.json(
      { storeRefs: null },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // Collect all related slip IDs from sticker multi-links
  const relatedSlipIds = new Set<string>();
  for (const box of targetSlip.receiptBoxes) {
    const sticker = await findStickerByBarcode(box.stickerBarcode);
    if (sticker && sticker.linkedPickSlipIds.length > 0) {
      for (const linkedId of sticker.linkedPickSlipIds) {
        if (linkedId !== slipId) {
          relatedSlipIds.add(linkedId);
        }
      }
    }
  }

  if (relatedSlipIds.size === 0) {
    return NextResponse.json(
      { storeRefs: null },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // Check related slips for GRN data (receiptStoreRefs)
  for (const run of runs) {
    for (const slip of run.slips) {
      if (relatedSlipIds.has(slip.id)) {
        const refs = slip.receiptStoreRefs?.filter(r => r.trim()) ?? [];
        if (refs.length > 0) {
          return NextResponse.json(
            { storeRefs: refs, relatedSlipId: slip.id },
            { headers: { 'Cache-Control': 'no-store' } },
          );
        }
      }
    }
  }

  return NextResponse.json(
    { storeRefs: null },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
