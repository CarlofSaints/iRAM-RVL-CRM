import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import {
  addSpLink,
  getClient,
  listSpLinks,
  type SpLink,
} from '@/lib/spLinkData';
import { resolveSharedItem, findFileInFolder } from '@/lib/graphIram';
import { requirePermission, requireLogin } from '@/lib/rolesData';
import { loadControl, saveControl } from '@/lib/controlData';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const guard = await requireLogin(req);
  if (guard instanceof NextResponse) return guard;

  const client = await getClient(id);
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  const links = await listSpLinks(id);
  return NextResponse.json(links, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const guard = await requirePermission(req, 'manage_clients');
  if (guard instanceof NextResponse) return guard;

  const body = await req.json();
  const channel = (body.channel ?? '').toString().trim();
  const vendorNumber = (body.vendorNumber ?? '').toString().trim();
  const folderUrl = (body.folderUrl ?? '').toString().trim();
  const fileName = (body.fileName ?? '').toString().trim();
  const pickSlipFolderUrl = (body.pickSlipFolderUrl ?? '').toString().trim() || undefined;
  const dryRun = !!body.dryRun;

  if (!channel || !vendorNumber || !folderUrl || !fileName) {
    return NextResponse.json(
      { error: 'channel, vendorNumber, folderUrl and fileName are all required' },
      { status: 400 }
    );
  }

  const client = await getClient(id);
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  // Resolve folder + file via Graph (validates the connection)
  let driveId: string;
  let fileId: string;
  try {
    const folder = await resolveSharedItem(folderUrl);
    driveId = folder.driveId;
    const found = await findFileInFolder(folder.driveId, folder.folderId, fileName);
    if (!found) {
      return NextResponse.json(
        { error: `File "${fileName}" not found in the folder. Check the spelling and that the file is in the root of the folder.` },
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

  // Auto-create the channel in the masterfile if it doesn't exist (mirror stores pattern)
  try {
    const channels = await loadControl<{ id: string; name: string; createdAt?: string }>('channels');
    const exists = channels.some(c => c.name.trim().toLowerCase() === channel.toLowerCase());
    if (!exists) {
      channels.push({ id: randomUUID(), name: channel, createdAt: new Date().toISOString() });
      await saveControl('channels', channels);
    }
  } catch (err) {
    // Non-fatal — log and continue
    console.error('[sp-links] failed to auto-create channel:', err instanceof Error ? err.message : err);
  }

  if (dryRun) {
    return NextResponse.json({ ok: true, driveId, fileId });
  }

  const link: SpLink = {
    id: randomUUID(),
    channel,
    vendorNumber,
    folderUrl,
    fileName,
    driveId,
    fileId,
    ...(pickSlipFolderUrl ? { pickSlipFolderUrl } : {}),
  };
  await addSpLink(id, link);
  return NextResponse.json(link, { status: 201 });
}
