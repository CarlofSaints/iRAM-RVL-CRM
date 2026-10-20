/**
 * Takealot (TAL) module data layer. Runs SEPARATE to aged stock and swap-outs.
 * Types and the scan rules live in lib/talShared.ts.
 *
 * Stored as a single private blob `tal/index.json` (+ local file in dev),
 * mirroring lib/swapOutData.ts. No module-level cache (serverless safety).
 */

import fs from 'fs';
import path from 'path';
import { put, get } from '@vercel/blob';
import { normCode, type TalBooking } from './talShared';

const INDEX_KEY = 'tal/index.json';
const localPath = () => path.join(process.cwd(), 'data', 'tal.json');

export async function listTalBookings(): Promise<TalBooking[]> {
  if (!process.env.VERCEL) {
    try {
      const f = localPath();
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8')) as TalBooking[];
    } catch { /* empty */ }
    return [];
  }
  try {
    const result = await get(INDEX_KEY, { access: 'private', useCache: false });
    if (result && result.statusCode === 200) {
      return JSON.parse(await new Response(result.stream).text()) as TalBooking[];
    }
  } catch (err) {
    console.error(`[talData] Blob read failed for ${INDEX_KEY}:`, err instanceof Error ? err.message : err);
  }
  return [];
}

export async function saveTalBookings(items: TalBooking[]): Promise<void> {
  const json = JSON.stringify(items, null, 2);
  // Off Vercel the local file IS the store (see saveSwapOuts).
  if (!process.env.VERCEL) {
    const f = localPath();
    if (!fs.existsSync(path.dirname(f))) fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, json);
    return;
  }
  try {
    await put(INDEX_KEY, json, {
      access: 'private',
      contentType: 'application/json',
      allowOverwrite: true,
      addRandomSuffix: false,
    });
  } catch (err) {
    throw new Error(`Failed to persist TAL bookings: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Find the booking a scanned code belongs to: a BRN, an Instruction Number or an RRN. */
export function findBookingByCode(all: TalBooking[], code: string): TalBooking | undefined {
  const c = normCode(code);
  if (!c) return undefined;
  return (
    all.find((b) => b.brn === c) ??
    all.find((b) => b.units.some((u) => u.rrn === c)) ??
    all.find((b) => b.instructions.some((i) => i.instructionNo === c))
  );
}
