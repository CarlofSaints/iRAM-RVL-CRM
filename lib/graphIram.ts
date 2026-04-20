/**
 * iRam SharePoint Graph client.
 *
 * Used to read & write per-client product control files (xlsx) stored in iRam SP.
 * Reuses the same env vars as the Phantom Consolidator (IRAM_TENANT_ID / CLIENT_ID
 * / CLIENT_SECRET / SP_HOST).
 *
 * Folder URL resolution uses the Graph `/shares/{base64url}/driveItem` endpoint
 * because it works for any kind of SP/OneDrive URL — sharing links, addressbar
 * URLs, encoded path URLs — without us needing to parse hostnames or paths.
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const TENANT_ID = process.env.IRAM_TENANT_ID!;
const CLIENT_ID = process.env.IRAM_CLIENT_ID!;
const CLIENT_SECRET = process.env.IRAM_CLIENT_SECRET!;

const GRAPH = 'https://graph.microsoft.com/v1.0';

// ── Auth ─────────────────────────────────────────────────────────────────────

let _tokenCache: { token: string; expiresAt: number } | null = null;

export async function getToken(): Promise<string> {
  // Token is reusable across requests for ~50 minutes
  if (_tokenCache && _tokenCache.expiresAt > Date.now() + 60_000) {
    return _tokenCache.token;
  }

  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('iRam Graph: missing IRAM_TENANT_ID / IRAM_CLIENT_ID / IRAM_CLIENT_SECRET env vars');
  }

  const res = await fetch(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default',
      }),
    }
  );
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`iRam auth failed: ${data.error_description ?? JSON.stringify(data)}`);
  }
  _tokenCache = {
    token: data.access_token as string,
    expiresAt: Date.now() + (Number(data.expires_in ?? 3500) * 1000),
  };
  return _tokenCache.token;
}

// ── Shared item resolution ───────────────────────────────────────────────────

export interface ResolvedFolder {
  driveId: string;
  folderId: string;
  webUrl: string;
}

/**
 * Encode a URL into the `u!{base64url}` form used by Graph /shares.
 * Per docs: base64-encode the URL, replace + → -, / → _, strip trailing =.
 */
function shareIdFromUrl(url: string): string {
  const b64 = Buffer.from(url, 'utf-8').toString('base64');
  const safe = b64.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `u!${safe}`;
}

/**
 * Resolve a SharePoint folder URL to a { driveId, folderId } pair.
 * Throws on any failure.
 */
export async function resolveSharedItem(folderUrl: string): Promise<ResolvedFolder> {
  const token = await getToken();
  const shareId = shareIdFromUrl(folderUrl.trim());

  const res = await fetch(
    `${GRAPH}/shares/${shareId}/driveItem`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`iRam: could not resolve folder URL (${res.status}): ${text}`);
  }
  const item = await res.json();

  const driveId: string | undefined = item?.parentReference?.driveId;
  const folderId: string | undefined = item?.id;
  if (!driveId || !folderId) {
    throw new Error('iRam: resolved item missing driveId/folderId — is the URL really a folder?');
  }
  if (!item?.folder) {
    throw new Error('iRam: URL points to a file, not a folder. Paste the folder URL instead.');
  }
  return { driveId, folderId, webUrl: item.webUrl as string };
}

// ── File find / download / upload ────────────────────────────────────────────

export interface FoundFile {
  fileId: string;
  downloadUrl: string;
  eTag: string;
  webUrl: string;
}

/**
 * Locate a file by name inside a folder. Case-insensitive match.
 * Returns null when the folder exists but the file isn't found.
 */
export async function findFileInFolder(
  driveId: string,
  folderId: string,
  fileName: string
): Promise<FoundFile | null> {
  const token = await getToken();
  // Page through children — most folders are small but be safe.
  let url: string | null = `${GRAPH}/drives/${driveId}/items/${folderId}/children?$top=200&$select=id,name,eTag,webUrl,@microsoft.graph.downloadUrl`;
  const target = fileName.trim().toLowerCase();

  while (url) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`iRam: list children failed (${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    for (const child of data.value ?? []) {
      if ((child.name as string).trim().toLowerCase() === target) {
        return {
          fileId: child.id as string,
          downloadUrl: child['@microsoft.graph.downloadUrl'] as string,
          eTag: child.eTag as string,
          webUrl: child.webUrl as string,
        };
      }
    }
    url = (data['@odata.nextLink'] as string) ?? null;
  }
  return null;
}

/**
 * Get a fresh per-file download URL (ephemeral, ~1h validity) so we don't have
 * to re-list the parent folder on every refresh.
 */
export async function getFreshDownloadUrl(driveId: string, fileId: string): Promise<{ downloadUrl: string; eTag: string }> {
  const token = await getToken();
  // Do NOT use $select — the @microsoft.graph.downloadUrl annotation is
  // stripped when $select is present (Graph OData behaviour).
  const res = await fetch(
    `${GRAPH}/drives/${driveId}/items/${fileId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`iRam: get item failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const downloadUrl = data['@microsoft.graph.downloadUrl'];
  if (!downloadUrl) {
    throw new Error('iRam: Graph did not return a download URL — the file may be too large or locked');
  }
  return {
    downloadUrl: downloadUrl as string,
    eTag: data.eTag as string,
  };
}

export async function downloadFile(downloadUrl: string): Promise<Buffer> {
  if (!downloadUrl) throw new Error('iRam: download URL is empty');
  const res = await fetch(downloadUrl);
  if (!res.ok) {
    throw new Error(`iRam: download failed (${res.status}): ${await res.text()}`);
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

/**
 * Upload (PUT replace) the given buffer over an existing file. Honours an
 * optional If-Match eTag for optimistic concurrency. Up to 3 retries on 429.
 */
export async function uploadFile(
  driveId: string,
  fileId: string,
  buffer: Buffer,
  ifMatchETag?: string
): Promise<{ eTag: string; webUrl: string }> {
  const token = await getToken();
  const url = `${GRAPH}/drives/${driveId}/items/${fileId}/content`;

  for (let attempt = 0; attempt < 4; attempt++) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    if (ifMatchETag) headers['If-Match'] = ifMatchETag;

    const res = await fetch(url, {
      method: 'PUT',
      headers,
      body: new Uint8Array(buffer),
    });

    if (res.status === 429) {
      if (attempt === 3) {
        throw new Error('iRam: upload throttled after 3 retries');
      }
      const retryAfterSec = parseInt(res.headers.get('Retry-After') ?? '15', 10);
      await sleep(Math.min(retryAfterSec, 30) * 1000);
      continue;
    }
    if (res.status === 412) {
      throw new Error('iRam: upload conflict — the file in SharePoint changed since the last refresh');
    }
    if (!res.ok) {
      throw new Error(`iRam: upload failed (${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    return { eTag: data.eTag as string, webUrl: data.webUrl as string };
  }
  throw new Error('iRam: upload failed — max retries exceeded');
}
