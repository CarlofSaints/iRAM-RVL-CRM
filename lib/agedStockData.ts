/**
 * Aged stock persistence.
 *
 * Two stages:
 *   1. A user uploads a file → parse it into a temporary DRAFT keyed by
 *      `agedStock/drafts/{userId}/{draftId}.json`. Drafts hold the raw parsed
 *      rows + all detected periods.
 *   2. The user picks which periods to sum → COMMIT. We aggregate qty+val,
 *      resolve barcodes from the client's product control files, and write:
 *         • `agedStock/{clientId}/loads/{loadId}.json`   full row payload
 *         • `agedStock/{clientId}/loads/index.json`      slim list of loads
 *      Then the draft is deleted.
 *
 * Loads are APPEND-ONLY. Same store+article from later uploads creates a
 * NEW row on the new load — the dashboard can filter by date/load or sum
 * across all of them.
 *
 * No module-level cache — multi-container serverless safety.
 */

import fs from 'fs';
import path from 'path';
import { put, get, del } from '@vercel/blob';
import type { AgedStockFormat, AgedStockPeriod, AgedStockRawRow } from './agedStockParser';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgedStockDraft {
  id: string;
  userId: string;
  clientId: string;
  clientName: string;
  vendorNumbers: string[];
  fileName: string;
  uploadedAt: string;
  format: AgedStockFormat;
  periods: AgedStockPeriod[];
  rows: AgedStockRawRow[];
}

/** Slim metadata kept in the per-client loads index. */
export interface AgedStockLoadMeta {
  id: string;
  clientId: string;
  clientName: string;
  vendorNumbers: string[];
  fileName: string;
  format: AgedStockFormat;
  periodsAll: AgedStockPeriod[];
  selectedPeriodKeys: string[];
  loadedAt: string;
  loadedBy: string;
  loadedByName: string;
  rowCount: number;
}

/** A single committed row. `qty` / `val` are sums across the selected periods. */
export interface AgedStockRow {
  id: string;
  loadId: string;
  clientId: string;
  siteCode: string;
  siteName: string;
  articleCode: string;
  description: string;
  barcode: string;
  vendorProductCode: string;
  qty: number;
  val: number;
}

export interface AgedStockLoadFull extends AgedStockLoadMeta {
  rows: AgedStockRow[];
}

// ── Blob/local helpers ───────────────────────────────────────────────────────

function draftKey(userId: string, draftId: string): string {
  return `agedStock/drafts/${userId}/${draftId}.json`;
}
function draftLocalPath(userId: string, draftId: string): string {
  return path.join(process.cwd(), 'data', 'agedStock', 'drafts', userId, `${draftId}.json`);
}
function loadKey(clientId: string, loadId: string): string {
  return `agedStock/${clientId}/loads/${loadId}.json`;
}
function loadLocalPath(clientId: string, loadId: string): string {
  return path.join(process.cwd(), 'data', 'agedStock', clientId, 'loads', `${loadId}.json`);
}
function indexKey(clientId: string): string {
  return `agedStock/${clientId}/loads/index.json`;
}
function indexLocalPath(clientId: string): string {
  return path.join(process.cwd(), 'data', 'agedStock', clientId, 'loads', 'index.json');
}

async function blobReadJson<T>(key: string): Promise<T | null> {
  try {
    const result = await get(key, { access: 'private', useCache: false });
    if (result && result.statusCode === 200) {
      const text = await new Response(result.stream).text();
      return JSON.parse(text) as T;
    }
  } catch (err) {
    // del() / get() both throw on 404 — treat as "no data"
    const msg = err instanceof Error ? err.message : String(err);
    if (!/not.?found|404/i.test(msg)) {
      console.error(`[agedStockData] Blob read failed for ${key}:`, msg);
    }
  }
  return null;
}

async function blobWriteJson(key: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  await put(key, json, {
    access: 'private',
    contentType: 'application/json',
    allowOverwrite: true,
    addRandomSuffix: false,
  });
}

async function localReadJson<T>(filePath: string): Promise<T | null> {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
    }
  } catch { /* empty */ }
  return null;
}

function localWriteJson(filePath: string, data: unknown): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch { /* Vercel read-only FS — expected */ }
}

// ── Drafts ───────────────────────────────────────────────────────────────────

export async function saveDraft(d: AgedStockDraft): Promise<void> {
  if (process.env.VERCEL) {
    await blobWriteJson(draftKey(d.userId, d.id), d);
  } else {
    localWriteJson(draftLocalPath(d.userId, d.id), d);
  }
}

export async function loadDraft(userId: string, draftId: string): Promise<AgedStockDraft | null> {
  if (process.env.VERCEL) {
    return blobReadJson<AgedStockDraft>(draftKey(userId, draftId));
  }
  return localReadJson<AgedStockDraft>(draftLocalPath(userId, draftId));
}

export async function deleteDraft(userId: string, draftId: string): Promise<void> {
  if (process.env.VERCEL) {
    try {
      await del(draftKey(userId, draftId));
    } catch (err) {
      console.error('[agedStockData] deleteDraft:', err instanceof Error ? err.message : err);
    }
  } else {
    try {
      const f = draftLocalPath(userId, draftId);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch { /* empty */ }
  }
}

// ── Loads (committed) ────────────────────────────────────────────────────────

export async function listLoads(clientId: string): Promise<AgedStockLoadMeta[]> {
  if (process.env.VERCEL) {
    return (await blobReadJson<AgedStockLoadMeta[]>(indexKey(clientId))) ?? [];
  }
  return (await localReadJson<AgedStockLoadMeta[]>(indexLocalPath(clientId))) ?? [];
}

async function saveIndex(clientId: string, items: AgedStockLoadMeta[]): Promise<void> {
  if (process.env.VERCEL) {
    await blobWriteJson(indexKey(clientId), items);
  } else {
    localWriteJson(indexLocalPath(clientId), items);
  }
}

export async function getLoad(clientId: string, loadId: string): Promise<AgedStockLoadFull | null> {
  if (process.env.VERCEL) {
    return blobReadJson<AgedStockLoadFull>(loadKey(clientId, loadId));
  }
  return localReadJson<AgedStockLoadFull>(loadLocalPath(clientId, loadId));
}

export async function saveLoad(full: AgedStockLoadFull): Promise<void> {
  // Write full load first so the index never points at a missing blob
  if (process.env.VERCEL) {
    await blobWriteJson(loadKey(full.clientId, full.id), full);
  } else {
    localWriteJson(loadLocalPath(full.clientId, full.id), full);
  }

  const meta: AgedStockLoadMeta = {
    id: full.id,
    clientId: full.clientId,
    clientName: full.clientName,
    vendorNumbers: full.vendorNumbers,
    fileName: full.fileName,
    format: full.format,
    periodsAll: full.periodsAll,
    selectedPeriodKeys: full.selectedPeriodKeys,
    loadedAt: full.loadedAt,
    loadedBy: full.loadedBy,
    loadedByName: full.loadedByName,
    rowCount: full.rowCount,
  };

  const index = await listLoads(full.clientId);
  const idx = index.findIndex(l => l.id === full.id);
  if (idx === -1) index.push(meta);
  else index[idx] = meta;

  // Newest first
  index.sort((a, b) => (a.loadedAt < b.loadedAt ? 1 : -1));
  await saveIndex(full.clientId, index);
}

export async function deleteLoad(clientId: string, loadId: string): Promise<void> {
  if (process.env.VERCEL) {
    try { await del(loadKey(clientId, loadId)); }
    catch (err) { console.error('[agedStockData] deleteLoad:', err instanceof Error ? err.message : err); }
  } else {
    try {
      const f = loadLocalPath(clientId, loadId);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch { /* empty */ }
  }

  const index = await listLoads(clientId);
  const next = index.filter(l => l.id !== loadId);
  if (next.length !== index.length) await saveIndex(clientId, next);
}
