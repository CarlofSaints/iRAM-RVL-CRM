import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { loadControl } from '@/lib/controlData';
import { listLoads, clearAllLoads } from '@/lib/agedStockData';
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
  const guard = await requirePermission(req, 'manage_users');
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

  const { modules, cascade } = body;
  const counts = {
    agedStockLoads: 0,
    pickSlipRuns: 0,
    stickerBatches: 0,
    auditMonths: 0,
  };

  // Get all client IDs from control data
  const clients = await loadControl<{ id: string }>('clients');
  const clientIds = clients.map(c => c.id);

  // ── 1. Aged Stock ─────────────────────────────────────────────────────────
  if (modules.agedStock) {
    for (const clientId of clientIds) {
      const deleted = await clearAllLoads(clientId);
      counts.agedStockLoads += deleted;
    }
  }

  // ── 2. Pick Slips ─────────────────────────────────────────────────────────
  const clearPickSlips =
    (modules.agedStock && cascade.agedStockPickSlips) || modules.pickSlips;

  if (clearPickSlips) {
    for (const clientId of clientIds) {
      // Load-based runs — read the aged stock index to get loadIds
      const loads = await listLoads(clientId);
      for (const load of loads) {
        const run = await getPickSlipRun(clientId, load.id);
        if (run && run.slips.length > 0) {
          await clearPickSlipRun(clientId, load.id);
          counts.pickSlipRuns++;
        }
      }
      // Manual runs
      const manualIds = await getManualIndex(clientId);
      for (const manualLoadId of manualIds) {
        const run = await getPickSlipRun(clientId, manualLoadId);
        if (run && run.slips.length > 0) {
          await clearPickSlipRun(clientId, manualLoadId);
          counts.pickSlipRuns++;
        }
      }
      // Clear the manual index itself
      if (manualIds.length > 0) {
        await clearManualIndex(clientId);
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
    // Log the clear action BEFORE wiping the log
    await logAudit({
      action: 'clear_data',
      userId: guard.userId,
      userName,
      detail: `Cleared data: ${Object.entries(modules).filter(([, v]) => v).map(([k]) => k).join(', ')}. Cascade: ${Object.entries(cascade).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`,
    });
    counts.auditMonths = await clearAuditLog();
  } else {
    // Log the clear action (audit log is NOT being cleared)
    logAudit({
      action: 'clear_data',
      userId: guard.userId,
      userName,
      detail: `Cleared data: ${Object.entries(modules).filter(([, v]) => v).map(([k]) => k).join(', ')}. Cascade: ${Object.entries(cascade).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}. Counts: loads=${counts.agedStockLoads}, runs=${counts.pickSlipRuns}, batches=${counts.stickerBatches}`,
    }).catch(err => console.error('[clear-data] audit log write failed:', err));
  }

  return NextResponse.json(counts);
}
