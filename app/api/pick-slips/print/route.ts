import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { listLoads } from '@/lib/agedStockData';
import {
  listAllPickSlipRuns,
  bulkPatchSlips,
  type PickSlipRecord,
} from '@/lib/pickSlipData';
import { loadUsers } from '@/lib/userData';
import { clientScopeFor, filterClientIdsByScope } from '@/lib/clientScope';
import { loadControl } from '@/lib/controlData';
import { resolveWarehouseAccess, denyIfOutOfScope } from '@/lib/warehouseScopeServer';
import { generatePickSlipsPdf, type PickSlipPdfParams } from '@/lib/pickSlipPdf';
import { resolvePickSlipRows } from '@/lib/pickSlipRows';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

interface ClientRecord { id: string; name: string; vendorNumbers: string[] }

/**
 * POST /api/pick-slips/print — print one or more pick slips.
 *
 * The paper alternative to emailing a slip to a rep: the pages come back as ONE
 * PDF (one print job, in the order the caller listed them) and every slip that
 * was still waiting to go out is advanced to 'printed', so the Picking Slips
 * grid shows which slips have actually been actioned for upliftment. Slips that
 * are further along the workflow are reprints — they render, and their print
 * record is updated, but their status is left alone.
 *
 * Body: { slipIds: string[] }
 * Returns: application/pdf (inline), with an `X-Print-Result` header carrying
 *          the counts + any per-slip skips, since a PDF body can't also be JSON.
 */
export async function POST(req: NextRequest) {
  // Same gate as Send — printing is the other way of issuing the same slip.
  const guard = await requirePermission(req, 'manage_pick_slips');
  if (guard instanceof NextResponse) return guard;

  let body: { slipIds?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const slipIds = Array.isArray(body.slipIds)
    ? body.slipIds.filter((id): id is string => typeof id === 'string' && !!id.trim()).map(id => id.trim())
    : [];

  if (slipIds.length === 0) {
    return NextResponse.json({ error: 'No pick slips selected to print' }, { status: 400 });
  }

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  if (!me) return NextResponse.json({ error: 'User not found' }, { status: 401 });
  const myName = `${me.name} ${me.surname}`.trim() || guard.userId;

  const scope = clientScopeFor({
    role: me.role,
    permissions: guard.permissions,
    linkedClientId: me.linkedClientId,
    assignedClientIds: me.assignedClientIds,
  });

  const allClients = await loadControl<ClientRecord>('clients');
  const scopedIds = filterClientIdsByScope(scope, allClients.map(c => c.id));
  const runs = await listAllPickSlipRuns(scopedIds, listLoads);

  const slipMap = new Map<string, PickSlipRecord & { _loadId: string; _clientId: string }>();
  for (const run of runs) {
    for (const slip of run.slips) {
      slipMap.set(slip.id, { ...slip, _loadId: run.loadId, _clientId: run.clientId });
    }
  }

  // Keep the caller's order — the pages come out of the printer in the order the
  // user sees on screen.
  const targetSlips: Array<PickSlipRecord & { _loadId: string; _clientId: string }> = [];
  const notFound: string[] = [];
  for (const id of slipIds) {
    const s = slipMap.get(id);
    if (s) targetSlips.push(s);
    else notFound.push(id);
  }

  if (targetSlips.length === 0) {
    return NextResponse.json(
      {
        error: slipIds.length === 1
          ? `Pick slip ${slipIds[0]} was not found, or it belongs to a client you don't have access to.`
          : `None of the ${slipIds.length} selected pick slips were found, or they belong to clients you don't have access to.`,
        notFound,
      },
      { status: 404 },
    );
  }

  // Every warehouse in the batch must be in scope — a partial check would let a
  // mixed selection through.
  const whAccess = await resolveWarehouseAccess(guard.userId);
  const whDenied = denyIfOutOfScope(
    whAccess,
    targetSlips.map(s => s.warehouseCode || s.warehouse),
    'Printing',
  );
  if (whDenied) return whDenied;

  // Build the page params, recording WHY any slip couldn't be rendered rather
  // than silently dropping it from the batch.
  const pages: PickSlipPdfParams[] = [];
  const printedIds: string[] = [];
  const skipped: Array<{ slipId: string; reason: string }> = [];

  for (const slip of targetSlips) {
    try {
      const rows = await resolvePickSlipRows(slip);
      if (rows.length === 0 && !slip.manual) {
        skipped.push({
          slipId: slip.id,
          reason: 'no line items to print — the load rows for this store could not be found',
        });
        continue;
      }
      pages.push({
        pickSlipId: slip.id,
        clientName: slip.clientName || 'Unknown',
        vendorNumber: slip.vendorNumber,
        siteName: slip.siteName,
        siteCode: slip.siteCode,
        warehouse: slip.warehouse,
        loadDate: slip.generatedAt.slice(0, 10),
        rows,
        manual: slip.manual,
      });
      printedIds.push(slip.id);
    } catch (err) {
      skipped.push({
        slipId: slip.id,
        reason: `PDF generation failed — ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  for (const id of notFound) {
    skipped.push({ slipId: id, reason: 'not found, or outside your client access' });
  }

  if (pages.length === 0) {
    return NextResponse.json(
      {
        error: 'Nothing could be printed. ' +
          skipped.map(s => `${s.slipId}: ${s.reason}`).join('; '),
        skipped,
      },
      { status: 422 },
    );
  }

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await generatePickSlipsPdf(pages);
  } catch (err) {
    return NextResponse.json(
      { error: `The pick slip PDF could not be built — ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  // Record the print. Status only advances for slips that were still waiting to
  // go out; anything further along is a reprint and keeps its status. The guard
  // is evaluated against the STORED slip inside bulkPatchSlips, not the copy
  // read above, so a slip booked while this request was building the PDF is not
  // dragged backwards.
  const now = new Date().toISOString();
  const printedSet = new Set(printedIds);
  const advanced: string[] = [];

  let patchedIds: string[] = [];
  try {
    patchedIds = await bulkPatchSlips(
      targetSlips
        .filter(s => printedSet.has(s.id))
        .map(s => ({ clientId: s._clientId, loadId: s._loadId, slipId: s.id })),
      (stored) => {
        const patch: Partial<PickSlipRecord> = {
          printedAt: now,
          printedBy: guard.userId,
          printedByName: myName,
          printCount: (stored.printCount ?? 0) + 1,
        };
        if (stored.status === 'generated' || stored.status === 'unsuccessful') {
          patch.status = 'printed';
          // Re-issuing a failed slip does NOT erase why it failed the first time
          // — the reason stays on the record and the grid keeps showing it under
          // the new status. (Resend still clears it; that path is untouched.)
          advanced.push(stored.id);
        }
        return patch;
      },
    );
  } catch (err) {
    // The paper is already coming out of the printer — hand the PDF over and say
    // the status didn't stick, rather than failing the whole print.
    console.error('[pick-slips/print] status update failed:', err);
    skipped.push({
      slipId: printedIds.join(', '),
      reason: 'printed, but the status could not be saved — re-print or set the status by hand',
    });
  }

  logAudit({
    action: 'pick-slip-print',
    userId: guard.userId,
    userName: myName,
    slipId: printedIds.length === 1 ? printedIds[0] : undefined,
    clientId: targetSlips[0]._clientId,
    detail:
      `Printed ${printedIds.length} pick slip${printedIds.length !== 1 ? 's' : ''}: ${printedIds.join(', ')}. ` +
      (advanced.length > 0
        ? `Advanced to Printed: ${advanced.join(', ')}.`
        : 'No status changes (all were reprints).') +
      (skipped.length > 0
        ? ` Skipped: ${skipped.map(s => `${s.slipId} (${s.reason})`).join('; ')}.`
        : ''),
  }).catch(err => console.error('[pick-slips/print] audit log failed:', err));

  const fileName = pages.length === 1
    ? (targetSlips.find(s => s.id === printedIds[0])?.fileName || `${printedIds[0]}.pdf`)
    : `Pick Slips - ${pages.length} - ${now.slice(0, 10)}.pdf`;

  // A PDF body can't carry JSON, so the counts ride in a header the page reads
  // back to report partial batches.
  const result = {
    printed: printedIds.length,
    advanced: advanced.length,
    saved: patchedIds.length,
    skipped,
  };

  return new Response(new Uint8Array(pdfBuffer), {
    headers: {
      'Content-Type': 'application/pdf',
      // inline — the browser opens it in its PDF viewer ready to print
      'Content-Disposition': `inline; filename="${fileName}"`,
      'X-Print-Result': encodeURIComponent(JSON.stringify(result)),
      'Cache-Control': 'no-store',
    },
  });
}
