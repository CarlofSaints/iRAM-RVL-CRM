// Dropbox Business API helper — same account/folders as ARIA Onboarding

const DROPBOX_APP_KEY = process.env.DROPBOX_APP_KEY!;
const DROPBOX_APP_SECRET = process.env.DROPBOX_APP_SECRET!;
const DROPBOX_REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN!;

export const DROPBOX_BASE_PATH =
  process.env.DROPBOX_BASE_PATH ??
  "/OuterJoin/Projects/Excel Add-Ins/Clients/iRam Internal/Live files/iRAM_ADDIN_APP_01/ssf/sf/SFS/2PBI_DB/Support Tables";

export const DROPBOX_TEMPLATE_FOLDER = `${DROPBOX_BASE_PATH}/0_MasterTemplates`;

/** Exchange refresh token for a short-lived access token */
export async function getDropboxToken(): Promise<string> {
  const res = await fetch("https://api.dropbox.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: DROPBOX_REFRESH_TOKEN,
      client_id: DROPBOX_APP_KEY,
      client_secret: DROPBOX_APP_SECRET,
    }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Dropbox token error: ${JSON.stringify(data)}`);
  }
  return data.access_token as string;
}

/**
 * Get the root namespace ID for a Dropbox Business account.
 * This is required so that API paths match the web UI paths.
 */
export async function getRootNamespaceId(token: string): Promise<string> {
  const res = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const data = await res.json();
  const nsId = data?.root_info?.root_namespace_id;
  if (!nsId) {
    throw new Error(
      `Could not resolve Dropbox root namespace. root_info: ${JSON.stringify(data?.root_info)}`
    );
  }
  return nsId as string;
}

/** Raw POST to a Dropbox API endpoint with root namespace header */
export async function dropbox(
  token: string,
  endpoint: string,
  body: Record<string, unknown>,
  rootNamespaceId?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (rootNamespaceId) {
    headers["Dropbox-API-Path-Root"] = JSON.stringify({
      ".tag": "root",
      root: rootNamespaceId,
    });
  }
  return fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** Typed JSON response from Dropbox API, throws on error */
export async function dropboxJson<T = unknown>(
  token: string,
  endpoint: string,
  body: Record<string, unknown>,
  rootNamespaceId?: string
): Promise<T> {
  const res = await dropbox(token, endpoint, body, rootNamespaceId);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Dropbox ${endpoint} → ${res.status}: ${text}`);
  }
  return text ? (JSON.parse(text) as T) : (null as T);
}
