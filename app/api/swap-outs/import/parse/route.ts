import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadControl } from '@/lib/controlData';
import { parseSwapOutWorkbook, type ParsedSwapOut } from '@/lib/swapOutParser';
import { listSwapOuts } from '@/lib/swapOutData';
import { aliasIndex, aliasKey, loadStoreAliases } from '@/lib/swapOutStoreMap';

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

/** One distinct store as it appears in the sheet — the unit the user maps. */
interface StoreGroup {
  key: string; // channel|sheetName
  sheetName: string;
  channel?: string;
  region?: string;
  consignments: number;
  units: number;
  /** Sheet rows this store appears on — helps the user find it in the file. */
  sheetRows: number[];
  suggestedStoreId: string;
  matchType: 'alias' | 'code' | 'exact' | 'fuzzy' | 'none';
  /**
   * Which selected client/vendor record this store should land on. One sheet can
   * span several vendor numbers for the same supplier, so the vendor is chosen
   * per store, not once for the whole file. Filled from a remembered mapping, or
   * auto-set when only one vendor was selected; '' means the user must choose.
   */
  suggestedClientId: string;
  /** True when suggestedClientId came from a previously confirmed mapping. */
  vendorRemembered: boolean;
}

interface ClientRecord {
  id: string;
  name?: string;
  vendorNumbers?: string[];
  swapOutEnabled?: boolean;
}

/** Uppercase, strip punctuation, collapse whitespace — for name comparison only. */
const canon = (s: string) =>
  s.trim().toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Noise words that carry no identity in a store name. */
const STOPWORDS = new Set(['NEW', 'CONV', 'STORE', 'THE', 'SA', 'BRANCH']);

const tokens = (s: string) => canon(s).split(' ').filter((t) => t && !STOPWORDS.has(t));

/**
 * Best-effort store suggestion. Deliberately conservative: a wrong auto-map is
 * worse than no map, because the user is standing right there with a dropdown.
 */
function suggest(
  sheetName: string,
  stores: StoreRecord[]
): { storeId: string; matchType: 'exact' | 'fuzzy' | 'none' } {
  const target = canon(sheetName);
  if (!target) return { storeId: '', matchType: 'none' };

  const exact = stores.filter((s) => canon(s.name ?? '') === target);
  if (exact.length === 1) return { storeId: exact[0].id, matchType: 'exact' };
  if (exact.length > 1) return { storeId: '', matchType: 'none' }; // ambiguous — ask

  // Token-overlap score; require every sheet token to appear in the store name.
  const wanted = tokens(sheetName);
  if (wanted.length === 0) return { storeId: '', matchType: 'none' };

  const scored = stores
    .map((s) => {
      const have = new Set(tokens(s.name ?? ''));
      const hits = wanted.filter((t) => have.has(t)).length;
      return { store: s, hits, extra: have.size - hits };
    })
    .filter((x) => x.hits === wanted.length)
    .sort((a, b) => a.extra - b.extra);

  if (scored.length === 1 || (scored.length > 1 && scored[0].extra < scored[1].extra)) {
    return { storeId: scored[0].store.id, matchType: 'fuzzy' };
  }
  return { storeId: '', matchType: 'none' };
}

/**
 * POST /api/swap-outs/import/parse — multipart: clientIds + Excel file.
 *
 * Step 1 of the import. Parses the sheet and returns the consignments plus the
 * distinct stores that need mapping. Writes nothing — the commit happens in
 * POST /api/swap-outs/import once the user has confirmed the mapping.
 *
 * More than one client/vendor record may be selected: a single supplier sheet
 * can carry stores belonging to different vendor accounts of the same supplier
 * (Major Tech (Builders) runs 2130 and 4394), and splitting it by hand meant
 * importing the file twice. `clientIds` is a comma-separated list; the legacy
 * single `clientId` field is still accepted.
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'import_excel');
  if (guard instanceof NextResponse) return guard;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart form data' }, { status: 400 });
  }

  // Accept repeated `clientIds` fields, one comma-joined field, or legacy `clientId`.
  const clientIds = [
    ...form.getAll('clientIds').flatMap((v) => String(v).split(',')),
    String(form.get('clientId') ?? ''),
  ]
    .map((v) => v.trim())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);

  const file = form.get('file');
  if (clientIds.length === 0) {
    return NextResponse.json({ error: 'Select at least one client / vendor number' }, { status: 400 });
  }
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'An Excel file is required' }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  let parsed;
  try {
    parsed = parseSwapOutWorkbook(buffer);
  } catch (err) {
    return NextResponse.json(
      { error: `Could not read that workbook: ${err instanceof Error ? err.message : String(err)}` },
      { status: 422 }
    );
  }
  const { consignments, warnings } = parsed;
  if (consignments.length === 0) {
    return NextResponse.json({ error: 'No swap-out rows found in that sheet', warnings }, { status: 422 });
  }

  const [stores, aliases, existing, allClients] = await Promise.all([
    loadControl<StoreRecord>('stores'),
    loadStoreAliases(),
    listSwapOuts(),
    loadControl<ClientRecord>('clients'),
  ]);

  // Reject an unknown or swap-out-disabled vendor here rather than at commit —
  // the user has not mapped anything yet, so there is nothing to lose.
  const clientById = new Map(allClients.map((c) => [c.id, c]));
  const unknownClients = clientIds.filter((id) => !clientById.has(id));
  if (unknownClients.length > 0) {
    return NextResponse.json(
      { error: `Client no longer exists: ${unknownClients.join(', ')}` },
      { status: 400 }
    );
  }
  const disabled = clientIds.filter((id) => !clientById.get(id)?.swapOutEnabled);
  if (disabled.length > 0) {
    const names = disabled.map((id) => clientById.get(id)?.name ?? id);
    return NextResponse.json(
      { error: `Swap-Out is not enabled for: ${names.join(', ')}. Turn it on from Control Centre → Clients / Suppliers.` },
      { status: 400 }
    );
  }

  const aliasMap = aliasIndex(aliases);
  const byCode = new Map<string, StoreRecord>();
  for (const s of stores) {
    const code = (s.siteCode ?? '').trim().toUpperCase();
    if (code) byCode.set(code, s);
  }

  // Picking numbers already imported for any selected vendor — flagged here,
  // then skipped on commit. A supplier picking number is one physical
  // consignment, so a hit on a DIFFERENT vendor still means "already in".
  const importedBy = new Map<string, string[]>();
  for (const s of existing) {
    if (!s.pickingNumber || !clientIds.includes(s.clientId)) continue;
    const k = s.pickingNumber.trim().toUpperCase();
    const list = importedBy.get(k) ?? [];
    if (!list.includes(s.clientId)) list.push(s.clientId);
    importedBy.set(k, list);
  }
  const duplicates = consignments
    .filter((c) => c.pickingNumber && importedBy.has(c.pickingNumber.toUpperCase()))
    .map((c) => c.pickingNumber);
  // picking # → the vendor record(s) it is already sitting on, for the preview.
  const duplicateVendors: Record<string, string[]> = {};
  for (const p of duplicates) duplicateVendors[p.toUpperCase()] = importedBy.get(p.toUpperCase()) ?? [];

  // Group the consignments by the store as written in the sheet. The key is
  // stamped onto each consignment so the client and the commit route never have
  // to re-derive it — three copies of one rule is how they drift apart.
  const groups = new Map<string, StoreGroup>();
  for (const c of consignments) {
    const key = `${(c.channel ?? '').toUpperCase()}|${canon(c.storeName)}`;
    c.groupKey = key;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        sheetName: c.storeName,
        channel: c.channel,
        region: c.region,
        consignments: 0,
        units: 0,
        sheetRows: [],
        suggestedStoreId: '',
        matchType: 'none',
        // With a single vendor selected there is nothing to choose — every store
        // goes there, and the UI hides the column entirely.
        suggestedClientId: clientIds.length === 1 ? clientIds[0] : '',
        vendorRemembered: false,
      };
      groups.set(key, g);
    }
    g.consignments += 1;
    g.units += c.lines.reduce((t, l) => t + (l.quantity || 0), 0);
    g.sheetRows.push(c.sheetRow);
  }

  for (const g of groups.values()) {
    // 1. A mapping the user already confirmed wins outright. Aliases are keyed
    //    per client, so checking every selected vendor tells us BOTH which store
    //    this is and which vendor record it went to last time.
    const hits = clientIds
      .map((cid) => ({ cid, storeId: aliasMap.get(aliasKey(cid, g.channel, g.sheetName)) ?? '' }))
      .filter((h) => h.storeId && stores.some((s) => s.id === h.storeId));

    if (hits.length > 0) {
      // Every hit should name the same FLOW store; if they disagree the alias
      // file is contradictory, so fall through and make the user look.
      const storeIds = [...new Set(hits.map((h) => h.storeId))];
      if (storeIds.length === 1) {
        g.suggestedStoreId = storeIds[0];
        g.matchType = 'alias';
        // This store has been imported under more than one of the selected
        // vendors before — we cannot know which one this week's rows belong to.
        if (hits.length === 1) {
          g.suggestedClientId = hits[0].cid;
          g.vendorRemembered = true;
        } else if (clientIds.length > 1) {
          g.suggestedClientId = '';
        }
        continue;
      }
    }
    // 2. A site code, if a future version of the sheet ever carries one.
    const withCode = consignments.find(
      (c) => `${(c.channel ?? '').toUpperCase()}|${canon(c.storeName)}` === g.key && c.storeCode
    );
    const coded = withCode?.storeCode && byCode.get(withCode.storeCode.trim().toUpperCase());
    if (coded) {
      g.suggestedStoreId = coded.id;
      g.matchType = 'code';
      continue;
    }
    // 3. Name match — exact, then a conservative token match.
    const s = suggest(g.sheetName, stores);
    g.suggestedStoreId = s.storeId;
    g.matchType = s.matchType;
  }

  const storeGroups = [...groups.values()].sort((a, b) => a.sheetName.localeCompare(b.sheetName));

  // Say plainly when a store has history on more than one selected vendor — it
  // is the one case the remembered mapping cannot decide on its own.
  const extraWarnings = [...warnings];
  const needsVendorChoice = storeGroups.filter(
    (g) => g.matchType === 'alias' && !g.suggestedClientId
  );
  if (needsVendorChoice.length > 0) {
    extraWarnings.push(
      `${needsVendorChoice.length} store${needsVendorChoice.length > 1 ? 's have' : ' has'} been imported under more than one of the selected vendor numbers before — pick the right one for this sheet: ${needsVendorChoice.map((g) => g.sheetName).join(', ')}.`
    );
  }

  return NextResponse.json(
    {
      fileName: file.name,
      clientIds,
      consignments: consignments as ParsedSwapOut[],
      storeGroups,
      duplicates,
      duplicateVendors,
      totals: {
        consignments: consignments.length,
        units: consignments.reduce(
          (t, c) => t + c.lines.reduce((s, l) => s + (l.quantity || 0), 0),
          0
        ),
        stores: storeGroups.length,
        unmapped: storeGroups.filter((g) => !g.suggestedStoreId || !g.suggestedClientId).length,
      },
      warnings: extraWarnings,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
