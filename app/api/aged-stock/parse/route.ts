import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requirePermission } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { clientScopeFor } from '@/lib/clientScope';
import { getClient } from '@/lib/spLinkData';
import { parseAgedStockFile } from '@/lib/agedStockParser';
import { saveDraft } from '@/lib/agedStockData';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB — aged stock files can be big

/**
 * POST /api/aged-stock/parse
 * multipart/form-data: clientId (string), file (xlsx)
 *
 * Parses the file into a per-user DRAFT and returns a preview:
 *   { draftId, format, fileName, rowCount, periods, sampleRows, warnings }
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'load_aged_stock');
  if (guard instanceof NextResponse) return guard;

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  if (!me) return NextResponse.json({ error: 'User not found' }, { status: 401 });

  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: 'Invalid form data' }, { status: 400 }); }

  const clientId = String(form.get('clientId') ?? '').trim();
  const file = form.get('file');
  if (!clientId) return NextResponse.json({ error: 'clientId is required' }, { status: 400 });
  if (!(file instanceof File)) return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: 'File is empty' }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'File must be 20 MB or less' }, { status: 400 });

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

  const buffer = Buffer.from(await file.arrayBuffer());
  const parsed = parseAgedStockFile(buffer);
  if (parsed.errors.length > 0) {
    return NextResponse.json({
      ok: false,
      errors: parsed.errors,
      warnings: parsed.warnings,
    }, { status: 422 });
  }

  const draftId = randomUUID();
  const now = new Date().toISOString();
  try {
    await saveDraft({
      id: draftId,
      userId: guard.userId,
      clientId,
      clientName: client.name,
      vendorNumbers: client.vendorNumbers ?? [],
      fileName: file.name,
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
    fileName: file.name,
    format: parsed.format,
    rowCount: parsed.rows.length,
    periods: parsed.periods,
    sampleRows: parsed.rows.slice(0, 5),
    warnings: parsed.warnings,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
