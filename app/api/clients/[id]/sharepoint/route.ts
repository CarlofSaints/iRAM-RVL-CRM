import { NextRequest, NextResponse } from 'next/server';
import { getClient, mutateClientById } from '@/lib/spLinkData';
import { getToken, graph, graphJson, pollSPCopy, SP_HOST } from '@/lib/graphIram';
import { requirePermission } from '@/lib/rolesData';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

const TEMPLATE_FOLDER_NAME = 'Z-FOLDER STRUCTURE TEMPLATES';

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

  if (client.sharepointStatus === 'done') {
    return NextResponse.json(
      { error: 'SharePoint folder already created for this client' },
      { status: 409 }
    );
  }

  try {
    const token = await getToken();

    // 1. Get root SP site
    const site = await graphJson<{ id: string }>(token, `/sites/${SP_HOST}`);
    const siteId = site.id;

    // 2. Find the "Clients" document library
    const drivesData = await graphJson<{ value: Array<{ id: string; name: string }> }>(
      token,
      `/sites/${siteId}/drives`
    );
    const clientsDrive = drivesData.value.find((d) => d.name === 'Clients');
    if (!clientsDrive) {
      throw new Error("'Clients' document library not found on SharePoint site");
    }
    const driveId = clientsDrive.id;

    // 3. Get the CLIENTS parent folder
    const clientsFolder = await graphJson<{ id: string }>(
      token,
      `/drives/${driveId}/root:/CLIENTS`
    );
    const clientsFolderId = clientsFolder.id;

    // 4. Get the template folder
    const templateFolder = await graphJson<{ id: string }>(
      token,
      `/drives/${driveId}/root:/CLIENTS/${encodeURIComponent(TEMPLATE_FOLDER_NAME)}`
    );

    // 5. Copy template folder into CLIENTS with client name (uppercase)
    const clientFolderName = client.name.toUpperCase();
    const copyRes = await graph(
      token,
      `/drives/${driveId}/items/${templateFolder.id}/copy`,
      {
        method: 'POST',
        body: JSON.stringify({
          parentReference: { driveId, id: clientsFolderId },
          name: clientFolderName,
        }),
      }
    );

    if (copyRes.status === 409) {
      // Folder already exists — treat as success
      await mutateClientById(id, (c) => {
        c.sharepointStatus = 'done';
        c.sharepointError = undefined;
      });

      await logAudit({
        action: 'sharepoint.created',
        userId: req.headers.get('x-user-id') ?? 'system',
        userName: 'system',
        clientId: id,
        detail: `SharePoint folder already existed at CLIENTS/${clientFolderName}.`,
      });

      return NextResponse.json({
        ok: true,
        folder: `CLIENTS/${clientFolderName}`,
        note: 'Folder already existed',
      });
    }

    if (!copyRes.ok) {
      const t = await copyRes.text();
      throw new Error(`Copy failed: ${copyRes.status} ${t}`);
    }

    // 6. Poll monitor URL for completion
    const monitorUrl = copyRes.headers.get('Location');
    if (monitorUrl) await pollSPCopy(monitorUrl);

    // 7. Persist status
    await mutateClientById(id, (c) => {
      c.sharepointStatus = 'done';
      c.sharepointError = undefined;
    });

    await logAudit({
      action: 'sharepoint.created',
      userId: req.headers.get('x-user-id') ?? 'system',
      userName: 'system',
      clientId: id,
      detail: `SharePoint folder structure created at CLIENTS/${clientFolderName}.`,
    });

    return NextResponse.json({ ok: true, folder: `CLIENTS/${clientFolderName}` });
  } catch (err) {
    console.error('SharePoint folder creation error:', err);
    const errMsg = (err as Error).message ?? String(err);

    await mutateClientById(id, (c) => {
      c.sharepointStatus = 'error';
      c.sharepointError = errMsg.slice(0, 300);
    });

    await logAudit({
      action: 'sharepoint.error',
      userId: req.headers.get('x-user-id') ?? 'system',
      userName: 'system',
      clientId: id,
      detail: `SharePoint folder creation failed: ${errMsg.slice(0, 200)}`,
    });

    return NextResponse.json({ error: errMsg }, { status: 500 });
  }
}
