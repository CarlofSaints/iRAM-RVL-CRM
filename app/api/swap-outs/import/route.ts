import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { loadControl } from '@/lib/controlData';
import type { ParsedSwapOut } from '@/lib/swapOutParser';
import { listSwapOuts, createSwapOuts, type SwapOut, type SwapOutLine } from '@/lib/swapOutData';
import { rememberStoreAliases } from '@/lib/swapOutStoreMap';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

interface StoreRecord {
  id: string;
  name?: string;
  siteCode?: string;
  region?: string;
  channel?: string;
}

/** Must match the grouping key built in /api/swap-outs/import/parse. */
const canon = (s: string) =>
  s.trim().toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const groupKey = (c: { channel?: string; storeName: string }) =>
  `${(c.channel ?? '').toUpperCase()}|${canon(c.storeName)}`;

/**
 * POST /api/swap-outs/import — step 2 of the import: commit the parsed sheet.
 *
 * Body: { clientId, fileName?, consignments: ParsedSwapOut[], mapping: { [groupKey]: storeId } }
 *
 * Every store group must be mapped to a FLOW store — the supplier sheet has no
 * site codes, so an unmapped consignment would be un-actionable in the
 * warehouse. Confirmed mappings are remembered for next week's sheet.
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'import_excel');
  if (guard instanceof NextResponse) return guard;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Expected a JSON body' }, { status: 400 });

  const clientId = String(body.clientId ?? '').trim();
  const fileName = String(body.fileName ?? '').trim() || 'swap-out sheet';
  const consignments: ParsedSwapOut[] = Array.isArray(body.consignments) ? body.consignments : [];
  const mapping: Record<string, string> =
    body.mapping && typeof body.mapping === 'object' ? body.mapping : {};

  if (!clientId) return NextResponse.json({ error: 'clientId is required' }, { status: 400 });
  if (consignments.length === 0) {
    return NextResponse.json({ error: 'No consignments to import' }, { status: 400 });
  }

  const [users, stores, existing] = await Promise.all([
    loadUsers(),
    loadControl<StoreRecord>('stores'),
    listSwapOuts(),
  ]);

  const me = users.find((u) => u.id === guard.userId);
  const actorName = me ? `${me.name} ${me.surname}` : 'Unknown';
  const storeById = new Map(stores.map((s) => [s.id, s]));

  // Refuse the whole import if any store is unmapped or points at a dead store —
  // a half-imported sheet is worse to unpick than a rejected one.
  const unmapped = new Set<string>();
  const badStore = new Set<string>();
  for (const c of consignments) {
    const storeId = mapping[groupKey(c)];
    if (!storeId) unmapped.add(c.storeName);
    else if (!storeById.has(storeId)) badStore.add(c.storeName);
  }
  if (unmapped.size > 0) {
    return NextResponse.json(
      { error: `Map every store before importing. Still unmapped: ${[...unmapped].join(', ')}` },
      { status: 400 }
    );
  }
  if (badStore.size > 0) {
    return NextResponse.json(
      { error: `Mapped to a store that no longer exists: ${[...badStore].join(', ')}` },
      { status: 400 }
    );
  }

  // Skip picking numbers already imported for this client (weekly sheets overlap).
  const seen = new Set(
    existing
      .filter((s) => s.clientId === clientId && s.pickingNumber)
      .map((s) => s.pickingNumber.trim().toUpperCase())
  );

  const now = new Date().toISOString();
  const importBatchId = randomUUID();
  const toCreate: SwapOut[] = [];
  const skippedPicking: string[] = [];

  for (const c of consignments) {
    const picking = (c.pickingNumber ?? '').trim();
    if (picking && seen.has(picking.toUpperCase())) {
      skippedPicking.push(picking);
      continue;
    }
    if (picking) seen.add(picking.toUpperCase());

    const store = storeById.get(mapping[groupKey(c)])!;
    const lines: SwapOutLine[] = (c.lines ?? [])
      .filter((l) => l && String(l.product ?? '').trim())
      .map((l) => ({
        product: String(l.product).trim(),
        description: l.description ? String(l.description).trim() : undefined,
        quantity: Number(l.quantity) || 0,
        issuedQty: 0,
        returnedQty: 0,
      }));
    if (lines.length === 0) continue;

    const status = picking ? 'picking_assigned' : 'requested';
    toCreate.push({
      id: randomUUID(),
      clientId,
      pickingNumber: picking,
      requestDate: c.requestDate,
      channel: c.channel,
      storeName: store.name ?? c.storeName,
      storeId: store.id,
      storeCode: store.siteCode,
      region: c.region ?? store.region,
      sheetStoreName: c.storeName,
      pickingNote: c.pickingNote,
      lines,
      movements: [],
      status,
      history: [
        {
          status,
          at: now,
          byUserId: guard.userId,
          byName: actorName,
          method: 'import',
          note: `Imported from ${fileName}`,
        },
      ],
      importBatchId,
      sourceFileName: fileName,
      createdAt: now,
      updatedAt: now,
    });
  }

  if (toCreate.length === 0) {
    return NextResponse.json({
      created: 0,
      skipped: skippedPicking.length,
      total: consignments.length,
      skippedPicking,
      storesRemembered: 0,
      warnings: ['Every consignment in this sheet had already been imported.'],
    });
  }

  await createSwapOuts(toCreate);

  // Remember the mapping so the same sheet names resolve themselves next week.
  const aliasEntries = new Map<
    string,
    { clientId: string; channel?: string; sheetName: string; storeId: string; storeName?: string }
  >();
  for (const c of consignments) {
    const key = groupKey(c);
    const storeId = mapping[key];
    if (!storeId || aliasEntries.has(key)) continue;
    aliasEntries.set(key, {
      clientId,
      channel: c.channel,
      sheetName: c.storeName,
      storeId,
      storeName: storeById.get(storeId)?.name,
    });
  }
  try {
    await rememberStoreAliases([...aliasEntries.values()], actorName);
  } catch (err) {
    // Non-fatal: the swap-outs are in; the user just re-maps next time.
    console.error('[swap-outs/import] alias save failed:', err instanceof Error ? err.message : err);
  }

  return NextResponse.json({
    created: toCreate.length,
    skipped: skippedPicking.length,
    total: consignments.length,
    skippedPicking,
    storesRemembered: aliasEntries.size,
    importBatchId,
    warnings: [],
  });
}
