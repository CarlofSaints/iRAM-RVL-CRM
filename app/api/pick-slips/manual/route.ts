import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { clientScopeFor } from '@/lib/clientScope';
import {
  warehouseScopeFor,
  makeWarehouseResolver,
  isWarehouseAllowed,
  scopeLabel,
  type WarehouseRecord,
} from '@/lib/warehouseScope';
import { getClient, listSpLinks } from '@/lib/spLinkData';
import { loadControl } from '@/lib/controlData';
import { resolveSharedItem, createFolder, uploadNewFile } from '@/lib/graphIram';
import { generatePickSlipPdf } from '@/lib/pickSlipPdf';
import {
  getPickSlipRun,
  savePickSlipRun,
  nextSequenceFromRuns,
  addToManualIndex,
  getManualIndex,
  listAllPickSlipRuns,
  type PickSlipRecord,
  type PickSlipRunIndex,
} from '@/lib/pickSlipData';
import { listLoads } from '@/lib/agedStockData';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

interface StoreRecord {
  id: string;
  name: string;
  siteCode: string;
  channel: string;
  linkedWarehouse: string;
}

/**
 * POST /api/pick-slips/manual
 *
 * Generates manual pick slips (one per store) for a vendor+channel combo.
 * No product rows — just store info and barcode. Products are captured later.
 *
 * Body: { clientId, storeIds: string[], channel: string }
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'manage_pick_slips');
  if (guard instanceof NextResponse) return guard;

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  if (!me) return NextResponse.json({ error: 'User not found' }, { status: 401 });

  let body: { clientId?: string; storeIds?: string[]; channel?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
  const storeIds = Array.isArray(body.storeIds) ? body.storeIds.filter(Boolean) : [];
  const channel = typeof body.channel === 'string' ? body.channel.trim() : '';

  if (!clientId) return NextResponse.json({ error: 'clientId is required' }, { status: 400 });
  if (storeIds.length === 0) return NextResponse.json({ error: 'storeIds is required' }, { status: 400 });
  if (!channel) return NextResponse.json({ error: 'channel is required' }, { status: 400 });

  // Scope check
  const scope = clientScopeFor({
    role: me.role,
    permissions: guard.permissions,
    linkedClientId: me.linkedClientId,
    assignedClientIds: me.assignedClientIds,
  });
  if (!scope.all && !scope.ids.includes(clientId)) {
    return NextResponse.json({ error: 'Access denied for this client' }, { status: 403 });
  }

  // Load client + SP links
  const client = await getClient(clientId);
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  const spLinks = await listSpLinks(clientId);
  const linksWithPickSlipFolder = spLinks.filter(l => l.pickSlipFolderUrl);
  if (linksWithPickSlipFolder.length === 0) {
    return NextResponse.json({
      error: 'No SP links have a Pick Slip Folder URL configured.',
    }, { status: 422 });
  }

  // Load store records
  const stores = await loadControl<StoreRecord>('stores');
  const storeById = new Map(stores.map(s => [s.id, s]));

  // Warehouse resolver
  const whList = await loadControl<WarehouseRecord>('warehouses');
  const whByCode = new Map(whList.map(w => [w.code.toUpperCase().trim(), w.code.toUpperCase().trim()]));
  const whByName = new Map(whList.map(w => [w.name.toUpperCase().trim(), w.code.toUpperCase().trim()]));
  function toWhCode(raw: string): string {
    const u = raw.toUpperCase().trim();
    if (!u) return '';
    return whByCode.get(u) ?? whByName.get(u) ?? u;
  }

  // Warehouse scoping — reject up front if any selected store routes to a
  // warehouse outside the user's access, before any PDF or SharePoint work.
  const whScope = warehouseScopeFor(
    { role: me.role, assignedWarehouseIds: me.assignedWarehouseIds },
    whList,
  );
  if (!whScope.all) {
    const strict = makeWarehouseResolver(whList);
    const outOfScope = storeIds
      .map(id => storeById.get(id))
      .filter((s): s is StoreRecord => !!s)
      .filter(s => !isWarehouseAllowed(whScope, s.linkedWarehouse, strict));
    if (outOfScope.length > 0) {
      return NextResponse.json(
        {
          error: `These stores are not in your warehouses: ${outOfScope.map(s => s.name).join(', ')}. ` +
            `Your access is limited to ${scopeLabel(whScope)}.`,
        },
        { status: 403 },
      );
    }
  }

  // Use first vendor with pick slip folder
  const defaultLink = linksWithPickSlipFolder[0];
  const vendorNumber = defaultLink.vendorNumber;

  // Resolve SP folder
  let dateFolder: { driveId: string; folderId: string } | null = null;
  const folderErrors: string[] = [];
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const dateDash = now.toISOString().slice(0, 10);

  try {
    const resolved = await resolveSharedItem(defaultLink.pickSlipFolderUrl!);
    const folder = await createFolder(resolved.driveId, resolved.folderId, dateStr);
    dateFolder = { driveId: resolved.driveId, folderId: folder.id };
  } catch (err) {
    console.error('[manual-capture] SP folder resolve failed:', err);
    // Slips are still generated without SharePoint, but say so — a silently
    // un-uploaded batch looks identical to a successful one.
    folderErrors.push(
      `The Pick Slip Folder in SharePoint could not be opened for vendor number ${vendorNumber}, so the PDFs were not uploaded: ` +
      (err instanceof Error ? err.message : String(err))
    );
  }

  // Gather ALL existing runs (load-based + manual) for sequence numbering
  const allClientIds = [clientId];
  const existingRuns = await listAllPickSlipRuns(allClientIds, listLoads);

  // Generate a synthetic loadId
  const manualLoadId = `manual-${randomUUID()}`;

  // Build pick slips
  const slips: PickSlipRecord[] = [];
  const uploadErrors: string[] = [];
  let seqCounter = nextSequenceFromRuns(existingRuns, vendorNumber, dateStr);

  for (const storeId of storeIds) {
    const storeRec = storeById.get(storeId);
    if (!storeRec) {
      uploadErrors.push(`Store ${storeId} not found`);
      continue;
    }

    const siteCode = storeRec.siteCode;
    const siteName = storeRec.name;
    const warehouse = storeRec.linkedWarehouse || 'N/A';

    const pickSlipId = `PS-${vendorNumber}-${dateStr}-${String(seqCounter).padStart(3, '0')}`;
    seqCounter++;

    // Generate PDF with manual flag
    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await generatePickSlipPdf({
        pickSlipId,
        clientName: client.name,
        vendorNumber,
        siteName,
        siteCode,
        warehouse,
        loadDate: dateDash,
        rows: [],
        manual: true,
      });
    } catch (err) {
      uploadErrors.push(`PDF gen failed for ${siteCode}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const fileName = `MANUAL ${siteName} ${siteCode} ${client.name} (${vendorNumber}) - ${dateStr} - ${pickSlipId}.pdf`;

    // Upload to SP
    let spWebUrl: string | undefined;
    let spFileId: string | undefined;
    if (dateFolder) {
      try {
        const uploaded = await uploadNewFile(
          dateFolder.driveId,
          dateFolder.folderId,
          fileName,
          pdfBuffer,
          'application/pdf'
        );
        spWebUrl = uploaded.webUrl;
        spFileId = uploaded.id;
      } catch (err) {
        uploadErrors.push(`Upload failed for ${siteCode}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    slips.push({
      id: pickSlipId,
      loadId: manualLoadId,
      clientId,
      vendorNumber,
      siteCode,
      siteName,
      warehouse,
      warehouseCode: toWhCode(warehouse),
      totalQty: 0,
      totalVal: 0,
      rowCount: 0,
      fileName,
      spWebUrl,
      generatedAt: now.toISOString(),
      status: 'generated',
      clientName: client.name,
      rows: [],
      manual: true,
      channel,
      spDriveId: dateFolder?.driveId,
      spFileId,
    });
  }

  if (slips.length === 0) {
    const reasons = [...uploadErrors, ...folderErrors];
    return NextResponse.json({
      error: reasons.length > 0
        ? `No pick slips could be generated — all ${storeIds.length} selected store${storeIds.length === 1 ? '' : 's'} failed. ${reasons.join(' ')}`
        : `No pick slips could be generated — none of the ${storeIds.length} selected store${storeIds.length === 1 ? '' : 's'} could be found in Store Control.`,
      details: reasons,
    }, { status: 500 });
  }

  // Save run
  const run: PickSlipRunIndex = {
    loadId: manualLoadId,
    clientId,
    generatedAt: now.toISOString(),
    slips,
  };
  await savePickSlipRun(run);
  await addToManualIndex(clientId, manualLoadId);

  // Audit log
  await logAudit({
    action: 'manual_pick_slips_generated',
    userId: guard.userId,
    userName: me.name + ' ' + me.surname,
    clientId,
    detail: `Generated ${slips.length} manual pick slip(s) for ${client.name} — channel: ${channel}, stores: ${slips.map(s => s.siteCode).join(', ')}`,
  });

  return NextResponse.json({
    ok: true,
    generated: slips.length,
    uploaded: slips.filter(s => s.spWebUrl).length,
    slips,
    ...(uploadErrors.length > 0 || folderErrors.length > 0
      ? { uploadErrors: [...uploadErrors, ...folderErrors] }
      : {}),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
