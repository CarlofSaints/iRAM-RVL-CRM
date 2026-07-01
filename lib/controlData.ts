import fs from 'fs';
import path from 'path';
import { put, get } from '@vercel/blob';
import { upperName } from './upperName';

export type ControlType = 'clients' | 'stores' | 'products' | 'reps' | 'warehouses' | 'channels' | 'sites';

function blobKey(type: ControlType): string {
  return `control/${type}.json`;
}

/**
 * Normalize store + vendor/client NAMES (and store codes) to uppercase on read
 * so they display consistently everywhere. Only touches store/vendor name
 * fields — never people names (managerName, contact names), products, or reps.
 */
function normalizeControl<T>(type: ControlType, items: T[]): T[] {
  if (type === 'stores') {
    for (const it of items as Array<Record<string, unknown>>) {
      if (typeof it.name === 'string') it.name = upperName(it.name);
      if (typeof it.siteCode === 'string') it.siteCode = upperName(it.siteCode);
    }
  } else if (type === 'clients') {
    for (const it of items as Array<Record<string, unknown>>) {
      if (typeof it.name === 'string') it.name = upperName(it.name);
    }
  }
  return items;
}

/**
 * Generic Blob-backed CRUD for all control/masterfile types.
 * NO module-level cache — multi-container serverless safety.
 */
export async function loadControl<T>(type: ControlType): Promise<T[]> {
  const key = blobKey(type);

  if (!process.env.VERCEL) {
    const localFile = path.join(process.cwd(), 'data', `${type}.json`);
    try {
      if (fs.existsSync(localFile)) {
        return normalizeControl(type, JSON.parse(fs.readFileSync(localFile, 'utf-8')) as T[]);
      }
    } catch { /* empty */ }
    return [];
  }

  try {
    const result = await get(key, { access: 'private', useCache: false });
    if (result && result.statusCode === 200) {
      const text = await new Response(result.stream).text();
      return normalizeControl(type, JSON.parse(text) as T[]);
    }
  } catch (err) {
    console.error(`[controlData] Blob read failed for ${key}:`, err instanceof Error ? err.message : err);
  }
  return [];
}

export async function saveControl<T>(type: ControlType, items: T[]): Promise<void> {
  const key = blobKey(type);
  const json = JSON.stringify(items, null, 2);

  try {
    await put(key, json, {
      access: 'private',
      contentType: 'application/json',
      allowOverwrite: true,
      addRandomSuffix: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to persist ${type} to Vercel Blob: ${msg}`);
  }

  // Local dev: also write to local file
  try {
    const localFile = path.join(process.cwd(), 'data', `${type}.json`);
    const dir = path.dirname(localFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(localFile, json);
  } catch {
    // Vercel read-only FS — expected
  }
}
