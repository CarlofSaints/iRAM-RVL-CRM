/**
 * Parser for the supplier swap-out request spreadsheet.
 *
 * Real layout (Major Tech example):
 *   DATE | CHANNEL | STORE | REGION | PRODUCT | QUANTITY | (blank) | PICKING NUMBERS
 * DATE/CHANNEL/STORE/REGION appear only on the first row of each picking-number
 * group and are blank on continuation rows, so we forward-fill them. One picking
 * number = one store consignment with multiple product lines.
 *
 * Tolerant of column order and of a future SITE CODE / STORE CODE column.
 */

import * as XLSX from 'xlsx';
import type { SwapOutLine } from './swapOutData';

export interface ParsedSwapOut {
  pickingNumber: string; // '' when the supplier hasn't issued a valid one yet
  needsPickingNumber: boolean; // true if the picking cell was blank/placeholder text
  requestDate?: string; // ISO yyyy-mm-dd
  channel?: string;
  storeName: string;
  storeCode?: string;
  region?: string;
  lines: SwapOutLine[];
}

// A valid supplier picking number is a letter followed by digits (J/C/D/P…).
const PICKING_RE = /^[A-Za-z]\d{5,}$/;

export interface ParseResult {
  consignments: ParsedSwapOut[];
  warnings: string[];
}

const norm = (v: unknown) => String(v ?? '').trim();
const upper = (v: unknown) => norm(v).toUpperCase();

// Map a header cell to a canonical field name.
function classify(header: string): string | null {
  const h = header.toUpperCase().replace(/\s+/g, ' ').trim();
  if (h === 'DATE') return 'date';
  if (h === 'CHANNEL') return 'channel';
  if (h === 'STORE' || h === 'STORE NAME') return 'store';
  if (h === 'SITE CODE' || h === 'STORE CODE' || h === 'SITE') return 'storeCode';
  if (h === 'REGION' || h === 'PROVINCE') return 'region';
  if (h === 'PRODUCT' || h === 'PRODUCT CODE' || h === 'SKU') return 'product';
  if (h === 'DESCRIPTION' || h === 'PRODUCT DESCRIPTION') return 'description';
  if (h === 'QUANTITY' || h === 'QTY') return 'quantity';
  if (h.startsWith('PICKING')) return 'picking';
  return null;
}

function toIsoDate(cell: unknown): string | undefined {
  if (cell === '' || cell === null || cell === undefined) return undefined;
  if (cell instanceof Date) {
    if (isNaN(cell.getTime())) return undefined;
    return cell.toISOString().slice(0, 10);
  }
  if (typeof cell === 'number') {
    // Excel serial date → JS date (epoch 1899-12-30).
    const ms = Math.round((cell - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
  }
  const d = new Date(norm(cell));
  return isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

export function parseSwapOutWorkbook(buffer: Buffer): ParseResult {
  const warnings: string[] = [];
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { consignments: [], warnings: ['No sheet found in workbook.'] };

  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: '',
    blankrows: false,
  });

  // Find the header row (the one containing a PICKING column), within first 10 rows.
  let headerRow = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    if (rows[i].some((c) => upper(c).startsWith('PICKING'))) {
      headerRow = i;
      break;
    }
  }
  if (headerRow === -1) {
    return { consignments: [], warnings: ['Could not find a header row with a PICKING column.'] };
  }

  // Build a field → column-index map.
  const colOf: Record<string, number> = {};
  rows[headerRow].forEach((cell, idx) => {
    const field = classify(norm(cell));
    if (field && colOf[field] === undefined) colOf[field] = idx;
  });

  if (colOf.picking === undefined || colOf.product === undefined) {
    return {
      consignments: [],
      warnings: ['Sheet is missing a PRODUCT or PICKING column.'],
    };
  }
  if (colOf.storeCode === undefined) {
    warnings.push('No SITE CODE column found — stores imported by name only (mapping pending).');
  }

  const get = (row: unknown[], field: string): unknown =>
    colOf[field] === undefined ? '' : row[colOf[field]];

  // Each store consignment is a block delimited by a non-empty STORE cell;
  // continuation rows (blank STORE) add more product lines to the current block.
  const consignments: ParsedSwapOut[] = [];
  let current: ParsedSwapOut | null = null;
  let rawPickingForCurrent = '';

  const finalize = (c: ParsedSwapOut | null) => {
    if (!c || c.lines.length === 0) return;
    const valid = PICKING_RE.test(rawPickingForCurrent);
    c.pickingNumber = valid ? rawPickingForCurrent : '';
    c.needsPickingNumber = !valid;
    consignments.push(c);
  };

  for (let i = headerRow + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((cell) => norm(cell) === '')) continue;

    const store = norm(get(row, 'store'));
    const picking = norm(get(row, 'picking'));

    // A non-empty STORE starts a new consignment block.
    if (store !== '' || current === null) {
      finalize(current);
      rawPickingForCurrent = '';
      current = {
        pickingNumber: '',
        needsPickingNumber: true,
        requestDate: toIsoDate(get(row, 'date')),
        channel: norm(get(row, 'channel')) || undefined,
        storeName: store || norm(get(row, 'store')),
        storeCode: norm(get(row, 'storeCode')) || undefined,
        region: norm(get(row, 'region')) || undefined,
        lines: [],
      };
    }
    // Capture the picking number wherever it appears within the block.
    if (picking) rawPickingForCurrent = picking;

    const product = norm(get(row, 'product'));
    if (!product) continue;
    current.lines.push({
      product,
      description: norm(get(row, 'description')) || undefined,
      quantity: Number(get(row, 'quantity')) || 0,
    });
  }
  finalize(current);

  const missing = consignments.filter((c) => c.needsPickingNumber).length;
  if (missing > 0) {
    warnings.push(
      `${missing} consignment(s) have no valid picking number yet — imported as "Requested".`
    );
  }
  if (consignments.length === 0) warnings.push('No swap-out lines found in the sheet.');
  return { consignments, warnings };
}
