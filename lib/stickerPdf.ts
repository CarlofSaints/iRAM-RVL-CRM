/**
 * Sticker label PDF generator.
 *
 * Generates A4 portrait PDFs with stickers laid out in a grid.
 * Grid size (cols x rows) is calculated from the sticker dimensions.
 * Contains:
 *   - Code128 barcode (centred)
 *   - Barcode value text
 *   - Rows of ruled fields (some split into two columns)
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
  /** Sticker width in mm. Defaults to 74. */
  stickerWidthMm?: number;
  /** Sticker height in mm. Defaults to 50. */
  stickerHeightMm?: number;
  /** Layout mode: 'roll' = one sticker per page sized to sticker, 'a4sheet' = grid on A4. Defaults to 'roll'. */
  layout?: 'roll' | 'a4sheet';
  /** Gap between labels on the roll in mm (added to page height). */
  gapMm?: number;
  /** Content margins in mm. */
  marginTopMm?: number;
  marginBottomMm?: number;
  marginLeftMm?: number;
  marginRightMm?: number;
}

// ── Layout constants ─────────────────────────────────────────────────────────

const PAGE_W = 595.28;   // A4 width (pt)
const PAGE_H = 841.89;   // A4 height (pt)
const MM = 72 / 25.4;    // 1mm in points

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
  const layout = params.layout ?? 'roll';
  const stickerW = (params.stickerWidthMm ?? 74) * MM;
  const stickerH = (params.stickerHeightMm ?? 50) * MM;

  // Inter-label gap (roll mode only — added to page height)
  const gapPt = (params.gapMm ?? 0) * MM;

  // Content margins (converted from mm to pt)
  const mTop = (params.marginTopMm ?? 0) * MM;
  const mBottom = (params.marginBottomMm ?? 0) * MM;
  const mLeft = (params.marginLeftMm ?? 0) * MM;
  const mRight = (params.marginRightMm ?? 0) * MM;

  // Decide visual mode: compact (height < 80mm) vs standard
  const compact = (params.stickerHeightMm ?? 50) < 80;

  // Load logo only for standard (tall) stickers on A4 sheets
  let logoBuffer: Buffer | null = null;
  if (!compact && layout === 'a4sheet') {
    try {
      const logoPath = path.join(process.cwd(), 'public', 'iram-logo.png');
      if (fs.existsSync(logoPath)) logoBuffer = fs.readFileSync(logoPath);
    } catch { /* skip */ }
  }

  // Pre-generate all barcode PNGs
  const barcodePngs = new Map<string, Buffer>();
  for (const s of stickers) {
    if (!barcodePngs.has(s.barcodeValue)) {
      try {
        const png = await bwipjs.toBuffer({
          bcid: 'code128',
          text: s.barcodeValue,
          scale: compact ? 2 : 3,
          height: compact ? 8 : 12,
          includetext: false,
        });
        barcodePngs.set(s.barcodeValue, png);
      } catch (err) {
        console.error(`[stickerPdf] barcode gen failed for ${s.barcodeValue}:`, err);
      }
    }
  }

  const margins = { top: mTop, bottom: mBottom, left: mLeft, right: mRight };

  if (layout === 'roll') {
    return generateRollPdf(stickers, warehouseName, stickerW, stickerH, compact, barcodePngs, margins, gapPt);
  } else {
    return generateA4SheetPdf(stickers, warehouseName, stickerW, stickerH, compact, logoBuffer, barcodePngs, margins, gapPt);
  }
}

// ── Roll mode: one sticker per page, page = sticker size ─────────────────────

interface ContentMargins { top: number; bottom: number; left: number; right: number }

function generateRollPdf(
  stickers: StickerPdfParams['stickers'],
  warehouseName: string,
  stickerW: number,
  stickerH: number,
  compact: boolean,
  barcodePngs: Map<string, Buffer>,
  margins: ContentMargins,
  gapPt: number,
): Promise<Buffer> {
  // Page height = label height + inter-label gap (so each page matches the full label pitch)
  // Content is drawn within stickerH only; the gap is blank space at the bottom
  const pageH = stickerH + gapPt;

  const doc = new PDFDocument({
    size: [stickerW, pageH],
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    bufferPages: true,
    info: {
      Title: `Sticker Labels - ${warehouseName}`,
      Author: 'iRamFlow — OuterJoin',
    },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  // Content area after margins (within the label area, not the gap)
  const cx = margins.left;
  const cy = margins.top;
  const cw = stickerW - margins.left - margins.right;
  const ch = stickerH - margins.top - margins.bottom;

  for (let i = 0; i < stickers.length; i++) {
    if (i > 0) doc.addPage({ size: [stickerW, pageH], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

    if (compact) {
      drawCompactSticker(doc, {
        x: cx, y: cy, w: cw, h: ch,
        barcodeValue: stickers[i].barcodeValue,
        barcodePng: barcodePngs.get(stickers[i].barcodeValue) ?? null,
        fields: stickers[i].fields,
      });
    } else {
      drawSticker(doc, {
        x: cx, y: cy, w: cw, h: ch,
        barcodeValue: stickers[i].barcodeValue,
        barcodePng: barcodePngs.get(stickers[i].barcodeValue) ?? null,
        logoBuffer: null,
        fields: stickers[i].fields,
      });
    }
  }

  doc.end();

  return new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

// ── A4 Sheet mode: grid of stickers on A4 pages ─────────────────────────────

function generateA4SheetPdf(
  stickers: StickerPdfParams['stickers'],
  warehouseName: string,
  stickerW: number,
  stickerH: number,
  compact: boolean,
  logoBuffer: Buffer | null,
  barcodePngs: Map<string, Buffer>,
  margins: ContentMargins,
  gap: number,
): Promise<Buffer> {
  // Inter-label gap (pt). gap 0 → contiguous labels; the grid auto-centres,
  // so the page-edge margins fall out of the dimensions (standard 4-up sheets).
  const cols = Math.max(1, Math.floor((PAGE_W + gap) / (stickerW + gap)));
  const rows = Math.max(1, Math.floor((PAGE_H + gap) / (stickerH + gap)));
  const stickersPerPage = cols * rows;

  const marginX = (PAGE_W - cols * stickerW - (cols - 1) * gap) / 2;
  const marginY = (PAGE_H - rows * stickerH - (rows - 1) * gap) / 2;

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: marginY, bottom: marginY, left: marginX, right: marginX },
    bufferPages: true,
    info: {
      Title: `Sticker Labels - ${warehouseName}`,
      Author: 'iRamFlow — OuterJoin',
    },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  const totalPages = Math.ceil(stickers.length / stickersPerPage);

  for (let page = 0; page < totalPages; page++) {
    if (page > 0) doc.addPage();

    for (let slot = 0; slot < stickersPerPage; slot++) {
      const idx = page * stickersPerPage + slot;
      if (idx >= stickers.length) break;

      const col = slot % cols;
      const row = Math.floor(slot / cols);

      const x = marginX + col * (stickerW + gap);
      const y = marginY + row * (stickerH + gap);

      // Apply content margins within each sticker cell
      const cx = x + margins.left;
      const cy = y + margins.top;
      const cw = stickerW - margins.left - margins.right;
      const ch = stickerH - margins.top - margins.bottom;

      if (compact) {
        drawCompactSticker(doc, {
          x: cx, y: cy, w: cw, h: ch,
          barcodeValue: stickers[idx].barcodeValue,
          barcodePng: barcodePngs.get(stickers[idx].barcodeValue) ?? null,
          fields: stickers[idx].fields,
        });
      } else {
        drawSticker(doc, {
          x: cx, y: cy, w: cw, h: ch,
          barcodeValue: stickers[idx].barcodeValue,
          barcodePng: barcodePngs.get(stickers[idx].barcodeValue) ?? null,
          logoBuffer,
          fields: stickers[idx].fields,
        });
      }
    }
  }

  doc.end();

  return new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

// ── Draw a compact sticker (< 80mm tall) ─────────────────────────────────────

interface CompactDrawParams {
  x: number;
  y: number;
  w: number;
  h: number;
  barcodeValue: string;
  barcodePng: Buffer | null;
  fields?: StickerFieldData;
}

function drawCompactSticker(doc: InstanceType<typeof PDFDocument>, p: CompactDrawParams) {
  const { x, y, w, h, barcodeValue, barcodePng, fields } = p;

  // Scale padding proportionally — 6pt at 50mm height, minimum 2pt
  const pad = Math.max(2, Math.min(6, h * 0.04));

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
  const fieldW = w - 2 * pad;

  // ── Allocate vertical space proportionally ──
  // Budget: barcode section ~30% of height, fields ~65%, padding ~5%
  const contentH = h - 2 * pad;
  const barcodeSection = contentH * 0.30;
  const bcMaxH = Math.max(8, barcodeSection * 0.7);   // barcode image
  const bcTextH = Math.max(6, barcodeSection * 0.25);  // barcode text + separator

  // ── Barcode (top, centred) ──
  if (barcodePng) {
    try {
      const bcW = Math.min(fieldW, 180);
      const bcX = x + (w - bcW) / 2;
      doc.image(barcodePng, bcX, cy, { fit: [bcW, bcMaxH] });
      cy += bcMaxH + 1;
    } catch {
      cy += 4;
    }
  } else {
    cy += 4;
  }

  // Barcode text — scale font to available space
  const bcFontSize = Math.min(6, Math.max(3, bcTextH * 0.5));
  doc.font('Helvetica').fontSize(bcFontSize).fillColor('#000000');
  doc.text(barcodeValue, x + pad, cy, { width: fieldW, align: 'center' });
  cy += bcFontSize + 2;

  // Thin separator
  doc.lineWidth(0.3).strokeColor('#cccccc')
    .moveTo(x + pad, cy).lineTo(x + w - pad, cy).stroke();
  cy += 2;

  // ── Field rows — fit all into remaining space ──
  const bottomPad = pad;
  const availH = (y + h - bottomPad) - cy;
  const rowH = Math.max(4, availH / FIELD_ROWS.length);
  const colGap = Math.min(6, w * 0.03);
  const fontSize = Math.min(6, Math.max(3, rowH * 0.45));

  for (const fieldRow of FIELD_ROWS) {
    // Skip row if it would overflow the sticker
    if (cy + rowH > y + h - 1) break;

    if (fieldRow.type === 'full') {
      drawCompactField(doc, x + pad, cy, fieldW, rowH, fieldRow.label, fontSize, fieldValues[fieldRow.label]);
    } else if (fieldRow.type === 'split') {
      const halfW = (fieldW - colGap) / 2;
      drawCompactField(doc, x + pad, cy, halfW, rowH, fieldRow.left, fontSize, fieldValues[fieldRow.left]);
      drawCompactField(doc, x + pad + halfW + colGap, cy, halfW, rowH, fieldRow.right, fontSize, fieldValues[fieldRow.right]);
    } else if (fieldRow.type === 'box-of') {
      drawCompactBoxOf(doc, x + pad, cy, fieldW, rowH, fontSize, fields?.boxNumber, fields?.totalBoxes);
    }
    cy += rowH;
  }

  doc.restore();
}

/** Compact field: label + optional value with underline. */
function drawCompactField(
  doc: InstanceType<typeof PDFDocument>,
  x: number, y: number, w: number, h: number,
  label: string, fontSize: number,
  value?: string,
) {
  doc.font('Helvetica-Bold').fontSize(fontSize).fillColor('#000000');
  const labelText = `${label}:`;
  doc.text(labelText, x, y + 1, { width: w, align: 'left' });

  if (value) {
    const labelW = doc.widthOfString(labelText) + 2;
    doc.font('Helvetica').fontSize(fontSize).fillColor('#000000');
    doc.text(value, x + labelW, y + 1, { width: w - labelW, align: 'left' });
  }

  const lineY = y + h - 2;
  doc.lineWidth(0.3).strokeColor('#bbbbbb')
    .moveTo(x, lineY).lineTo(x + w, lineY).stroke();
}

/** Compact "Box ___ of ___" field. */
function drawCompactBoxOf(
  doc: InstanceType<typeof PDFDocument>,
  x: number, y: number, w: number, h: number,
  fontSize: number,
  boxNumber?: number, totalBoxes?: number,
) {
  doc.font('Helvetica-Bold').fontSize(fontSize).fillColor('#000000');
  const boxTextW = doc.widthOfString('Box');
  const ofTextW = doc.widthOfString('of');
  const ofX = x + (w / 2) - (ofTextW / 2);

  doc.text('Box', x, y + 1);
  doc.text('of', ofX, y + 1);

  const lineY = y + h - 2;

  if (boxNumber != null && totalBoxes != null) {
    doc.font('Helvetica').fontSize(fontSize).fillColor('#000000');
    const numStr = String(boxNumber);
    const totalStr = String(totalBoxes);
    const gap1Start = x + boxTextW + 2;
    const gap1End = ofX - 2;
    const numW = doc.widthOfString(numStr);
    doc.text(numStr, gap1Start + (gap1End - gap1Start - numW) / 2, y + 1);
    const gap2Start = ofX + ofTextW + 2;
    const gap2End = x + w;
    const totalW = doc.widthOfString(totalStr);
    doc.text(totalStr, gap2Start + (gap2End - gap2Start - totalW) / 2, y + 1);
  }

  doc.lineWidth(0.3).strokeColor('#bbbbbb')
    .moveTo(x + boxTextW + 2, lineY).lineTo(ofX - 2, lineY).stroke();
  doc.lineWidth(0.3).strokeColor('#bbbbbb')
    .moveTo(ofX + ofTextW + 2, lineY).lineTo(x + w, lineY).stroke();
}

// ── Draw a standard sticker (>= 80mm tall) ──────────────────────────────────

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
  const pad = 10;

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

  // Barcode image (centred)
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

  // Barcode value text
  doc.font('Helvetica').fontSize(7).fillColor('#000000');
  doc.text(barcodeValue, x + pad, cy, { width: w - 2 * pad, align: 'center' });
  cy += 14;

  // ── Fields ──
  const fieldW = w - 2 * pad;
  const availH = (y + h - pad) - cy;
  const rowH = Math.min(availH / FIELD_ROWS.length, 38);
  const colGap = 8;

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

/** Standard ruled field: bold label with underline. */
function drawField(
  doc: InstanceType<typeof PDFDocument>,
  x: number, y: number, w: number, h: number,
  label: string, value?: string,
) {
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#000000');
  const labelText = `${label}:`;
  doc.text(labelText, x, y + 2, { width: w, align: 'left' });

  if (value) {
    const labelW = doc.widthOfString(labelText) + 4;
    doc.font('Helvetica').fontSize(7.5).fillColor('#000000');
    doc.text(value, x + labelW, y + 2, { width: w - labelW, align: 'left' });
  }

  const lineY = y + h - 3;
  doc.lineWidth(0.5).strokeColor('#999999')
    .moveTo(x, lineY).lineTo(x + w, lineY).stroke();
}

/** Standard "Box ___ of ___" field with two inline underline blanks. */
function drawBoxOfField(
  doc: InstanceType<typeof PDFDocument>,
  x: number, y: number, w: number, h: number,
  boxNumber?: number, totalBoxes?: number,
) {
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#000000');
  const boxTextW = doc.widthOfString('Box');
  const ofTextW = doc.widthOfString('of');
  const ofX = x + (w / 2) - (ofTextW / 2);

  doc.text('Box', x, y + 2);
  doc.text('of', ofX, y + 2);

  const lineY = y + h - 3;

  if (boxNumber != null && totalBoxes != null) {
    doc.font('Helvetica').fontSize(7.5).fillColor('#000000');
    const numStr = String(boxNumber);
    const totalStr = String(totalBoxes);
    const gap1Start = x + boxTextW + 4;
    const gap1End = ofX - 4;
    const numW = doc.widthOfString(numStr);
    doc.text(numStr, gap1Start + (gap1End - gap1Start - numW) / 2, y + 2);
    const gap2Start = ofX + ofTextW + 4;
    const gap2End = x + w;
    const totalW = doc.widthOfString(totalStr);
    doc.text(totalStr, gap2Start + (gap2End - gap2Start - totalW) / 2, y + 2);
  }

  doc.lineWidth(0.5).strokeColor('#999999')
    .moveTo(x + boxTextW + 4, lineY).lineTo(ofX - 4, lineY).stroke();
  doc.lineWidth(0.5).strokeColor('#999999')
    .moveTo(ofX + ofTextW + 4, lineY).lineTo(x + w, lineY).stroke();
}
