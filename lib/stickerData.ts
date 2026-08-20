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
import { put, get, del } from '@vercel/blob';

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

/**
 * Barcode sequence high-water mark, per warehouse code.
 *
 * DELIBERATELY a separate blob from the batch index, and DELIBERATELY never
 * touched by `clearAllBatches`. The sequence used to be derived by summing the
 * quantities in `stickers/index.json`; on 7 Aug 2026 a targeted "clear one
 * aged-stock load" with the sticker cascade ticked deleted all 665 batches
 * globally, the derived sequence restarted at 0001, and every barcode minted
 * afterwards collided with a label already stuck to a box on the warehouse
 * floor (193 duplicated barcodes across GAU and WC before it was caught).
 *
 * A barcode is printed onto a physical box, so a number is spent forever the
 * moment it is issued. It can NEVER be reissued, no matter what is later
 * deleted from the database.
 */
const SEQ_KEY = 'stickers/sequence.json';
const SEQ_LOCAL = path.join(process.cwd(), 'data', 'stickers', 'sequence.json');

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

/** Highest barcode number ever ISSUED, keyed by warehouse code. Only goes up. */
export interface StickerSequenceState {
  [warehouseCode: string]: number;
}

async function loadSequenceState(): Promise<StickerSequenceState> {
  if (process.env.VERCEL) {
    return (await blobReadJson<StickerSequenceState>(SEQ_KEY)) ?? {};
  }
  return (await localReadJson<StickerSequenceState>(SEQ_LOCAL)) ?? {};
}

async function saveSequenceState(state: StickerSequenceState): Promise<void> {
  if (process.env.VERCEL) {
    await blobWriteJson(SEQ_KEY, state);
  } else {
    localWriteJson(SEQ_LOCAL, state);
  }
}

/**
 * Secondary floor: the highest number the surviving batch index can account
 * for. This is the OLD derivation, kept only so that if `stickers/sequence.json`
 * is ever lost the counter cannot fall below what the index still proves was
 * issued. It is a floor, never a source of truth — it can only raise the
 * number, never lower it.
 */
async function indexDerivedFloor(warehouseCode: string): Promise<number> {
  const index = await listBatches();
  let total = 0;
  for (const b of index) {
    if (b.warehouseCode === warehouseCode) total += b.quantity;
  }
  return total;
}

/** Read the current high-water mark for every warehouse. */
export async function getStickerSequenceState(): Promise<StickerSequenceState> {
  return loadSequenceState();
}

/**
 * Reserve `count` consecutive barcode numbers for a warehouse and return the
 * FIRST one. The high-water mark is advanced and persisted before the caller
 * mints anything, so two bookings running at the same time cannot be handed
 * the same block.
 *
 * Replaces the old `nextStickerSequence()`, which recomputed the next number
 * from the batch index every time and therefore restarted at 1 whenever the
 * index was cleared. See the SEQ_KEY comment above.
 */
export async function reserveStickerSequence(
  warehouseCode: string,
  count: number,
): Promise<number> {
  if (count < 1) throw new Error('reserveStickerSequence: count must be >= 1');

  const state = await loadSequenceState();
  const floor = await indexDerivedFloor(warehouseCode);
  const high = Math.max(state[warehouseCode] ?? 0, floor);

  state[warehouseCode] = high + count;
  await saveSequenceState(state);

  return high + 1;
}

/**
 * Raise a warehouse's high-water mark to at least `highest`. Never lowers it.
 * Used to re-seed the counter from barcodes that exist on pick slips but whose
 * sticker records were deleted — the only way to recover from a wipe, because
 * the labels themselves are out on the floor where the database cannot see them.
 *
 * Returns the mark after the call.
 */
export async function raiseStickerSequenceFloor(
  warehouseCode: string,
  highest: number,
): Promise<number> {
  const state = await loadSequenceState();
  const current = state[warehouseCode] ?? 0;
  if (highest <= current) return current;
  state[warehouseCode] = highest;
  await saveSequenceState(state);
  return highest;
}

/**
 * Resolve MANY barcodes to their linked pick slips in one pass over the batch
 * blobs. `findStickerByBarcode` re-reads every batch per call, which is fine
 * for a single scan but quadratic when checking a whole release.
 *
 * Barcodes the registry has never heard of are simply absent from the map —
 * callers must treat "absent" as legacy/unknown, not as wrong.
 */
export async function findSlipsForBarcodes(
  barcodes: string[],
): Promise<Map<string, string[]>> {
  const wanted = new Set(barcodes.filter(Boolean));
  const out = new Map<string, string[]>();
  if (wanted.size === 0) return out;

  const index = await listBatches();
  for (const meta of index) {
    const batch = await getBatch(meta.id);
    if (!batch) continue;
    for (const s of batch.stickers) {
      if (!wanted.has(s.barcodeValue)) continue;
      const ids = getLinkedIds(s);
      const existing = out.get(s.barcodeValue);
      if (existing) {
        for (const id of ids) if (!existing.includes(id)) existing.push(id);
      } else {
        out.set(s.barcodeValue, [...ids]);
      }
    }
  }
  return out;
}

/**
 * Delete only the stickers linked to the given pick slips, leaving every other
 * warehouse and client untouched. A sticker still linked to a slip OUTSIDE the
 * set is kept — one label can carry several slips.
 *
 * This is what the "also delete stickers" cascade on Clear Data uses. It used
 * to call `clearAllBatches()`, which wiped every warehouse regardless of how
 * narrow the clear was.
 */
export async function deleteStickersForSlips(
  slipIds: string[],
): Promise<{ batchesDeleted: number; stickersRemoved: number }> {
  const target = new Set(slipIds);
  if (target.size === 0) return { batchesDeleted: 0, stickersRemoved: 0 };

  const index = await listBatches();
  let batchesDeleted = 0;
  let stickersRemoved = 0;
  const survivingIndex: StickerBatchMeta[] = [];

  for (const meta of index) {
    const batch = await getBatch(meta.id);
    if (!batch) continue;

    const keep = batch.stickers.filter(s => {
      const ids = getLinkedIds(s);
      // Never delete a sticker that was never linked to anything — it is a
      // blank label that may already be printed and waiting to be scanned.
      if (ids.length === 0) return true;
      // Drop only when EVERY slip it points at is being cleared.
      return !ids.every(id => target.has(id));
    });

    if (keep.length === batch.stickers.length) {
      survivingIndex.push(meta);
      continue;
    }

    stickersRemoved += batch.stickers.length - keep.length;

    if (keep.length === 0) {
      if (process.env.VERCEL) {
        try { await del(batchKey(batch.id)); } catch { /* already gone */ }
      } else {
        try {
          const f = batchLocalPath(batch.id);
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch { /* empty */ }
      }
      batchesDeleted++;
      continue;
    }

    batch.stickers = keep;
    batch.quantity = keep.length;
    if (process.env.VERCEL) {
      await blobWriteJson(batchKey(batch.id), batch);
    } else {
      localWriteJson(batchLocalPath(batch.id), batch);
    }
    survivingIndex.push({ ...meta, quantity: keep.length });
  }

  await saveIndex(survivingIndex);
  return { batchesDeleted, stickersRemoved };
}

/**
 * Delete ALL sticker batches. Reads the index, deletes each batch blob,
 * resets the index to [].
 *
 * NOTE: this does NOT reset `stickers/sequence.json`, and must never be made
 * to. Deleting the records of a label does not peel it off the box.
 *
 * Returns count of batches deleted.
 */
export async function clearAllBatches(): Promise<number> {
  const index = await listBatches();
  let count = 0;
  for (const meta of index) {
    if (process.env.VERCEL) {
      try { await del(batchKey(meta.id)); count++; }
      catch { /* blob may already be gone */ }
    } else {
      try {
        const f = batchLocalPath(meta.id);
        if (fs.existsSync(f)) { fs.unlinkSync(f); count++; }
      } catch { /* empty */ }
    }
  }
  await saveIndex([]);
  return count;
}
