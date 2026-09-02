/**
 * Resolve a sticker barcode to the pick slips — and therefore the STORES —
 * that actually carry it.
 *
 * Deliberately sweeps the pick slips themselves rather than trusting the
 * sticker registry's `linkedPickSlipIds`. The registry is an index built from
 * the slips and it has been wrong twice:
 *   - the 7 Aug 2026 global sticker clear deleted 665 batches, so every slip
 *     older than that has boxes whose barcodes the registry has never heard of;
 *   - `replace-labels` UNLINKS a retired barcode, so the registry goes silent
 *     on exactly the number someone is standing in the warehouse holding.
 * A box's number lives on the slip's own box list. That is the answer to
 * "which store is this label on", and it is the only copy that survives.
 */

import { listLoads } from '@/lib/agedStockData';
import { listAllPickSlipRuns, type PickSlipRecord, type ReceiptBox } from '@/lib/pickSlipData';

/** Where on a slip the barcode turned up. */
export interface BarcodePlacement {
  /** Captured into the warehouse at receipt. */
  onReceipt: boolean;
  /** Left behind by a short release — still owed. */
  onOutstanding: boolean;
  /** On the delivery note currently out for signature. */
  onRelease: boolean;
  /** On a delivery note that has already been signed for. */
  onDelivered: boolean;
  /** This number was RETIRED on this slip — a Replace label swapped it out. */
  retired: boolean;
  /** The barcode that replaced it, when retired. */
  replacedBy?: string;
  /** When the box carrying this barcode was scanned in. */
  scannedAt?: string;
}

export interface StickerSlipRef extends BarcodePlacement {
  id: string;
  clientId: string;
  clientName: string;
  loadId: string;
  siteCode: string;
  siteName: string;
  warehouse: string;
  warehouseCode?: string;
  status: string;
  totalQty: number;
  totalVal: number;
  generatedAt: string;
  /** Boxes this slip can still put on a delivery note. */
  releasableBoxCount: number;
  /** Boxes captured at receipt. */
  receiptBoxCount: number;
  /** The registry also names this slip. */
  registryLinked: boolean;
  /** The label is still live on this slip — not retired, not already delivered. */
  live: boolean;
}

function match(box: ReceiptBox | undefined, barcode: string): boolean {
  return !!box && (box.stickerBarcode ?? '').toUpperCase().trim() === barcode;
}

function placementFor(slip: PickSlipRecord, barcode: string): BarcodePlacement | null {
  // An empty barcode is the "look these slip ids up by id" call — no box on any
  // slip should be reported as carrying it, not even one with a blank barcode.
  if (!barcode) return null;

  const receipt = (slip.receiptBoxes ?? []).find(b => match(b, barcode));
  const outstanding = (slip.outstandingBoxes ?? []).find(b => match(b, barcode));
  const release = (slip.releaseBoxes ?? []).find(b => match(b, barcode));

  // A slip normally has ONE delivery, and it stays in the top-level
  // `releaseBoxes` / `deliveredAt` fields — `deliveryHistory` only fills up when
  // a release went out short. So a box is delivered if it is in the history OR
  // it is on the current note of a slip that has since been signed for. Reading
  // only the history would call a June delivery "live on a delivery note".
  const signedOff = slip.status === 'delivered' || !!slip.deliveredAt;
  const deliveredNow = signedOff ? release : undefined;
  const delivered = (slip.deliveryHistory ?? [])
    .flatMap(h => h.releaseBoxes ?? [])
    .find(b => match(b, barcode)) ?? deliveredNow;

  // A Replace swapped this number out. The box is still here under a new
  // number, so the slip is still the right answer to "whose label is this" —
  // it just must not read as live.
  const retiredOn = [
    ...(slip.receiptBoxes ?? []),
    ...(slip.outstandingBoxes ?? []),
    ...(slip.releaseBoxes ?? []),
    ...(slip.deliveryHistory ?? []).flatMap(h => h.releaseBoxes ?? []),
  ].find(b => (b.replacedBarcode ?? '').toUpperCase().trim() === barcode);

  if (!receipt && !outstanding && !release && !delivered && !retiredOn) return null;

  return {
    onReceipt: !!receipt,
    onOutstanding: !!outstanding,
    // "On a delivery note" means one still out for signature.
    onRelease: !!release && !signedOff,
    onDelivered: !!delivered,
    retired: !receipt && !outstanding && !release && !delivered && !!retiredOn,
    replacedBy: retiredOn && !receipt && !outstanding && !release && !delivered
      ? retiredOn.stickerBarcode
      : undefined,
    scannedAt: (receipt ?? outstanding ?? release ?? delivered)?.scannedAt,
  };
}

/**
 * Every slip that names `barcode`, plus every slip the registry claims it is
 * linked to (even when that slip's box list no longer mentions it — a stale
 * link is itself worth showing).
 *
 * `clientIds` must already be narrowed to the caller's client scope.
 */
export async function resolveSlipsForBarcode(
  barcode: string,
  registryLinkedIds: string[],
  clientIds: string[],
): Promise<StickerSlipRef[]> {
  const wanted = barcode.toUpperCase().trim();
  const linked = new Set(registryLinkedIds);
  // Callers also use this to resolve bare slip ids (empty barcode, ids supplied).
  if (clientIds.length === 0 || (!wanted && linked.size === 0)) return [];

  const runs = await listAllPickSlipRuns(clientIds, listLoads);
  const out: StickerSlipRef[] = [];

  for (const run of runs) {
    for (const slip of run.slips) {
      const placement = placementFor(slip, wanted);
      const registryLinked = linked.has(slip.id);
      if (!placement && !registryLinked) continue;

      const releasable = slip.outstandingBoxes ?? slip.receiptBoxes ?? [];

      out.push({
        id: slip.id,
        clientId: slip.clientId,
        clientName: slip.clientName,
        loadId: slip.loadId,
        siteCode: slip.siteCode,
        siteName: slip.siteName,
        warehouse: slip.warehouse,
        warehouseCode: slip.warehouseCode,
        status: slip.status,
        totalQty: slip.totalQty,
        totalVal: slip.totalVal,
        generatedAt: slip.generatedAt,
        releasableBoxCount: releasable.length,
        receiptBoxCount: (slip.receiptBoxes ?? []).length,
        registryLinked,
        onReceipt: placement?.onReceipt ?? false,
        onOutstanding: placement?.onOutstanding ?? false,
        onRelease: placement?.onRelease ?? false,
        onDelivered: placement?.onDelivered ?? false,
        retired: placement?.retired ?? false,
        replacedBy: placement?.replacedBy,
        scannedAt: placement?.scannedAt,
        live: !!placement && !placement.retired && !placement.onDelivered,
      });
    }
  }

  // Live claims first — if two slips both think this label is theirs, that is
  // the thing the operator has to see, not a delivered slip from June.
  out.sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    return a.generatedAt < b.generatedAt ? 1 : -1;
  });
  return out;
}

/** More than one slip still claims this label — a scan cannot tell them apart. */
export function isContested(refs: StickerSlipRef[]): boolean {
  return refs.filter(r => r.live).length > 1;
}
