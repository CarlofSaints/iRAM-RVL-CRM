/**
 * Swap-Out module data layer. Runs SEPARATE to aged stock.
 *
 * A swap-out is one store consignment identified by a supplier picking number
 * (e.g. J152606036891) — the barcode on the physical swap-out. It carries one
 * or more product lines (product + quantity) and moves through a chain of
 * custody: store request → picking# assigned → received at iRam WH → issued to
 * a rep → faulty returned to WH → returned to the client (supplier).
 *
 * Stored as a single private blob `swapouts/index.json` (+ local file in dev),
 * mirroring the control-file pattern. No module-level cache (serverless safety).
 */

import fs from 'fs';
import path from 'path';
import { put, get } from '@vercel/blob';
import { upperName } from './upperName';

export type SwapOutStatus =
  | 'requested'
  | 'picking_assigned'
  | 'received_wh'
  | 'issued_rep'
  | 'faulty_returned'
  | 'returned_client'
  | 'cancelled';

// Lifecycle order (cancelled is terminal/off-path).
export const SWAPOUT_STAGES: SwapOutStatus[] = [
  'requested',
  'picking_assigned',
  'received_wh',
  'issued_rep',
  'faulty_returned',
  'returned_client',
];

export const SWAPOUT_STATUS_LABELS: Record<SwapOutStatus, string> = {
  requested: 'Requested',
  picking_assigned: 'Picking # Assigned',
  received_wh: 'Received at WH',
  issued_rep: 'Issued to Rep',
  faulty_returned: 'Faulty Returned to WH',
  returned_client: 'Returned to Client',
  cancelled: 'Cancelled',
};

export interface SwapOutLine {
  product: string; // product code
  description?: string;
  quantity: number;
}

export interface SwapOutEvent {
  status: SwapOutStatus;
  at: string; // ISO
  byUserId?: string;
  byName?: string;
  note?: string;
  method?: 'scan' | 'manual' | 'import';
}

export interface SwapOutSignedForm {
  blobKey: string; // private blob key of the uploaded signed form
  fileName: string;
  contentType: string;
  uploadedAt: string;
  uploadedByName?: string;
  spWebUrl?: string; // SharePoint URL once pushed
  spUploadedAt?: string;
}

export interface SwapOut {
  id: string;
  clientId: string;
  pickingNumber: string; // J... barcode; '' until the supplier assigns it
  requestDate?: string; // ISO (from the sheet DATE column)
  channel?: string;
  storeName: string;
  storeId?: string; // mapped to an existing store when site code is available
  storeCode?: string;
  region?: string;
  lines: SwapOutLine[];
  status: SwapOutStatus;
  assignedRepId?: string;
  assignedRepName?: string;
  history: SwapOutEvent[];
  signedForm?: SwapOutSignedForm;
  importBatchId?: string;
  createdAt: string;
  updatedAt: string;
}

const INDEX_KEY = 'swapouts/index.json';
const localPath = () => path.join(process.cwd(), 'data', 'swapouts.json');

/** Uppercase store names/codes on read for consistent display everywhere. */
function normalizeSwapOuts(items: SwapOut[]): SwapOut[] {
  for (const s of items) {
    s.storeName = upperName(s.storeName);
    if (s.storeCode) s.storeCode = upperName(s.storeCode);
  }
  return items;
}

export async function listSwapOuts(): Promise<SwapOut[]> {
  if (!process.env.VERCEL) {
    try {
      const f = localPath();
      if (fs.existsSync(f)) return normalizeSwapOuts(JSON.parse(fs.readFileSync(f, 'utf-8')) as SwapOut[]);
    } catch { /* empty */ }
    return [];
  }
  try {
    const result = await get(INDEX_KEY, { access: 'private', useCache: false });
    if (result && result.statusCode === 200) {
      const text = await new Response(result.stream).text();
      return normalizeSwapOuts(JSON.parse(text) as SwapOut[]);
    }
  } catch (err) {
    console.error(`[swapOutData] Blob read failed for ${INDEX_KEY}:`, err instanceof Error ? err.message : err);
  }
  return [];
}

export async function saveSwapOuts(items: SwapOut[]): Promise<void> {
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
    throw new Error(`Failed to persist swap-outs: ${msg}`);
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

export async function getSwapOut(id: string): Promise<SwapOut | null> {
  const all = await listSwapOuts();
  return all.find((s) => s.id === id) ?? null;
}

/** Find by exact picking number (used by the scan flow). Case-insensitive. */
export async function findByPickingNumber(picking: string): Promise<SwapOut[]> {
  const target = picking.trim().toLowerCase();
  if (!target) return [];
  const all = await listSwapOuts();
  return all.filter((s) => (s.pickingNumber || '').trim().toLowerCase() === target);
}

export async function createSwapOuts(records: SwapOut[]): Promise<void> {
  const all = await listSwapOuts();
  all.push(...records);
  await saveSwapOuts(all);
}

export async function updateSwapOut(
  id: string,
  updates: Partial<Omit<SwapOut, 'id'>>
): Promise<SwapOut | null> {
  const all = await listSwapOuts();
  const idx = all.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  all[idx] = { ...all[idx], ...updates, updatedAt: new Date().toISOString() };
  await saveSwapOuts(all);
  return all[idx];
}

export async function deleteSwapOut(id: string): Promise<void> {
  const all = await listSwapOuts();
  await saveSwapOuts(all.filter((s) => s.id !== id));
}

/** Total physical units across a swap-out's lines. */
export function unitCount(s: Pick<SwapOut, 'lines'>): number {
  return (s.lines || []).reduce((t, l) => t + (l.quantity || 0), 0);
}
