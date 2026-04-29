import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { loadControl } from '@/lib/controlData';
import { listLoads, clearAllLoads, deleteLoad } from '@/lib/agedStockData';
import {
  getManualIndex,
  getPickSlipRun,
  clearPickSlipRun,
  clearManualIndex,
} from '@/lib/pickSlipData';
import { clearAllBatches } from '@/lib/stickerData';
import { logAudit, clearAuditLog } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

interface ClearRequest {
  clientId?: string;
  selectedLoadIds?: string[];
  modules: {
    agedStock?: boolean;
    pickSlips?: boolean;
    stickers?: boolean;
    auditLog?: boolean;
  };
  cascade: {
    agedStockPickSlips?: boolean;
    pickSlipStickers?: boolean;
  };
}

export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'clear_data');
  if (guard instanceof NextResponse) return guard;

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  const userName = me ? `${me.name} ${me.surname}` : guard.userId;

  let body: ClearRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { clientId, selectedLoadIds, modules, cascade } = body;
  const counts = {
    agedStockLoads: 0,
    pickSlipRuns: 0,
    stickerBatches: 0,
    auditMonths: 0,
  };

  // Determine scope: single client + selected loads, or all clients
  const isTargeted = !!clientId && Array.isArray(selectedLoadIds) && selectedLoadIds.length > 0;

  // Get client IDs in scope
  let clientIds: string[];
  if (isTargeted) {
    clientIds = [clientId!];
  } else {
    const clients = await loadControl<{ id: string }>('clients');
    clientIds = clients.map(c => c.id);
  }

  // ── 1. Aged Stock ─────────────────────────────────────────────────────────
  if (modules.agedStock) {
    if (isTargeted) {
      // Delete only selected loads for the single client
      for (const loadId of selectedLoadIds!) {
        await deleteLoad(clientId!, loadId);
        counts.agedStockLoads++;
      }
    } else {
      // Legacy: clear all loads for all clients
      for (const cid of clientIds) {
        const deleted = await clearAllLoads(cid);
        counts.agedStockLoads += deleted;
      }
    }
  }

  // ── 2. Pick Slips ─────────────────────────────────────────────────────────
  const clearPickSlips =
    (modules.agedStock && cascade.agedStockPickSlips) || modules.pickSlips;

  if (clearPickSlips) {
    if (isTargeted) {
      // Only clear pick slip runs for the selected loads
      for (const loadId of selectedLoadIds!) {
        const run = await getPickSlipRun(clientId!, loadId);
        if (run && run.slips.length > 0) {
          await clearPickSlipRun(clientId!, loadId);
          counts.pickSlipRuns++;
        }
      }
    } else {
      // Legacy: clear all pick slips for all clients
      for (const cid of clientIds) {
        const loads = await listLoads(cid);
        for (const load of loads) {
          const run = await getPickSlipRun(cid, load.id);
          if (run && run.slips.length > 0) {
            await clearPickSlipRun(cid, load.id);
            counts.pickSlipRuns++;
          }
        }
        const manualIds = await getManualIndex(cid);
        for (const manualLoadId of manualIds) {
          const run = await getPickSlipRun(cid, manualLoadId);
          if (run && run.slips.length > 0) {
            await clearPickSlipRun(cid, manualLoadId);
            counts.pickSlipRuns++;
          }
        }
        if (manualIds.length > 0) {
          await clearManualIndex(cid);
        }
      }
    }
  }

  // ── 3. Stickers ───────────────────────────────────────────────────────────
  const clearStickers =
    (clearPickSlips && cascade.pickSlipStickers) || modules.stickers;

  if (clearStickers) {
    counts.stickerBatches = await clearAllBatches();
  }

  // ── 4. Audit Log ──────────────────────────────────────────────────────────
  if (modules.auditLog) {
    await logAudit({
      action: 'clear_data',
      userId: guard.userId,
      userName,
      detail: `Cleared data: ${Object.entries(modules).filter(([, v]) => v).map(([k]) => k).join(', ')}. Cascade: ${Object.entries(cascade).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`,
    });
    counts.auditMonths = await clearAuditLog();
  } else {
    const targetInfo = isTargeted
      ? ` Client=${clientId}, loads=${selectedLoadIds!.join(',')}.`
      : '';
    logAudit({
      action: 'clear_data',
      userId: guard.userId,
      userName,
      detail: `Cleared data: ${Object.entries(modules).filter(([, v]) => v).map(([k]) => k).join(', ')}. Cascade: ${Object.entries(cascade).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}.${targetInfo} Counts: loads=${counts.agedStockLoads}, runs=${counts.pickSlipRuns}, batches=${counts.stickerBatches}`,
    }).catch(err => console.error('[clear-data] audit log write failed:', err));
  }

  return NextResponse.json(counts);
}
