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
 * POST /api/swap-outs/import/parse — multipart: clientId + Excel file.
 *
 * Step 1 of the import. Parses the sheet and returns the consignments plus the
 * distinct stores that need mapping. Writes nothing — the commit happens in
 * POST /api/swap-outs/import once the user has confirmed the mapping.
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

  const clientId = String(form.get('clientId') ?? '').trim();
  const file = form.get('file');
  if (!clientId) return NextResponse.json({ error: 'clientId is required' }, { status: 400 });
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

  const [stores, aliases, existing] = await Promise.all([
    loadControl<StoreRecord>('stores'),
    loadStoreAliases(),
    listSwapOuts(),
  ]);

  const aliasMap = aliasIndex(aliases);
  const byCode = new Map<string, StoreRecord>();
  for (const s of stores) {
    const code = (s.siteCode ?? '').trim().toUpperCase();
    if (code) byCode.set(code, s);
  }

  // Picking numbers already imported for this client — flagged, then skipped on commit.
  const alreadyImported = new Set(
    existing
      .filter((s) => s.clientId === clientId && s.pickingNumber)
      .map((s) => s.pickingNumber.trim().toUpperCase())
  );
  const duplicates = consignments
    .filter((c) => c.pickingNumber && alreadyImported.has(c.pickingNumber.toUpperCase()))
    .map((c) => c.pickingNumber);

  // Group the consignments by the store as written in the sheet.
  const groups = new Map<string, StoreGroup>();
  for (const c of consignments) {
    const key = `${(c.channel ?? '').toUpperCase()}|${canon(c.storeName)}`;
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
      };
      groups.set(key, g);
    }
    g.consignments += 1;
    g.units += c.lines.reduce((t, l) => t + (l.quantity || 0), 0);
    g.sheetRows.push(c.sheetRow);
  }

  for (const g of groups.values()) {
    // 1. A mapping the user already confirmed for this client wins outright.
    const remembered = aliasMap.get(aliasKey(clientId, g.channel, g.sheetName));
    if (remembered && stores.some((s) => s.id === remembered)) {
      g.suggestedStoreId = remembered;
      g.matchType = 'alias';
      continue;
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

  return NextResponse.json(
    {
      fileName: file.name,
      consignments: consignments as ParsedSwapOut[],
      storeGroups,
      duplicates,
      totals: {
        consignments: consignments.length,
        units: consignments.reduce(
          (t, c) => t + c.lines.reduce((s, l) => s + (l.quantity || 0), 0),
          0
        ),
        stores: storeGroups.length,
        unmapped: storeGroups.filter((g) => !g.suggestedStoreId).length,
      },
      warnings,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
