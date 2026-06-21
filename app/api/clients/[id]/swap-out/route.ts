import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadControl, saveControl } from '@/lib/controlData';
import type { ClientWithLinks } from '@/lib/spLinkData';

export const dynamic = 'force-dynamic';

/** PATCH /api/clients/[id]/swap-out — toggle the Swap-Out module + set its SP folder. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(req, 'manage_clients');
  if (guard instanceof NextResponse) return guard;
  const { id } = await params;

  const body = await req.json().catch(() => ({}));
  const items = await loadControl<ClientWithLinks>('clients');
  const idx = items.findIndex((c) => c.id === id);
  if (idx === -1) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  if (body.swapOutEnabled !== undefined) items[idx].swapOutEnabled = !!body.swapOutEnabled;
  if (body.swapOutFolderUrl !== undefined) {
    items[idx].swapOutFolderUrl = String(body.swapOutFolderUrl ?? '').trim() || undefined;
  }
  await saveControl('clients', items);

  return NextResponse.json({
    id,
    swapOutEnabled: items[idx].swapOutEnabled ?? false,
    swapOutFolderUrl: items[idx].swapOutFolderUrl,
  });
}
