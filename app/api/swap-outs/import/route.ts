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

interface ClientRecord {
  id: string;
  name?: string;
  vendorNumbers?: string[];
  swapOutEnabled?: boolean;
}

/**
 * The store group a consignment belongs to. The parse route stamps `groupKey`
 * on every consignment and the client sends it straight back, so this only
 * recomputes it for a payload that predates the stamp.
 */
const canon = (s: string) =>
  s.trim().toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const groupKey = (c: { groupKey?: string; channel?: string; storeName: string }) =>
  c.groupKey ?? `${(c.channel ?? '').toUpperCase()}|${canon(c.storeName)}`;

/** What the user confirmed for one store group. */
interface GroupChoice {
  storeId: string;
  clientId: string;
}

/**
 * Normalise the mapping payload. A group is either `{ storeId, clientId }` (a
 * sheet split across vendor numbers) or a bare storeId string (the original
 * single-vendor shape, still sent by anything that has not been updated). A
 * bare string falls back to the single selected vendor.
 */
function readMapping(raw: unknown, fallbackClientId: string): Record<string, GroupChoice> {
  const out: Record<string, GroupChoice> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      if (value.trim()) out[key] = { storeId: value.trim(), clientId: fallbackClientId };
    } else if (value && typeof value === 'object') {
      const v = value as { storeId?: unknown; clientId?: unknown };
      const storeId = String(v.storeId ?? '').trim();
      const clientId = String(v.clientId ?? '').trim() || fallbackClientId;
      if (storeId) out[key] = { storeId, clientId };
    }
  }
  return out;
}

/**
 * POST /api/swap-outs/import — step 2 of the import: commit the parsed sheet.
 *
 * Body: {
 *   clientIds: string[],            // vendor records this sheet may land on
 *   fileName?, consignments: ParsedSwapOut[],
 *   mapping: { [groupKey]: { storeId, clientId } }
 * }
 *
 * Every store group must be mapped to a FLOW store AND to one client/vendor
 * record — the supplier sheet has no site codes, and one supplier can run
 * several vendor numbers, so an unmapped consignment would be un-actionable in
 * the warehouse. Confirmed mappings are remembered for next week's sheet.
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'import_excel');
  if (guard instanceof NextResponse) return guard;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Expected a JSON body' }, { status: 400 });

  const clientIds: string[] = [
    ...(Array.isArray(body.clientIds) ? body.clientIds.map((v: unknown) => String(v ?? '')) : []),
    String(body.clientId ?? ''),
  ]
    .map((v) => v.trim())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);

  const fileName = String(body.fileName ?? '').trim() || 'swap-out sheet';
  const consignments: ParsedSwapOut[] = Array.isArray(body.consignments) ? body.consignments : [];
  const mapping = readMapping(body.mapping, clientIds.length === 1 ? clientIds[0] : '');

  if (clientIds.length === 0) {
    return NextResponse.json({ error: 'Select at least one client / vendor number' }, { status: 400 });
  }
  if (consignments.length === 0) {
    return NextResponse.json({ error: 'No consignments to import' }, { status: 400 });
  }

  const [users, stores, existing, allClients] = await Promise.all([
    loadUsers(),
    loadControl<StoreRecord>('stores'),
    listSwapOuts(),
    loadControl<ClientRecord>('clients'),
  ]);

  const me = users.find((u) => u.id === guard.userId);
  const actorName = me ? `${me.name} ${me.surname}` : 'Unknown';
  const storeById = new Map(stores.map((s) => [s.id, s]));
  const clientById = new Map(allClients.map((c) => [c.id, c]));

  const badClients = clientIds.filter((id) => !clientById.get(id)?.swapOutEnabled);
  if (badClients.length > 0) {
    const names = badClients.map((id) => clientById.get(id)?.name ?? id);
    return NextResponse.json(
      { error: `Swap-Out is not enabled for: ${names.join(', ')}` },
      { status: 400 }
    );
  }

  // Refuse the whole import if any store is unmapped, points at a dead store, or
  // has no vendor chosen — a half-imported sheet is worse to unpick than a
  // rejected one.
  const unmapped = new Set<string>();
  const badStore = new Set<string>();
  const noVendor = new Set<string>();
  const wrongVendor = new Set<string>();
  for (const c of consignments) {
    const choice = mapping[groupKey(c)];
    if (!choice?.storeId) { unmapped.add(c.storeName); continue; }
    if (!storeById.has(choice.storeId)) badStore.add(c.storeName);
    if (!choice.clientId) noVendor.add(c.storeName);
    else if (!clientIds.includes(choice.clientId)) wrongVendor.add(c.storeName);
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
  if (noVendor.size > 0) {
    return NextResponse.json(
      { error: `Choose a vendor number for: ${[...noVendor].join(', ')}` },
      { status: 400 }
    );
  }
  if (wrongVendor.size > 0) {
    return NextResponse.json(
      { error: `Vendor chosen for these stores was not one of the selected clients: ${[...wrongVendor].join(', ')}` },
      { status: 400 }
    );
  }

  // Skip picking numbers already imported (weekly sheets overlap). A supplier
  // picking number identifies ONE physical consignment, so a hit on any of the
  // selected vendor records counts — importing the same number under a second
  // vendor would invent stock that does not exist.
  const seenOn = new Map<string, string>(); // picking # → clientId it sits on
  for (const s of existing) {
    if (!s.pickingNumber || !clientIds.includes(s.clientId)) continue;
    const k = s.pickingNumber.trim().toUpperCase();
    if (!seenOn.has(k)) seenOn.set(k, s.clientId);
  }

  const now = new Date().toISOString();
  const importBatchId = randomUUID();
  const toCreate: SwapOut[] = [];
  const skippedPicking: string[] = [];
  /** Why each skip happened, so a short import is never silent. */
  const skippedDetail: Array<{ pickingNumber: string; store: string; onClientId: string; sameVendor: boolean }> = [];

  for (const c of consignments) {
    const choice = mapping[groupKey(c)];
    const picking = (c.pickingNumber ?? '').trim();
    if (picking && seenOn.has(picking.toUpperCase())) {
      const onClientId = seenOn.get(picking.toUpperCase())!;
      skippedPicking.push(picking);
      skippedDetail.push({
        pickingNumber: picking,
        store: c.storeName,
        onClientId,
        sameVendor: onClientId === choice.clientId,
      });
      continue;
    }
    if (picking) seenOn.set(picking.toUpperCase(), choice.clientId);

    const store = storeById.get(choice.storeId)!;
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
      clientId: choice.clientId,
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

  /** How many landed on each vendor record — the point of the split. */
  const createdByClient: Record<string, number> = {};
  for (const s of toCreate) createdByClient[s.clientId] = (createdByClient[s.clientId] ?? 0) + 1;

  if (toCreate.length === 0) {
    return NextResponse.json({
      created: 0,
      skipped: skippedPicking.length,
      total: consignments.length,
      skippedPicking,
      skippedDetail,
      createdByClient,
      storesRemembered: 0,
      warnings: ['Every consignment in this sheet had already been imported.'],
    });
  }

  await createSwapOuts(toCreate);

  // Remember the mapping so the same sheet names resolve themselves next week —
  // including WHICH vendor record the store went to, so the split repeats itself.
  const aliasEntries = new Map<
    string,
    { clientId: string; channel?: string; sheetName: string; storeId: string; storeName?: string }
  >();
  for (const c of consignments) {
    const key = groupKey(c);
    const choice = mapping[key];
    if (!choice?.storeId || !choice.clientId || aliasEntries.has(key)) continue;
    aliasEntries.set(key, {
      clientId: choice.clientId,
      channel: c.channel,
      sheetName: c.storeName,
      storeId: choice.storeId,
      storeName: storeById.get(choice.storeId)?.name,
    });
  }
  try {
    await rememberStoreAliases([...aliasEntries.values()], actorName);
  } catch (err) {
    // Non-fatal: the swap-outs are in; the user just re-maps next time.
    console.error('[swap-outs/import] alias save failed:', err instanceof Error ? err.message : err);
  }

  // A picking number already sitting on a DIFFERENT vendor is the one skip the
  // user will not expect — name it rather than fold it into the skipped count.
  const crossVendor = skippedDetail.filter((d) => !d.sameVendor);
  const warnings = crossVendor.length
    ? [
        `${crossVendor.length} consignment${crossVendor.length > 1 ? 's were' : ' was'} skipped because the picking number is already imported under a different vendor number: ${crossVendor
          .map((d) => `${d.pickingNumber} (${d.store} → ${clientById.get(d.onClientId)?.name ?? d.onClientId})`)
          .join(', ')}.`,
      ]
    : [];

  return NextResponse.json({
    created: toCreate.length,
    skipped: skippedPicking.length,
    total: consignments.length,
    skippedPicking,
    skippedDetail,
    createdByClient,
    storesRemembered: aliasEntries.size,
    importBatchId,
    warnings,
  });
}
