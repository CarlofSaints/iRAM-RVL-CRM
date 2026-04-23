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
  /** @deprecated Use linkedPickSlipIds — kept for backward compat reading old data */
  linkedPickSlipId?: string;
  linkedAt?: string;
  /** Multi-slip link array — canonical field for linked pick slips */
  linkedPickSlipIds?: string[];
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
 * Get the canonical linked slip IDs array for a sticker, merging legacy
 * `linkedPickSlipId` with the new `linkedPickSlipIds` field.
 */
function getLinkedIds(sticker: Sticker): string[] {
  const ids = [...(sticker.linkedPickSlipIds ?? [])];
  if (sticker.linkedPickSlipId && !ids.includes(sticker.linkedPickSlipId)) {
    ids.unshift(sticker.linkedPickSlipId);
  }
  return ids;
}

/**
 * Find a sticker by barcode across all batches and link it to a pick slip.
 * Returns the found sticker (with link fields set) or null if not found.
 *
 * Multi-slip: if the sticker is already linked to OTHER slips, the new
 * slipId is ADDED to the array (not rejected). Only rejects if the same
 * slipId is already present (duplicate = no-op).
 */
export async function findAndLinkSticker(
  barcodeValue: string,
  pickSlipId: string,
): Promise<(Sticker & { batchId: string }) | null> {
  const index = await listBatches();
  for (const meta of index) {
    const batch = await getBatch(meta.id);
    if (!batch) continue;
    const sticker = batch.stickers.find(s => s.barcodeValue === barcodeValue);
    if (sticker) {
      const ids = getLinkedIds(sticker);
      // Already linked to this slip — no-op
      if (ids.includes(pickSlipId)) {
        // Ensure canonical fields are up to date
        sticker.linkedPickSlipIds = ids;
        sticker.linkedPickSlipId = ids[0];
        return { ...sticker, batchId: batch.id };
      }
      // Add this slip to the multi-link array
      ids.push(pickSlipId);
      sticker.linkedPickSlipIds = ids;
      sticker.linkedPickSlipId = ids[0]; // keep legacy field in sync
      sticker.linkedAt = new Date().toISOString();
      await saveBatch(batch);
      return { ...sticker, batchId: batch.id };
    }
  }
  return null;
}

/**
 * Unlink a sticker from ALL its pick slips by barcode. Clears both legacy
 * and multi-link fields. Returns true if found and unlinked.
 */
export async function unlinkSticker(barcodeValue: string): Promise<boolean> {
  const index = await listBatches();
  for (const meta of index) {
    const batch = await getBatch(meta.id);
    if (!batch) continue;
    const sticker = batch.stickers.find(s => s.barcodeValue === barcodeValue);
    if (sticker && (sticker.linkedPickSlipId || (sticker.linkedPickSlipIds?.length ?? 0) > 0)) {
      sticker.linkedPickSlipId = undefined;
      sticker.linkedPickSlipIds = undefined;
      sticker.linkedAt = undefined;
      await saveBatch(batch);
      return true;
    }
  }
  return false;
}

/**
 * Remove ONE pick slip from a sticker's linked list. If the sticker
 * has no remaining links, both fields are cleared entirely.
 * Returns true if found and modified.
 */
export async function unlinkStickerFromSlip(
  barcodeValue: string,
  pickSlipId: string,
): Promise<boolean> {
  const index = await listBatches();
  for (const meta of index) {
    const batch = await getBatch(meta.id);
    if (!batch) continue;
    const sticker = batch.stickers.find(s => s.barcodeValue === barcodeValue);
    if (sticker) {
      const ids = getLinkedIds(sticker);
      const idx = ids.indexOf(pickSlipId);
      if (idx === -1) return false;
      ids.splice(idx, 1);
      if (ids.length === 0) {
        sticker.linkedPickSlipId = undefined;
        sticker.linkedPickSlipIds = undefined;
        sticker.linkedAt = undefined;
      } else {
        sticker.linkedPickSlipIds = ids;
        sticker.linkedPickSlipId = ids[0];
      }
      await saveBatch(batch);
      return true;
    }
  }
  return false;
}

/**
 * Look up a sticker by barcode. Returns sticker info + batch context,
 * or null if not found. Includes `linkedPickSlipIds` (merged from legacy).
 */
export async function findStickerByBarcode(
  barcodeValue: string,
): Promise<(Sticker & { batchId: string; warehouseCode: string; warehouseName: string; linkedPickSlipIds: string[] }) | null> {
  const index = await listBatches();
  for (const meta of index) {
    const batch = await getBatch(meta.id);
    if (!batch) continue;
    const sticker = batch.stickers.find(s => s.barcodeValue === barcodeValue);
    if (sticker) {
      return {
        ...sticker,
        linkedPickSlipIds: getLinkedIds(sticker),
        batchId: batch.id,
        warehouseCode: batch.warehouseCode,
        warehouseName: batch.warehouseName,
      };
    }
  }
  return null;
}

/**
 * Compute the next global sequence number for stickers in the given
 * warehouse. Reads the index and sums all stickers ever generated for
 * that warehouse. Returns offset + 1 (i.e. the first available number).
 */
export async function nextStickerSequence(
  warehouseCode: string,
): Promise<number> {
  const index = await listBatches();

  let total = 0;
  for (const b of index) {
    if (b.warehouseCode === warehouseCode) {
      total += b.quantity;
    }
  }

  return total + 1;
}
