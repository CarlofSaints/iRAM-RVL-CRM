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
    warehouse, releaseRepName, releasedAt, storeRefs, manual,
    rows, boxCount, stickerBarcodes, qrUrl,
    signature, signedByName, deliveredAt,
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

  // Table columns: Article Code | Description | Qty | Value
  const colWidths = [80, 270, 50, 60];
  const totalColW = colWidths.reduce((a, b) => a + b, 0);
  const scale = usableW / totalColW;
  const cols = colWidths.map(w => Math.round(w * scale));
  const sumCols = cols.reduce((a, b) => a + b, 0);
  cols[cols.length - 1] += (Math.round(usableW) - sumCols);

  const rowH = 22;
  const tableHeaderH = 22;

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

  // GRN refs
  if (storeRefs.length > 0) {
    doc.font('Helvetica').fontSize(9);
    doc.text(`GRN/GRV Refs: ${storeRefs.join(', ')}`, leftX, y);
    y += 13;
  }

  // Manual/Uploaded indicator
  if (manual) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#CC0000');
    doc.text('MANUAL CAPTURE', leftX, y);
    doc.fillColor('#000000');
    y += 13;
  }

  y += 5;

  // ── Product table header ──
  const tableX = marginL;
  let colX = tableX;
  doc.font('Helvetica-Bold').fontSize(8);
  const headerLabels = ['Article Code', 'Description', 'Qty', 'Value'];

  for (let c = 0; c < cols.length; c++) {
    doc.rect(colX, y, cols[c], tableHeaderH).stroke();
    doc.text(headerLabels[c], colX + 3, y + 5, {
      width: cols[c] - 6,
      align: c >= 2 ? 'right' : 'left',
    });
    colX += cols[c];
  }
  y += tableHeaderH;

  // ── Product table rows ──
  doc.font('Helvetica').fontSize(8);
  const totalQty = rows.reduce((s, r) => s + r.qty, 0);
  const totalVal = rows.reduce((s, r) => s + r.val, 0);

  for (const r of rows) {
    // Check if we need a new page
    if (y + rowH > pageH - marginB - 200) {
      doc.addPage();
      y = marginT;
    }

    colX = tableX;
    const cellVals = [
      r.articleCode,
      r.description,
      r.qty.toString(),
      manual ? '' : `R ${r.val.toFixed(2)}`,
    ];
    for (let c = 0; c < cols.length; c++) {
      doc.rect(colX, y, cols[c], rowH).stroke();
      if (cellVals[c]) {
        doc.text(cellVals[c], colX + 3, y + 5, {
          width: cols[c] - 6,
          height: rowH - 6,
          align: c >= 2 ? 'right' : 'left',
        });
      }
      colX += cols[c];
    }
    y += rowH;
  }

  // ── Total row ──
  doc.font('Helvetica-Bold').fontSize(8);
  const labelW = cols[0] + cols[1];
  doc.rect(tableX, y, labelW, rowH).stroke();
  doc.text('Total', tableX + labelW - 40, y + 5, { width: 36, align: 'right' });
  doc.rect(tableX + labelW, y, cols[2], rowH).stroke();
  doc.text(totalQty.toString(), tableX + labelW + 3, y + 5, { width: cols[2] - 6, align: 'right' });
  doc.rect(tableX + labelW + cols[2], y, cols[3], rowH).stroke();
  if (!manual) {
    doc.text(`R ${totalVal.toFixed(2)}`, tableX + labelW + cols[2] + 3, y + 5, { width: cols[3] - 6, align: 'right' });
  }
  y += rowH + 10;

  // ── Box count + sticker barcodes ──
  doc.font('Helvetica').fontSize(9);
  doc.text(`Boxes: ${boxCount}`, leftX, y);
  y += 13;
  if (stickerBarcodes.length > 0) {
    doc.font('Helvetica').fontSize(8).fillColor('#555555');
    doc.text(`Stickers: ${stickerBarcodes.join(', ')}`, leftX, y, { width: usableW });
    doc.fillColor('#000000');
    y += Math.ceil(stickerBarcodes.length / 5) * 12 + 5;
  }

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
