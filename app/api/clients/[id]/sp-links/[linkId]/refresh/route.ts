import { NextRequest, NextResponse } from 'next/server';
import {
  getSpLink,
  patchSpLink,
  loadLinkProducts,
  saveLinkProducts,
} from '@/lib/spLinkData';
import {
  resolveSharedItem,
  findFileInFolder,
  getFreshDownloadUrl,
  downloadFile,
} from '@/lib/graphIram';
import { parseProductFile } from '@/lib/productControlFile';
import { requirePermission } from '@/lib/rolesData';

export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; linkId: string }> }
) {
  const { id, linkId } = await params;
  const guard = await requirePermission(req, 'manage_products');
  if (guard instanceof NextResponse) return guard;

  const link = await getSpLink(id, linkId);
  if (!link) return NextResponse.json({ error: 'Link not found' }, { status: 404 });

  // Resolve / re-resolve drive+file. We always re-resolve the folder when the
  // cached driveId is missing OR the cached download URL has expired (we don't
  // store one — we ask for a fresh one each refresh anyway).
  let driveId = link.driveId;
  let fileId = link.fileId;
  try {
    if (!driveId || !fileId) {
      const folder = await resolveSharedItem(link.folderUrl);
      driveId = folder.driveId;
      const found = await findFileInFolder(folder.driveId, folder.folderId, link.fileName);
      if (!found) throw new Error(`File "${link.fileName}" not found in folder`);
      fileId = found.fileId;
    }
    const fresh = await getFreshDownloadUrl(driveId!, fileId!);
    const buffer = await downloadFile(fresh.downloadUrl);

    // Parse
    const parsed = await parseProductFile(buffer);

    if (parsed.errors.length > 0) {
      // Hard error — don't overwrite the existing products blob.
      const stamp = new Date().toISOString();
      await patchSpLink(id, linkId, {
        driveId,
        fileId,
        lastRefreshError: parsed.errors.join('; '),
      });
      return NextResponse.json(
        {
          ok: false,
          errors: parsed.errors,
          warnings: parsed.warnings,
          added: 0,
          updated: 0,
          removed: 0,
          lastRefreshedAt: stamp,
        },
        { status: 422 }
      );
    }

    // Diff for the response message
    const previous = await loadLinkProducts(id, linkId);
    const prevByArticle = new Map(previous.map(p => [p.articleNumber, p]));
    let added = 0, updated = 0;
    for (const p of parsed.products) {
      const prev = prevByArticle.get(p.articleNumber);
      if (!prev) { added++; continue; }
      if (
        prev.description !== p.description ||
        prev.barcode !== p.barcode ||
        prev.vendorProductCode !== p.vendorProductCode ||
        (prev.uom ?? '') !== (p.uom ?? '') ||
        (prev.caseBarcode ?? '') !== (p.caseBarcode ?? '')
      ) updated++;
    }
    const newKeys = new Set(parsed.products.map(p => p.articleNumber));
    const removed = previous.filter(p => !newKeys.has(p.articleNumber)).length;

    await saveLinkProducts(id, linkId, parsed.products);

    const stamp = new Date().toISOString();
    await patchSpLink(id, linkId, {
      driveId,
      fileId,
      lastRefreshedAt: stamp,
      lastRefreshError: undefined,
    });

    return NextResponse.json({
      ok: true,
      added,
      updated,
      removed,
      total: parsed.products.length,
      warnings: parsed.warnings,
      errors: [],
      lastRefreshedAt: stamp,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await patchSpLink(id, linkId, { lastRefreshError: msg });
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
