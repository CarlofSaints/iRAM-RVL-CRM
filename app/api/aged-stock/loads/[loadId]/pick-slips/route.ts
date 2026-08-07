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
  // Hoisted so the skip summariser below can close over it — TS drops the
  // non-null narrowing of `client` inside a function declaration.
  const clientName = client.name;

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

  // Every vendor number that appears on ANY SP link (with or without a pick slip
  // folder) — lets us tell "wrong vendor number" apart from "folder not set".
  const vendorsWithAnyLink = new Set(spLinks.map(l => l.vendorNumber));

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

  // Skipped store/vendor groups, so a zero-slip (or short) run can explain itself
  // instead of returning a bare "No pick slips could be generated".
  interface SkippedGroup { siteCode: string; vendorNumber: string; rowCount: number }
  const skippedNoVendorLink: SkippedGroup[] = [];
  const skippedNoFolder: SkippedGroup[] = [];
  const skippedEmptyRows: SkippedGroup[] = [];

  for (const [, group] of rowsBySiteVendor) {
    const { siteCode, vendorNumber, rows: siteRows } = group;

    const link = vendorToLink.get(vendorNumber);
    if (!link?.pickSlipFolderUrl) {
      skippedNoVendorLink.push({ siteCode, vendorNumber, rowCount: siteRows.length });
      continue;
    }

    const dateFolder = dateFolders.get(link.pickSlipFolderUrl);
    if (!dateFolder) {
      skippedNoFolder.push({ siteCode, vendorNumber, rowCount: siteRows.length });
      continue;
    }

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
    if (pdfRows.length === 0) {
      skippedEmptyRows.push({ siteCode, vendorNumber, rowCount: siteRows.length });
      continue;
    }

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
    const fileName = `${siteName} ${siteCode} ${clientName} (${vendorNumber}) - ${dateStr} - ${pickSlipId}.pdf`;

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

  // Turn the skipped groups into plain-English, actionable sentences. A single
  // mistyped vendor number on an SP link silently skips every store on the load,
  // so name the vendor numbers involved and where to fix them.
  function summariseSkips(): string[] {
    const out: string[] = [];

    if (skippedNoVendorLink.length > 0) {
      const byVendor = new Map<string, { rows: number; stores: number }>();
      for (const s of skippedNoVendorLink) {
        const agg = byVendor.get(s.vendorNumber) ?? { rows: 0, stores: 0 };
        agg.rows += s.rowCount;
        agg.stores += 1;
        byVendor.set(s.vendorNumber, agg);
      }
      for (const [vendor, agg] of byVendor) {
        const what = `${agg.rows} row${agg.rows === 1 ? '' : 's'} across ${agg.stores} store${agg.stores === 1 ? '' : 's'}`;
        if (vendorsWithAnyLink.has(vendor)) {
          out.push(
            `Vendor number ${vendor} (${what}): the SharePoint link for this vendor has no Pick Slip Folder URL configured.`
          );
        } else {
          const configured = [...vendorsWithAnyLink].filter(Boolean);
          out.push(
            `Vendor number ${vendor} (${what}): no SharePoint link on ${clientName} has this vendor number. ` +
            `Vendor numbers on its SP links are: ${configured.length ? configured.join(', ') : 'none'}.`
          );
        }
      }
      out.push(
        `Fix this at Control Centre → Clients → ${clientName} → edit the SharePoint link and correct its Vendor Number, then generate again.`
      );
    }

    if (skippedNoFolder.length > 0) {
      const vendors = [...new Set(skippedNoFolder.map(s => s.vendorNumber))].join(', ');
      out.push(
        `${skippedNoFolder.length} store${skippedNoFolder.length === 1 ? '' : 's'} skipped: the Pick Slip Folder in SharePoint could not be opened for vendor number ${vendors}.`
      );
    }

    if (skippedEmptyRows.length > 0) {
      const codes = skippedEmptyRows.map(s => s.siteCode).join(', ');
      out.push(
        `${skippedEmptyRows.length} store${skippedEmptyRows.length === 1 ? '' : 's'} skipped because every row had zero quantity and zero value: ${codes}.`
      );
    }

    return out;
  }

  const skipReasons = summariseSkips();

  if (slips.length === 0) {
    const headline = skipReasons.length > 0
      ? `No pick slips could be generated — all ${rowsBySiteVendor.size} store/vendor group${rowsBySiteVendor.size === 1 ? ' was' : 's were'} skipped. ${skipReasons.join(' ')}`
      : 'No pick slips could be generated — the load has no rows to put on a pick slip.';
    const hadRealErrors = folderErrors.length > 0 || uploadErrors.length > 0;
    return NextResponse.json({
      error: headline,
      details: [...skipReasons, ...folderErrors, ...uploadErrors],
      skipped: skipReasons,
    }, { status: hadRealErrors ? 500 : 422 });
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
    // A partial run is the dangerous case — some stores got a slip and the rest
    // vanished silently. Always report what was left out.
    ...(skipReasons.length > 0 ? { skipped: skipReasons } : {}),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
