/**
 * Delivery Note PDF generator.
 *
 * Generates a single delivery note when stock is released (in-transit).
 * Contains a QR code that links to the public delivery confirmation mini-site.
 * Follows the same pdfkit pattern as pickSlipPdf.ts.
 */

import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const bwipjs = require('bwip-js') as {
  toBuffer(opts: { bcid: string; text: string; scale: number; height: number; includetext: boolean }): Promise<Buffer>;
};

export interface DeliveryNotePdfRow {
  articleCode: string;
  description: string;
  qty: number;
  val: number;
}

/**
 * Value of the GRN/GRV document(s) for a slip. Prefer the value captured at
 * receipt (the store document value); fall back to the stock value (sum of row
 * values) when no receipt value was entered.
 */
function documentValue(receiptValue: string | undefined, rows: { val: number }[]): number {
  const parsed = parseFloat((receiptValue ?? '').replace(/[^0-9.]/g, ''));
  if (!isNaN(parsed) && parsed > 0) return parsed;
  return rows.reduce((s, r) => s + r.val, 0);
}

export interface DeliveryNotePdfParams {
  pickSlipId: string;
  clientName: string;
  vendorNumber: string;
  siteName: string;
  siteCode: string;
  warehouse: string;
  releaseRepName: string;
  releasedAt: string; // ISO
  /** GRN/GRV reference numbers */
  storeRefs: string[];
  /** GRN/GRV document date (captured at receipt) */
  receiptGrnDate?: string;
  /** GRN/GRV document value captured at receipt (string, may include "R"/commas) */
  receiptValue?: string;
  /** Whether this was a manual capture pick slip */
  manual?: boolean;
  rows: DeliveryNotePdfRow[];
  /** Box count */
  boxCount: number;
  /** Sticker barcodes of released boxes */
  stickerBarcodes: string[];
  /** Full URL for the QR code (e.g. https://iram-rvl-crm.vercel.app/delivery/{token}) */
  qrUrl: string;
  /** Optional base64 PNG signature — if provided, rendered in the signature block */
  signature?: string;
  /** Name of the person who signed */
  signedByName?: string;
  /** ISO timestamp of when delivery was confirmed */
  deliveredAt?: string;
}

/**
 * Generate a delivery note PDF. Returns the PDF as a Buffer.
 */
export async function generateDeliveryNotePdf(params: DeliveryNotePdfParams): Promise<Buffer> {
  const {
    pickSlipId, clientName, vendorNumber, siteName, siteCode,
    warehouse, releaseRepName, releasedAt, storeRefs, receiptGrnDate,
    receiptValue, manual, rows, boxCount, qrUrl,
    signature, signedByName, deliveredAt,
  } = params;

  const docVal = documentValue(receiptValue, rows);

  // Parse signature image if provided
  let signatureBuffer: Buffer | null = null;
  if (signature) {
    try {
      const base64Data = signature.replace(/^data:image\/\w+;base64,/, '');
      signatureBuffer = Buffer.from(base64Data, 'base64');
    } catch { /* skip */ }
  }

  const pageW = 595.28; // A4
  const marginL = 40;
  const marginR = 40;
  const marginT = 40;
  const marginB = 40;
  const usableW = pageW - marginL - marginR;
  const pageH = 841.89;

  // Load logos
  let iramLogoBuffer: Buffer | null = null;
  let ojLogoBuffer: Buffer | null = null;
  try {
    const iramPath = path.join(process.cwd(), 'public', 'iram-logo.png');
    if (fs.existsSync(iramPath)) iramLogoBuffer = fs.readFileSync(iramPath);
  } catch { /* skip */ }
  try {
    const ojPath = path.join(process.cwd(), 'public', 'oj-logo.jpg');
    if (fs.existsSync(ojPath)) ojLogoBuffer = fs.readFileSync(ojPath);
  } catch { /* skip */ }

  // Generate Code128 barcode for pick slip ID
  let barcodeBuffer: Buffer | null = null;
  try {
    barcodeBuffer = await bwipjs.toBuffer({
      bcid: 'code128',
      text: pickSlipId,
      scale: 3,
      height: 10,
      includetext: true,
    });
  } catch { /* skip */ }

  // Generate QR code as PNG data URL
  let qrBuffer: Buffer | null = null;
  try {
    const qrDataUrl = await QRCode.toDataURL(qrUrl, { width: 200, margin: 1 });
    // Convert data URL to Buffer
    const base64 = qrDataUrl.replace(/^data:image\/png;base64,/, '');
    qrBuffer = Buffer.from(base64, 'base64');
  } catch { /* skip */ }

  // Format release date
  let releaseDateStr = releasedAt;
  try {
    const d = new Date(releasedAt);
    const tz = 'Africa/Johannesburg';
    releaseDateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: tz })
      + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  } catch { /* keep raw */ }

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: marginT, bottom: marginB, left: marginL, right: marginR },
    bufferPages: true,
    info: {
      Title: `Delivery Note - ${pickSlipId}`,
      Author: 'iRamFlow — OuterJoin',
    },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  let y = marginT;

  // ── iRam logo (top-left) ──
  if (iramLogoBuffer) {
    try {
      doc.image(iramLogoBuffer, marginL, y, { height: 30 });
    } catch { /* skip */ }
  }

  // ── Title ──
  doc.font('Helvetica-Bold').fontSize(18);
  doc.text('iRam Delivery Note', marginL, y, { width: usableW, align: 'center' });
  y += 30;

  // ── Pick slip barcode ──
  if (barcodeBuffer) {
    try {
      const bcW = 200;
      const bcH = 40;
      const bcX = marginL + (usableW - bcW) / 2;
      doc.image(barcodeBuffer, bcX, y, { width: bcW, height: bcH });
      y += bcH + 8;
    } catch { /* skip */ }
  }

  // ── Header info ──
  doc.font('Helvetica').fontSize(9);
  const leftX = marginL;
  const rightX = marginL + usableW / 2;

  doc.font('Helvetica-Bold').fontSize(10);
  doc.text(`${clientName} - ${vendorNumber}`, leftX, y);
  doc.font('Helvetica').fontSize(10);
  doc.text(`Warehouse: ${warehouse}`, rightX, y, { width: usableW / 2, align: 'right' });
  y += 15;

  doc.font('Helvetica-Bold').fontSize(10);
  doc.text(`${siteName} - ${siteCode}`, leftX, y);
  doc.font('Helvetica').fontSize(10);
  doc.text(`Released: ${releaseDateStr}`, rightX, y, { width: usableW / 2, align: 'right' });
  y += 15;

  doc.font('Helvetica').fontSize(10);
  doc.text(`Pick Slip: ${pickSlipId}`, leftX, y);
  doc.text(`Collecting Rep: ${releaseRepName}`, rightX, y, { width: usableW / 2, align: 'right' });
  y += 15;

  const tableX = marginL;

  // GRN/GRV number(s) + date
  if (storeRefs.length > 0 || receiptGrnDate) {
    doc.font('Helvetica-Bold').fontSize(10);
    const refText = storeRefs.length > 0 ? storeRefs.join(', ') : '—';
    doc.text(`GRN/GRV: ${refText}${receiptGrnDate ? `   |   Date: ${receiptGrnDate}` : ''}`, leftX, y, { width: usableW });
    doc.font('Helvetica').fontSize(10);
    y += 16;
  }

  // Manual/Uploaded indicator
  if (manual) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#CC0000');
    doc.text('MANUAL CAPTURE', leftX, y);
    doc.fillColor('#000000');
    y += 13;
  }

  y += 8;

  // ── Value + box count (no article breakdown) ──
  const summaryH = 30;
  doc.rect(tableX, y, usableW, summaryH).stroke();
  doc.font('Helvetica-Bold').fontSize(12);
  doc.text(`Value: R ${docVal.toFixed(2)}`, tableX + 8, y + 9, { width: usableW / 2 - 12 });
  doc.text(`Boxes: ${boxCount}`, tableX + usableW / 2, y + 9, { width: usableW / 2 - 8, align: 'right' });
  doc.font('Helvetica').fontSize(10);
  y += summaryH + 12;

  // Check space for QR + signature — if not enough, add page
  const neededSpace = 250;
  if (y + neededSpace > pageH - marginB) {
    doc.addPage();
    y = marginT;
  }

  // ── QR Code ──
  if (qrBuffer) {
    y += 5;
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text('Scan to Confirm Delivery', marginL, y, { width: usableW, align: 'center' });
    y += 16;
    try {
      const qrSize = 120;
      const qrX = marginL + (usableW - qrSize) / 2;
      doc.image(qrBuffer, qrX, y, { width: qrSize, height: qrSize });
      y += qrSize + 8;
    } catch { /* skip */ }
    doc.font('Helvetica').fontSize(7).fillColor('#888888');
    doc.text(qrUrl, marginL, y, { width: usableW, align: 'center' });
    doc.fillColor('#000000');
    y += 15;
  }

  // ── Physical signature block ──
  y += 10;
  if (signatureBuffer) {
    // Signed version — show signature image + name + date
    doc.font('Helvetica-Bold').fontSize(9);
    doc.text('Received By:', tableX, y);
    y += 14;
    try {
      doc.image(signatureBuffer, tableX, y, { height: 50 });
    } catch { /* skip */ }
    y += 55;
    doc.font('Helvetica').fontSize(9);
    if (signedByName) {
      doc.text(`Name: ${signedByName}`, tableX, y);
      y += 13;
    }
    if (deliveredAt) {
      let deliveredDateStr = deliveredAt;
      try {
        const dd = new Date(deliveredAt);
        const tz = 'Africa/Johannesburg';
        deliveredDateStr = dd.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: tz })
          + ' ' + dd.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
      } catch { /* keep raw */ }
      doc.text(`Date: ${deliveredDateStr}`, tableX, y);
      y += 13;
    }
    y += 10;
  } else {
    // Unsigned version — blank boxes for physical signing
    doc.font('Helvetica').fontSize(9);
    const sigBlockW = usableW * 0.55;
    const dateBlockW = usableW * 0.35;
    doc.rect(tableX, y, sigBlockW, 35).stroke();
    doc.text('Vendor Representative Name & Signature', tableX + 4, y + 12);
    doc.rect(tableX + usableW - dateBlockW, y, dateBlockW, 35).stroke();
    doc.text('Date', tableX + usableW - dateBlockW + 4, y + 12);
    y += 50;
  }

  // ── Branding footer ──
  const brandY = pageH - marginB - 30;
  doc.font('Helvetica').fontSize(8).fillColor('#888888');
  if (ojLogoBuffer) {
    try {
      const logoH = 40;
      const logoW = logoH * 2;
      const poweredText = 'Powered by';
      const textW = doc.widthOfString(poweredText);
      const gap = 6;
      const totalW = textW + gap + logoW;
      const startX = marginL + (usableW - totalW) / 2;
      doc.text(poweredText, startX, brandY + (logoH / 2) - 4);
      doc.image(ojLogoBuffer, startX + textW + gap, brandY, { height: logoH });
    } catch {
      doc.text('Powered by OuterJoin', marginL, brandY, { width: usableW, align: 'center' });
    }
  } else {
    doc.text('Powered by OuterJoin', marginL, brandY, { width: usableW, align: 'center' });
  }
  doc.fillColor('#000000');

  doc.end();

  return new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

// ── Multi-slip delivery note ────────────────────────────────────────────────

export interface MultiSlipSection {
  pickSlipId: string;
  siteName: string;
  siteCode: string;
  warehouse: string;
  storeRefs: string[];
  receiptGrnDate?: string;
  /** GRN/GRV document value captured at receipt (string, may include "R"/commas) */
  receiptValue?: string;
  manual?: boolean;
  rows: DeliveryNotePdfRow[];
  stickerBarcodes: string[];
}

export interface MultiSlipDeliveryNotePdfParams {
  clientName: string;
  vendorNumber: string;
  releaseRepName: string;
  releasedAt: string; // ISO
  qrUrl: string;
  slips: MultiSlipSection[];
  signature?: string;
  signedByName?: string;
  deliveredAt?: string;
}

/**
 * Generate a multi-slip delivery note PDF covering multiple pick slips.
 * Each slip gets its own product table section, followed by a combined box
 * summary table and grand totals.
 */
export async function generateMultiSlipDeliveryNotePdf(params: MultiSlipDeliveryNotePdfParams): Promise<Buffer> {
  const {
    clientName, vendorNumber, releaseRepName, releasedAt, qrUrl,
    slips, signature, signedByName, deliveredAt,
  } = params;

  // Parse signature image if provided
  let signatureBuffer: Buffer | null = null;
  if (signature) {
    try {
      const base64Data = signature.replace(/^data:image\/\w+;base64,/, '');
      signatureBuffer = Buffer.from(base64Data, 'base64');
    } catch { /* skip */ }
  }

  const pageW = 595.28; // A4
  const marginL = 40;
  const marginR = 40;
  const marginT = 40;
  const marginB = 40;
  const usableW = pageW - marginL - marginR;
  const pageH = 841.89;
  const tableX = marginL;
  const leftX = marginL;
  const rightX = marginL + usableW / 2;

  // Load logos
  let iramLogoBuffer: Buffer | null = null;
  let ojLogoBuffer: Buffer | null = null;
  try {
    const iramPath = path.join(process.cwd(), 'public', 'iram-logo.png');
    if (fs.existsSync(iramPath)) iramLogoBuffer = fs.readFileSync(iramPath);
  } catch { /* skip */ }
  try {
    const ojPath = path.join(process.cwd(), 'public', 'oj-logo.jpg');
    if (fs.existsSync(ojPath)) ojLogoBuffer = fs.readFileSync(ojPath);
  } catch { /* skip */ }

  // Generate QR code
  let qrBuffer: Buffer | null = null;
  try {
    const qrDataUrl = await QRCode.toDataURL(qrUrl, { width: 200, margin: 1 });
    const base64 = qrDataUrl.replace(/^data:image\/png;base64,/, '');
    qrBuffer = Buffer.from(base64, 'base64');
  } catch { /* skip */ }

  // Format release date
  let releaseDateStr = releasedAt;
  try {
    const d = new Date(releasedAt);
    const tz = 'Africa/Johannesburg';
    releaseDateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: tz })
      + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  } catch { /* keep raw */ }

  const allSlipIds = slips.map(s => s.pickSlipId).join(', ');

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: marginT, bottom: marginB, left: marginL, right: marginR },
    bufferPages: true,
    info: {
      Title: `Delivery Note - ${allSlipIds}`,
      Author: 'iRamFlow — OuterJoin',
    },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  let y = marginT;

  // Helper: check if we need a new page
  const ensureSpace = (needed: number) => {
    if (y + needed > pageH - marginB) {
      doc.addPage();
      y = marginT;
    }
  };

  // ── iRam logo (top-left) ──
  if (iramLogoBuffer) {
    try { doc.image(iramLogoBuffer, marginL, y, { height: 30 }); } catch { /* skip */ }
  }

  // ── Title ──
  doc.font('Helvetica-Bold').fontSize(18);
  doc.text('iRam Delivery Note', marginL, y, { width: usableW, align: 'center' });
  y += 35;

  // ── Header info ──
  doc.font('Helvetica-Bold').fontSize(10);
  doc.text(`${clientName} - ${vendorNumber}`, leftX, y);
  doc.font('Helvetica').fontSize(10);
  doc.text(`Released: ${releaseDateStr}`, rightX, y, { width: usableW / 2, align: 'right' });
  y += 15;

  doc.font('Helvetica').fontSize(10);
  doc.text(`Collecting Rep: ${releaseRepName}`, leftX, y);
  doc.text(`Pick Slips: ${slips.length}`, rightX, y, { width: usableW / 2, align: 'right' });
  y += 20;

  // ── Per-slip sections (no article breakdown) ──
  let grandVal = 0;

  // Table: Pick Slip / Store | GRN/GRV (+date) | Boxes | Value
  const dnColWidths = [200, 190, 45, 80];
  const dnColW = dnColWidths.reduce((a, b) => a + b, 0);
  const dnScale = usableW / dnColW;
  const dnCols = dnColWidths.map(w => Math.round(w * dnScale));
  const dnSum = dnCols.reduce((a, b) => a + b, 0);
  dnCols[dnCols.length - 1] += (Math.round(usableW) - dnSum);
  const dnRowH = 40;
  const dnHeaderH = 20;

  // Header
  ensureSpace(dnHeaderH + dnRowH);
  let colX = tableX;
  doc.font('Helvetica-Bold').fontSize(8);
  const dnHeaders = ['Pick Slip / Store', 'GRN/GRV & Date', 'Boxes', 'Value'];
  for (let c = 0; c < dnCols.length; c++) {
    doc.rect(colX, y, dnCols[c], dnHeaderH).stroke();
    doc.text(dnHeaders[c], colX + 4, y + 6, { width: dnCols[c] - 8, align: c >= 2 ? 'right' : 'left' });
    colX += dnCols[c];
  }
  y += dnHeaderH;

  // Rows — one per slip
  for (const slip of slips) {
    const slipVal = documentValue(slip.receiptValue, slip.rows);
    grandVal += slipVal;
    ensureSpace(dnRowH + 6);

    colX = tableX;
    // cell heights are uniform; draw all borders first
    for (let c = 0; c < dnCols.length; c++) {
      doc.rect(colX, y, dnCols[c], dnRowH).stroke();
      colX += dnCols[c];
    }

    // Col 0: Pick slip + store (+ MANUAL)
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000000');
    doc.text(slip.pickSlipId, tableX + 4, y + 5, { width: dnCols[0] - 8 });
    doc.font('Helvetica').fontSize(8);
    doc.text(`${slip.siteName} (${slip.siteCode})`, tableX + 4, y + 17, { width: dnCols[0] - 8 });
    if (slip.manual) {
      doc.font('Helvetica-Bold').fontSize(6).fillColor('#CC0000');
      doc.text('MANUAL CAPTURE', tableX + 4, y + 29, { width: dnCols[0] - 8 });
      doc.fillColor('#000000');
    }

    // Col 1: GRN/GRV + date
    const c1x = tableX + dnCols[0];
    doc.font('Helvetica').fontSize(8);
    doc.text(slip.storeRefs.length > 0 ? slip.storeRefs.join(', ') : '—', c1x + 4, y + 5, { width: dnCols[1] - 8 });
    if (slip.receiptGrnDate) {
      doc.fillColor('#555555');
      doc.text(`Date: ${slip.receiptGrnDate}`, c1x + 4, y + 22, { width: dnCols[1] - 8 });
      doc.fillColor('#000000');
    }

    // Col 2: boxes
    const c2x = c1x + dnCols[1];
    doc.text(String(slip.stickerBarcodes.length), c2x + 4, y + 15, { width: dnCols[2] - 8, align: 'right' });

    // Col 3: value
    const c3x = c2x + dnCols[2];
    doc.font('Helvetica-Bold').fontSize(9);
    doc.text(`R ${slipVal.toFixed(2)}`, c3x + 4, y + 15, { width: dnCols[3] - 8, align: 'right' });
    doc.font('Helvetica').fontSize(8);

    y += dnRowH;
  }

  // ── Combined total ──
  ensureSpace(30);
  const totalBoxes = slips.reduce((s, sl) => s + sl.stickerBarcodes.length, 0);
  const labelW = dnCols[0] + dnCols[1];
  doc.font('Helvetica-Bold').fontSize(9);
  doc.rect(tableX, y, labelW, dnHeaderH).stroke();
  doc.text(`Combined — ${slips.length} slips`, tableX + 4, y + 6, { width: labelW - 8, align: 'right' });
  doc.rect(tableX + labelW, y, dnCols[2], dnHeaderH).stroke();
  doc.text(String(totalBoxes), tableX + labelW + 4, y + 6, { width: dnCols[2] - 8, align: 'right' });
  doc.rect(tableX + labelW + dnCols[2], y, dnCols[3], dnHeaderH).stroke();
  doc.text(`R ${grandVal.toFixed(2)}`, tableX + labelW + dnCols[2] + 4, y + 6, { width: dnCols[3] - 8, align: 'right' });
  y += dnHeaderH + 12;

  // ── QR Code ──
  ensureSpace(200);
  if (qrBuffer) {
    y += 5;
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text('Scan to Confirm Delivery', marginL, y, { width: usableW, align: 'center' });
    y += 16;
    try {
      const qrSize = 120;
      const qrX = marginL + (usableW - qrSize) / 2;
      doc.image(qrBuffer, qrX, y, { width: qrSize, height: qrSize });
      y += qrSize + 8;
    } catch { /* skip */ }
    doc.font('Helvetica').fontSize(7).fillColor('#888888');
    doc.text(qrUrl, marginL, y, { width: usableW, align: 'center' });
    doc.fillColor('#000000');
    y += 15;
  }

  // ── Physical signature block ──
  ensureSpace(80);
  y += 10;
  if (signatureBuffer) {
    doc.font('Helvetica-Bold').fontSize(9);
    doc.text('Received By:', tableX, y);
    y += 14;
    try { doc.image(signatureBuffer, tableX, y, { height: 50 }); } catch { /* skip */ }
    y += 55;
    doc.font('Helvetica').fontSize(9);
    if (signedByName) {
      doc.text(`Name: ${signedByName}`, tableX, y);
      y += 13;
    }
    if (deliveredAt) {
      let deliveredDateStr = deliveredAt;
      try {
        const dd = new Date(deliveredAt);
        const tz = 'Africa/Johannesburg';
        deliveredDateStr = dd.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: tz })
          + ' ' + dd.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
      } catch { /* keep raw */ }
      doc.text(`Date: ${deliveredDateStr}`, tableX, y);
      y += 13;
    }
    y += 10;
  } else {
    doc.font('Helvetica').fontSize(9);
    const sigBlockW = usableW * 0.55;
    const dateBlockW = usableW * 0.35;
    doc.rect(tableX, y, sigBlockW, 35).stroke();
    doc.text('Vendor Representative Name & Signature', tableX + 4, y + 12);
    doc.rect(tableX + usableW - dateBlockW, y, dateBlockW, 35).stroke();
    doc.text('Date', tableX + usableW - dateBlockW + 4, y + 12);
    y += 50;
  }

  // ── Branding footer ──
  const brandY = pageH - marginB - 30;
  doc.font('Helvetica').fontSize(8).fillColor('#888888');
  if (ojLogoBuffer) {
    try {
      const logoH = 40;
      const logoW = logoH * 2;
      const poweredText = 'Powered by';
      const textW = doc.widthOfString(poweredText);
      const gap = 6;
      const totalW = textW + gap + logoW;
      const startX = marginL + (usableW - totalW) / 2;
      doc.text(poweredText, startX, brandY + (logoH / 2) - 4);
      doc.image(ojLogoBuffer, startX + textW + gap, brandY, { height: logoH });
    } catch {
      doc.text('Powered by OuterJoin', marginL, brandY, { width: usableW, align: 'center' });
    }
  } else {
    doc.text('Powered by OuterJoin', marginL, brandY, { width: usableW, align: 'center' });
  }
  doc.fillColor('#000000');

  doc.end();

  return new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}
