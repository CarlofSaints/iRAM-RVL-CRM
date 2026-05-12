import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { listSpLinks, loadLinkProducts } from '@/lib/spLinkData';

export const dynamic = 'force-dynamic';

function normArticle(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, '').replace(/^0+/, '').toLowerCase();
}

/**
 * GET /api/clients/[id]/products
 *
 * Returns all products for a client aggregated from all SP links,
 * deduplicated by normalized article number.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requirePermission(req, 'receipt_stock');
  if (guard instanceof NextResponse) return guard;

  const { id: clientId } = await params;
  if (!clientId) return NextResponse.json({ error: 'clientId required' }, { status: 400 });

  const spLinks = await listSpLinks(clientId);
  const productMap = new Map<string, {
    articleNumber: string;
    description: string;
    barcode: string;
    vendorProductCode: string;
  }>();

  for (const link of spLinks) {
    const products = await loadLinkProducts(clientId, link.id);
    for (const p of products) {
      const key = normArticle(p.articleNumber);
      if (!key || productMap.has(key)) continue;
      productMap.set(key, {
        articleNumber: p.articleNumber,
        description: p.description || '',
        barcode: p.barcode || '',
        vendorProductCode: p.vendorProductCode || '',
      });
    }
  }

  return NextResponse.json(
    { products: [...productMap.values()] },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
