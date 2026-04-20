/**
 * SharePoint links + per-link products storage helpers.
 *
 * - `sharepointLinks` lives on the client record itself (clients control file).
 * - Each link's product list is persisted under `products/{clientId}/{linkId}.json`
 *   in the same Vercel Blob private store as everything else.
 *
 * No module-level cache — multi-container serverless safety.
 */

import fs from 'fs';
import path from 'path';
import { put, get, del } from '@vercel/blob';
import { loadControl, saveControl } from './controlData';
import type { Product } from './productControlFile';

export interface SpLink {
  id: string;
  channel: string;
  vendorNumber: string;
  folderUrl: string;
  fileName: string;
  driveId?: string;
  fileId?: string;
  lastRefreshedAt?: string;
  lastRefreshError?: string;
  /** ISO of last successful upload back to SP — informational. */
  lastWriteAt?: string;
  /** SP folder URL where pick slip PDFs should be uploaded. */
  pickSlipFolderUrl?: string;
}

export interface ClientWithLinks {
  id: string;
  name: string;
  vendorNumbers: string[];
  type: 'ASL' | 'NSL';
  createdAt: string;
  sharepointLinks?: SpLink[];
}

// ── Client record helpers ────────────────────────────────────────────────────

export async function getClient(clientId: string): Promise<ClientWithLinks | null> {
  const items = await loadControl<ClientWithLinks>('clients');
  return items.find(c => c.id === clientId) ?? null;
}

export async function listSpLinks(clientId: string): Promise<SpLink[]> {
  const c = await getClient(clientId);
  return c?.sharepointLinks ?? [];
}

export async function getSpLink(clientId: string, linkId: string): Promise<SpLink | null> {
  const links = await listSpLinks(clientId);
  return links.find(l => l.id === linkId) ?? null;
}

async function mutateClient(clientId: string, mutator: (c: ClientWithLinks) => void): Promise<ClientWithLinks> {
  const items = await loadControl<ClientWithLinks>('clients');
  const idx = items.findIndex(c => c.id === clientId);
  if (idx === -1) throw new Error(`Client ${clientId} not found`);
  if (!items[idx].sharepointLinks) items[idx].sharepointLinks = [];
  mutator(items[idx]);
  await saveControl('clients', items);
  return items[idx];
}

export async function addSpLink(clientId: string, link: SpLink): Promise<SpLink> {
  await mutateClient(clientId, (c) => {
    c.sharepointLinks!.push(link);
  });
  return link;
}

export async function patchSpLink(
  clientId: string,
  linkId: string,
  patch: Partial<SpLink>
): Promise<SpLink> {
  let updated: SpLink | null = null;
  await mutateClient(clientId, (c) => {
    const idx = c.sharepointLinks!.findIndex(l => l.id === linkId);
    if (idx === -1) throw new Error(`Link ${linkId} not found on client ${clientId}`);
    c.sharepointLinks![idx] = { ...c.sharepointLinks![idx], ...patch };
    updated = c.sharepointLinks![idx];
  });
  if (!updated) throw new Error('Link patch produced no record');
  return updated;
}

export async function deleteSpLink(clientId: string, linkId: string): Promise<void> {
  await mutateClient(clientId, (c) => {
    c.sharepointLinks = (c.sharepointLinks ?? []).filter(l => l.id !== linkId);
  });
  // Best-effort: drop the products blob too
  try {
    await deleteProductsBlob(clientId, linkId);
  } catch (err) {
    console.error('[spLinkData] failed to delete products blob:', err instanceof Error ? err.message : err);
  }
}

// ── Per-link products blob ───────────────────────────────────────────────────

function productsKey(clientId: string, linkId: string): string {
  return `products/${clientId}/${linkId}.json`;
}

function localProductsPath(clientId: string, linkId: string): string {
  return path.join(process.cwd(), 'data', 'products', clientId, `${linkId}.json`);
}

export async function loadLinkProducts(clientId: string, linkId: string): Promise<Product[]> {
  if (!process.env.VERCEL) {
    const file = localProductsPath(clientId, linkId);
    try {
      if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, 'utf-8')) as Product[];
      }
    } catch { /* empty */ }
    return [];
  }

  try {
    const result = await get(productsKey(clientId, linkId), { access: 'private', useCache: false });
    if (result && result.statusCode === 200) {
      const text = await new Response(result.stream).text();
      return JSON.parse(text) as Product[];
    }
  } catch (err) {
    console.error(`[spLinkData] Blob read failed for ${productsKey(clientId, linkId)}:`,
      err instanceof Error ? err.message : err);
  }
  return [];
}

export async function saveLinkProducts(clientId: string, linkId: string, products: Product[]): Promise<void> {
  const json = JSON.stringify(products, null, 2);

  try {
    await put(productsKey(clientId, linkId), json, {
      access: 'private',
      contentType: 'application/json',
      allowOverwrite: true,
      addRandomSuffix: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to persist products for link ${linkId}: ${msg}`);
  }

  try {
    const file = localProductsPath(clientId, linkId);
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, json);
  } catch {
    // Vercel read-only FS — expected
  }
}

export async function deleteProductsBlob(clientId: string, linkId: string): Promise<void> {
  if (process.env.VERCEL) {
    try {
      await del(productsKey(clientId, linkId));
    } catch (err) {
      // del() throws if the key doesn't exist — swallow
      console.error('[spLinkData] del() returned:', err instanceof Error ? err.message : err);
    }
  } else {
    try {
      const file = localProductsPath(clientId, linkId);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch { /* empty */ }
  }
}
