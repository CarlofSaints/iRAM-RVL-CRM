/**
 * Parser for the supplier swap-out request spreadsheet.
 *
 * Real layout (Major Tech example):
 *   DATE | CHANNEL | STORE | REGION | PRODUCT | QUANTITY | (blank) | PICKING NUMBERS
 *
 * The sheet is written for human eyes, not machines:
 *   - DATE / CHANNEL / STORE / REGION appear only on the FIRST row of a store
 *     block and are blank on every continuation row — so we forward-fill them.
 *   - A completely blank row separates one block from the next — ignored.
 *   - The picking number may sit on only the first row of a block, on every row,
 *     or be replaced by a free-text note from the supplier
 *     (e.g. "please provide correct stock code") — captured as `pickingNote`.
 *   - There is NO site/store code, so every store needs mapping to a FLOW store
 *     by hand after the parse.
 *
 * One store block = one consignment = one picking number + N product lines.
 * Tolerant of column order and of a future SITE CODE column appearing.
 */

import * as XLSX from 'xlsx';
import type { SwapOutLine } from './swapOutData';

export interface ParsedSwapOut {
  /** Stable key for this consignment within the parse (client-side mapping ref). */
  key: string;
  pickingNumber: string; // '' when the supplier hasn't issued a valid one yet
  needsPickingNumber: boolean; // true if the picking cell was blank/placeholder text
  pickingNote?: string; // free text found in the picking column instead of a number
  requestDate?: string; // ISO yyyy-mm-dd
  channel?: string;
  storeName: string;
  storeCode?: string;
  region?: string;
  lines: SwapOutLine[];
  /** 1-based sheet row where this block starts — for "row 24" style feedback. */
  sheetRow: number;
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
    // Read the LOCAL parts: xlsx hands back a local-midnight Date, and
    // toISOString() would shift it back a day everywhere east of Greenwich.
    const p = (n: number) => String(n).padStart(2, '0');
    return `${cell.getFullYear()}-${p(cell.getMonth() + 1)}-${p(cell.getDate())}`;
  }
  if (typeof cell === 'number') {
    // Excel serial date → JS date (epoch 1899-12-30).
    const ms = Math.round((cell - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
  }
  const raw = norm(cell);
  // The sheet writes US-style m/d/yy ("6/9/26" = 9 June 2026, per the file name).
  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (us) {
    const [, a, b, y] = us;
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    const d = new Date(Date.UTC(year, Number(a) - 1, Number(b)));
    return isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
  }
  const d = new Date(raw);
  return isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

export function parseSwapOutWorkbook(buffer: Buffer): ParseResult {
  const warnings: string[] = [];
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { consignments: [], warnings: ['No sheet found in workbook.'] };

  // blankrows: true so sheet row numbers stay truthful in user feedback; the
  // separator rows are skipped explicitly below.
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: '',
    blankrows: true,
  });

  // Find the header row (the one containing a PICKING column), within first 10 rows.
  let headerRow = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    if ((rows[i] ?? []).some((c) => upper(c).startsWith('PICKING'))) {
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
    warnings.push('No SITE CODE column in this sheet — every store must be mapped by hand.');
  }

  const get = (row: unknown[], field: string): unknown =>
    colOf[field] === undefined ? '' : row[colOf[field]];

  // Forward-fill carry: the sheet only writes these on the first row of a block.
  let lastDate: string | undefined;
  let lastChannel: string | undefined;
  let lastRegion: string | undefined;

  const consignments: ParsedSwapOut[] = [];
  let current: ParsedSwapOut | null = null;
  let rawPickingForCurrent = '';
  let noteForCurrent = '';

  const finalize = (c: ParsedSwapOut | null) => {
    if (!c || c.lines.length === 0) return;
    const valid = PICKING_RE.test(rawPickingForCurrent);
    c.pickingNumber = valid ? rawPickingForCurrent : '';
    c.needsPickingNumber = !valid;
    if (noteForCurrent) c.pickingNote = noteForCurrent;
    consignments.push(c);
  };

  for (let i = headerRow + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    // Blank separator row between blocks — ignore entirely.
    if (row.every((cell) => norm(cell) === '')) continue;

    const store = norm(get(row, 'store'));
    const pickingCell = norm(get(row, 'picking'));

    // A non-empty STORE cell starts a new consignment block.
    if (store !== '' || current === null) {
      finalize(current);
      rawPickingForCurrent = '';
      noteForCurrent = '';

      // Forward-fill: this row's value if present, else carry the last one down.
      const date = toIsoDate(get(row, 'date')) ?? lastDate;
      const channel = norm(get(row, 'channel')) || lastChannel;
      const region = norm(get(row, 'region')) || lastRegion;
      lastDate = date;
      lastChannel = channel;
      lastRegion = region;

      current = {
        key: `r${i + 1}`,
        pickingNumber: '',
        needsPickingNumber: true,
        requestDate: date,
        channel: channel || undefined,
        storeName: store,
        storeCode: norm(get(row, 'storeCode')) || undefined,
        region: region || undefined,
        lines: [],
        sheetRow: i + 1,
      };
    }

    // Capture the picking number wherever it appears within the block. Anything
    // in that column that isn't a picking number is a supplier comment.
    if (pickingCell) {
      if (PICKING_RE.test(pickingCell)) rawPickingForCurrent = pickingCell;
      else noteForCurrent = pickingCell;
    }

    const product = norm(get(row, 'product'));
    if (!product) continue;
    current.lines.push({
      product,
      description: norm(get(row, 'description')) || undefined,
      quantity: Number(get(row, 'quantity')) || 0,
    });
  }
  finalize(current);

  const missing = consignments.filter((c) => c.needsPickingNumber);
  if (missing.length > 0) {
    warnings.push(
      `${missing.length} consignment(s) have no valid picking number yet — they import as "Requested" ` +
        `(sheet row ${missing.map((c) => c.sheetRow).join(', ')}).`
    );
  }
  for (const c of consignments) {
    if (c.pickingNote) {
      warnings.push(`Row ${c.sheetRow} (${c.storeName}): supplier note — "${c.pickingNote}".`);
    }
  }
  if (consignments.length === 0) warnings.push('No swap-out lines found in the sheet.');
  return { consignments, warnings };
}
