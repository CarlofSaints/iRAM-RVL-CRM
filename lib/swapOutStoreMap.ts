/**
 * Remembered store mappings for swap-out imports.
 *
 * The supplier sheet has no site codes — just loose store names like "Rivonia
 * New" or "Rossburgh Conv". The user maps each one to a FLOW store by hand on
 * first import; we remember that decision so the same sheet name auto-resolves
 * on every future import for that client.
 *
 * Stored as a single private blob `swapouts/store-aliases.json` (+ local file in
 * dev), mirroring the control-file pattern. No module-level cache.
 */

import fs from 'fs';
import path from 'path';
import { put, get } from '@vercel/blob';

export interface SwapOutStoreAlias {
  clientId: string;
  /** Sheet store name, uppercased + whitespace-collapsed. */
  sheetName: string;
  /** Sheet channel, uppercased ('' when the sheet had none). */
  channel: string;
  storeId: string;
  /** Denormalised for display in the Control Centre / debugging. */
  storeName?: string;
  updatedAt: string;
  updatedByName?: string;
}

const INDEX_KEY = 'swapouts/store-aliases.json';
const localPath = () => path.join(process.cwd(), 'data', 'swapout-store-aliases.json');

/** Canonical alias lookup key — same shape used on read and write. */
export function aliasKey(clientId: string, channel: string | undefined, sheetName: string): string {
  const ch = (channel ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  const nm = (sheetName ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  return `${clientId}|${ch}|${nm}`;
}

export async function loadStoreAliases(): Promise<SwapOutStoreAlias[]> {
  if (!process.env.VERCEL) {
    try {
      const f = localPath();
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8')) as SwapOutStoreAlias[];
    } catch { /* empty */ }
    return [];
  }
  try {
    const result = await get(INDEX_KEY, { access: 'private', useCache: false });
    if (result && result.statusCode === 200) {
      const text = await new Response(result.stream).text();
      return JSON.parse(text) as SwapOutStoreAlias[];
    }
  } catch (err) {
    console.error(
      `[swapOutStoreMap] Blob read failed for ${INDEX_KEY}:`,
      err instanceof Error ? err.message : err
    );
  }
  return [];
}

export async function saveStoreAliases(items: SwapOutStoreAlias[]): Promise<void> {
  const json = JSON.stringify(items, null, 2);
  try {
    await put(INDEX_KEY, json, {
      access: 'private',
      contentType: 'application/json',
      allowOverwrite: true,
      addRandomSuffix: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to persist swap-out store mappings: ${msg}`);
  }
  try {
    const f = localPath();
    const dir = path.dirname(f);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(f, json);
  } catch {
    // Vercel read-only FS — expected
  }
}

/** Build a key → storeId map for fast resolution during a parse. */
export function aliasIndex(aliases: SwapOutStoreAlias[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of aliases) {
    if (a.storeId) m.set(aliasKey(a.clientId, a.channel, a.sheetName), a.storeId);
  }
  return m;
}

/**
 * Upsert the mappings the user just confirmed. Later decisions win, so a store
 * that moves in FLOW is simply re-mapped on the next import.
 */
export async function rememberStoreAliases(
  entries: Array<{
    clientId: string;
    channel?: string;
    sheetName: string;
    storeId: string;
    storeName?: string;
  }>,
  updatedByName?: string
): Promise<void> {
  const usable = entries.filter((e) => e.storeId && e.sheetName);
  if (usable.length === 0) return;

  const all = await loadStoreAliases();
  const byKey = new Map(all.map((a) => [aliasKey(a.clientId, a.channel, a.sheetName), a]));
  const now = new Date().toISOString();

  for (const e of usable) {
    const channel = (e.channel ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
    const sheetName = e.sheetName.trim().toUpperCase().replace(/\s+/g, ' ');
    byKey.set(aliasKey(e.clientId, channel, sheetName), {
      clientId: e.clientId,
      sheetName,
      channel,
      storeId: e.storeId,
      storeName: e.storeName,
      updatedAt: now,
      updatedByName,
    });
  }

  await saveStoreAliases([...byKey.values()]);
}
