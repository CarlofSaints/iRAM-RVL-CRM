import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { getPickSlipRun, updateSlipInRun } from '@/lib/pickSlipData';
import { generatePickSlipPdf, type PickSlipPdfRow } from '@/lib/pickSlipPdf';
import { renameFile, createFolder, uploadNewFile } from '@/lib/graphIram';

export const dynamic = 'force-dynamic';

/**
 * PATCH /api/pick-slips/[slipId] — Edit a pick slip's line items.
 *
 * Body: { clientId, loadId, rows: PickSlipPdfRow[] }
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ slipId: string }> }
) {
  const { slipId } = await params;
  const guard = await requirePermission(req, 'manage_pick_slips');
  if (guard instanceof NextResponse) return guard;

  let body: { clientId?: string; loadId?: string; rows?: PickSlipPdfRow[] };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
  const loadId = typeof body.loadId === 'string' ? body.loadId.trim() : '';
  const rawRows = Array.isArray(body.rows) ? body.rows : [];

  if (!clientId || !loadId) {
    return NextResponse.json({ error: 'clientId and loadId are required' }, { status: 400 });
  }

  // Filter out zero rows
  const rows = rawRows.filter(r => r.qty > 0 || r.val > 0);

  if (rows.length === 0) {
    return NextResponse.json({ error: 'No valid rows remain after filtering' }, { status: 400 });
  }

  // Find existing slip
  const run = await getPickSlipRun(clientId, loadId);
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

  const slip = run.slips.find(s => s.id === slipId);
  if (!slip) return NextResponse.json({ error: 'Slip not found' }, { status: 404 });

  const totalQty = rows.reduce((s, r) => s + r.qty, 0);
  const totalVal = rows.reduce((s, r) => s + r.val, 0);

  let spWebUrlEdited: string | undefined;

  // SP operations — rename original + upload edited
  if (slip.spDriveId && slip.spFileId) {
    try {
      // 1. Rename original to "V1"
      const v1Name = slip.fileName.replace(/\.pdf$/i, ' V1.pdf');
      await renameFile(slip.spDriveId, slip.spFileId, v1Name);

      // 2. Get the parent folder of the original file — we need to find it
      //    The original file lives in the date folder. We stored spDriveId on the slip.
      //    We'll create "Edited on App" subfolder using the file's parent.
      //    Since we don't store parent folder ID, resolve from the run's structure.
      //    The spDriveId + the file's parent are the date folder.
      //    We can get the parent from the renamed file's response or use Graph.
      //    Simpler: use the Graph API to get the parent reference of the file.
      const { getToken } = await import('@/lib/graphIram');
      const token = await getToken();
      const itemRes = await fetch(
        `https://graph.microsoft.com/v1.0/drives/${slip.spDriveId}/items/${slip.spFileId}?$select=id,parentReference`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (itemRes.ok) {
        const itemData = await itemRes.json();
        const parentId = itemData.parentReference?.id;
        if (parentId) {
          // 3. Create "Edited on App" subfolder
          const editedFolder = await createFolder(slip.spDriveId, parentId, 'Edited on App');

          // 4. Re-generate PDF with updated rows
          const pdfBuffer = await generatePickSlipPdf({
            pickSlipId: slip.id,
            clientName: slip.clientName,
            vendorNumber: slip.vendorNumber,
            siteName: slip.siteName,
            siteCode: slip.siteCode,
            warehouse: slip.warehouse,
            loadDate: slip.generatedAt.slice(0, 10),
            rows,
          });

          // 5. Upload to subfolder with EDITED suffix
          const editedFileName = slip.fileName.replace(/\.pdf$/i, ' EDITED.pdf');
          const uploaded = await uploadNewFile(
            slip.spDriveId,
            editedFolder.id,
            editedFileName,
            pdfBuffer,
            'application/pdf'
          );
          spWebUrlEdited = uploaded.webUrl;
        }
      }
    } catch (err) {
      console.error('[pick-slips] SP edit operations failed:', err instanceof Error ? err.message : err);
      // Continue — we still update the record even if SP ops fail
    }
  }

  // Update record
  const updated = await updateSlipInRun(clientId, loadId, slipId, {
    rows,
    totalQty,
    totalVal,
    rowCount: rows.length,
    editedAt: new Date().toISOString(),
    ...(spWebUrlEdited ? { spWebUrlEdited } : {}),
  });

  return NextResponse.json({ ok: true, slip: updated }, { headers: { 'Cache-Control': 'no-store' } });
}
