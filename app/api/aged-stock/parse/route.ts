import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { gunzipSync } from 'zlib';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { clientScopeFor } from '@/lib/clientScope';
import { getClient } from '@/lib/spLinkData';
import { parseAgedStockFile, type AgedStockParseResult } from '@/lib/agedStockParser';
import { saveDraft } from '@/lib/agedStockData';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB — aged stock files can be big

/**
 * POST /api/aged-stock/parse
 *
 * Two intake paths:
 *  - application/gzip  → a gzipped JSON payload of a CLIENT-SIDE parse
 *    `{ clientId, fileName, format, periods, rows, warnings }`. Used by the load
 *    page so large xlsx files (>4.5 MB) never hit Vercel's request-body limit —
 *    the browser parses the file and ships the compact, gzipped result.
 *  - multipart/form-data → `clientId` + `file` (xlsx). Legacy/small-file path;
 *    the server parses the file directly.
 *
 * Either way it saves a per-user DRAFT and returns a preview:
 *   { draftId, format, fileName, rowCount, periods, sampleRows, warnings }
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'load_aged_stock');
  if (guard instanceof NextResponse) return guard;

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  if (!me) return NextResponse.json({ error: 'User not found' }, { status: 401 });

  const contentType = req.headers.get('content-type') ?? '';

  let clientId = '';
  let fileName = 'aged-stock.xlsx';
  let parsed: AgedStockParseResult;

  if (contentType.includes('application/gzip') || contentType.includes('application/octet-stream')) {
    // ── Client-side parse: gunzip the JSON payload ──────────────────────────
    let payload: {
      clientId?: unknown; fileName?: unknown; format?: unknown;
      periods?: unknown; rows?: unknown; warnings?: unknown;
    };
    try {
      const gz = Buffer.from(await req.arrayBuffer());
      payload = JSON.parse(gunzipSync(gz).toString('utf-8'));
    } catch {
      return NextResponse.json({ error: 'Could not read upload (bad gzip/JSON)' }, { status: 400 });
    }
    clientId = String(payload.clientId ?? '').trim();
    fileName = String(payload.fileName ?? 'aged-stock.xlsx');
    if (!Array.isArray(payload.rows)) {
      return NextResponse.json({ error: 'Payload has no parsed rows' }, { status: 400 });
    }
    parsed = {
      format: (payload.format as AgedStockParseResult['format']) ?? 'unknown',
      sheetName: '',
      periods: Array.isArray(payload.periods) ? payload.periods as AgedStockParseResult['periods'] : [],
      rows: payload.rows as AgedStockParseResult['rows'],
      warnings: Array.isArray(payload.warnings) ? payload.warnings as string[] : [],
      errors: [],
    };
  } else {
    // ── Legacy multipart path: server parses the file ───────────────────────
    let form: FormData;
    try { form = await req.formData(); }
    catch { return NextResponse.json({ error: 'Invalid form data' }, { status: 400 }); }

    clientId = String(form.get('clientId') ?? '').trim();
    const file = form.get('file');
    if (!(file instanceof File)) return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    if (file.size === 0) return NextResponse.json({ error: 'File is empty' }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: 'File must be 20 MB or less' }, { status: 400 });
    fileName = file.name;
    parsed = parseAgedStockFile(new Uint8Array(await file.arrayBuffer()));
  }

  if (!clientId) return NextResponse.json({ error: 'clientId is required' }, { status: 400 });

  if (parsed.errors.length > 0) {
    return NextResponse.json({
      ok: false,
      errors: parsed.errors,
      warnings: parsed.warnings,
    }, { status: 422 });
  }

  // Scope check — user must have access to this client
  const scope = clientScopeFor({
    role: me.role,
    permissions: guard.permissions,
    linkedClientId: me.linkedClientId,
    assignedClientIds: me.assignedClientIds,
  });
  if (!scope.all && !scope.ids.includes(clientId)) {
    return NextResponse.json({ error: 'You do not have access to this client' }, { status: 403 });
  }

  const client = await getClient(clientId);
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  const draftId = randomUUID();
  const now = new Date().toISOString();
  try {
    await saveDraft({
      id: draftId,
      userId: guard.userId,
      clientId,
      clientName: client.name,
      vendorNumbers: client.vendorNumbers ?? [],
      fileName,
      uploadedAt: now,
      format: parsed.format,
      periods: parsed.periods,
      rows: parsed.rows,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to save draft: ${msg}` }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    draftId,
    fileName,
    format: parsed.format,
    rowCount: parsed.rows.length,
    periods: parsed.periods,
    sampleRows: parsed.rows.slice(0, 5),
    warnings: parsed.warnings,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
