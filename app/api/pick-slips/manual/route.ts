import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { clientScopeFor } from '@/lib/clientScope';
import { getClient, listSpLinks, loadLinkProducts } from '@/lib/spLinkData';
import { loadControl } from '@/lib/controlData';
import { resolveSharedItem, createFolder, uploadNewFile } from '@/lib/graphIram';
import { generatePickSlipPdf, type PickSlipPdfRow } from '@/lib/pickSlipPdf';
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

function normArticle(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, '').replace(/^0+/, '').toLowerCase();
}

/**
 * POST /api/pick-slips/manual
 *
 * Generates manual pick slips (one per store) for a vendor+channel combo.
 * All products from the vendor's SP links are included with qty=0, val=0.
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

  // Merge all products from all SP links (dedup by articleNumber)
  const productMap = new Map<string, { barcode: string; articleCode: string; vendorProductCode: string; description: string }>();
  for (const link of spLinks) {
    const products = await loadLinkProducts(clientId, link.id);
    for (const p of products) {
      const key = normArticle(p.articleNumber);
      if (!key || productMap.has(key)) continue;
      productMap.set(key, {
        barcode: p.barcode || '',
        articleCode: p.articleNumber,
        vendorProductCode: p.vendorProductCode || '',
        description: p.description || '',
      });
    }
  }

  if (productMap.size === 0) {
    return NextResponse.json({
      error: 'No products found in SP product files. Refresh the product control files first.',
    }, { status: 422 });
  }

  // Build product rows (all qty=0, val=0 for manual)
  const allProductRows: PickSlipPdfRow[] = [...productMap.values()].map(p => ({
    barcode: p.barcode,
    articleCode: p.articleCode,
    vendorProductCode: p.vendorProductCode,
    description: p.description,
    qty: 0,
    val: 0,
  }));

  // Load store records
  const stores = await loadControl<StoreRecord>('stores');
  const storeById = new Map(stores.map(s => [s.id, s]));

  // Warehouse resolver
  const whList = await loadControl<{ code: string; name: string }>('warehouses');
  const whByCode = new Map(whList.map(w => [w.code.toUpperCase().trim(), w.code.toUpperCase().trim()]));
  const whByName = new Map(whList.map(w => [w.name.toUpperCase().trim(), w.code.toUpperCase().trim()]));
  function toWhCode(raw: string): string {
    const u = raw.toUpperCase().trim();
    if (!u) return '';
    return whByCode.get(u) ?? whByName.get(u) ?? u;
  }

  // Use first vendor with pick slip folder
  const defaultLink = linksWithPickSlipFolder[0];
  const vendorNumber = defaultLink.vendorNumber;

  // Resolve SP folder
  let dateFolder: { driveId: string; folderId: string } | null = null;
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const dateDash = now.toISOString().slice(0, 10);

  try {
    const resolved = await resolveSharedItem(defaultLink.pickSlipFolderUrl!);
    const folder = await createFolder(resolved.driveId, resolved.folderId, dateStr);
    dateFolder = { driveId: resolved.driveId, folderId: folder.id };
  } catch (err) {
    console.error('[manual-capture] SP folder resolve failed:', err);
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
        rows: allProductRows,
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
      rowCount: allProductRows.length,
      fileName,
      spWebUrl,
      generatedAt: now.toISOString(),
      status: 'generated',
      clientName: client.name,
      rows: allProductRows,
      manual: true,
      channel,
      spDriveId: dateFolder?.driveId,
      spFileId,
    });
  }

  if (slips.length === 0) {
    return NextResponse.json({
      error: 'No pick slips could be generated',
      details: uploadErrors,
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
    ...(uploadErrors.length > 0 ? { uploadErrors } : {}),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
