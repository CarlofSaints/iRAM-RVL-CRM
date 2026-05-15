/**
 * Sticker label PDF generator.
 *
 * Generates A4 portrait PDFs with 4 stickers per page (2 cols x 2 rows).
 * Each sticker is 99.1mm wide x 139mm tall (standard label size).
 * Contains:
 *   - iRam logo (top-left)
 *   - Code128 barcode (centred)
 *   - Barcode value text
 *   - 6 rows of ruled fields (some split into two columns)
 *
 * Uses pdfkit for layout and bwip-js for barcode PNG generation.
 */

import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bwipjs = require('bwip-js') as {
  toBuffer(opts: { bcid: string; text: string; scale: number; height: number; includetext: boolean }): Promise<Buffer>;
};

export interface StickerFieldData {
  siteCode?: string;
  date?: string;
  storeName?: string;
  referenceNumber?: string;
  vendorName?: string;
  vendorCode?: string;
  repName?: string;
  boxNumber?: number;
  totalBoxes?: number;
}

export interface StickerPdfParams {
  stickers: Array<{ barcodeValue: string; fields?: StickerFieldData }>;
  warehouseName: string;
}

// ── Layout constants ─────────────────────────────────────────────────────────

const PAGE_W = 595.28;   // A4 width (pt)
const PAGE_H = 841.89;   // A4 height (pt)

const MM = 72 / 25.4;    // 1mm in points
const STICKER_W = 99.1 * MM;   // ~281pt
const STICKER_H = 139 * MM;    // ~394pt

const COLS = 2;
const ROWS = 2;
const STICKERS_PER_PAGE = COLS * ROWS;

const GAP = 8;  // gap between stickers (pt)
const MARGIN_X = (PAGE_W - COLS * STICKER_W - (COLS - 1) * GAP) / 2;
const MARGIN_Y = (PAGE_H - ROWS * STICKER_H - (ROWS - 1) * GAP) / 2;

// Field layout — each row is full-width, split into two columns, or the
// special "Box _ of _" layout with inline underlines.
type FieldRow =
  | { type: 'full'; label: string }
  | { type: 'split'; left: string; right: string }
  | { type: 'box-of' };

const FIELD_ROWS: FieldRow[] = [
  { type: 'split', left: 'Site Number', right: 'Date' },
  { type: 'full', label: 'Store Name' },
  { type: 'full', label: 'Reference Number' },
  { type: 'split', left: 'Vendor Name', right: 'Vendor Code' },
  { type: 'full', label: 'Rep Name' },
  { type: 'box-of' },
];

/**
 * Generate a sticker label PDF. Returns the PDF as a Buffer.
 */
export async function generateStickerPdf(params: StickerPdfParams): Promise<Buffer> {
  const { stickers, warehouseName } = params;

  // Load logo
  let logoBuffer: Buffer | null = null;
  try {
    const logoPath = path.join(process.cwd(), 'public', 'iram-logo.png');
    if (fs.existsSync(logoPath)) logoBuffer = fs.readFileSync(logoPath);
  } catch { /* skip */ }

  // Pre-generate all barcode PNGs
  const barcodePngs = new Map<string, Buffer>();
  for (const s of stickers) {
    if (!barcodePngs.has(s.barcodeValue)) {
      try {
        const png = await bwipjs.toBuffer({
          bcid: 'code128',
          text: s.barcodeValue,
          scale: 3,
          height: 12,
          includetext: false,
        });
        barcodePngs.set(s.barcodeValue, png);
      } catch (err) {
        console.error(`[stickerPdf] barcode gen failed for ${s.barcodeValue}:`, err);
      }
    }
  }

  // Create PDF
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN_Y, bottom: MARGIN_Y, left: MARGIN_X, right: MARGIN_X },
    bufferPages: true,
    info: {
      Title: `Sticker Labels - ${warehouseName}`,
      Author: 'iRamFlow — OuterJoin',
    },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  const totalPages = Math.ceil(stickers.length / STICKERS_PER_PAGE);

  for (let page = 0; page < totalPages; page++) {
    if (page > 0) doc.addPage();

    for (let slot = 0; slot < STICKERS_PER_PAGE; slot++) {
      const idx = page * STICKERS_PER_PAGE + slot;
      if (idx >= stickers.length) break;

      const col = slot % COLS;
      const row = Math.floor(slot / COLS);

      const x = MARGIN_X + col * (STICKER_W + GAP);
      const y = MARGIN_Y + row * (STICKER_H + GAP);

      drawSticker(doc, {
        x,
        y,
        w: STICKER_W,
        h: STICKER_H,
        barcodeValue: stickers[idx].barcodeValue,
        barcodePng: barcodePngs.get(stickers[idx].barcodeValue) ?? null,
        logoBuffer,
        fields: stickers[idx].fields,
      });
    }
  }

  doc.end();

  return new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

// ── Draw a single sticker ────────────────────────────────────────────────────

interface StickerDrawParams {
  x: number;
  y: number;
  w: number;
  h: number;
  barcodeValue: string;
  barcodePng: Buffer | null;
  logoBuffer: Buffer | null;
  fields?: StickerFieldData;
}

function drawSticker(doc: InstanceType<typeof PDFDocument>, p: StickerDrawParams) {
  const { x, y, w, h, barcodeValue, barcodePng, logoBuffer, fields } = p;
  const pad = 10; // inner padding

  // Map field labels → pre-filled values (if provided)
  const fieldValues: Record<string, string | undefined> = fields ? {
    'Site Number': fields.siteCode,
    'Date': fields.date,
    'Store Name': fields.storeName,
    'Reference Number': fields.referenceNumber,
    'Vendor Name': fields.vendorName,
    'Vendor Code': fields.vendorCode,
    'Rep Name': fields.repName,
  } : {};

  // Border
  doc.save();
  doc.lineWidth(0.5).strokeColor('#999999').rect(x, y, w, h).stroke();

  let cy = y + pad;

  // Logo (top-left)
  if (logoBuffer) {
    try {
      doc.image(logoBuffer, x + pad, cy, { height: 28 });
    } catch { /* skip */ }
  }
  cy += 34;

  // Barcode image (centred, height-capped so it doesn't cover the text)
  const bcMaxH = 36;
  if (barcodePng) {
    try {
      const bcW = Math.min(w - 2 * pad, 220);
      const bcX = x + (w - bcW) / 2;
      doc.image(barcodePng, bcX, cy, { fit: [bcW, bcMaxH] });
      cy += bcMaxH + 4;
    } catch {
      cy += 10;
    }
  } else {
    cy += 10;
  }

  // Barcode value text (centred, below the barcode)
  doc.font('Helvetica').fontSize(7).fillColor('#000000');
  doc.text(barcodeValue, x + pad, cy, {
    width: w - 2 * pad,
    align: 'center',
  });
  cy += 14;

  // ── Fields ──────────────────────────────────────────────────────────
  const fieldW = w - 2 * pad;
  const availH = (y + h - pad) - cy;
  const rowH = Math.min(availH / FIELD_ROWS.length, 38);
  const colGap = 8; // gap between left/right columns in split rows

  for (const fieldRow of FIELD_ROWS) {
    if (fieldRow.type === 'full') {
      drawField(doc, x + pad, cy, fieldW, rowH, fieldRow.label, fieldValues[fieldRow.label]);
    } else if (fieldRow.type === 'split') {
      const halfW = (fieldW - colGap) / 2;
      drawField(doc, x + pad, cy, halfW, rowH, fieldRow.left, fieldValues[fieldRow.left]);
      drawField(doc, x + pad + halfW + colGap, cy, halfW, rowH, fieldRow.right, fieldValues[fieldRow.right]);
    } else if (fieldRow.type === 'box-of') {
      drawBoxOfField(doc, x + pad, cy, fieldW, rowH, fields?.boxNumber, fields?.totalBoxes);
    }
    cy += rowH;
  }

  doc.restore();
}

/** Standard ruled field: bold label with underline. If value is provided, print it. */
function drawField(
  doc: InstanceType<typeof PDFDocument>,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  value?: string,
) {
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#000000');
  const labelText = `${label}:`;
  doc.text(labelText, x, y + 2, { width: w, align: 'left' });

  // If a value is provided, print it next to the label
  if (value) {
    const labelW = doc.widthOfString(labelText) + 4;
    doc.font('Helvetica').fontSize(7.5).fillColor('#000000');
    doc.text(value, x + labelW, y + 2, { width: w - labelW, align: 'left' });
  }

  const lineY = y + h - 3;
  doc.lineWidth(0.5).strokeColor('#999999')
    .moveTo(x, lineY)
    .lineTo(x + w, lineY)
    .stroke();
}

/** Special "Box ___ of ___" field with two inline underline blanks or pre-filled numbers. */
function drawBoxOfField(
  doc: InstanceType<typeof PDFDocument>,
  x: number,
  y: number,
  w: number,
  h: number,
  boxNumber?: number,
  totalBoxes?: number,
) {
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#000000');

  const boxTextW = doc.widthOfString('Box');
  const ofTextW = doc.widthOfString('of');

  // Position "of" at the centre of the field
  const ofX = x + (w / 2) - (ofTextW / 2);

  doc.text('Box', x, y + 2);
  doc.text('of', ofX, y + 2);

  const lineY = y + h - 3;

  if (boxNumber != null && totalBoxes != null) {
    // Pre-filled: print the numbers between "Box" and "of", and after "of"
    doc.font('Helvetica').fontSize(7.5).fillColor('#000000');
    const numStr = String(boxNumber);
    const totalStr = String(totalBoxes);
    // Centre the number between "Box" and "of"
    const gap1Start = x + boxTextW + 4;
    const gap1End = ofX - 4;
    const numW = doc.widthOfString(numStr);
    doc.text(numStr, gap1Start + (gap1End - gap1Start - numW) / 2, y + 2);
    // Centre the total after "of"
    const gap2Start = ofX + ofTextW + 4;
    const gap2End = x + w;
    const totalW = doc.widthOfString(totalStr);
    doc.text(totalStr, gap2Start + (gap2End - gap2Start - totalW) / 2, y + 2);
  }

  // Underline after "Box" → before "of"
  doc.lineWidth(0.5).strokeColor('#999999')
    .moveTo(x + boxTextW + 4, lineY)
    .lineTo(ofX - 4, lineY)
    .stroke();

  // Underline after "of" → end
  doc.lineWidth(0.5).strokeColor('#999999')
    .moveTo(ofX + ofTextW + 4, lineY)
    .lineTo(x + w, lineY)
    .stroke();
}
