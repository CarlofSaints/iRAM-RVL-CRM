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
  quantity: number; // requested — what the store asked to be swapped out
  /** Good replacement stock booked OUT of the iRam warehouse against this line. */
  issuedQty?: number;
  /** Faulty stock booked back IN against the good stock that went out. */
  returnedQty?: number;
}

/**
 * A physical stock movement against a swap-out.
 *   'issue'  — good replacement stock booked OUT (warehouse → rep → store)
 *   'return' — faulty stock booked back IN, against the good stock issued
 * Movements are append-only; a mistake is corrected with a reversing movement
 * so the ledger always explains the running balance.
 */
export interface SwapOutMovement {
  id: string;
  type: 'issue' | 'return';
  product: string;
  quantity: number; // negative = a reversal of an earlier movement
  at: string; // ISO
  byUserId?: string;
  byName?: string;
  /** Rep/warehouse the stock moved to/from, captured at the time of the move. */
  repId?: string;
  repName?: string;
  warehouseId?: string;
  reference?: string; // e.g. Major Tech form number, waybill
  note?: string;
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
  /** Append-only good-out / faulty-in ledger. */
  movements?: SwapOutMovement[];
  signedForm?: SwapOutSignedForm;
  /** Free-text the supplier wrote in the picking column instead of a number. */
  pickingNote?: string;
  importBatchId?: string;
  sourceFileName?: string;
  /** Sheet store name before mapping — kept so re-imports stay traceable. */
  sheetStoreName?: string;
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

/** Good replacement units booked out across all lines. */
export function issuedCount(s: Pick<SwapOut, 'lines'>): number {
  return (s.lines || []).reduce((t, l) => t + (l.issuedQty || 0), 0);
}

/** Faulty units booked back in across all lines. */
export function returnedCount(s: Pick<SwapOut, 'lines'>): number {
  return (s.lines || []).reduce((t, l) => t + (l.returnedQty || 0), 0);
}

/**
 * Recompute per-line issued/returned totals from the movement ledger. The
 * ledger is the source of truth; the line totals are a cached rollup so grids
 * don't have to walk every movement.
 */
export function rollupMovements(lines: SwapOutLine[], movements: SwapOutMovement[]): SwapOutLine[] {
  const issued = new Map<string, number>();
  const returned = new Map<string, number>();
  for (const m of movements) {
    const key = m.product.trim().toUpperCase();
    const target = m.type === 'issue' ? issued : returned;
    target.set(key, (target.get(key) ?? 0) + m.quantity);
  }
  return lines.map((l) => {
    const key = l.product.trim().toUpperCase();
    return { ...l, issuedQty: issued.get(key) ?? 0, returnedQty: returned.get(key) ?? 0 };
  });
}

/**
 * Where a swap-out sits in the physical stock cycle, derived from the ledger.
 *   'none'      — nothing booked out yet
 *   'partial'   — some good stock out, not all
 *   'issued'    — all requested good stock booked out, no faulty back yet
 *   'part_back' — some faulty stock returned against it
 *   'complete'  — faulty returned for everything issued
 */
export type SwapStockPhase = 'none' | 'partial' | 'issued' | 'part_back' | 'complete';

export function stockPhase(s: Pick<SwapOut, 'lines'>): SwapStockPhase {
  const req = unitCount(s);
  const out = issuedCount(s);
  const back = returnedCount(s);
  if (out <= 0) return 'none';
  if (back <= 0) return out >= req ? 'issued' : 'partial';
  if (back >= out) return 'complete';
  return 'part_back';
}
