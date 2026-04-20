import { NextRequest, NextResponse } from 'next/server';
import { getSpLink, patchSpLink, deleteSpLink } from '@/lib/spLinkData';
import { resolveSharedItem, findFileInFolder } from '@/lib/graphIram';
import { requirePermission } from '@/lib/rolesData';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; linkId: string }> }
) {
  const { id, linkId } = await params;
  const guard = await requirePermission(req, 'manage_clients');
  if (guard instanceof NextResponse) return guard;

  const link = await getSpLink(id, linkId);
  if (!link) return NextResponse.json({ error: 'Link not found' }, { status: 404 });

  const body = await req.json();
  const channel = body.channel !== undefined ? String(body.channel).trim() : undefined;
  const vendorNumber = body.vendorNumber !== undefined ? String(body.vendorNumber).trim() : undefined;
  const folderUrl = body.folderUrl !== undefined ? String(body.folderUrl).trim() : undefined;
  const fileName = body.fileName !== undefined ? String(body.fileName).trim() : undefined;
  const pickSlipFolderUrl = body.pickSlipFolderUrl !== undefined
    ? (String(body.pickSlipFolderUrl).trim() || undefined)
    : undefined;

  // If folderUrl or fileName changed, re-resolve and refresh cached driveId/fileId.
  let driveId = link.driveId;
  let fileId = link.fileId;
  const newFolder = folderUrl ?? link.folderUrl;
  const newFile = fileName ?? link.fileName;
  if (folderUrl !== undefined || fileName !== undefined) {
    try {
      const folder = await resolveSharedItem(newFolder);
      driveId = folder.driveId;
      const found = await findFileInFolder(folder.driveId, folder.folderId, newFile);
      if (!found) {
        return NextResponse.json(
          { error: `File "${newFile}" not found in folder` },
          { status: 422 }
        );
      }
      fileId = found.fileId;
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'SharePoint check failed' },
        { status: 422 }
      );
    }
  }

  const patched = await patchSpLink(id, linkId, {
    ...(channel !== undefined ? { channel } : {}),
    ...(vendorNumber !== undefined ? { vendorNumber } : {}),
    ...(folderUrl !== undefined ? { folderUrl } : {}),
    ...(fileName !== undefined ? { fileName } : {}),
    ...(pickSlipFolderUrl !== undefined ? { pickSlipFolderUrl } : {}),
    driveId,
    fileId,
  });
  return NextResponse.json(patched);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; linkId: string }> }
) {
  const { id, linkId } = await params;
  const guard = await requirePermission(req, 'manage_clients');
  if (guard instanceof NextResponse) return guard;

  const link = await getSpLink(id, linkId);
  if (!link) return NextResponse.json({ error: 'Link not found' }, { status: 404 });

  await deleteSpLink(id, linkId);
  return NextResponse.json({ ok: true });
}
