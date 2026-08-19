/**
 * Pick slip persistence.
 *
 * Each "run" corresponds to one load's pick slip generation. The run index
 * stores metadata about every PDF produced (one per store). Blob key:
 *   `pickSlips/{clientId}/{loadId}.json`
 *
 * No module-level cache — multi-container serverless safety.
 */

import fs from 'fs';
import path from 'path';
import { put, get, del, list } from '@vercel/blob';
import type { PickSlipPdfRow } from './pickSlipPdf';
import { upperName } from './upperName';

// ── Types ────────────────────────────────────────────────────────────────────

/** Per-product unreturned stock breakdown, captured after receipt */
export interface UnreturnedStockRow {
  articleCode: string;
  description: string;
  pickSlipQty: number;       // original qty from pick slip (read-only reference)
  display: number;           // qty left on display at store
  storeRefused: number;      // qty store refused to return
  notFound: number;          // qty not found at store
  damaged: number;           // qty damaged
  // collected = pickSlipQty - (display + storeRefused + notFound + damaged)
}

export interface ReceiptBox {
  id: string;
  stickerBarcode: string;
  scannedAt: string;
}

export type PickSlipStatus =
  | 'generated'
  | 'printed'
  | 'sent'
  | 'unsuccessful'
  | 'booked'
  | 'captured'
  | 'in-transit'
  | 'failed-release'
  | 'partial-release'
  | 'delivered';

/** Map legacy statuses to current values. */
export function normalizeStatus(s: string): PickSlipStatus {
  switch (s) {
    case 'receipted': return 'captured';
    case 'picked': return 'booked';
    case 'returned-to-vendor': return 'delivered';
    default: return s as PickSlipStatus;
  }
}

export interface PickSlipRecord {
  /** Unique pick slip ID, e.g. PS-9448-20260309-001 */
  id: string;
  loadId: string;
  clientId: string;
  vendorNumber: string;
  siteCode: string;
  siteName: string;
  warehouse: string;
  /** Canonical warehouse code resolved from control table at generation time */
  warehouseCode?: string;
  totalQty: number;
  totalVal: number;
  rowCount: number;
  /** PDF filename in SharePoint */
  fileName: string;
  /** Set after successful SP upload */
  spWebUrl?: string;
  generatedAt: string;
  /** Current workflow status */
  status: PickSlipStatus;
  /** Denormalized client name for listing */
  clientName: string;
  /** Line items for editing without re-reading the load */
  rows: PickSlipPdfRow[];
  /** True if this pick slip was generated via Manual Capture */
  manual?: boolean;
  /** Channel (e.g. "Dis-Chem", "Clicks") — set for manual pick slips */
  channel?: string;
  /** ISO timestamp — set after email send */
  sentAt?: string;
  /** Print fields — set when the slip is printed from the Picking Slips page.
   *  Printing is an alternative to emailing it to a rep: the paper slip goes out
   *  with the driver, so the slip counts as actioned for upliftment. Kept as
   *  their own fields (not derived from status) so the history survives the slip
   *  later moving to 'sent' and beyond. */
  printedAt?: string;
  printedBy?: string;
  printedByName?: string;
  /** How many times this slip has been printed (reprints included). */
  printCount?: number;
  /** Upliftment-failure fields — set when an admin marks a 'sent' slip 'unsuccessful' */
  unsuccessfulReason?: string;
  unsuccessfulAt?: string;
  unsuccessfulBy?: string;
  unsuccessfulByName?: string;
  /** ISO timestamp — set after edit */
  editedAt?: string;
  /** SP web URL of the edited PDF */
  spWebUrlEdited?: string;
  /** SP drive ID from upload response */
  spDriveId?: string;
  /** SP file ID from upload response */
  spFileId?: string;
  /** Receipt fields — populated during warehouse stock receipting */
  receiptQty?: string;
  receiptValue?: string;
  receiptTotalBoxes?: number;
  receiptUpliftedById?: string;
  receiptUpliftedByName?: string;
  receiptStoreRef1?: string;
  receiptStoreRef2?: string;
  receiptStoreRef3?: string;
  receiptStoreRef4?: string;
  receiptBoxes?: ReceiptBox[];
  receiptedAt?: string;
  receiptedBy?: string;
  receiptedByName?: string;
  /** Booking fields — populated when a rep books stock via the scan screen */
  bookedAt?: string;
  bookedBy?: string;
  bookedByName?: string;
  bookedRepId?: string;
  bookedRepName?: string;
  /** True when booked via "Nothing to Return" — no boxes, skips box capture */
  nothingToReturn?: boolean;
  /** Store references — replaces legacy receiptStoreRef1-4 */
  receiptStoreRefs?: string[];
  /** GRN/GRV date entered during receipt capture */
  receiptGrnDate?: string;
  /** GRN/GRV correction audit — set when the captured value/refs/date are corrected
   *  after the slip has moved past capture (via the "Correct GRN/GRV" admin action). */
  receiptValueCorrectedAt?: string;
  receiptValueCorrectedBy?: string;
  receiptValueCorrectedByName?: string;
  /** Release fields — populated during warehouse stock release */
  releaseRepId?: string;
  releaseRepName?: string;
  releaseBoxes?: ReceiptBox[];
  releasedAt?: string;
  releasedBy?: string;
  releasedByName?: string;
  /** Unreturned stock capture — populated after receipt */
  unreturnedStock?: UnreturnedStockRow[];
  unreturnedCapturedAt?: string;
  unreturnedCapturedBy?: string;
  unreturnedCapturedByName?: string;
  unreturnedSkipped?: boolean;
  unreturnedSkipReason?: string;
  unreturnedSkipRepId?: string;
  unreturnedSkipRepName?: string;
  /** Unique delivery token (UUID) — used in QR code URL */
  deliveryToken?: string;
  /** SP web URL of the delivery note PDF */
  deliveryNoteSpWebUrl?: string;
  /** SP web URL of the signed delivery note PDF */
  deliveryNoteSignedSpWebUrl?: string;
  /** ISO timestamp when delivery note was generated */
  deliveryNoteGeneratedAt?: string;
  /** ── Short-delivery audit ──────────────────────────────────────────────
   *  Set when this store was on a delivery note but its boxes were NOT
   *  physically handed over at sign-off (the vendor rep left it unticked).
   *  The slip is rolled back to `captured` so the stock is released again on
   *  its own delivery note, and these fields record why it fell off.
   *
   *  Deliberately NOT cleared by a later successful delivery or by a Reverse —
   *  they are the audit trail for a stock discrepancy, so they stay on the
   *  record. The full history is also in the audit log under
   *  `delivery_not_delivered`. */
  deliveryShortAt?: string;
  /** Reason the vendor rep gave for not accepting this store's stock. */
  deliveryShortReason?: string;
  /** Vendor rep who signed the delivery that excluded this store. */
  deliveryShortSignedByName?: string;
  /** Collecting rep on that delivery. */
  deliveryShortRepName?: string;
  /** The delivery token this store was dropped from — traces back to the
   *  signed delivery note that recorded the shortfall. */
  deliveryShortToken?: string;
  /** How many times this slip has been short-delivered. */
  deliveryShortCount?: number;
  /** Vendor signature — base64 PNG from canvas pad */
  deliverySignature?: string;
  /** Name of vendor rep who signed */
  deliverySignedByName?: string;
  /** ISO timestamp of delivery confirmation */
  deliveredAt?: string;
  /** ID of the rep who submitted the delivery confirmation */
  deliveredByRepId?: string;
  /** Name of the rep who submitted */
  deliveredByRepName?: string;
}

export interface PickSlipRunIndex {
  loadId: string;
  clientId: string;
  generatedAt: string;
  slips: PickSlipRecord[];
}

// ── Blob / local helpers ─────────────────────────────────────────────────────

function runKey(clientId: string, loadId: string): string {
  return `pickSlips/${clientId}/${loadId}.json`;
}

function runLocalPath(clientId: string, loadId: string): string {
  return path.join(process.cwd(), 'data', 'pickSlips', clientId, `${loadId}.json`);
}

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
      console.error(`[pickSlipData] Blob read failed for ${key}:`, msg);
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

// ── Manual index helpers ─────────────────────────────────────────────────────

function manualIndexKey(clientId: string): string {
  return `pickSlips/${clientId}/_manual-index.json`;
}

/** Read the list of manual loadIds for a client. */
export async function getManualIndex(clientId: string): Promise<string[]> {
  if (process.env.VERCEL) {
    return (await blobReadJson<string[]>(manualIndexKey(clientId))) ?? [];
  }
  try {
    const filePath = path.join(process.cwd(), 'data', 'pickSlips', clientId, '_manual-index.json');
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as string[];
    }
  } catch { /* empty */ }
  return [];
}

/** Append a manual loadId to the client's manual index. */
export async function addToManualIndex(clientId: string, loadId: string): Promise<void> {
  const ids = await getManualIndex(clientId);
  if (!ids.includes(loadId)) {
    ids.push(loadId);
  }
  if (process.env.VERCEL) {
    await blobWriteJson(manualIndexKey(clientId), ids);
  }
  try {
    const filePath = path.join(process.cwd(), 'data', 'pickSlips', clientId, '_manual-index.json');
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(ids, null, 2));
  } catch { /* Vercel read-only FS — expected */ }
}

// ── Public helpers ───────────────────────────────────────────────────────────

export async function getPickSlipRun(
  clientId: string,
  loadId: string
): Promise<PickSlipRunIndex | null> {
  let run: PickSlipRunIndex | null = null;
  if (process.env.VERCEL) {
    run = await blobReadJson<PickSlipRunIndex>(runKey(clientId, loadId));
  } else {
    try {
      const filePath = runLocalPath(clientId, loadId);
      if (fs.existsSync(filePath)) {
        run = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PickSlipRunIndex;
      }
    } catch { /* empty */ }
  }
  // Normalize legacy statuses + uppercase store/vendor names on read
  if (run) {
    for (const slip of run.slips) {
      slip.status = normalizeStatus(slip.status);
      slip.siteName = upperName(slip.siteName);
      slip.siteCode = upperName(slip.siteCode);
      slip.clientName = upperName(slip.clientName);
    }
  }
  return run;
}

export async function savePickSlipRun(run: PickSlipRunIndex): Promise<void> {
  if (process.env.VERCEL) {
    await blobWriteJson(runKey(run.clientId, run.loadId), run);
  }
  // Local dev fallback
  try {
    const filePath = runLocalPath(run.clientId, run.loadId);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(run, null, 2));
  } catch { /* Vercel read-only FS — expected */ }
}

/**
 * Compute the next sequence number for a vendor+date combo.
 * Scans ALL existing pick slip runs for the given client to find the max
 * sequence already used with that vendor number on that date.
 */
export function nextSequenceFromRuns(
  existingRuns: PickSlipRunIndex[],
  vendorNumber: string,
  dateStr: string // YYYYMMDD
): number {
  let max = 0;
  const prefix = `PS-${vendorNumber}-${dateStr}-`;
  for (const run of existingRuns) {
    for (const slip of run.slips) {
      if (slip.id.startsWith(prefix)) {
        const seqStr = slip.id.slice(prefix.length);
        const seq = parseInt(seqStr, 10);
        if (!isNaN(seq) && seq > max) max = seq;
      }
    }
  }
  return max + 1;
}

// ── List / update / remove helpers ──────────────────────────────────────────

/**
 * List all pick slip runs across the given client IDs.
 * Iterates each client's aged-stock load index AND manual index →
 * reads the run for each load.
 */
/** Read `items` through `fn`, at most `size` requests in flight at a time. */
async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

/**
 * Which `clientId/loadId` runs could possibly hold a slip generated on or after
 * `since`, from ONE cheap `list()` call instead of reading every run.
 *
 * Safe because generating a slip writes its run blob: a run whose blob was last
 * written before `since` cannot contain a slip generated after `since`. The
 * bound is conservative in the right direction — a run rewritten later for an
 * unrelated status change is still read, so nothing is ever missed.
 *
 * Returns null when the optimisation cannot be applied (local dev, or the list
 * call fails), meaning "no restriction — read them all".
 */
async function runsTouchedSince(since: string): Promise<Set<string> | null> {
  if (!process.env.VERCEL) return null;
  try {
    const keep = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: 'pickSlips/', cursor, limit: 1000 });
      for (const blob of page.blobs) {
        if (blob.pathname.endsWith('/_manual-index.json')) continue;
        const uploadedAt =
          blob.uploadedAt instanceof Date ? blob.uploadedAt.toISOString() : String(blob.uploadedAt ?? '');
        if (uploadedAt && uploadedAt < since) continue;
        const m = blob.pathname.match(/^pickSlips\/([^/]+)\/(.+)\.json$/);
        if (m) keep.add(`${m[1]}/${m[2]}`);
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return keep;
  } catch (err) {
    // Never fail the request over an optimisation — fall back to reading all.
    console.error('[pickSlipData] blob list failed, reading all runs:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function listAllPickSlipRuns(
  clientIds: string[],
  listLoadsFn: (clientId: string) => Promise<Array<{ id: string }>>,
  /**
   * Only read these load/run ids. Every run is a separate blob read, so
   * narrowing here is the difference between one read and several hundred —
   * this is the main cost of the pick-slip pages.
   */
  onlyLoadIds?: string[],
  /**
   * ISO date. Skip runs whose blob has not been written since then — they
   * cannot hold a slip generated inside the window. See runsTouchedSince.
   */
  generatedSince?: string
): Promise<PickSlipRunIndex[]> {
  const wanted = onlyLoadIds && onlyLoadIds.length ? new Set(onlyLoadIds) : null;
  const touched = generatedSince ? await runsTouchedSince(generatedSince) : null;
  const runs: PickSlipRunIndex[] = [];

  for (const clientId of clientIds) {
    const loads = await listLoadsFn(clientId);
    const manualIds = await getManualIndex(clientId);

    const ids = [...loads.map((l) => l.id), ...manualIds].filter(
      (id) =>
        (!wanted || wanted.has(id)) &&
        (!touched || touched.has(`${clientId}/${id}`))
    );

    // Blob reads are latency-bound, not CPU-bound; running them sequentially
    // was most of the wall-clock. Capped so a big client cannot open hundreds
    // of sockets at once.
    const fetched = await inBatches(ids, 12, (id) => getPickSlipRun(clientId, id));
    for (const run of fetched) {
      if (run && run.slips.length > 0) runs.push(run);
    }
  }
  return runs;
}

/**
 * Update a single slip within its run and persist.
 */
export async function updateSlipInRun(
  clientId: string,
  loadId: string,
  slipId: string,
  patch: Partial<PickSlipRecord>
): Promise<PickSlipRecord | null> {
  const run = await getPickSlipRun(clientId, loadId);
  if (!run) return null;
  const idx = run.slips.findIndex(s => s.id === slipId);
  if (idx === -1) return null;
  run.slips[idx] = { ...run.slips[idx], ...patch };
  await savePickSlipRun(run);
  return run.slips[idx];
}

/**
 * Remove a single slip from its run and persist.
 */
export async function removeSlipFromRun(
  clientId: string,
  loadId: string,
  slipId: string
): Promise<boolean> {
  const run = await getPickSlipRun(clientId, loadId);
  if (!run) return false;
  const before = run.slips.length;
  run.slips = run.slips.filter(s => s.id !== slipId);
  if (run.slips.length === before) return false;
  await savePickSlipRun(run);
  return true;
}

/**
 * Bulk remove slips across multiple runs.
 */
export async function bulkRemoveSlips(
  items: Array<{ clientId: string; loadId: string; slipId: string }>
): Promise<number> {
  // Group by clientId+loadId to minimize reads/writes
  const grouped = new Map<string, typeof items>();
  for (const item of items) {
    const key = `${item.clientId}|${item.loadId}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(item);
  }

  let deleted = 0;
  for (const [, group] of grouped) {
    const { clientId, loadId } = group[0];
    const run = await getPickSlipRun(clientId, loadId);
    if (!run) continue;
    const idsToRemove = new Set(group.map(g => g.slipId));
    const before = run.slips.length;
    run.slips = run.slips.filter(s => !idsToRemove.has(s.id));
    deleted += before - run.slips.length;
    await savePickSlipRun(run);
  }
  return deleted;
}

/**
 * Bulk patch slips across multiple runs.
 *
 * Grouped by run so each run blob is read once and written once — a per-slip
 * `updateSlipInRun` loop would re-read and re-write the same blob for every
 * slip in it, and each of those round trips is a window for a concurrent write
 * to be lost.
 *
 * `patchFor` receives the CURRENT stored slip and returns the patch to apply,
 * or `null` to leave that slip untouched — so status guards ("only advance a
 * 'generated' slip") are evaluated against the stored record, not a stale copy
 * the caller read earlier.
 *
 * Returns the ids that were actually patched.
 */
export async function bulkPatchSlips(
  items: Array<{ clientId: string; loadId: string; slipId: string }>,
  patchFor: (slip: PickSlipRecord) => Partial<PickSlipRecord> | null,
): Promise<string[]> {
  const grouped = new Map<string, typeof items>();
  for (const item of items) {
    const key = `${item.clientId}|${item.loadId}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(item);
  }

  const patched: string[] = [];
  for (const [, group] of grouped) {
    const { clientId, loadId } = group[0];
    const run = await getPickSlipRun(clientId, loadId);
    if (!run) continue;
    let dirty = false;
    for (const item of group) {
      const idx = run.slips.findIndex(s => s.id === item.slipId);
      if (idx === -1) continue;
      const patch = patchFor(run.slips[idx]);
      if (!patch) continue;
      run.slips[idx] = { ...run.slips[idx], ...patch };
      patched.push(item.slipId);
      dirty = true;
    }
    if (dirty) await savePickSlipRun(run);
  }
  return patched;
}

/**
 * Find a pick slip by its delivery token. Iterates all runs for all clients.
 * Called infrequently — only on QR scan.
 */
export async function findSlipByDeliveryToken(
  token: string,
  clientIds: string[],
  listLoadsFn: (clientId: string) => Promise<Array<{ id: string }>>
): Promise<{ slip: PickSlipRecord; clientId: string; loadId: string } | null> {
  for (const clientId of clientIds) {
    // Load-based runs
    const loads = await listLoadsFn(clientId);
    for (const load of loads) {
      const run = await getPickSlipRun(clientId, load.id);
      if (!run) continue;
      const slip = run.slips.find(s => s.deliveryToken === token);
      if (slip) return { slip, clientId, loadId: load.id };
    }
    // Manual runs
    const manualIds = await getManualIndex(clientId);
    for (const manualLoadId of manualIds) {
      const run = await getPickSlipRun(clientId, manualLoadId);
      if (!run) continue;
      const slip = run.slips.find(s => s.deliveryToken === token);
      if (slip) return { slip, clientId, loadId: manualLoadId };
    }
  }
  return null;
}

/**
 * Find ALL pick slips sharing a delivery token. Iterates all runs for all clients.
 * Used for multi-slip delivery notes where one token covers multiple slips.
 */
export async function findAllSlipsByDeliveryToken(
  token: string,
  clientIds: string[],
  listLoadsFn: (clientId: string) => Promise<Array<{ id: string }>>
): Promise<Array<{ slip: PickSlipRecord; clientId: string; loadId: string }>> {
  const results: Array<{ slip: PickSlipRecord; clientId: string; loadId: string }> = [];
  for (const clientId of clientIds) {
    // Load-based runs
    const loads = await listLoadsFn(clientId);
    for (const load of loads) {
      const run = await getPickSlipRun(clientId, load.id);
      if (!run) continue;
      for (const slip of run.slips) {
        if (slip.deliveryToken === token) {
          results.push({ slip, clientId, loadId: load.id });
        }
      }
    }
    // Manual runs
    const manualIds = await getManualIndex(clientId);
    for (const manualLoadId of manualIds) {
      const run = await getPickSlipRun(clientId, manualLoadId);
      if (!run) continue;
      for (const slip of run.slips) {
        if (slip.deliveryToken === token) {
          results.push({ slip, clientId, loadId: manualLoadId });
        }
      }
    }
  }
  return results;
}

/**
 * Delete a single pick slip run blob for a given client + loadId.
 */
export async function clearPickSlipRun(clientId: string, loadId: string): Promise<void> {
  if (process.env.VERCEL) {
    try { await del(runKey(clientId, loadId)); }
    catch { /* blob may already be gone */ }
  } else {
    try {
      const f = runLocalPath(clientId, loadId);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch { /* empty */ }
  }
}

/**
 * Clear the manual pick slip index for a client (reset to []).
 */
export async function clearManualIndex(clientId: string): Promise<void> {
  if (process.env.VERCEL) {
    try { await del(manualIndexKey(clientId)); }
    catch { /* blob may already be gone */ }
  } else {
    try {
      const f = path.join(process.cwd(), 'data', 'pickSlips', clientId, '_manual-index.json');
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch { /* empty */ }
  }
}

/**
 * Delete EVERY pick slip run across all clients — load-based, manual, AND
 * orphaned runs whose source load has already been deleted.
 *
 * The load-index–derived helpers (clearPickSlipRun keyed by loadId, the manual
 * index) cannot reach runs once their load is gone, which leaves stale slips on
 * the dashboard. This enumerates the `pickSlips/` blob prefix directly so it
 * sweeps everything regardless of any index. Returns count of run blobs deleted
 * (the per-client `_manual-index.json` markers are deleted but not counted).
 */
export async function clearAllPickSlipRuns(): Promise<number> {
  let count = 0;

  if (process.env.VERCEL) {
    let cursor: string | undefined;
    do {
      const result = await list({ prefix: 'pickSlips/', cursor, limit: 1000 });
      for (const blob of result.blobs) {
        const isManualIndex = blob.pathname.endsWith('/_manual-index.json');
        try {
          await del(blob.pathname);
          if (!isManualIndex) count++;
        } catch { /* blob may already be gone */ }
      }
      cursor = result.hasMore ? result.cursor : undefined;
    } while (cursor);
    return count;
  }

  // Local dev fallback — walk data/pickSlips/<client>/*.json
  try {
    const root = path.join(process.cwd(), 'data', 'pickSlips');
    if (fs.existsSync(root)) {
      for (const clientId of fs.readdirSync(root)) {
        const dir = path.join(root, clientId);
        if (!fs.statSync(dir).isDirectory()) continue;
        for (const file of fs.readdirSync(dir)) {
          if (!file.endsWith('.json')) continue;
          fs.unlinkSync(path.join(dir, file));
          if (file !== '_manual-index.json') count++;
        }
      }
    }
  } catch { /* empty */ }
  return count;
}
