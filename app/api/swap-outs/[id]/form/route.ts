import { NextRequest, NextResponse } from 'next/server';
import { put, get } from '@vercel/blob';
import { requirePermission, requireLogin } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { getClient } from '@/lib/spLinkData';
import { resolveSharedItem, uploadNewFile } from '@/lib/graphIram';
import { getSwapOut, updateSwapOut, type SwapOutSignedForm } from '@/lib/swapOutData';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

function extOf(name: string): string {
  const m = name.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : 'pdf';
}

/** POST /api/swap-outs/[id]/form — upload the signed Major-Tech form; optionally push to SharePoint. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(req, 'scan_stock');
  if (guard instanceof NextResponse) return guard;
  const { id } = await params;
  const rec = await getSwapOut(id);
  if (!rec) return NextResponse.json({ error: 'Swap-out not found' }, { status: 404 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart form data' }, { status: 400 });
  }
  const file = form.get('file');
  const pushToSp = String(form.get('pushToSp') ?? '') === 'yes';
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'A file is required' }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const contentType = file.type || 'application/octet-stream';
  const ext = extOf(file.name);
  const blobKey = `swapouts/${id}/signed-form.${ext}`;

  try {
    await put(blobKey, buffer, {
      access: 'private',
      contentType,
      allowOverwrite: true,
      addRandomSuffix: false,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to store form: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }

  const users = await loadUsers();
  const me = users.find((u) => u.id === guard.userId);
  const actorName = me ? `${me.name} ${me.surname}` : 'Unknown';

  const signedForm: SwapOutSignedForm = {
    blobKey,
    fileName: file.name,
    contentType,
    uploadedAt: new Date().toISOString(),
    uploadedByName: actorName,
    spWebUrl: rec.signedForm?.spWebUrl,
  };

  // Optionally push to the client's SharePoint swap-out folder.
  let spError: string | undefined;
  if (pushToSp) {
    try {
      const client = await getClient(rec.clientId);
      const folderUrl = client?.swapOutFolderUrl;
      if (!folderUrl) {
        spError = 'No SharePoint swap-out folder configured for this client.';
      } else {
        const folder = await resolveSharedItem(folderUrl);
        const spName = `${rec.pickingNumber || 'no-picking'}_${rec.storeName}_signed.${ext}`.replace(
          /[\\/:*?"<>|]/g,
          '-'
        );
        const up = await uploadNewFile(folder.driveId, folder.folderId, spName, buffer, contentType);
        signedForm.spWebUrl = up.webUrl;
        signedForm.spUploadedAt = new Date().toISOString();
      }
    } catch (err) {
      spError = err instanceof Error ? err.message : 'SharePoint upload failed';
    }
  }

  const updated = await updateSwapOut(id, { signedForm });
  return NextResponse.json({ ok: true, signedForm: updated?.signedForm, spError });
}

/** GET /api/swap-outs/[id]/form — download the stored signed form. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireLogin(req);
  if (guard instanceof NextResponse) return guard;
  const { id } = await params;
  const rec = await getSwapOut(id);
  if (!rec?.signedForm) return NextResponse.json({ error: 'No form on file' }, { status: 404 });

  try {
    const result = await get(rec.signedForm.blobKey, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) {
      return NextResponse.json({ error: 'Form file not found' }, { status: 404 });
    }
    return new Response(result.stream, {
      headers: {
        'Content-Type': rec.signedForm.contentType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${rec.signedForm.fileName}"`,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Download failed' },
      { status: 500 }
    );
  }
}
