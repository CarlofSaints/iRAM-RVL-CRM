/**
 * Pick-slip stage reversal model.
 *
 * A super admin can roll a pick slip back to ANY earlier status to undo a
 * mistake (e.g. a GRN captured against the wrong store). This module is the
 * single source of truth for:
 *   - the linear lifecycle ordering,
 *   - which fields each stage writes (so a revert can clear them),
 *   - which earlier statuses are valid targets for a given slip,
 *   - whether the booking side-effect (sticker links) must be undone.
 *
 * PURE module — only `import type`, no runtime imports of server-only code, so
 * it is safe to import from both API routes and client components.
 */

import type { PickSlipRecord, PickSlipStatus } from './pickSlipData';

// ── Lifecycle ordering ───────────────────────────────────────────────────────
// Fractional indices let branch states (unsuccessful / failed-release) and the
// field-group boundaries sit cleanly between the main backbone stages.

const STATUS_STAGE: Record<PickSlipStatus, number> = {
  'generated': 0,
  'sent': 1,
  'unsuccessful': 1.5,
  'booked': 2,
  'captured': 3,
  'failed-release': 3.5,
  'in-transit': 4,
  'partial-release': 4,
  'delivered': 5,
};

export function stageIndexFor(status: string): number {
  return STATUS_STAGE[status as PickSlipStatus] ?? 0;
}

export const STATUS_LABELS: Record<string, string> = {
  'generated': 'Generated',
  'sent': 'Sent',
  'unsuccessful': 'Unsuccessful',
  'booked': 'Booked',
  'captured': 'Captured',
  'in-transit': 'In Transit',
  'failed-release': 'Failed Release',
  'partial-release': 'Partial Release',
  'delivered': 'Delivered',
};

// ── Field groups, keyed by the stage that WRITES them ────────────────────────
// `idx` is where the group sits on the timeline. A revert to `targetIdx` clears
// every group whose idx > targetIdx.

interface FieldGroup {
  idx: number;
  /** Human description shown in the confirm dialog. */
  label: string;
  /** Slip fields this stage sets — cleared (set to undefined) on revert. */
  fields: Array<keyof PickSlipRecord>;
}

const FIELD_GROUPS: FieldGroup[] = [
  {
    idx: 1,
    label: 'Sent-to-rep timestamp',
    fields: ['sentAt'],
  },
  {
    idx: 1.5,
    label: 'Unsuccessful flag & reason',
    fields: ['unsuccessfulReason', 'unsuccessfulAt', 'unsuccessfulBy', 'unsuccessfulByName'],
  },
  {
    idx: 2,
    label: 'Booking & box scan — stickers are unlinked from this slip',
    fields: [
      'bookedAt', 'bookedBy', 'bookedByName', 'bookedRepId', 'bookedRepName',
      'receiptBoxes', 'receiptTotalBoxes', 'nothingToReturn',
    ],
  },
  {
    idx: 3,
    label: 'GRN capture (quantities, value, store refs, GRN date) & unreturned-stock',
    fields: [
      'receiptQty', 'receiptValue', 'receiptUpliftedById', 'receiptUpliftedByName',
      'receiptStoreRef1', 'receiptStoreRef2', 'receiptStoreRef3', 'receiptStoreRef4',
      'receiptStoreRefs', 'receiptGrnDate', 'receiptedAt', 'receiptedBy', 'receiptedByName',
      'unreturnedStock', 'unreturnedCapturedAt', 'unreturnedCapturedBy', 'unreturnedCapturedByName',
      'unreturnedSkipped', 'unreturnedSkipReason', 'unreturnedSkipRepId', 'unreturnedSkipRepName',
    ],
  },
  {
    idx: 3.5,
    label: 'Release, delivery note & transit details',
    fields: [
      'releaseRepId', 'releaseRepName', 'releaseBoxes', 'releasedAt', 'releasedBy', 'releasedByName',
      'deliveryToken', 'deliveryNoteSpWebUrl', 'deliveryNoteSignedSpWebUrl', 'deliveryNoteGeneratedAt',
    ],
  },
  {
    idx: 4.5,
    label: 'Delivery confirmation & signature',
    fields: [
      'deliverySignature', 'deliverySignedByName', 'deliveredAt', 'deliveredByRepId', 'deliveredByRepName',
    ],
  },
];

// ── Valid revert targets ─────────────────────────────────────────────────────
// Only "clean" backbone statuses are offered as targets (never the branch
// states unsuccessful / failed-release / partial-release).

const TARGET_CANDIDATES: Array<{ status: PickSlipStatus; idx: number }> = [
  { status: 'generated', idx: 0 },
  { status: 'sent', idx: 1 },
  { status: 'booked', idx: 2 },
  { status: 'captured', idx: 3 },
  { status: 'in-transit', idx: 4 },
];

export interface RevertTarget {
  status: PickSlipStatus;
  label: string;
}

/**
 * Earlier statuses a slip can be rolled back to, newest-first
 * (closest rollback listed first). `sent` is only offered when the slip was
 * actually sent (some slips are booked straight from `generated`).
 */
export function validRevertTargets(slip: Pick<PickSlipRecord, 'status' | 'sentAt'>): RevertTarget[] {
  const currentIdx = stageIndexFor(slip.status);
  return TARGET_CANDIDATES
    .filter(c => c.idx < currentIdx)
    .filter(c => (c.status === 'sent' ? !!slip.sentAt : true))
    .sort((a, b) => b.idx - a.idx)
    .map(c => ({ status: c.status, label: STATUS_LABELS[c.status] ?? c.status }));
}

export function isValidRevertTarget(
  slip: Pick<PickSlipRecord, 'status' | 'sentAt'>,
  target: string,
): boolean {
  return validRevertTargets(slip).some(t => t.status === target);
}

/**
 * Human descriptions of every stage that will be undone when rolling back from
 * `currentStatus` to `targetStatus` (for the confirm dialog).
 */
export function clearedStageDescriptions(currentStatus: string, targetStatus: string): string[] {
  const currentIdx = stageIndexFor(currentStatus);
  const targetIdx = stageIndexFor(targetStatus);
  return FIELD_GROUPS
    .filter(g => g.idx > targetIdx && g.idx <= currentIdx)
    .sort((a, b) => b.idx - a.idx)
    .map(g => g.label);
}

/**
 * Build the patch that clears every field written after `targetStatus`.
 * Cleared fields are set to `undefined` — `JSON.stringify` drops them on save,
 * so they are gone on the next read.
 */
export function buildRevertPatch(targetStatus: string): Partial<PickSlipRecord> {
  const targetIdx = stageIndexFor(targetStatus);
  const patch: Record<string, undefined> = {};
  for (const group of FIELD_GROUPS) {
    if (group.idx > targetIdx) {
      for (const f of group.fields) patch[f as string] = undefined;
    }
  }
  patch.status = undefined; // overwritten by caller with the target status
  return { ...(patch as Partial<PickSlipRecord>), status: targetStatus as PickSlipStatus };
}

/** True when rolling back to `targetStatus` undoes the booking stage (stickers must be unlinked). */
export function revertUndoesBooking(targetStatus: string): boolean {
  return stageIndexFor(targetStatus) < 2;
}
