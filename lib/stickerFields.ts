/**
 * Rebuild the printed fields of a box label (store, vendor, reference, rep,
 * "box N of M") from the pick slip that carries it.
 *
 * Booking prints filled labels, but the fields are never stored — the sticker
 * register keeps only the barcode. Any later reprint has to read them back off
 * the slip, or it comes out as a blank template.
 *
 * The slip's own box list is the source of truth for "which slip is this label
 * on" (see stickerLookup.ts), so a barcode is matched against the boxes, not
 * the register's link.
 */

import { listLoads } from '@/lib/agedStockData';
import { listAllPickSlipRuns, type PickSlipRecord } from '@/lib/pickSlipData';
import type { StickerFieldData } from '@/lib/stickerPdf';

function norm(b: string | undefined): string {
  return (b ?? '').toUpperCase().trim();
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-ZA', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Africa/Johannesburg',
  });
}

/**
 * Fields for one barcode on one slip, or null when the slip does not carry it.
 * Box number is the label's position in the slip's captured boxes — the same
 * numbering booking and Replace label print.
 */
export function stickerFieldsForSlip(slip: PickSlipRecord, barcode: string): StickerFieldData | null {
  const wanted = norm(barcode);
  if (!wanted) return null;

  const receipt = slip.receiptBoxes ?? [];
  let idx = receipt.findIndex(b => norm(b.stickerBarcode) === wanted);
  let total = receipt.length;

  // A box that already went out on a delivery note may only be on the note.
  if (idx < 0) {
    const lists = [
      slip.outstandingBoxes ?? [],
      slip.releaseBoxes ?? [],
      ...(slip.deliveryHistory ?? []).map(h => h.releaseBoxes ?? []),
    ];
    if (!lists.some(l => l.some(b => norm(b.stickerBarcode) === wanted))) return null;
    idx = -1;
    total = 0;
  }

  return {
    siteCode: slip.siteCode,
    date: fmtDate(slip.bookedAt ?? slip.receiptedAt ?? slip.generatedAt),
    storeName: slip.siteName,
    referenceNumber: slip.id,
    vendorName: slip.clientName,
    vendorCode: slip.vendorNumber,
    repName: slip.bookedRepName || '',
    boxNumber: idx >= 0 ? idx + 1 : undefined,
    totalBoxes: idx >= 0 ? total : undefined,
  };
}

/**
 * Fields for every barcode that a live pick slip carries. Barcodes on no slip
 * (genuinely blank labels, never scanned) are simply absent from the map and
 * print as the blank template.
 *
 * `slipIdHints` (the register's links) narrow which clients are read: a slip id
 * is `PS-<vendor>-…`, so only clients holding that vendor number are swept.
 * With no hints there is nothing to look up and no blob is read.
 */
export async function stickerFieldsForBarcodes(
  barcodes: string[],
  slipIdHints: string[],
  clients: Array<{ id: string; vendorNumbers?: string[] }>,
): Promise<Map<string, StickerFieldData>> {
  const out = new Map<string, StickerFieldData>();
  const wanted = new Set(barcodes.map(norm).filter(Boolean));
  if (wanted.size === 0 || slipIdHints.length === 0) return out;

  const vendors = new Set(
    slipIdHints.map(id => id.match(/^PS-([^-]+)-/)?.[1]).filter((v): v is string => !!v),
  );
  const clientIds = clients
    .filter(c => (c.vendorNumbers ?? []).some(v => vendors.has(String(v).trim())))
    .map(c => c.id);
  if (clientIds.length === 0) return out;

  const hinted = new Set(slipIdHints);
  const runs = await listAllPickSlipRuns(clientIds, listLoads);

  // Hinted slips first, so a label two slips claim prints the register's owner.
  const slips = runs.flatMap(r => r.slips)
    .sort((a, b) => Number(hinted.has(b.id)) - Number(hinted.has(a.id)));

  for (const slip of slips) {
    for (const bc of wanted) {
      if (out.has(bc)) continue;
      const fields = stickerFieldsForSlip(slip, bc);
      if (fields) out.set(bc, fields);
    }
    if (out.size === wanted.size) break;
  }
  return out;
}
