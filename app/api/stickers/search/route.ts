import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { loadControl } from '@/lib/controlData';
import { clientScopeFor, filterClientIdsByScope } from '@/lib/clientScope';
import { searchStickers, type StickerSearchHit } from '@/lib/stickerData';
import { resolveSlipsForBarcode, isContested } from '@/lib/stickerLookup';
import { resolveWarehouseAccess } from '@/lib/warehouseScopeServer';
import { isWarehouseAllowed, scopeLabel } from '@/lib/warehouseScope';

export const dynamic = 'force-dynamic';

interface ClientRecord { id: string; name: string }

/**
 * GET /api/stickers/search?q=STK-GAU-0148
 *
 * Find a box label by its number and say which STORE it is on.
 *
 * Returns one of three shapes, all with the same top-level keys so an older
 * tab never sees a body it cannot read:
 *   { found: false, matches: [] }              nothing matched
 *   { found: false, matches: [...] }           several partial matches — pick one
 *   { found: true, sticker, slips, contested } one sticker resolved
 */
export async function GET(req: NextRequest) {
  const guard = await requirePermission(req, 'view_aged_stock');
  if (guard instanceof NextResponse) return guard;

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (!q) {
    return NextResponse.json({ error: 'q query param is required' }, { status: 400 });
  }

  const empty = {
    found: false,
    matches: [] as StickerSearchHit[],
    barcode: q.toUpperCase(),
    sticker: null,
    slips: [],
    contested: false,
  };
  const noStore = { headers: { 'Cache-Control': 'no-store' } };

  const access = await resolveWarehouseAccess(guard.userId);
  const hits = (await searchStickers(q))
    .filter(h => isWarehouseAllowed(access.scope, h.warehouseCode, access.resolve));

  // Several possibilities — let the operator choose rather than guessing.
  const exact = hits.filter(h => h.exact);
  if (hits.length > 1 && exact.length !== 1) {
    return NextResponse.json({ ...empty, matches: hits }, noStore);
  }

  const sticker = exact[0] ?? hits[0] ?? null;

  // Client scope — the same narrowing the pick-slip screens use.
  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  const scope = clientScopeFor({
    role: me?.role ?? '',
    permissions: guard.permissions,
    linkedClientId: me?.linkedClientId,
    assignedClientIds: me?.assignedClientIds,
  });
  const allClients = await loadControl<ClientRecord>('clients');
  const clientIds = filterClientIdsByScope(scope, allClients.map(c => c.id));

  const barcode = sticker?.barcodeValue ?? q.toUpperCase().replace(/\s+/g, '');
  const slips = await resolveSlipsForBarcode(barcode, sticker?.linkedPickSlipIds ?? [], clientIds);

  // An empty slip list from a NARROWED search proves nothing — the label may
  // well be on a store this caller cannot see. Say which it is, so "no pick
  // slip" is never mistaken for "blank label". A filtered list cannot prove
  // absence.
  const scopeNarrowed = !scope.all;

  // The register not knowing a number does NOT mean no box carries it. Labels
  // printed before the 7 Aug 2026 wipe have no record at all, and a Replace
  // retires the old number out of the register while it is still stuck to the
  // box someone is holding. The slips are the source of truth — answer from
  // them, and say plainly that there is no record to edit.
  if (!sticker) {
    if (slips.length > 0) {
      return NextResponse.json(
        { found: true, matches: [], barcode, sticker: null, slips, contested: isContested(slips), scopeNarrowed },
        noStore,
      );
    }

    // Say plainly when the label exists but belongs elsewhere, rather than
    // sending someone hunting the floor for a number that scanned fine.
    const unscoped = await searchStickers(q, 1);
    if (unscoped.length > 0) {
      return NextResponse.json(
        {
          ...empty,
          error: `${unscoped[0].barcodeValue} belongs to ${unscoped[0].warehouseName || unscoped[0].warehouseCode}. ` +
            `Your access is limited to ${scopeLabel(access.scope)}.`,
        },
        noStore,
      );
    }
    return NextResponse.json(empty, noStore);
  }

  return NextResponse.json(
    { found: true, matches: [], barcode, sticker, slips, contested: isContested(slips), scopeNarrowed },
    noStore,
  );
}
