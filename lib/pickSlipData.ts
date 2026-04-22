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
import { put, get } from '@vercel/blob';
import type { PickSlipPdfRow } from './pickSlipPdf';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReceiptBox {
  id: string;
  stickerBarcode: string;
  scannedAt: string;
}

export type PickSlipStatus =
  | 'generated'
  | 'sent'
  | 'picked'
  | 'receipted'
  | 'in-transit'
  | 'returned-to-vendor'
  | 'failed-release';

export interface PickSlipRecord {
  /** Unique pick slip ID, e.g. PS-9448-20260309-001 */
  id: string;
  loadId: string;
  clientId: string;
  vendorNumber: string;
  siteCode: string;
  siteName: string;
  warehouse: string;
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
  /** ISO timestamp — set after email send */
  sentAt?: string;
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
  /** Store references — replaces legacy receiptStoreRef1-4 */
  receiptStoreRefs?: string[];
  /** Release fields — populated during warehouse stock release */
  releaseRepId?: string;
  releaseRepName?: string;
  releaseBoxes?: ReceiptBox[];
  releasedAt?: string;
  releasedBy?: string;
  releasedByName?: string;
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

// ── Public helpers ───────────────────────────────────────────────────────────

export async function getPickSlipRun(
  clientId: string,
  loadId: string
): Promise<PickSlipRunIndex | null> {
  if (process.env.VERCEL) {
    return blobReadJson<PickSlipRunIndex>(runKey(clientId, loadId));
  }
  try {
    const filePath = runLocalPath(clientId, loadId);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PickSlipRunIndex;
    }
  } catch { /* empty */ }
  return null;
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
 * Iterates each client's aged-stock load index → reads the run for each load.
 */
export async function listAllPickSlipRuns(
  clientIds: string[],
  listLoadsFn: (clientId: string) => Promise<Array<{ id: string }>>
): Promise<PickSlipRunIndex[]> {
  const runs: PickSlipRunIndex[] = [];
  for (const clientId of clientIds) {
    const loads = await listLoadsFn(clientId);
    for (const load of loads) {
      const run = await getPickSlipRun(clientId, load.id);
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
