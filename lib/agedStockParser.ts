/**
 * Parse client aged-stock xlsx files.
 *
 * Auto-detects the layout from header cells — no user-facing "format" choice.
 * Currently recognises six common shapes:
 *
 *   1. Genkem-style — fiscal-week banner in row 1, "Department" / "Site" /
 *      "Article" in row 3. Qty+Val pairs, % columns skipped. Two sub-variants
 *      (A and B) differ only in the number of period columns.
 *
 *   2. SafeTop — "Fiscal Week / Year" + "Barcode" in the same row (R2 or R3).
 *      Barcode and vendor product code (BMC) are in the file.
 *
 *   3. USABCO flat — single-row header: Region | Store Code | Store | Article
 *      Code. One period only. Zero-padded article codes, `_Sxx` store suffix.
 *
 *   4. BW Site-Article — SAP BW export with "Site" at col A, "Article" at col C.
 *      Two sub-variants: with Barcode/BMC columns (Topline, Usabco HS) or
 *      without (STA007-style). Dynamically detects period Qty/Val pairs.
 *
 * Multi-sheet workbooks: parser prefers "Site Article" sheet, skips hidden
 * SAP sheets (`_com.sap.*`), and tries each sheet until detection succeeds.
 *
 * Output is normalized across all shapes: one row per store+article, with
 * period values kept separate so the UI can let the user choose which to sum.
 */

import * as XLSX from 'xlsx';

export type AgedStockFormat = 'genkem' | 'safetop' | 'usabco' | 'bw-site' | 'unknown';

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
  // Normalize headers from the first few rows for flexible pattern matching.
  // Scanning dynamically handles SAP BW files where blank/hidden rows may
  // shift the header row position depending on export options.
  const hRows: string[][] = [];
  for (let i = 0; i < Math.min(6, rows.length); i++) {
    hRows.push((rows[i] ?? []).map(v => normalizeHeader(cellText(v))));
  }

  // ── USABCO flat — always row 1: Region | Store Code | Store | Article Code
  if (
    hRows[0]?.[0] === 'region' &&
    hRows[0]?.[1] === 'store code' &&
    hRows[0]?.[2] === 'store' &&
    hRows[0]?.[3] === 'article code'
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

  // ── SafeTop — row with "Fiscal Week / Year" at A and "Barcode" somewhere.
  //    Original: headers on R2 (index 1). Variant: headers on R3 (index 2).
  //    Period Qty/Val headers are always one row above the column-name row.
  for (let i = 0; i < hRows.length; i++) {
    if (
      hRows[i]?.[0] === 'fiscal week / year' &&
      hRows[i]?.includes('barcode')
    ) {
      const barcodeCol = hRows[i].indexOf('barcode');
      return {
        format: 'safetop',
        periodHeaderRow: Math.max(0, i - 1),
        firstDataRow: i + 1,               // skip column-name row; subtotal rows filtered in main loop
        periodStartCol: barcodeCol + 3,     // skip Barcode, BMC, BMC category
        siteCodeCol: 3,
        siteNameCol: 4,
        articleCol: 5,
        descriptionCol: 6,
        barcodeCol,
        vendorProductCodeCol: barcodeCol + 1,
      };
    }
  }

  // ── Genkem — row with "Department" at A, "Site" at C, "Article" at E
  for (let i = 0; i < hRows.length; i++) {
    if (
      hRows[i]?.[0] === 'department' &&
      hRows[i]?.[2] === 'site' &&
      hRows[i]?.[4] === 'article'
    ) {
      return {
        format: 'genkem',
        periodHeaderRow: Math.max(0, i - 1),
        firstDataRow: i + 1,
        periodStartCol: 6,
        siteCodeCol: 2,
        siteNameCol: 3,
        articleCol: 4,
        descriptionCol: 5,
        barcodeCol: -1,
        vendorProductCodeCol: -1,
      };
    }
  }

  // ── BW Site-Article — row with "Site" at A, "Article" at C.
  //    Two variants: with Barcode/BMC columns (cols E-G) or without.
  //    Covers: STA007-style, Topline "Site Article", Usabco Home Storage BW.
  for (let i = 0; i < hRows.length; i++) {
    if (hRows[i]?.[0] === 'site' && hRows[i]?.[2] === 'article') {
      const hasBarcode = hRows[i].includes('barcode');
      if (hasBarcode) {
        const barcodeCol = hRows[i].indexOf('barcode');
        return {
          format: 'bw-site',
          periodHeaderRow: Math.max(0, i - 1),
          firstDataRow: i + 1,
          periodStartCol: barcodeCol + 3,   // skip Barcode, BMC, BMC desc
          siteCodeCol: 0,
          siteNameCol: 1,
          articleCol: 2,
          descriptionCol: 3,
          barcodeCol,
          vendorProductCodeCol: barcodeCol + 1,
        };
      }
      return {
        format: 'bw-site',
        periodHeaderRow: Math.max(0, i - 1),
        firstDataRow: i + 1,
        periodStartCol: 4,
        siteCodeCol: 0,
        siteNameCol: 1,
        articleCol: 2,
        descriptionCol: 3,
        barcodeCol: -1,
        vendorProductCodeCol: -1,
      };
    }
  }

  return null;
}

// ── Main entry point ─────────────────────────────────────────────────────────

export function parseAgedStockFile(buffer: Buffer): AgedStockParseResult {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: true });

  // Build ordered list of sheets to try:
  //   1. "Site Article" (if present — Topline files have summary sheets first)
  //   2. Non-hidden sheets (skip SAP "_com.sap..." internal sheets)
  //   3. All remaining sheets as fallback
  const tried = new Set<string>();
  const sheetOrder: string[] = [];
  const siteArticle = wb.SheetNames.find(n => /^site\s*article$/i.test(n.trim()));
  if (siteArticle) { sheetOrder.push(siteArticle); tried.add(siteArticle); }
  for (const n of wb.SheetNames) {
    if (!tried.has(n) && !n.startsWith('_')) { sheetOrder.push(n); tried.add(n); }
  }
  for (const n of wb.SheetNames) {
    if (!tried.has(n)) { sheetOrder.push(n); tried.add(n); }
  }

  if (sheetOrder.length === 0) {
    return {
      format: 'unknown', sheetName: '', periods: [], rows: [],
      warnings: [], errors: ['Workbook has no worksheets'],
    };
  }

  // Try each sheet until format detection succeeds
  let sheetName = sheetOrder[0];
  let grid: unknown[][] = [];
  let det: DetectedFormat | null = null;

  for (const name of sheetOrder) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const g = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1, raw: true, blankrows: false, defval: null,
    });
    const d = detectFormat(g);
    if (d) {
      sheetName = name;
      grid = g;
      det = d;
      break;
    }
  }

  if (!det) {
    return {
      format: 'unknown', sheetName, periods: [], rows: [],
      warnings: [],
      errors: [
        'Unrecognised aged stock list format. Expected one of: Genkem-style (fiscal-week banner), SafeTop-style (Barcode column), USABCO-style (Region / Store Code headers), or BW Site-Article (Site / Article columns).',
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
