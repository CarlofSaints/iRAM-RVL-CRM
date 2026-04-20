import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { clientScopeFor } from '@/lib/clientScope';
import { getLoad } from '@/lib/agedStockData';
import { getClient, listSpLinks } from '@/lib/spLinkData';
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

  // Load store control data → siteCode → store record (for warehouse)
  const stores = await loadControl<StoreRecord>('stores');
  const storeByCode = new Map(stores.map(s => [s.siteCode.trim().toLowerCase(), s]));

  // Group load rows by siteCode
  const rowsBySite = new Map<string, typeof load.rows>();
  for (const row of load.rows) {
    const key = row.siteCode;
    if (!rowsBySite.has(key)) rowsBySite.set(key, []);
    rowsBySite.get(key)!.push(row);
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

  // Generate pick slips: one per store
  const slips: PickSlipRecord[] = [];
  const uploadErrors: string[] = [];
  const seqCounters = new Map<string, number>(); // key: vendorNumber → next sequence

  // Determine which vendor number to use for each store group.
  // The client may have multiple vendor numbers — use the first one that has
  // a pick slip folder configured.
  const clientVendors = client.vendorNumbers ?? [];
  const defaultVendor = linksWithPickSlipFolder[0].vendorNumber;

  for (const [siteCode, siteRows] of rowsBySite) {
    // Find the vendor number for this site group — use the one from the load's
    // client record that has a pick slip folder URL configured
    let vendorNumber = defaultVendor;
    for (const v of clientVendors) {
      if (vendorToLink.has(v)) { vendorNumber = v; break; }
    }

    const link = vendorToLink.get(vendorNumber);
    if (!link?.pickSlipFolderUrl) continue;

    const dateFolder = dateFolders.get(link.pickSlipFolderUrl);
    if (!dateFolder) continue;

    // Look up warehouse from store control
    const storeRec = storeByCode.get(siteCode.trim().toLowerCase());
    const warehouse = storeRec?.linkedWarehouse || 'N/A';
    const siteName = siteRows[0].siteName;

    // Generate sequence
    const seqKey = `${vendorNumber}-${dateStr}`;
    let seq = seqCounters.get(seqKey);
    if (seq === undefined) {
      seq = nextSequenceFromRuns(existingRuns, vendorNumber, dateStr);
    }
    const pickSlipId = `PS-${vendorNumber}-${dateStr}-${String(seq).padStart(3, '0')}`;
    seqCounters.set(seqKey, seq + 1);

    const totalQty = siteRows.reduce((s, r) => s + r.qty, 0);
    const totalVal = siteRows.reduce((s, r) => s + r.val, 0);

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
        rows: siteRows.map(r => ({
          barcode: r.barcode,
          articleCode: r.articleCode,
          description: r.description,
          qty: r.qty,
          val: r.val,
        })),
      });
    } catch (err) {
      uploadErrors.push(`PDF gen failed for ${siteCode}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // Build filename: {StoreName} {SiteCode} {ClientName} ({VendorNumber}) - {YYYYMMDD} - {pickSlipId}.pdf
    const fileName = `${siteName} ${siteCode} ${client.name} (${vendorNumber}) - ${dateStr} - ${pickSlipId}.pdf`;

    // Upload to SP
    let spWebUrl: string | undefined;
    try {
      const uploaded = await uploadNewFile(
        dateFolder.driveId,
        dateFolder.folderId,
        fileName,
        pdfBuffer,
        'application/pdf'
      );
      spWebUrl = uploaded.webUrl;
    } catch (err) {
      uploadErrors.push(`Upload failed for ${siteCode}: ${err instanceof Error ? err.message : String(err)}`);
    }

    slips.push({
      id: pickSlipId,
      loadId,
      clientId,
      vendorNumber,
      siteCode,
      siteName,
      warehouse,
      totalQty,
      totalVal,
      rowCount: siteRows.length,
      fileName,
      spWebUrl,
      generatedAt: new Date().toISOString(),
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
