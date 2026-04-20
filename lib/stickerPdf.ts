/**
 * Sticker label PDF generator.
 *
 * Generates A4 portrait PDFs with 6 stickers per page (2 cols x 3 rows).
 * Each sticker contains:
 *   - iRam logo (top-left)
 *   - Code128 barcode (centred)
 *   - Barcode value text
 *   - 7 ruled fields for manual pen capture
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

export interface StickerPdfParams {
  stickers: Array<{ barcodeValue: string }>;
  warehouseName: string;
}

// ── Layout constants ─────────────────────────────────────────────────────────

const PAGE_W = 595.28;   // A4 width (pt)
const PAGE_H = 841.89;   // A4 height (pt)
const MARGIN = 20;        // all sides
const GAP = 10;           // between stickers
const COLS = 2;
const ROWS = 3;
const STICKERS_PER_PAGE = COLS * ROWS;

const STICKER_W = (PAGE_W - 2 * MARGIN - (COLS - 1) * GAP) / COLS;
const STICKER_H = (PAGE_H - 2 * MARGIN - (ROWS - 1) * GAP) / ROWS;

const FIELDS = [
  'Store Name',
  'Site Number',
  'Reference Number',
  'Vendor Name',
  'Vendor Code',
  'Total QTY',
  'Total Value',
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
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: {
      Title: `Sticker Labels - ${warehouseName}`,
      Author: 'iRam RVL CRM — OuterJoin',
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

      const x = MARGIN + col * (STICKER_W + GAP);
      const y = MARGIN + row * (STICKER_H + GAP);

      drawSticker(doc, {
        x,
        y,
        w: STICKER_W,
        h: STICKER_H,
        barcodeValue: stickers[idx].barcodeValue,
        barcodePng: barcodePngs.get(stickers[idx].barcodeValue) ?? null,
        logoBuffer,
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
}

function drawSticker(doc: InstanceType<typeof PDFDocument>, p: StickerDrawParams) {
  const { x, y, w, h, barcodeValue, barcodePng, logoBuffer } = p;
  const pad = 8; // inner padding

  // Border
  doc.save();
  doc.lineWidth(0.5).strokeColor('#999999').rect(x, y, w, h).stroke();

  let cy = y + pad;

  // Logo (top-left)
  if (logoBuffer) {
    try {
      doc.image(logoBuffer, x + pad, cy, { height: 22 });
    } catch { /* skip */ }
  }
  cy += 26;

  // Barcode image (centred)
  if (barcodePng) {
    try {
      const bcW = Math.min(w - 2 * pad, 200);
      const bcX = x + (w - bcW) / 2;
      doc.image(barcodePng, bcX, cy, { width: bcW });
      cy += 38;
    } catch {
      cy += 10;
    }
  } else {
    cy += 10;
  }

  // Barcode value text (centred)
  doc.font('Helvetica').fontSize(7).fillColor('#000000');
  doc.text(barcodeValue, x + pad, cy, {
    width: w - 2 * pad,
    align: 'center',
  });
  cy += 14;

  // 7 ruled fields
  const fieldW = w - 2 * pad;
  const fieldSpacing = (y + h - pad - cy) / FIELDS.length;
  const lineH = Math.min(fieldSpacing, 24);

  for (const label of FIELDS) {
    // Label text (bold)
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#000000');
    doc.text(`${label}:`, x + pad, cy + 1, {
      width: fieldW,
      align: 'left',
    });
    // Underline for writing
    const lineY = cy + lineH - 3;
    doc.lineWidth(0.5).strokeColor('#999999')
      .moveTo(x + pad, lineY)
      .lineTo(x + pad + fieldW, lineY)
      .stroke();
    cy += lineH;
  }

  doc.restore();
}
