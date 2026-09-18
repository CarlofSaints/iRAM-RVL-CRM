/**
 * File name for a MULTI-store delivery note:
 *   `TOPLINE (BUILDERS) - 2026-09-16 - GAU - 0903.pdf`
 *   `TOPLINE (BUILDERS) - 2026-09-16 - GAU - 0903 - SIGNED.pdf`
 *
 * Until 18 Sep 2026 the name listed the last three digits of every pick slip
 * — `(073, 081, 079, …)` — and a 30-store note produced a name Windows and
 * Acrobat refused to open until it was renamed.
 *
 * The time is NOT decoration. SharePoint uploads replace a file of the same
 * name in the same date folder without a word, and supplier + date + warehouse
 * alone is not unique: two Topline releases from GAU on one day would leave
 * only the second delivery note. The slip numbers used to prevent that; the
 * release time (SAST) now does.
 *
 * Single-store notes keep `{store} {code} - DN-{slip}.pdf` — short already.
 */
export function multiStoreDnFileName(opts: {
  clientName: string;
  warehouse?: string;
  at: string; // ISO timestamp — release time, or sign-off time for the signed copy
  signed?: boolean;
}): string {
  const sast = new Date(new Date(opts.at).getTime() + 2 * 60 * 60 * 1000).toISOString();
  const date = sast.slice(0, 10);
  const time = sast.slice(11, 13) + sast.slice(14, 16);
  const parts = [opts.clientName.trim(), date];
  if (opts.warehouse?.trim()) parts.push(opts.warehouse.trim());
  parts.push(time);
  const name = parts.join(' - ') + (opts.signed ? ' - SIGNED' : '');
  // Characters SharePoint and Windows refuse in a file name.
  return name.replace(/[\\/:*?"<>|]/g, '-') + '.pdf';
}
