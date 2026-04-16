/**
 * Parse client aged-stock xlsx files.
 *
 * Auto-detects the layout from header cells — no user-facing "format" choice.
 * Currently recognises four common shapes we've seen in the wild:
 *
 *   1. Genkem-style (variant A) — fiscal-week banner in row 1, column headers
 *      in rows 2–3, data from row 4. Columns A–F: Dept code, Dept name, Site
 *      code, Site name, Article, Description (no header on description).
 *      Period blocks are Qty+Val pairs, extra % columns are skipped.
 *
 *   2. Genkem-style (variant B) — same shape, fewer trailing period columns.
 *      Parser emits the same schema — we just enumerate whatever periods the
 *      header row advertises.
 *
 *   3. SafeTop — "Fiscal Week / Year" in A2, "Barcode" in H2. Data from row 4.
 *      Barcode and vendor product code are in the file. Fewer period columns.
 *
 *   4. USABCO — simple single-row header. Data from row 2. One period only
 *      (13 to +24 Mnth). Article codes may be zero-padded to 18 chars; store
 *      name has a trailing `_<code>` suffix.
 *
 * Output is normalized across all shapes: one row per store+article, with
 * period values kept separate so the UI can let the user choose which to sum.
 */

import * as XLSX from 'xlsx';

export type AgedStockFormat = 'genkem' | 'safetop' | 'usabco' | 'unknown';

export interface AgedStockPeriod {
  /** Stable id used in the UI. Derived from the label, e.g. "10mnth". */
  key: string;
  /** Human-readable label shown in the UI, e.g. "10 Mnth". */
  label: string;
  /** 0-based column index for the Qty column. */
  qtyCol: number;
  /** 0-based column index for the Val column. */
  valCol: number;
}

export interface AgedStockRawRow {
  siteCode: string;
  siteName: string;
  articleCode: string;
  description: string;
  /** Non-empty only for formats that include barcode in the file (SafeTop). */
  barcode: string;
  /** Non-empty only for formats that include it in the file. */
  vendorProductCode: string;
  /** Keyed by AgedStockPeriod.key. */
  periods: Record<string, { qty: number; val: number }>;
}

export interface AgedStockParseResult {
  format: AgedStockFormat;
  sheetName: string;
  periods: AgedStockPeriod[];
  rows: AgedStockRawRow[];
  warnings: string[];
  errors: string[];
}

// ── Utilities ────────────────────────────────────────────────────────────────

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') {
    // Preserve large ints without scientific notation (barcodes)
    if (Number.isInteger(v) && Math.abs(v) > 1e10) return v.toFixed(0);
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

function cellNumber(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

function normalizeHeader(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Split a header like `13toPlus24MnthQty` into `13 to Plus 24 Mnth Qty` so we
 * can strip the suffix and build a readable label. Leaves already-spaced
 * strings alone.
 */
function splitCamelAndDigits(s: string): string {
  return s
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(s: string): string {
  return s
    .split(' ')
    .map(w => w.length ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)
    .join(' ');
}

/** Strip a known leading zero-padding (USABCO article codes). */
function stripZeroPrefix(s: string): string {
  // USABCO pads article codes to 18 chars with 12 leading zeros.
  if (/^0{10,}\d+$/.test(s)) return s.replace(/^0+/, '');
  return s;
}

/** `BEX Amanzimtoti_S66` → `BEX Amanzimtoti` when the trailing `_<code>` matches. */
function stripStoreCodeSuffix(storeName: string, storeCode: string): string {
  if (!storeCode) return storeName;
  const suffix = `_${storeCode}`;
  return storeName.endsWith(suffix) ? storeName.slice(0, -suffix.length).trim() : storeName;
}

/** Build a period key from a label by lowercasing + stripping non-alphanumerics. */
function periodKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '').trim() || 'unknown';
}

/**
 * Scan a header row for `xxx Qty` / `xxx Val` (or `Cost`) pairs. For each Qty
 * column, pair it with the immediately-following column and treat that as the
 * matching Val. Label falls back to the Val-column header if the Qty header
 * was corrupted/blank (Genkem files sometimes have this).
 *
 * Headers are first run through `splitCamelAndDigits` so USABCO-style
 * `13toPlus24MnthQty` becomes `13 to Plus 24 Mnth Qty` and the suffix regexes
 * work the same as for space-separated Genkem/SafeTop headers.
 */
function extractPeriodsFromHeaderRow(row: unknown[], startCol: number): AgedStockPeriod[] {
  const periods: AgedStockPeriod[] = [];
  const used = new Set<string>();
  for (let c = startCol; c < row.length; c++) {
    const raw = cellText(row[c]);
    if (!raw) continue;
    const normalized = normalizeHeader(splitCamelAndDigits(raw));
    // Treat "qty" at the end as the anchor (suffix match handles both
    // "Soh Qty" and camelCase like "13toPlus24MnthQty").
    if (!/qty\s*$/.test(normalized)) continue;

    // Next non-blank cell is the Val/Cost pair
    let valCol = c + 1;
    while (valCol < row.length && cellText(row[valCol]) === '') valCol++;
    if (valCol >= row.length) break;
    const valRaw = cellText(row[valCol]);
    const valNorm = normalizeHeader(splitCamelAndDigits(valRaw));
    if (!/(val|value|cost|zar)\s*$/.test(valNorm)) {
      // Not a matching pair — skip and keep scanning from next col
      continue;
    }

    // Prefer label from Qty header if it has words other than "qty"; else use Val header
    let label = normalized.replace(/qty\s*$/, '').replace(/\s+/g, ' ').trim();
    if (!label) {
      label = valNorm.replace(/(val|value|cost|zar)\s*$/, '').replace(/\s+/g, ' ').trim();
    }
    // Title-case for display niceness
    label = titleCase(label).replace(/\bMnth\b/gi, 'Mnth');

    if (!label) label = `Period ${periods.length + 1}`;

    // Ensure unique keys
    let key = periodKey(label);
    let suffix = 2;
    while (used.has(key)) { key = `${periodKey(label)}${suffix++}`; }
    used.add(key);

    periods.push({ key, label, qtyCol: c, valCol });
    c = valCol; // skip past the val column
  }
  return periods;
}

// ── Format detection ─────────────────────────────────────────────────────────

interface DetectedFormat {
  format: AgedStockFormat;
  /** 0-based row that contains the header row whose Qty/Val labels we parse. */
  periodHeaderRow: number;
  /** 0-based row where data rows begin. */
  firstDataRow: number;
  /** 0-based column where period Qty/Val pairs begin. */
  periodStartCol: number;
  /** Site code column (0-based). */
  siteCodeCol: number;
  siteNameCol: number;
  articleCol: number;
  descriptionCol: number;
  /** -1 when not present in the format. */
  barcodeCol: number;
  vendorProductCodeCol: number;
}

function detectFormat(rows: unknown[][]): DetectedFormat | null {
  const r0 = rows[0] ?? [];
  const r1 = rows[1] ?? [];
  const r2 = rows[2] ?? [];

  // USABCO — clean single-row header
  const r0Headers = r0.map(v => normalizeHeader(cellText(v)));
  if (
    r0Headers[0] === 'region' &&
    r0Headers[1] === 'store code' &&
    r0Headers[2] === 'store' &&
    r0Headers[3] === 'article code'
  ) {
    return {
      format: 'usabco',
      periodHeaderRow: 0,
      firstDataRow: 1,
      periodStartCol: 5,
      siteCodeCol: 1,
      siteNameCol: 2,
      articleCol: 3,
      descriptionCol: 4,
      barcodeCol: -1,
      vendorProductCodeCol: -1,
    };
  }

  // SafeTop — "Fiscal Week / Year" in A2, "Barcode" header in H2
  const r1Headers = r1.map(v => normalizeHeader(cellText(v)));
  if (
    r1Headers[0] === 'fiscal week / year' &&
    r1Headers.includes('barcode')
  ) {
    const barcodeCol = r1Headers.indexOf('barcode');
    // BMC code column is right after barcode. Description is immediately before barcode.
    return {
      format: 'safetop',
      periodHeaderRow: 0,                  // "10 Mnth Qty" etc. live in row 1
      firstDataRow: 3,                     // data starts at row 4 (index 3) — row 3 is a totals row
      periodStartCol: barcodeCol + 3,      // skip BMC code + BMC category after barcode
      siteCodeCol: 3,
      siteNameCol: 4,
      articleCol: 5,
      descriptionCol: 6,
      barcodeCol,
      vendorProductCodeCol: barcodeCol + 1, // "BMC" (Merch/Vendor code)
    };
  }

  // Genkem-style — row 3 has "Department" / "Site" / "Article" headers
  const r2Headers = r2.map(v => normalizeHeader(cellText(v)));
  if (
    r2Headers[0] === 'department' &&
    r2Headers[2] === 'site' &&
    r2Headers[4] === 'article'
  ) {
    return {
      format: 'genkem',
      periodHeaderRow: 1,     // row 2 holds the Qty/Val pair headers
      firstDataRow: 3,        // row 4 is "Overall Result" — will be skipped by row filter
      periodStartCol: 6,      // col G
      siteCodeCol: 2,
      siteNameCol: 3,
      articleCol: 4,
      descriptionCol: 5,
      barcodeCol: -1,
      vendorProductCodeCol: -1,
    };
  }

  return null;
}

// ── Main entry point ─────────────────────────────────────────────────────────

export function parseAgedStockFile(buffer: Buffer): AgedStockParseResult {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: true });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) {
    return {
      format: 'unknown', sheetName: '', periods: [], rows: [],
      warnings: [], errors: ['Workbook has no worksheets'],
    };
  }

  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1, raw: true, blankrows: false, defval: null,
  });

  const det = detectFormat(grid);
  if (!det) {
    return {
      format: 'unknown', sheetName, periods: [], rows: [],
      warnings: [],
      errors: [
        'Unrecognised aged stock list format. Expected one of: Genkem-style (fiscal-week banner), SafeTop-style (Barcode column), or USABCO-style (Region / Store Code / Article Code headers).',
      ],
    };
  }

  const warnings: string[] = [];
  const errors: string[] = [];

  const headerRow = grid[det.periodHeaderRow] ?? [];
  const periods = extractPeriodsFromHeaderRow(headerRow, det.periodStartCol);
  if (periods.length === 0) {
    errors.push('Could not identify any Qty/Val period columns in the header row.');
  }

  const rows: AgedStockRawRow[] = [];
  for (let r = det.firstDataRow; r < grid.length; r++) {
    const g = grid[r];
    if (!g || !g.length) continue;

    const siteCode = cellText(g[det.siteCodeCol]);
    const siteNameRaw = cellText(g[det.siteNameCol]);
    const articleRaw = cellText(g[det.articleCol]);
    const description = cellText(g[det.descriptionCol]);

    // Skip subtotal / summary rows — they don't have a real article code
    if (!articleRaw) continue;
    const articleLower = articleRaw.toLowerCase();
    if (articleLower === 'result' || articleLower === 'overall result') continue;
    if (cellText(g[0]).toLowerCase() === 'overall result') continue;
    // SafeTop uses col B = "Result" for rollups
    if (det.format === 'safetop' && cellText(g[1]).toLowerCase() === 'result') continue;
    // A real data row must have a site code too
    if (!siteCode) continue;

    const articleCode = stripZeroPrefix(articleRaw);
    const siteName = stripStoreCodeSuffix(siteNameRaw, siteCode);
    const barcode = det.barcodeCol >= 0 ? cellText(g[det.barcodeCol]) : '';
    const vendorProductCode = det.vendorProductCodeCol >= 0
      ? cellText(g[det.vendorProductCodeCol])
      : '';

    const periodValues: Record<string, { qty: number; val: number }> = {};
    for (const p of periods) {
      periodValues[p.key] = {
        qty: cellNumber(g[p.qtyCol]),
        val: cellNumber(g[p.valCol]),
      };
    }

    rows.push({
      siteCode, siteName, articleCode, description,
      barcode, vendorProductCode, periods: periodValues,
    });
  }

  if (rows.length === 0 && errors.length === 0) {
    warnings.push('No data rows found after filtering subtotals.');
  }

  return {
    format: det.format,
    sheetName,
    periods,
    rows,
    warnings,
    errors,
  };
}
