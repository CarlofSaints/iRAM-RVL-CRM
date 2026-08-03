/**
 * Delivery shortfall reasons.
 *
 * When a store on a multi-store delivery note is not physically handed over at
 * sign-off, WHY it is missing determines where the slip has to land — the two
 * cases are not interchangeable:
 *
 *   Boxes left at the warehouse  → the stock exists and is in the warehouse, so
 *                                  the slip goes back to `captured` and is
 *                                  simply released again.
 *   Never collected from store   → the stock was booked in, receipted and
 *                                  released ON PAPER but never physically
 *                                  existed. Sending it to `captured` would
 *                                  assert warehouse stock that isn't there, so
 *                                  it rolls all the way back to `sent` — an
 *                                  outstanding collection — and its box labels
 *                                  are unlinked because those boxes were never
 *                                  packed.
 *
 * PURE module — shared by the public delivery page and the confirmation API so
 * the two cannot disagree about what a reason means.
 */

export type ShortfallRollback = 'captured' | 'sent';

export interface ShortfallReasonDef {
  key: string;
  /** Shown in the picker, on the signed PDF and in the audit log. */
  label: string;
  /** Lifecycle status the slip is rolled back to. */
  rollbackTo: ShortfallRollback;
  /** One-liner shown under the option so the rep picks the right one. */
  hint: string;
  /** When true the rep must type a note as well. */
  requiresNote?: boolean;
}

export const SHORTFALL_REASONS: ShortfallReasonDef[] = [
  {
    key: 'left-at-warehouse',
    label: 'Boxes left at the warehouse',
    rollbackTo: 'captured',
    hint: 'The stock exists but did not go on the vehicle. It stays in the warehouse and is released again.',
  },
  {
    key: 'never-collected',
    label: 'Never collected from store',
    rollbackTo: 'sent',
    hint: 'The stock was never actually picked up from the store. The pick slip goes back to outstanding and its box labels are freed.',
  },
  {
    key: 'other',
    label: 'Other',
    rollbackTo: 'captured',
    hint: 'Anything else — please explain. Treated as stock retained in the warehouse.',
    requiresNote: true,
  },
];

export function shortfallReasonFor(key: string | undefined | null): ShortfallReasonDef | undefined {
  if (!key) return undefined;
  return SHORTFALL_REASONS.find(r => r.key === key);
}

/**
 * Resolve a submitted reason into { def, note, text }.
 *
 * Accepts the legacy shape (a plain free-text string) so an older client can
 * still confirm a delivery — that path is treated as "other" / stock retained.
 */
export function resolveShortfall(
  input: string | { reasonKey?: string; note?: string } | undefined,
): { def: ShortfallReasonDef; note: string; text: string } {
  const other = SHORTFALL_REASONS.find(r => r.key === 'other')!;

  if (typeof input === 'string') {
    const note = input.trim();
    return { def: other, note, text: note || 'No reason given' };
  }

  const note = (input?.note ?? '').trim();
  const def = shortfallReasonFor(input?.reasonKey) ?? other;
  const text = note ? `${def.label} — ${note}` : def.label;
  return { def, note, text };
}
