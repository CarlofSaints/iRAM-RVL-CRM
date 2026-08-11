/**
 * Resolve the line items a pick slip PDF should be rendered from.
 *
 * Shared by every route that regenerates a slip PDF (email send, batch print) so
 * a printed slip and an emailed slip can never show different lines.
 */

import { getLoad } from '@/lib/agedStockData';
import type { PickSlipRecord } from '@/lib/pickSlipData';
import type { PickSlipPdfRow } from '@/lib/pickSlipPdf';

/**
 * Rows for a slip, backfilling from the load when the slip has none stored
 * (older slips predate `rows` being denormalized onto the record).
 *
 * Manual slips legitimately have no rows — that's a blank pick slip, and the
 * caller must not treat the empty array as a failure.
 */
export async function resolvePickSlipRows(slip: PickSlipRecord): Promise<PickSlipPdfRow[]> {
  if (slip.rows?.length) return slip.rows;
  if (slip.manual) return [];
  const load = await getLoad(slip.clientId, slip.loadId);
  if (!load) return [];
  return load.rows
    .filter(r => r.siteCode === slip.siteCode)
    .map(r => ({
      barcode: r.barcode,
      articleCode: r.articleCode,
      vendorProductCode: r.vendorProductCode,
      description: r.description,
      qty: r.qty,
      val: r.val,
    }))
    .filter(r => r.qty > 0 || r.val > 0);
}
