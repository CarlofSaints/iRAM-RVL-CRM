import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { clientScopeFor } from '@/lib/clientScope';
import { getLoad } from '@/lib/agedStockData';
import { getClient, listSpLinks, loadLinkProducts } from '@/lib/spLinkData';
import { loadControl } from '@/lib/controlData';
import { resolveSharedItem, createFolder, uploadNewFile } from '@/lib/graphIram';
import { generatePickSlipPdf } from '@/lib/pickSlipPdf';
import {
  getPickSlipRun,
  savePickSlipRun,
  nextSequenceFromRuns,
  type PickSlipRecord,
  type PickSlipRunIndex,
} from '@/lib/pickSlipData';

export const dynamic = 'force-dynamic';

/** Strip non-alphanumeric, leading zeros, lowercase — matches commit route logic. */
function normArticle(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, '').replace(/^0+/, '').toLowerCase();
}

interface StoreRecord {
  id: string;
  name: string;
  siteCode: string;
  linkedWarehouse: string;
}

/**
 * POST /api/aged-stock/loads/[loadId]/pick-slips
 *
 * Generates pick slip PDFs for a committed load, one per store, and uploads
 * them to SharePoint. Gated on `load_aged_stock` permission.
 *
 * Body: { clientId: string, force?: boolean }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ loadId: string }> }
) {
  const { loadId } = await params;
  const guard = await requirePermission(req, 'load_aged_stock');
  if (guard instanceof NextResponse) return guard;

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  if (!me) return NextResponse.json({ error: 'User not found' }, { status: 401 });

  let body: { clientId?: string; force?: boolean };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
  const force = !!body.force;

  if (!clientId) {
    return NextResponse.json({ error: 'clientId is required' }, { status: 400 });
  }

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

  // Load the committed load
  const load = await getLoad(clientId, loadId);
  if (!load) {
    return NextResponse.json({ error: 'Load not found' }, { status: 404 });
  }

  // Check for existing run (duplicate guard)
  const existingRun = await getPickSlipRun(clientId, loadId);
  if (existingRun && !force) {
    return NextResponse.json({
      error: 'Pick slips already generated for this load',
      code: 'ALREADY_GENERATED',
      existingRun,
    }, { status: 409 });
  }

  // Get client record + SP links
  const client = await getClient(clientId);
  if (!client) {
    return NextResponse.json({ error: 'Client not found' }, { status: 404 });
  }

  const spLinks = await listSpLinks(clientId);
  const linksWithPickSlipFolder = spLinks.filter(l => l.pickSlipFolderUrl);
  if (linksWithPickSlipFolder.length === 0) {
    return NextResponse.json({
      error: 'No SP links have a Pick Slip Folder URL configured. Go to Control Centre → Clients → configure a Pick Slip Folder URL on at least one SP link.',
    }, { status: 422 });
  }

  // Build a vendorNumber → link lookup (first link with pickSlipFolderUrl for that vendor wins)
  const vendorToLink = new Map<string, typeof spLinks[0]>();
  for (const link of linksWithPickSlipFolder) {
    if (!vendorToLink.has(link.vendorNumber)) {
      vendorToLink.set(link.vendorNumber, link);
    }
  }

  // Build article → vendorNumber lookup from SP link products so we can
  // split rows by vendor number (a client like Genkem may have 2+ vendor numbers)
  const articleToVendor = new Map<string, string>();
  for (const link of spLinks) {
    const products = await loadLinkProducts(clientId, link.id);
    for (const p of products) {
      const k = normArticle(p.articleNumber);
      if (!k) continue;
      if (!articleToVendor.has(k)) {
        articleToVendor.set(k, link.vendorNumber);
      }
    }
  }

  // Load store control data → siteCode → store record (for warehouse)
  const stores = await loadControl<StoreRecord>('stores');
  const storeByCode = new Map(stores.map(s => [s.siteCode.trim().toLowerCase(), s]));

  // Warehouse name/code resolver for canonical warehouseCode on slip
  const whList = await loadControl<{ code: string; name: string }>('warehouses');
  const whByCode = new Map(whList.map(w => [w.code.toUpperCase().trim(), w.code.toUpperCase().trim()]));
  const whByName = new Map(whList.map(w => [w.name.toUpperCase().trim(), w.code.toUpperCase().trim()]));
  function toWhCode(raw: string): string {
    const u = raw.toUpperCase().trim();
    if (!u) return '';
    return whByCode.get(u) ?? whByName.get(u) ?? u;
  }

  // Default vendor = first with a pick slip folder configured
  const defaultVendor = linksWithPickSlipFolder[0].vendorNumber;

  // Group load rows by siteCode + vendorNumber
  // Prefer vendorNumber from the file (committed row), fall back to article→vendor lookup
  const rowsBySiteVendor = new Map<string, { siteCode: string; vendorNumber: string; rows: typeof load.rows }>();
  for (const row of load.rows) {
    const vendorNum = (row as { vendorNumber?: string }).vendorNumber
      || articleToVendor.get(normArticle(row.articleCode))
      || defaultVendor;
    const key = `${row.siteCode}|${vendorNum}`;
    if (!rowsBySiteVendor.has(key)) {
      rowsBySiteVendor.set(key, { siteCode: row.siteCode, vendorNumber: vendorNum, rows: [] });
    }
    rowsBySiteVendor.get(key)!.rows.push(row);
  }

  // Resolve SP folders (cache driveId+folderId per unique URL)
  const resolvedFolders = new Map<string, { driveId: string; folderId: string }>();
  const folderErrors: string[] = [];

  for (const link of linksWithPickSlipFolder) {
    const url = link.pickSlipFolderUrl!;
    if (resolvedFolders.has(url)) continue;
    try {
      const resolved = await resolveSharedItem(url);
      resolvedFolders.set(url, { driveId: resolved.driveId, folderId: resolved.folderId });
    } catch (err) {
      folderErrors.push(`Vendor ${link.vendorNumber}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (resolvedFolders.size === 0) {
    return NextResponse.json({
      error: 'Could not resolve any Pick Slip Folder URLs in SharePoint',
      details: folderErrors,
    }, { status: 422 });
  }

  // Date string for folder name + filenames
  const loadDateObj = new Date(load.loadedAt);
  const dateStr = loadDateObj.toISOString().slice(0, 10).replace(/-/g, '');
  const dateDash = loadDateObj.toISOString().slice(0, 10); // YYYY-MM-DD

  // Create date sub-folders (one per unique resolved folder URL)
  const dateFolders = new Map<string, { driveId: string; folderId: string }>();
  for (const [url, resolved] of resolvedFolders) {
    try {
      const folder = await createFolder(resolved.driveId, resolved.folderId, dateStr);
      dateFolders.set(url, { driveId: resolved.driveId, folderId: folder.id });
    } catch (err) {
      folderErrors.push(`Date folder for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (dateFolders.size === 0) {
    return NextResponse.json({
      error: 'Could not create date sub-folders in SharePoint',
      details: folderErrors,
    }, { status: 500 });
  }

  // Build sequence counters per vendor — start from previous runs if force-overwriting
  const existingRuns: PickSlipRunIndex[] = existingRun ? [existingRun] : [];

  // Generate pick slips: one per store per vendor number
  const slips: PickSlipRecord[] = [];
  const uploadErrors: string[] = [];
  const seqCounters = new Map<string, number>(); // key: vendorNumber-dateStr → next sequence

  for (const [, group] of rowsBySiteVendor) {
    const { siteCode, vendorNumber, rows: siteRows } = group;

    const link = vendorToLink.get(vendorNumber);
    if (!link?.pickSlipFolderUrl) continue;

    const dateFolder = dateFolders.get(link.pickSlipFolderUrl);
    if (!dateFolder) continue;

    // Look up warehouse from store control
    const storeRec = storeByCode.get(siteCode.trim().toLowerCase());
    const warehouse = storeRec?.linkedWarehouse || 'N/A';
    const siteName = siteRows[0].siteName;

    // Build row data and filter out zero rows
    const pdfRows = siteRows
      .map(r => ({
        barcode: r.barcode,
        articleCode: r.articleCode,
        vendorProductCode: r.vendorProductCode,
        description: r.description,
        qty: r.qty,
        val: r.val,
      }))
      .filter(r => r.qty > 0 || r.val > 0);

    // Skip entire store if no rows remain after filter
    if (pdfRows.length === 0) continue;

    // Generate sequence
    const seqKey = `${vendorNumber}-${dateStr}`;
    let seq = seqCounters.get(seqKey);
    if (seq === undefined) {
      seq = nextSequenceFromRuns(existingRuns, vendorNumber, dateStr);
    }
    const pickSlipId = `PS-${vendorNumber}-${dateStr}-${String(seq).padStart(3, '0')}`;
    seqCounters.set(seqKey, seq + 1);

    const totalQty = pdfRows.reduce((s, r) => s + r.qty, 0);
    const totalVal = pdfRows.reduce((s, r) => s + r.val, 0);

    // Build PDF
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
        rows: pdfRows,
      });
    } catch (err) {
      uploadErrors.push(`PDF gen failed for ${siteCode} (${vendorNumber}): ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // Build filename: {StoreName} {SiteCode} {ClientName} ({VendorNumber}) - {YYYYMMDD} - {pickSlipId}.pdf
    const fileName = `${siteName} ${siteCode} ${client.name} (${vendorNumber}) - ${dateStr} - ${pickSlipId}.pdf`;

    // Upload to SP
    let spWebUrl: string | undefined;
    let spFileId: string | undefined;
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
      uploadErrors.push(`Upload failed for ${siteCode} (${vendorNumber}): ${err instanceof Error ? err.message : String(err)}`);
    }

    slips.push({
      id: pickSlipId,
      loadId,
      clientId,
      vendorNumber,
      siteCode,
      siteName,
      warehouse,
      warehouseCode: toWhCode(warehouse),
      totalQty,
      totalVal,
      rowCount: pdfRows.length,
      fileName,
      spWebUrl,
      generatedAt: new Date().toISOString(),
      status: 'generated',
      clientName: client.name,
      rows: pdfRows,
      spDriveId: dateFolder.driveId,
      spFileId,
    });
  }

  if (slips.length === 0) {
    return NextResponse.json({
      error: 'No pick slips could be generated',
      details: [...folderErrors, ...uploadErrors],
    }, { status: 500 });
  }

  // Save pick slip run index
  const run: PickSlipRunIndex = {
    loadId,
    clientId,
    generatedAt: new Date().toISOString(),
    slips,
  };

  try {
    await savePickSlipRun(run);
  } catch (err) {
    console.error('[pick-slips] Failed to save run index:', err);
  }

  const uploaded = slips.filter(s => s.spWebUrl).length;

  return NextResponse.json({
    ok: true,
    generated: slips.length,
    uploaded,
    failed: slips.length - uploaded,
    slips,
    ...(uploadErrors.length > 0 ? { uploadErrors } : {}),
    ...(folderErrors.length > 0 ? { folderErrors } : {}),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
