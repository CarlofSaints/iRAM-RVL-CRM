import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import {
  getSpLink,
  patchSpLink,
  loadLinkProducts,
  saveLinkProducts,
} from '@/lib/spLinkData';
import {
  getFreshDownloadUrl,
  downloadFile,
  uploadFile,
  resolveSharedItem,
  findFileInFolder,
} from '@/lib/graphIram';
import {
  parseProductFile,
  serializeProductsToBuffer,
  type Product,
} from '@/lib/productControlFile';
import { requirePermission, requireLogin } from '@/lib/rolesData';

export const dynamic = 'force-dynamic';

// ── Helpers ──────────────────────────────────────────────────────────────────

interface RefreshGuardArgs {
  clientId: string;
  linkId: string;
  ifLastRefreshed: string | null;
}

/**
 * If the client sent an If-Last-Refreshed header, verify it matches the
 * link's stored lastRefreshedAt. Returns a 409 NextResponse on mismatch,
 * or null when OK.
 *
 * When the client did NOT send the header, we treat it as a refresh-bypass —
 * useful for legacy callers but the UI is expected to always send it.
 */
async function refreshGate(args: RefreshGuardArgs): Promise<NextResponse | null> {
  if (!args.ifLastRefreshed) return null;
  const link = await getSpLink(args.clientId, args.linkId);
  if (!link) return NextResponse.json({ error: 'Link not found' }, { status: 404 });
  const current = link.lastRefreshedAt ?? '';
  if (current !== args.ifLastRefreshed) {
    return NextResponse.json(
      { error: 'SP file was refreshed in another session. Click Refresh to sync.', code: 'STALE_REFRESH' },
      { status: 409 }
    );
  }
  return null;
}

/**
 * Locate driveId+fileId for the link, re-resolving via the folder URL if the
 * cached IDs are missing.
 */
async function resolveDriveFile(
  clientId: string,
  linkId: string
): Promise<{ driveId: string; fileId: string }> {
  const link = await getSpLink(clientId, linkId);
  if (!link) throw new Error('Link not found');
  if (link.driveId && link.fileId) {
    return { driveId: link.driveId, fileId: link.fileId };
  }
  const folder = await resolveSharedItem(link.folderUrl);
  const found = await findFileInFolder(folder.driveId, folder.folderId, link.fileName);
  if (!found) throw new Error(`File "${link.fileName}" not found in folder`);
  await patchSpLink(clientId, linkId, { driveId: folder.driveId, fileId: found.fileId });
  return { driveId: folder.driveId, fileId: found.fileId };
}

/**
 * Common write-back loop:
 *   download SP file → parse → mutate products → serialize → upload → save blob.
 * Returns the fresh products list + new lastRefreshedAt stamp.
 */
async function writeBack(
  clientId: string,
  linkId: string,
  mutate: (products: Product[]) => Product[] | { products: Product[]; error?: string }
): Promise<{ products: Product[]; lastRefreshedAt: string } | { error: string; status: number }> {
  const { driveId, fileId } = await resolveDriveFile(clientId, linkId);

  // Pull current SP file
  const fresh = await getFreshDownloadUrl(driveId, fileId);
  const buffer = await downloadFile(fresh.downloadUrl);
  const parsed = await parseProductFile(buffer);
  if (parsed.errors.length > 0) {
    return { error: `Cannot edit — source file has errors: ${parsed.errors.join('; ')}`, status: 422 };
  }

  // Apply mutation
  const result = mutate(parsed.products);
  const next = Array.isArray(result) ? result : result.products;
  if (!Array.isArray(result) && result.error) {
    return { error: result.error, status: 400 };
  }

  // Re-stamp updatedAt + ensure ids/rowIndex are present for saved blob.
  // Row indices get re-applied during serialization.
  const stamp = new Date().toISOString();
  const stamped: Product[] = next.map((p, i) => ({
    ...p,
    id: p.id || randomUUID(),
    rowIndex: parsed.headerRow + 1 + i,
    updatedAt: stamp,
  }));

  // Serialize & upload
  const outBuf = await serializeProductsToBuffer(
    buffer,
    stamped,
    parsed.headerMap,
    parsed.sheetName,
    parsed.headerRow
  );
  await uploadFile(driveId, fileId, outBuf);

  // Persist locally
  await saveLinkProducts(clientId, linkId, stamped);
  await patchSpLink(clientId, linkId, {
    driveId,
    fileId,
    lastRefreshedAt: stamp,
    lastWriteAt: stamp,
    lastRefreshError: undefined,
  });

  return { products: stamped, lastRefreshedAt: stamp };
}

// ── Routes ───────────────────────────────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; linkId: string }> }
) {
  const { id, linkId } = await params;
  const guard = await requireLogin(req);
  if (guard instanceof NextResponse) return guard;

  const link = await getSpLink(id, linkId);
  if (!link) return NextResponse.json({ error: 'Link not found' }, { status: 404 });

  const products = await loadLinkProducts(id, linkId);
  return NextResponse.json(
    { products, lastRefreshedAt: link.lastRefreshedAt ?? null },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; linkId: string }> }
) {
  const { id, linkId } = await params;
  const guard = await requirePermission(req, 'manage_products');
  if (guard instanceof NextResponse) return guard;

  const stale = await refreshGate({
    clientId: id,
    linkId,
    ifLastRefreshed: req.headers.get('if-last-refreshed'),
  });
  if (stale) return stale;

  const body = await req.json();
  const articleNumber = (body.articleNumber ?? '').toString().trim();
  const description = (body.description ?? '').toString().trim();
  const barcode = (body.barcode ?? '').toString().trim();
  const vendorProductCode = (body.vendorProductCode ?? '').toString().trim();
  const uom = body.uom !== undefined ? String(body.uom).trim() : undefined;
  const caseBarcode = body.caseBarcode !== undefined ? String(body.caseBarcode).trim() : undefined;

  if (!articleNumber || !description || !barcode || !vendorProductCode) {
    return NextResponse.json(
      { error: 'Article Number, Product Description, Barcode and Vendor Product Code are required' },
      { status: 400 }
    );
  }

  try {
    const result = await writeBack(id, linkId, (products) => {
      if (products.some(p => p.articleNumber === articleNumber)) {
        return { products, error: `A product with Article Number "${articleNumber}" already exists` };
      }
      return [...products, {
        id: randomUUID(),
        articleNumber, description, barcode, vendorProductCode,
        uom, caseBarcode,
        updatedAt: new Date().toISOString(),
      }];
    });
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to add product' },
      { status: 502 }
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; linkId: string }> }
) {
  const { id, linkId } = await params;
  const guard = await requirePermission(req, 'manage_products');
  if (guard instanceof NextResponse) return guard;

  const stale = await refreshGate({
    clientId: id,
    linkId,
    ifLastRefreshed: req.headers.get('if-last-refreshed'),
  });
  if (stale) return stale;

  const body = await req.json();
  const productId = body.id;
  if (!productId) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const updates: Partial<Product> = {};
  for (const k of ['articleNumber', 'description', 'barcode', 'vendorProductCode', 'uom', 'caseBarcode'] as const) {
    if (body[k] !== undefined) updates[k] = String(body[k]).trim();
  }

  try {
    const result = await writeBack(id, linkId, (products) => {
      const idx = products.findIndex(p => p.id === productId || p.articleNumber === body.matchArticleNumber);
      if (idx === -1) return { products, error: 'Product not found in current SP file (it may have been removed). Refresh and try again.' };
      // If we're changing articleNumber, ensure the new one is unique
      if (updates.articleNumber && updates.articleNumber !== products[idx].articleNumber) {
        if (products.some((p, i) => i !== idx && p.articleNumber === updates.articleNumber)) {
          return { products, error: `Article Number "${updates.articleNumber}" already exists in this file` };
        }
      }
      const next = [...products];
      next[idx] = { ...next[idx], ...updates };
      // Mandatory fields must remain non-empty
      const merged = next[idx];
      if (!merged.articleNumber || !merged.description || !merged.barcode || !merged.vendorProductCode) {
        return { products, error: 'Mandatory fields cannot be blank' };
      }
      return next;
    });
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to update product' },
      { status: 502 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; linkId: string }> }
) {
  const { id, linkId } = await params;
  const guard = await requirePermission(req, 'manage_products');
  if (guard instanceof NextResponse) return guard;

  const stale = await refreshGate({
    clientId: id,
    linkId,
    ifLastRefreshed: req.headers.get('if-last-refreshed'),
  });
  if (stale) return stale;

  const { searchParams } = new URL(req.url);
  const productId = searchParams.get('id');
  const articleNumber = searchParams.get('articleNumber');
  if (!productId && !articleNumber) {
    return NextResponse.json({ error: 'Missing id or articleNumber' }, { status: 400 });
  }

  try {
    const result = await writeBack(id, linkId, (products) => {
      const idx = products.findIndex(p =>
        (productId && p.id === productId) || (articleNumber && p.articleNumber === articleNumber)
      );
      if (idx === -1) return { products, error: 'Product not found in current SP file (it may have been removed already)' };
      return products.filter((_, i) => i !== idx);
    });
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to delete product' },
      { status: 502 }
    );
  }
}
