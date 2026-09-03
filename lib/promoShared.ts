/**
 * Pure, I/O-free helpers for the Promotional Material module.
 *
 * Split out of lib/promoData.ts so the client pages can import them: promoData
 * pulls in `fs` and `@vercel/blob`, which cannot go into a browser bundle. Keep
 * this file free of imports for the same reason.
 */

export type PromoLineSource = 'sku' | 'promo';
export type PromoKitStatus = 'home' | 'out';

export const PROMO_KIT_STATUS_LABELS: Record<PromoKitStatus, string> = {
  home: 'At Home',
  out: 'Out',
};

export const PROMO_KIT_STATUS_BADGE: Record<PromoKitStatus, string> = {
  home: 'bg-emerald-100 text-emerald-700',
  out: 'bg-amber-100 text-amber-700',
};

/** Total units in a kit — the sum of every line quantity, not the line count. */
export function kitUnits(kit: { lines: Array<{ quantity: number }> }): number {
  return kit.lines.reduce((t, l) => t + (Number(l.quantity) || 0), 0);
}

/** Normalise an article number the same way /api/clients/[id]/products does. */
export function normArticle(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, '').replace(/^0+/, '').toLowerCase();
}

/**
 * The key a kit line is deduplicated on. Two lines for the same item merge
 * their quantities rather than sitting side by side — otherwise "add this item
 * to 5 kits" run twice leaves doubles nobody can tell apart on the return
 * tick-list.
 */
export function lineKey(source: PromoLineSource, ref: string): string {
  return source === 'sku' ? `sku:${normArticle(ref)}` : `promo:${ref.trim().toLowerCase()}`;
}

/** dd/mm/yyyy hh:mm in SAST, or an em-dash-free placeholder when absent. */
export function fmtPromoDateTime(iso?: string | null): string {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return iso;
  }
}
