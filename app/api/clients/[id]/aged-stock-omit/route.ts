import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadControl, saveControl } from '@/lib/controlData';
import type { ClientWithLinks, AgedStockOmit } from '@/lib/spLinkData';

export const dynamic = 'force-dynamic';

/** Coerce an incoming value to a clean, de-duped string array. */
function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<string>();
  for (const x of v) {
    const s = String(x ?? '').trim();
    if (s) out.add(s);
  }
  return [...out];
}

/** PATCH /api/clients/[id]/aged-stock-omit — set the client's aged-stock omission rules. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(req, 'manage_clients');
  if (guard instanceof NextResponse) return guard;
  const { id } = await params;

  const body = await req.json().catch(() => ({}));
  const items = await loadControl<ClientWithLinks>('clients');
  const idx = items.findIndex((c) => c.id === id);
  if (idx === -1) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  const omit: AgedStockOmit = {
    countries: toStringArray(body.countries),
    subChannels: toStringArray(body.subChannels),
    siteNums: toStringArray(body.siteNums),
  };
  // Drop the field entirely when nothing is set, keeping the record tidy.
  const isEmpty = !omit.countries!.length && !omit.subChannels!.length && !omit.siteNums!.length;
  items[idx].agedStockOmit = isEmpty ? undefined : omit;
  await saveControl('clients', items);

  return NextResponse.json({ id, agedStockOmit: items[idx].agedStockOmit ?? null });
}
