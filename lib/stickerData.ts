/**
 * Sticker batch persistence.
 *
 * Reps pick stock from warehouses and stick labels on boxes. Each sticker has
 * a unique barcode (Code128). At generation time the barcode is linked to
 * nothing — a future receipting UI will let users scan the barcode and link
 * it to a pick slip.
 *
 * Blob keys:
 *   stickers/batches/{batchId}.json   full StickerBatch
 *   stickers/index.json               StickerBatchMeta[] (newest first)
 *
 * No module-level cache — multi-container serverless safety.
 */

import fs from 'fs';
import path from 'path';
import { put, get } from '@vercel/blob';

// ── Types ────────────────────────────────────────────────────────────────────

export interface Sticker {
  id: string;
  barcodeValue: string;
  linkedPickSlipId?: string;
  linkedAt?: string;
}

export interface StickerBatch {
  id: string;
  warehouseCode: string;
  warehouseName: string;
  quantity: number;
  createdAt: string;
  createdBy: string;
  createdByName: string;
  stickers: Sticker[];
}

export interface StickerBatchMeta {
  id: string;
  warehouseCode: string;
  warehouseName: string;
  quantity: number;
  createdAt: string;
  createdByName: string;
}

// ── Blob/local helpers (mirrors agedStockData.ts pattern) ────────────────────

function batchKey(batchId: string): string {
  return `stickers/batches/${batchId}.json`;
}
function batchLocalPath(batchId: string): string {
  return path.join(process.cwd(), 'data', 'stickers', 'batches', `${batchId}.json`);
}
const INDEX_KEY = 'stickers/index.json';
const INDEX_LOCAL = path.join(process.cwd(), 'data', 'stickers', 'index.json');

async function blobReadJson<T>(key: string): Promise<T | null> {
  try {
    const result = await get(key, { access: 'private', useCache: false });
    if (result && result.statusCode === 200) {
      const text = await new Response(result.stream).text();
      return JSON.parse(text) as T;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/not.?found|404/i.test(msg)) {
      console.error(`[stickerData] Blob read failed for ${key}:`, msg);
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

// ── Public API ───────────────────────────────────────────────────────────────

export async function listBatches(): Promise<StickerBatchMeta[]> {
  if (process.env.VERCEL) {
    return (await blobReadJson<StickerBatchMeta[]>(INDEX_KEY)) ?? [];
  }
  return (await localReadJson<StickerBatchMeta[]>(INDEX_LOCAL)) ?? [];
}

async function saveIndex(items: StickerBatchMeta[]): Promise<void> {
  if (process.env.VERCEL) {
    await blobWriteJson(INDEX_KEY, items);
  } else {
    localWriteJson(INDEX_LOCAL, items);
  }
}

export async function getBatch(batchId: string): Promise<StickerBatch | null> {
  if (process.env.VERCEL) {
    return blobReadJson<StickerBatch>(batchKey(batchId));
  }
  return localReadJson<StickerBatch>(batchLocalPath(batchId));
}

export async function saveBatch(batch: StickerBatch): Promise<void> {
  // Write full batch first so the index never points at a missing blob
  if (process.env.VERCEL) {
    await blobWriteJson(batchKey(batch.id), batch);
  } else {
    localWriteJson(batchLocalPath(batch.id), batch);
  }

  const meta: StickerBatchMeta = {
    id: batch.id,
    warehouseCode: batch.warehouseCode,
    warehouseName: batch.warehouseName,
    quantity: batch.quantity,
    createdAt: batch.createdAt,
    createdByName: batch.createdByName,
  };

  const index = await listBatches();
  const idx = index.findIndex(b => b.id === batch.id);
  if (idx === -1) index.unshift(meta); // newest first
  else index[idx] = meta;

  // Sort newest first
  index.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  await saveIndex(index);
}

/**
 * Compute the next global sequence number for stickers in the given
 * warehouse+date combination. Reads the index, then loads each matching
 * batch to count total stickers already generated. Returns offset + 1
 * (i.e. the first available sequence number).
 */
export async function nextStickerSequence(
  warehouseCode: string,
  dateStr: string // YYYYMMDD
): Promise<number> {
  const index = await listBatches();

  // Filter batches for the same warehouse and date
  const matching = index.filter(b => {
    if (b.warehouseCode !== warehouseCode) return false;
    // Extract YYYYMMDD from createdAt (ISO)
    const batchDate = b.createdAt.slice(0, 10).replace(/-/g, '');
    return batchDate === dateStr;
  });

  // Sum quantities from matching batches
  let total = 0;
  for (const m of matching) {
    total += m.quantity;
  }

  return total + 1;
}
