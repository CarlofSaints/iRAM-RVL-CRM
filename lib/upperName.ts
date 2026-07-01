/**
 * Normalize a store or vendor/client name to UPPERCASE for display.
 *
 * The control files are captured in uppercase, but some data (pick-slip
 * captures, manual entries) arrives in proper/mixed case. Forcing store and
 * vendor names to a single case keeps the whole app consistent and prevents
 * the same store/vendor from fragmenting into duplicate rows in aggregations.
 *
 * Only apply this to STORE NAMES and VENDOR/CLIENT NAMES (and their codes) —
 * not to product descriptions, rep names, UI labels, or free-text notes.
 */
export function upperName(s: string | null | undefined): string {
  return (s ?? '').toUpperCase();
}
