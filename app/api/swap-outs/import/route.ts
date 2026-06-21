import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { loadControl } from '@/lib/controlData';
import { parseSwapOutWorkbook } from '@/lib/swapOutParser';
import { listSwapOuts, createSwapOuts, type SwapOut } from '@/lib/swapOutData';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

interface StoreRecord {
  id: string;
  name?: string;
  code?: string;
  siteCode?: string;
}

/** POST /api/swap-outs/import — multipart: clientId + Excel file. */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'import_excel');
  if (guard instanceof NextResponse) return guard;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart form data' }, { status: 400 });
  }

  const clientId = String(form.get('clientId') ?? '').trim();
  const file = form.get('file');
  if (!clientId) return NextResponse.json({ error: 'clientId is required' }, { status: 400 });
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'An Excel file is required' }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const { consignments, warnings } = parseSwapOutWorkbook(buffer);
  if (consignments.length === 0) {
    return NextResponse.json({ error: 'No swap-out rows found', warnings }, { status: 422 });
  }

  const users = await loadUsers();
  const me = users.find((u) => u.id === guard.userId);
  const actorName = me ? `${me.name} ${me.surname}` : 'Unknown';

  // Store lookup for mapping (by site code, then name).
  const stores = await loadControl<StoreRecord>('stores');
  const byCode = new Map<string, StoreRecord>();
  const byName = new Map<string, StoreRecord>();
  for (const s of stores) {
    const code = (s.siteCode || s.code || '').toString().trim().toLowerCase();
    if (code) byCode.set(code, s);
    if (s.name) byName.set(s.name.trim().toLowerCase(), s);
  }

  // Dedupe valid picking numbers already imported for this client.
  const existing = await listSwapOuts();
  const seen = new Set(
    existing
      .filter((s) => s.clientId === clientId && s.pickingNumber)
      .map((s) => s.pickingNumber.toLowerCase())
  );

  const now = new Date().toISOString();
  const toCreate: SwapOut[] = [];
  let skipped = 0;

  for (const c of consignments) {
    if (c.pickingNumber && seen.has(c.pickingNumber.toLowerCase())) {
      skipped++;
      continue;
    }
    if (c.pickingNumber) seen.add(c.pickingNumber.toLowerCase());

    // Map to an existing store if we can.
    const codeKey = (c.storeCode || '').trim().toLowerCase();
    const nameKey = (c.storeName || '').trim().toLowerCase();
    const store = (codeKey && byCode.get(codeKey)) || (nameKey && byName.get(nameKey)) || null;

    const status = c.pickingNumber ? 'picking_assigned' : 'requested';
    toCreate.push({
      id: randomUUID(),
      clientId,
      pickingNumber: c.pickingNumber,
      requestDate: c.requestDate,
      channel: c.channel,
      storeName: c.storeName,
      storeId: store?.id,
      storeCode: c.storeCode || store?.siteCode || store?.code,
      region: c.region,
      lines: c.lines,
      status,
      history: [
        {
          status,
          at: now,
          byUserId: guard.userId,
          byName: actorName,
          method: 'import',
          note: `Imported from ${file.name}`,
        },
      ],
      createdAt: now,
      updatedAt: now,
    });
  }

  if (toCreate.length > 0) await createSwapOuts(toCreate);

  return NextResponse.json({
    created: toCreate.length,
    skipped,
    total: consignments.length,
    unmappedStores: toCreate.filter((s) => !s.storeId).length,
    warnings,
  });
}
