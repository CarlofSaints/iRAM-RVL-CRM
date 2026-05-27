import { NextRequest, NextResponse } from 'next/server';
import { getClient, mutateClientById } from '@/lib/spLinkData';
import {
  getDropboxToken,
  getRootNamespaceId,
  dropboxJson,
  DROPBOX_BASE_PATH,
  DROPBOX_TEMPLATE_FOLDER,
} from '@/lib/dropboxApi';
import { requirePermission } from '@/lib/rolesData';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

type DropboxEntry = {
  '.tag': 'file' | 'folder';
  name: string;
  path_lower: string;
  path_display: string;
  id: string;
};

type ListFolderResult = {
  entries: DropboxEntry[];
  cursor: string;
  has_more: boolean;
};

type FolderMetadata = {
  metadata: { id: string; path_display: string };
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const guard = await requirePermission(req, 'manage_clients');
  if (guard instanceof NextResponse) return guard;

  const client = await getClient(id);
  if (!client) {
    return NextResponse.json({ error: 'Client not found' }, { status: 404 });
  }

  if (client.dropboxStatus === 'done') {
    return NextResponse.json(
      { error: 'Dropbox folder already created for this client' },
      { status: 409 }
    );
  }

  try {
    const token = await getDropboxToken();
    const rootNs = await getRootNamespaceId(token);
    const clientFolderPath = `${DROPBOX_BASE_PATH}/${client.name}`;

    // 1. Create client folder
    let folderId: string;
    try {
      const folder = await dropboxJson<FolderMetadata>(
        token,
        'files/create_folder_v2',
        { path: clientFolderPath, autorename: false },
        rootNs
      );
      folderId = folder.metadata.id;
    } catch (err) {
      const msg = (err as Error).message ?? '';
      // Folder already exists — that's OK, get its metadata
      if (msg.includes('409') || msg.includes('conflict') || msg.includes('path/conflict')) {
        const meta = await dropboxJson<{ id: string }>(
          token,
          'files/get_metadata',
          { path: clientFolderPath },
          rootNs
        );
        folderId = meta.id;
      } else {
        throw err;
      }
    }

    // 2. List template files in 0_MasterTemplates
    const templates = await dropboxJson<ListFolderResult>(
      token,
      'files/list_folder',
      { path: DROPBOX_TEMPLATE_FOLDER },
      rootNs
    );

    const fileEntries = templates.entries.filter((e) => e['.tag'] === 'file');

    // 3. Copy each file, replacing "CLIENT" in filename with client name
    let copiedCount = 0;
    for (const file of fileEntries) {
      const newName = file.name.replace(/CLIENT/g, client.name);
      const toPath = `${clientFolderPath}/${newName}`;
      try {
        await dropboxJson(
          token,
          'files/copy_v2',
          {
            from_path: file.path_display || file.path_lower,
            to_path: toPath,
            autorename: false,
          },
          rootNs
        );
        copiedCount++;
      } catch (copyErr) {
        const copyMsg = (copyErr as Error).message ?? '';
        // File already exists — skip, don't fail
        if (copyMsg.includes('409') || copyMsg.includes('conflict') || copyMsg.includes('to/conflict')) {
          copiedCount++;
          continue;
        }
        throw copyErr;
      }
    }

    // 4. Persist status
    await mutateClientById(id, (c) => {
      c.dropboxStatus = 'done';
      c.dropboxError = undefined;
    });

    await logAudit({
      action: 'dropbox.created',
      userId: req.headers.get('x-user-id') ?? 'system',
      userName: 'system',
      clientId: id,
      detail: `Dropbox folder created at ${clientFolderPath}. ${copiedCount} template file(s) copied.`,
    });

    return NextResponse.json({
      ok: true,
      folder: clientFolderPath,
      filesCopied: copiedCount,
    });
  } catch (err) {
    console.error('Dropbox folder creation error:', err);
    const errMsg = (err as Error).message ?? String(err);

    await mutateClientById(id, (c) => {
      c.dropboxStatus = 'error';
      c.dropboxError = errMsg.slice(0, 300);
    });

    await logAudit({
      action: 'dropbox.error',
      userId: req.headers.get('x-user-id') ?? 'system',
      userName: 'system',
      clientId: id,
      detail: `Dropbox folder creation failed: ${errMsg.slice(0, 200)}`,
    });

    return NextResponse.json({ error: errMsg }, { status: 500 });
  }
}
