/**
 * Which boxes on a slip are still in the warehouse.
 *
 * A slip's releasable set is normally everything captured at receipt. It is
 * NOT that after a short release: the boxes that travelled are on a delivery
 * note awaiting signature, and only the ones left behind can be scanned out
 * next. `outstandingBoxes` records exactly those, so it wins whenever it is
 * present.
 *
 * Deliberately free of any persistence import so the scan screen and the
 * release/delivery routes can share one definition. A second copy of this rule
 * that disagreed with the server's would put stock on the wrong note.
 */

export interface BoxLike {
  id?: string;
  stickerBarcode: string;
  scannedAt?: string;
}

export interface SlipBoxesLike {
  receiptBoxes?: BoxLike[];
  outstandingBoxes?: BoxLike[];
}

/**
 * The boxes this slip can still put on a delivery note.
 *
 * An EMPTY `outstandingBoxes` is meaningful — it means a short release has
 * since been settled and nothing is owed — so only a missing one falls back to
 * the full receipt.
 */
export function releasableBoxes<T extends BoxLike>(
  slip: { receiptBoxes?: T[]; outstandingBoxes?: T[] },
): T[] {
  return slip.outstandingBoxes ?? slip.receiptBoxes ?? [];
}

/** How many boxes a delivery note for this slip should be asking for. */
export function releasableBoxCount(slip: SlipBoxesLike): number {
  return releasableBoxes(slip).length;
}

/** Barcodes of the boxes this slip can still release. */
export function releasableBarcodes(slip: SlipBoxesLike): string[] {
  return releasableBoxes(slip)
    .map(b => b.stickerBarcode)
    .filter((b): b is string => !!b);
}

/** True when a short release left boxes behind that are still owed. */
export function hasOutstandingBoxes(slip: SlipBoxesLike): boolean {
  return (slip.outstandingBoxes?.length ?? 0) > 0;
}

/**
 * What the delivery note for a slip's CURRENT release should say: how many
 * boxes went, out of how many that release was asked for.
 *
 * Read from a slip that has already been released, so the asked-for figure is
 * the boxes on the note plus the boxes left behind — not the full receipt. A
 * follow-up note carrying the one box that was owed reads "1 of 1", because
 * that release was complete in itself.
 */
export function noteBoxCounts(
  slip: { releaseBoxes?: BoxLike[]; outstandingBoxes?: BoxLike[] },
): { sent: number; asked: number } {
  const sent = slip.releaseBoxes?.length ?? 0;
  return { sent, asked: sent + (slip.outstandingBoxes?.length ?? 0) };
}
