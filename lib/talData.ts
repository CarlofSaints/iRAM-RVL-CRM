/**
 * Takealot (TAL) module data layer. Runs SEPARATE to aged stock and swap-outs.
 * Types and the scan rules live in lib/talShared.ts.
 *
 * Stored as a single private blob `tal/index.json` (+ local file in dev).
 * No module-level cache (serverless safety).
 *
 * Two rules keep the one shared index safe:
 *  - A failed read THROWS. Returning [] would let the next save overwrite every
 *    booking with just the new one.
 *  - Writes go through mutateTalBookings, which writes only if the blob is still
 *    the version that was read (ETag), and re-reads + re-checks if it is not,
 *    so two scanners saving at once can't undo each other (see claimSlipsInRun).
 */

import fs from 'fs';
import path from 'path';
import { put, get, BlobPreconditionFailedError } from '@vercel/blob';
import { normCode, type TalBooking } from './talShared';

const INDEX_KEY = 'tal/index.json';
const localPath = () => path.join(process.cwd(), 'data', 'tal.json');

async function readIndex(): Promise<{ items: TalBooking[]; etag?: string }> {
  if (!process.env.VERCEL) {
    const f = localPath();
    return { items: fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf-8')) as TalBooking[]) : [] };
  }
  const res = await get(INDEX_KEY, { access: 'private', useCache: false });
  if (!res) return { items: [] }; // never written yet
  if (res.statusCode !== 200) throw new Error(`TAL bookings read failed (HTTP ${res.statusCode})`);
  return {
    items: JSON.parse(await new Response(res.stream).text()) as TalBooking[],
    // A compressed blob comes back with a weak etag (W/"…") that If-Match never matches.
    etag: res.blob.etag?.replace(/^W\//, ''),
  };
}

export async function listTalBookings(): Promise<TalBooking[]> {
  return (await readIndex()).items;
}

/**
 * Read the bookings, let `fn` decide, and save `save` if it returns one. `fn`
 * may run more than once (after a clash), so it must not have side effects
 * beyond its return value.
 */
export async function mutateTalBookings<R>(
  fn: (all: TalBooking[]) => { save?: TalBooking[]; result: R },
): Promise<R> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { items, etag } = await readIndex();
    const { save, result } = fn(items);
    if (!save) return result;
    const json = JSON.stringify(save, null, 2);

    if (!process.env.VERCEL) {
      const f = localPath();
      if (!fs.existsSync(path.dirname(f))) fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, json);
      return result;
    }
    try {
      await put(INDEX_KEY, json, {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
        // First ever write: refuse if another request created it meanwhile.
        ...(etag ? { allowOverwrite: true, ifMatch: etag } : { allowOverwrite: false }),
      });
      return result;
    } catch (err) {
      const clash = err instanceof BlobPreconditionFailedError || (!etag && /exist/i.test(String(err)));
      if (!clash) throw new Error(`Failed to persist TAL bookings: ${err instanceof Error ? err.message : String(err)}`);
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
    }
  }
  throw new Error('Takealot bookings kept changing while saving — try again');
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
