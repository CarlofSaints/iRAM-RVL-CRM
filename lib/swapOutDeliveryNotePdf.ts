/**
 * Swap-Out Delivery Note PDF generator.
 *
 * The paperwork for the LAST leg of a swap-out: the damaged/faulty stock
 * leaving the iRam warehouse to go back to the supplier. The supplier's
 * collector signs it — on paper, or by scanning the QR code and signing on a
 * phone, which is the same pattern the aged-stock delivery note uses.
 *
 * Deliberately its own generator rather than a branch inside deliveryNotePdf.ts:
 * an aged-stock note is about box count and GRN/GRV value, a swap-out note is
 * about which faulty units are going back against which picking number and POD.
 * Follows the same pdfkit layout conventions so the two look like siblings.
 */

import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const bwipjs = require('bwip-js') as {
  toBuffer(opts: { bcid: string; text: string; scale: number; height: number; includetext: boolean }): Promise<Buffer>;
};

export interface SwapOutDeliveryNoteRow {
  product: string;
  description: string;
  /** Units the store originally asked to be swapped out. */
  requested: number;
  /** Good replacement units issued out of the warehouse. */
  issued: number;
  /** Faulty units booked back in — what is physically going back to the supplier. */
  returned: number;
}

export interface SwapOutDeliveryNoteParams {
  swapOutId: string;
  pickingNumber: string;
  /** Supplier POD for the GOOD replacement stock this swap was made against. */
  podNumber?: string;
  clientName: string;
  vendorNumber: string;
  storeName: string;
  storeCode?: string;
  channel?: string;
  region?: string;
  repName?: string;
  releasedAt?: string; // ISO
  releasedByName?: string;
  releaseReference?: string;
  rows: SwapOutDeliveryNoteRow[];
  /** Full URL behind the QR code — the public sign-off page. */
  qrUrl: string;
  /** base64 PNG from the signature pad; when present the note renders as signed. */
  signature?: string;
  signedByName?: string;
  signedAt?: string; // ISO
}

const TZ = 'Africa/Johannesburg';

/**
 * Render an absent value as an em dash. `?? '—'` is not enough on its own:
 * these fields arrive as '' at least as often as undefined, and a label with
 * nothing after it reads as a broken document rather than an empty field.
 */
const orDash = (v?: string | null): string => (v && v.trim() ? v.trim() : '—');

function fmtDateTime(iso?: string): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return (
      d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: TZ }) +
      ' ' +
      d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ })
    );
  } catch {
    return iso;
  }
}

export async function generateSwapOutDeliveryNotePdf(
  params: SwapOutDeliveryNoteParams
): Promise<Buffer> {
  const {
    swapOutId, pickingNumber, podNumber, clientName, vendorNumber,
    storeName, storeCode, channel, region, repName, releasedAt,
    releasedByName, releaseReference, rows, qrUrl,
    signature, signedByName, signedAt,
  } = params;

  let signatureBuffer: Buffer | null = null;
  if (signature) {
    try {
      signatureBuffer = Buffer.from(signature.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    } catch { /* skip */ }
  }

  const pageW = 595.28; // A4
  const pageH = 841.89;
  const marginL = 40;
  const marginR = 40;
  const marginT = 40;
  const marginB = 40;
  const usableW = pageW - marginL - marginR;

  let iramLogoBuffer: Buffer | null = null;
  let ojLogoBuffer: Buffer | null = null;
  try {
    const p = path.join(process.cwd(), 'public', 'iram-logo.png');
    if (fs.existsSync(p)) iramLogoBuffer = fs.readFileSync(p);
  } catch { /* skip */ }
  try {
    const p = path.join(process.cwd(), 'public', 'oj-logo.jpg');
    if (fs.existsSync(p)) ojLogoBuffer = fs.readFileSync(p);
  } catch { /* skip */ }

  // The picking number is the barcode the supplier's own system knows.
  let barcodeBuffer: Buffer | null = null;
  if (pickingNumber) {
    try {
      barcodeBuffer = await bwipjs.toBuffer({
        bcid: 'code128', text: pickingNumber, scale: 3, height: 10, includetext: true,
      });
    } catch { /* skip */ }
  }

  let qrBuffer: Buffer | null = null;
  try {
    const dataUrl = await QRCode.toDataURL(qrUrl, { width: 200, margin: 1 });
    qrBuffer = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  } catch { /* skip */ }

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: marginT, bottom: marginB, left: marginL, right: marginR },
    bufferPages: true,
    info: {
      Title: `Swap-Out Delivery Note - ${pickingNumber || swapOutId}`,
      Author: 'iRamFlow — OuterJoin',
    },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));

  let y = marginT;

  if (iramLogoBuffer) {
    try { doc.image(iramLogoBuffer, marginL, y, { height: 30 }); } catch { /* skip */ }
  }

  doc.font('Helvetica-Bold').fontSize(18);
  doc.text('iRam Swap-Out Delivery Note', marginL, y, { width: usableW, align: 'center' });
  y += 26;
  doc.font('Helvetica').fontSize(9).fillColor('#666666');
  doc.text('Faulty stock returned to supplier', marginL, y, { width: usableW, align: 'center' });
  doc.fillColor('#000000');
  y += 16;

  if (barcodeBuffer) {
    try {
      const bcW = 200, bcH = 40;
      doc.image(barcodeBuffer, marginL + (usableW - bcW) / 2, y, { width: bcW, height: bcH });
      y += bcH + 8;
    } catch { /* skip */ }
  }

  // ── Header block ──
  const leftX = marginL;
  const rightX = marginL + usableW / 2;

  doc.font('Helvetica-Bold').fontSize(10);
  doc.text(`${clientName}${vendorNumber ? ` - ${vendorNumber}` : ''}`, leftX, y);
  doc.font('Helvetica').fontSize(10);
  doc.text(`Released: ${fmtDateTime(releasedAt)}`, rightX, y, { width: usableW / 2, align: 'right' });
  y += 15;

  doc.font('Helvetica-Bold').fontSize(10);
  doc.text(`${storeName}${storeCode ? ` - ${storeCode}` : ''}`, leftX, y);
  doc.font('Helvetica').fontSize(10);
  doc.text(`Released by: ${orDash(releasedByName)}`, rightX, y, { width: usableW / 2, align: 'right' });
  y += 15;

  doc.font('Helvetica').fontSize(10);
  doc.text(`Picking #: ${orDash(pickingNumber)}`, leftX, y);
  doc.text(`Rep: ${orDash(repName)}`, rightX, y, { width: usableW / 2, align: 'right' });
  y += 15;

  // The POD is the whole reason this release is allowed to happen — it belongs
  // on the face of the document, not buried in the system.
  doc.font('Helvetica-Bold').fontSize(10);
  doc.text(`POD (replacement stock): ${orDash(podNumber)}`, leftX, y, { width: usableW });
  doc.font('Helvetica').fontSize(10);
  y += 15;

  if (channel || region || releaseReference) {
    doc.fontSize(9).fillColor('#555555');
    doc.text(
      [channel ? `Channel: ${channel}` : '', region ? `Region: ${region}` : '', releaseReference ? `Ref: ${releaseReference}` : '']
        .filter(Boolean)
        .join('   |   '),
      leftX,
      y,
      { width: usableW }
    );
    doc.fillColor('#000000').fontSize(10);
    y += 14;
  }

  y += 8;

  // ── Line table ──
  const colProduct = 110;
  const colDesc = usableW - colProduct - 60 - 60 - 70;
  const colReq = 60;
  const colIss = 60;
  const colRet = 70;
  const headH = 20;

  doc.rect(marginL, y, usableW, headH).fillAndStroke('#f0f0f0', '#000000');
  doc.fillColor('#000000').font('Helvetica-Bold').fontSize(9);
  let cx = marginL;
  doc.text('Product', cx + 4, y + 6, { width: colProduct - 8 }); cx += colProduct;
  doc.text('Description', cx + 4, y + 6, { width: colDesc - 8 }); cx += colDesc;
  doc.text('Requested', cx + 4, y + 6, { width: colReq - 8, align: 'right' }); cx += colReq;
  doc.text('Good out', cx + 4, y + 6, { width: colIss - 8, align: 'right' }); cx += colIss;
  doc.text('FAULTY BACK', cx + 4, y + 6, { width: colRet - 8, align: 'right' });
  y += headH;

  doc.font('Helvetica').fontSize(9);
  let totalReturned = 0;
  for (const r of rows) {
    if (y + 18 > pageH - marginB - 60) {
      doc.addPage();
      y = marginT;
    }
    const rowH = 18;
    doc.rect(marginL, y, usableW, rowH).stroke();
    cx = marginL;
    doc.text(r.product, cx + 4, y + 5, { width: colProduct - 8, ellipsis: true }); cx += colProduct;
    doc.text(orDash(r.description), cx + 4, y + 5, { width: colDesc - 8, ellipsis: true }); cx += colDesc;
    doc.text(String(r.requested), cx + 4, y + 5, { width: colReq - 8, align: 'right' }); cx += colReq;
    doc.text(String(r.issued), cx + 4, y + 5, { width: colIss - 8, align: 'right' }); cx += colIss;
    doc.font('Helvetica-Bold');
    doc.text(String(r.returned), cx + 4, y + 5, { width: colRet - 8, align: 'right' });
    doc.font('Helvetica');
    totalReturned += r.returned;
    y += rowH;
  }

  // ── Total ──
  const totH = 24;
  doc.rect(marginL, y, usableW, totH).stroke();
  doc.font('Helvetica-Bold').fontSize(11);
  doc.text('Total faulty units returned to supplier', marginL + 8, y + 7, { width: usableW - 100 });
  doc.text(String(totalReturned), marginL + usableW - 78, y + 7, { width: 70, align: 'right' });
  doc.font('Helvetica').fontSize(10);
  y += totH + 10;

  // Never let a note claim a return that has nothing in it without saying so.
  if (totalReturned === 0) {
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#CC0000');
    doc.text('NO FAULTY UNITS WERE BOOKED IN AGAINST THIS SWAP-OUT', marginL, y, {
      width: usableW,
      align: 'center',
    });
    doc.fillColor('#000000').font('Helvetica').fontSize(10);
    y += 18;
  }

  // Keep the QR and the signature block together on one page.
  if (y + 250 > pageH - marginB) {
    doc.addPage();
    y = marginT;
  }

  if (qrBuffer && !signatureBuffer) {
    y += 5;
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text('Scan to sign for this return', marginL, y, { width: usableW, align: 'center' });
    y += 16;
    try {
      const qrSize = 120;
      doc.image(qrBuffer, marginL + (usableW - qrSize) / 2, y, { width: qrSize, height: qrSize });
      y += qrSize + 8;
    } catch { /* skip */ }
    doc.font('Helvetica').fontSize(7).fillColor('#888888');
    doc.text(qrUrl, marginL, y, { width: usableW, align: 'center' });
    doc.fillColor('#000000');
    y += 15;
  }

  // ── Signature block ──
  y += 10;
  if (signatureBuffer) {
    doc.font('Helvetica-Bold').fontSize(9);
    doc.text('Collected / received by (supplier):', marginL, y);
    y += 14;
    try { doc.image(signatureBuffer, marginL, y, { height: 50 }); } catch { /* skip */ }
    y += 55;
    doc.font('Helvetica').fontSize(9);
    if (signedByName) { doc.text(`Name: ${signedByName}`, marginL, y); y += 13; }
    doc.text(`Date: ${fmtDateTime(signedAt)}`, marginL, y);
    y += 20;
  } else {
    doc.font('Helvetica').fontSize(9);
    const sigW = usableW * 0.55;
    const dateW = usableW * 0.35;
    doc.rect(marginL, y, sigW, 35).stroke();
    doc.text('Supplier Representative Name & Signature', marginL + 4, y + 12);
    doc.rect(marginL + usableW - dateW, y, dateW, 35).stroke();
    doc.text('Date', marginL + usableW - dateW + 4, y + 12);
    y += 50;
  }

  // ── Branding footer ──
  const brandY = pageH - marginB - 30;
  doc.font('Helvetica').fontSize(8).fillColor('#888888');
  if (ojLogoBuffer) {
    try {
      const logoH = 40;
      const logoW = logoH * 2;
      const txt = 'Powered by';
      const textW = doc.widthOfString(txt);
      const gap = 6;
      const startX = marginL + (usableW - (textW + gap + logoW)) / 2;
      doc.text(txt, startX, brandY + logoH / 2 - 4);
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

/**
 * The agreed file name for a signed swap-out note. Mirrors the aged-stock
 * convention `{siteName} {siteCode} - DN-{slipId} - SIGNED.pdf` so both sets of
 * paperwork read alike in SharePoint.
 */
export function signedSwapOutNoteFileName(opts: {
  storeName: string;
  storeCode?: string;
  pickingNumber: string;
  swapOutId: string;
}): string {
  const store = [opts.storeName, opts.storeCode].filter(Boolean).join(' ');
  const ref = opts.pickingNumber || opts.swapOutId.slice(0, 8);
  return `${store} - SWAPOUT-${ref} - SIGNED.pdf`.replace(/[\\/:*?"<>|]/g, '-');
}
