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

// ── Types ────────────────────────────────────────────────────────────────────

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
