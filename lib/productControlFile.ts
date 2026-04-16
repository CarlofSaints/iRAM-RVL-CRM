/**
 * Parse / serialize iRam product control xlsx files.
 *
 * Uses ExcelJS so that round-tripping a workbook preserves formatting, formulas
 * in unrelated columns, and any extra sheets the client added. We only ever
 * touch the data rows of the products sheet.
 *
 * Header layout in the source file is flexible — column order is whatever the
 * client used. We match by canonical name (case-insensitive, whitespace-tolerant).
 */

import ExcelJS from 'exceljs';
import { randomUUID } from 'crypto';

export interface Product {
  id: string;
  articleNumber: string;
  description: string;
  barcode: string;
  vendorProductCode: string;
  uom?: string;
  caseBarcode?: string;
  rowIndex?: number;          // 1-based row from source xlsx (inc. header row)
  updatedAt: string;
}

/**
 * Canonical column → list of header aliases (matched case-insensitive,
 * whitespace stripped).
 */
const COLUMN_ALIASES: Record<keyof HeaderMap, string[]> = {
  articleNumber: ['Article Number', 'ArticleNumber', 'Article #', 'Article'],
  description: ['Product Description', 'Description', 'Product Name'],
  barcode: ['Barcode', 'EAN', 'EAN Barcode'],
  vendorProductCode: ['Vendor Product Code', 'Vendor Code', 'VendorProductCode', 'Supplier Product Code'],
  uom: ['UoM', 'UOM', 'Unit of Measure', 'Unit'],
  caseBarcode: ['Case Barcode', 'CaseBarcode', 'Case EAN', 'Outer Barcode'],
};

const MANDATORY_KEYS: (keyof HeaderMap)[] = ['articleNumber', 'description', 'barcode', 'vendorProductCode'];
const OPTIONAL_KEYS: (keyof HeaderMap)[] = ['uom', 'caseBarcode'];

export interface HeaderMap {
  articleNumber: number;        // 1-based column index in the worksheet
  description: number;
  barcode: number;
  vendorProductCode: number;
  uom: number;                  // 0 = not present in file
  caseBarcode: number;
}

export interface ParseResult {
  products: Product[];
  warnings: string[];
  errors: string[];
  headerMap: HeaderMap;
  /** Sheet name we read from (so write-back uses the same one). */
  sheetName: string;
  /** 1-based header row index. */
  headerRow: number;
}

function normHeader(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase();
}

function buildAliasMap(): Record<string, keyof HeaderMap> {
  const map: Record<string, keyof HeaderMap> = {};
  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES) as [keyof HeaderMap, string[]][]) {
    for (const a of aliases) map[normHeader(a)] = canonical;
    map[normHeader(canonical)] = canonical;
  }
  return map;
}

/** Coerce a worksheet cell value into a trimmed string. Handles numbers, formulas, rich text. */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') {
    // Avoid scientific notation for big barcodes
    if (Number.isInteger(value) && Math.abs(value) > 1e10) {
      return value.toFixed(0);
    }
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return value.toISOString();
  // ExcelJS rich text / formula objects
  const v = value as { result?: unknown; richText?: { text: string }[]; text?: string };
  if (v.result !== undefined) return cellToString(v.result);
  if (Array.isArray(v.richText)) return v.richText.map(r => r.text).join('').trim();
  if (typeof v.text === 'string') return v.text.trim();
  return String(value).trim();
}

/**
 * Parse a product control xlsx buffer.
 * Reads the FIRST worksheet. Header row = first row with at least one
 * recognised mandatory header.
 */
export async function parseProductFile(buffer: Buffer): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);

  const ws = wb.worksheets[0];
  if (!ws) {
    return {
      products: [],
      warnings: [],
      errors: ['No worksheet found in the file'],
      headerMap: { articleNumber: 0, description: 0, barcode: 0, vendorProductCode: 0, uom: 0, caseBarcode: 0 },
      sheetName: '',
      headerRow: 0,
    };
  }

  const aliasMap = buildAliasMap();
  const errors: string[] = [];
  const warnings: string[] = [];

  // Find the header row — scan first 10 rows for one that contains at least one mandatory header
  let headerRow = 0;
  let headerMap: HeaderMap | null = null;
  for (let r = 1; r <= Math.min(10, ws.rowCount); r++) {
    const row = ws.getRow(r);
    const candidate: HeaderMap = { articleNumber: 0, description: 0, barcode: 0, vendorProductCode: 0, uom: 0, caseBarcode: 0 };
    let hits = 0;
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const text = cellToString(cell.value);
      if (!text) return;
      const canon = aliasMap[normHeader(text)];
      if (canon && candidate[canon] === 0) {
        candidate[canon] = colNumber;
        hits++;
      }
    });
    if (hits >= 2 && (candidate.articleNumber || candidate.description)) {
      headerRow = r;
      headerMap = candidate;
      break;
    }
  }

  if (!headerMap) {
    return {
      products: [],
      warnings: [],
      errors: ['Could not find a header row. Expected columns include: Article Number, Product Description, Barcode, Vendor Product Code'],
      headerMap: { articleNumber: 0, description: 0, barcode: 0, vendorProductCode: 0, uom: 0, caseBarcode: 0 },
      sheetName: ws.name,
      headerRow: 0,
    };
  }

  const missing = MANDATORY_KEYS.filter(k => headerMap![k] === 0);
  if (missing.length > 0) {
    const labels = missing.map(k => COLUMN_ALIASES[k][0]).join(', ');
    errors.push(`Missing mandatory column(s): ${labels}`);
  }
  for (const k of OPTIONAL_KEYS) {
    if (headerMap[k] === 0) {
      warnings.push(`Optional column "${COLUMN_ALIASES[k][0]}" not present`);
    }
  }
  if (errors.length > 0) {
    return { products: [], warnings, errors, headerMap, sheetName: ws.name, headerRow };
  }

  // Walk data rows
  const products: Product[] = [];
  const now = new Date().toISOString();
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const articleNumber = cellToString(row.getCell(headerMap.articleNumber).value);
    const description = cellToString(row.getCell(headerMap.description).value);
    const barcode = cellToString(row.getCell(headerMap.barcode).value);
    const vendorProductCode = cellToString(row.getCell(headerMap.vendorProductCode).value);
    const uom = headerMap.uom ? cellToString(row.getCell(headerMap.uom).value) : '';
    const caseBarcode = headerMap.caseBarcode ? cellToString(row.getCell(headerMap.caseBarcode).value) : '';

    // Skip wholly-blank rows
    if (!articleNumber && !description && !barcode && !vendorProductCode && !uom && !caseBarcode) continue;

    // Per-row validation — soft warnings
    for (const k of MANDATORY_KEYS) {
      const val = k === 'articleNumber' ? articleNumber
        : k === 'description' ? description
        : k === 'barcode' ? barcode
        : vendorProductCode;
      if (!val) warnings.push(`Row ${r}: ${COLUMN_ALIASES[k][0]} is empty`);
    }

    products.push({
      id: randomUUID(),
      articleNumber,
      description,
      barcode,
      vendorProductCode,
      uom: uom || undefined,
      caseBarcode: caseBarcode || undefined,
      rowIndex: r,
      updatedAt: now,
    });
  }

  return { products, warnings, errors, headerMap, sheetName: ws.name, headerRow };
}

/**
 * Serialize the products list back into the xlsx, preserving the original
 * header row + any other sheets/formatting. Replaces ALL rows below the header.
 *
 * If the source had additional columns (formulas, notes), those columns'
 * values for our written rows are left blank — adjust here if any client
 * needs us to preserve specific extra columns.
 */
export async function serializeProductsToBuffer(
  sourceBuffer: Buffer,
  products: Product[],
  headerMap: HeaderMap,
  sheetName: string,
  headerRow: number
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(sourceBuffer as unknown as ArrayBuffer);
  const ws = wb.getWorksheet(sheetName) ?? wb.worksheets[0];
  if (!ws) throw new Error('Source workbook has no worksheet to write to');

  // Wipe all data rows below the header
  if (ws.rowCount > headerRow) {
    // ExcelJS spliceRows uses 1-based start, count
    ws.spliceRows(headerRow + 1, ws.rowCount - headerRow);
  }

  // Write fresh data
  let r = headerRow + 1;
  for (const p of products) {
    const row = ws.getRow(r);
    if (headerMap.articleNumber) row.getCell(headerMap.articleNumber).value = p.articleNumber;
    if (headerMap.description) row.getCell(headerMap.description).value = p.description;
    if (headerMap.barcode) row.getCell(headerMap.barcode).value = p.barcode;
    if (headerMap.vendorProductCode) row.getCell(headerMap.vendorProductCode).value = p.vendorProductCode;
    if (headerMap.uom && p.uom !== undefined) row.getCell(headerMap.uom).value = p.uom;
    if (headerMap.caseBarcode && p.caseBarcode !== undefined) row.getCell(headerMap.caseBarcode).value = p.caseBarcode;
    row.commit();
    r++;
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

export const PRODUCT_COLUMN_LABELS: Record<keyof HeaderMap, string> = {
  articleNumber: 'Article Number',
  description: 'Product Description',
  barcode: 'Barcode',
  vendorProductCode: 'Vendor Product Code',
  uom: 'UoM',
  caseBarcode: 'Case Barcode',
};
