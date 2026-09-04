/**
 * Promo Kit Delivery Note PDF generator.
 *
 * The paperwork for dropping a promo kit at a store and leaving it there. Nine
 * times out of ten a rep drops a kit off, the store manager keeps it for the
 * weekend and it is collected the following week — so the one thing this note
 * has to produce is a name and a signature from whoever at the store took it.
 *
 * Deliberately its own generator rather than a branch inside
 * swapOutDeliveryNotePdf.ts: that note is about faulty units going back to a
 * supplier against a picking number and a POD, this one is about a countable
 * list of promo material left in someone's care. Same pdfkit layout conventions
 * so the three notes read as siblings.
 *
 * No QR sign-off page here on purpose. The swap-out and aged-stock notes have
 * one because a driver signs on a phone at the point of delivery; a promo kit
 * gets left on a manager's desk, and a signed sheet in the rep's bag is the
 * proof that was asked for.
 */

import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';

export interface PromoDeliveryNoteRow {
  code: string;
  description: string;
  /** Physical units of this line handed over. */
  quantity: number;
}

export interface PromoDeliveryNoteParams {
  kitReference: string;
  kitName: string;
  clientName: string;
  /** Copies of the kit handed over, and how many exist in total. */
  copies: number;
  totalCopies: number;
  storeName?: string;
  storeCode?: string;
  channel?: string;
  region?: string;
  storeManagerName?: string;
  storeManagerPhone?: string;
  /** The promoter working the kit at the store. */
  promoterName?: string;
  /** The person accountable for bringing the kit back. */
  takenByName: string;
  takenByEmail?: string;
  bookedOutAt: string; // ISO
  bookedOutByName: string;
  /** The tick-list the store counts against as the kit is handed over. */
  rows: PromoDeliveryNoteRow[];
  note?: string;
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

export async function generatePromoDeliveryNotePdf(
  params: PromoDeliveryNoteParams,
): Promise<Buffer> {
  const {
    kitReference, kitName, clientName, copies, totalCopies,
    storeName, storeCode, channel, region, storeManagerName, storeManagerPhone,
    promoterName, takenByName, takenByEmail, bookedOutAt, bookedOutByName, note,
  } = params;

  const rows = params.rows ?? [];

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

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: marginT, bottom: marginB, left: marginL, right: marginR },
    bufferPages: true,
    info: {
      Title: `Promo Kit Delivery Note - ${kitReference}`,
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
  doc.text('Promotional Material Delivery Note', marginL, y, { width: usableW, align: 'center' });
  y += 26;
  doc.font('Helvetica').fontSize(9).fillColor('#666666');
  doc.text('Promo kit left in the care of the store', marginL, y, { width: usableW, align: 'center' });
  doc.fillColor('#000000');
  y += 20;

  // ── Header block ──
  const leftX = marginL;
  const rightX = marginL + usableW / 2;

  doc.font('Helvetica-Bold').fontSize(12);
  doc.text(`${kitReference} - ${kitName}`, leftX, y, { width: usableW / 2 });
  doc.font('Helvetica').fontSize(10);
  doc.text(`Delivered: ${fmtDateTime(bookedOutAt)}`, rightX, y + 2, { width: usableW / 2, align: 'right' });
  y += 18;

  doc.font('Helvetica-Bold').fontSize(10);
  doc.text(clientName, leftX, y, { width: usableW / 2 });
  doc.font('Helvetica').fontSize(10);
  doc.text(`Booked out by: ${orDash(bookedOutByName)}`, rightX, y, { width: usableW / 2, align: 'right' });
  y += 15;

  doc.font('Helvetica-Bold').fontSize(10);
  doc.text(storeName ? `${storeName}${storeCode ? ` - ${storeCode}` : ''}` : 'No store recorded', leftX, y, { width: usableW / 2 });
  doc.font('Helvetica').fontSize(10);
  doc.text(
    totalCopies > 1 ? `Copies delivered: ${copies} of ${totalCopies}` : 'Copies delivered: 1',
    rightX, y, { width: usableW / 2, align: 'right' },
  );
  y += 15;

  doc.font('Helvetica').fontSize(10);
  doc.text(`Delivered by: ${orDash(takenByName)}${takenByEmail ? ` (${takenByEmail})` : ''}`, leftX, y, { width: usableW / 2 });
  doc.text(`Promoter: ${orDash(promoterName)}`, rightX, y, { width: usableW / 2, align: 'right' });
  y += 15;

  if (channel || region || storeManagerName || storeManagerPhone) {
    doc.fontSize(9).fillColor('#555555');
    doc.text(
      [
        channel ? `Channel: ${channel}` : '',
        region ? `Region: ${region}` : '',
        storeManagerName ? `Store manager: ${storeManagerName}` : '',
        storeManagerPhone ? `Tel: ${storeManagerPhone}` : '',
      ].filter(Boolean).join('   |   '),
      leftX, y, { width: usableW },
    );
    doc.fillColor('#000000').fontSize(10);
    y += 14;
  }

  y += 8;

  // ── Line table ──
  const colCode = 110;
  const colQty = 70;
  const colTick = 50;
  const colDesc = usableW - colCode - colQty - colTick;
  const headH = 20;

  doc.rect(marginL, y, usableW, headH).fillAndStroke('#f0f0f0', '#000000');
  doc.fillColor('#000000').font('Helvetica-Bold').fontSize(9);
  let cx = marginL;
  doc.text('Item', cx + 4, y + 6, { width: colCode - 8 }); cx += colCode;
  doc.text('Description', cx + 4, y + 6, { width: colDesc - 8 }); cx += colDesc;
  doc.text('Qty', cx + 4, y + 6, { width: colQty - 8, align: 'right' }); cx += colQty;
  doc.text('Check', cx + 4, y + 6, { width: colTick - 8, align: 'center' });
  y += headH;

  doc.font('Helvetica').fontSize(9);
  let totalUnits = 0;
  for (const r of rows) {
    if (y + 18 > pageH - marginB - 60) {
      doc.addPage();
      y = marginT;
    }
    const rowH = 18;
    doc.rect(marginL, y, usableW, rowH).stroke();
    cx = marginL;
    doc.text(r.code, cx + 4, y + 5, { width: colCode - 8, ellipsis: true }); cx += colCode;
    doc.text(orDash(r.description), cx + 4, y + 5, { width: colDesc - 8, ellipsis: true }); cx += colDesc;
    doc.font('Helvetica-Bold');
    doc.text(String(r.quantity), cx + 4, y + 5, { width: colQty - 8, align: 'right' });
    doc.font('Helvetica');
    cx += colQty;
    // An empty box the store ticks as they count the kit in front of the rep.
    doc.rect(cx + colTick / 2 - 5, y + 4, 10, 10).stroke();
    totalUnits += r.quantity;
    y += rowH;
  }

  // ── Total ──
  const totH = 24;
  doc.rect(marginL, y, usableW, totH).stroke();
  doc.font('Helvetica-Bold').fontSize(11);
  doc.text('Total units handed over', marginL + 8, y + 7, { width: usableW - 100 });
  doc.text(String(totalUnits), marginL + usableW - 78, y + 7, { width: 70, align: 'right' });
  doc.font('Helvetica').fontSize(10);
  y += totH + 10;

  // A note claiming a delivery with nothing in it must say so on its face.
  if (totalUnits === 0) {
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#CC0000');
    doc.text('NO UNITS WERE HANDED OVER AGAINST THIS BOOKING', marginL, y, { width: usableW, align: 'center' });
    doc.fillColor('#000000').font('Helvetica').fontSize(10);
    y += 18;
  }

  if (note) {
    doc.fontSize(9).fillColor('#555555');
    doc.text(`Note: ${note}`, marginL, y, { width: usableW });
    doc.fillColor('#000000').fontSize(10);
    y += 20;
  }

  // Keep the terms and the signature block together on one page.
  if (y + 190 > pageH - marginB) {
    doc.addPage();
    y = marginT;
  }

  y += 6;
  doc.font('Helvetica-Bold').fontSize(9);
  doc.text('Received at the store', marginL, y);
  y += 14;
  doc.font('Helvetica').fontSize(8).fillColor('#555555');
  doc.text(
    'The items listed above have been counted and left at this store. They remain the property of ' +
    `${clientName} and must be available for collection in the same condition. Any item missing on ` +
    'collection is recorded against this kit.',
    marginL, y, { width: usableW },
  );
  doc.fillColor('#000000').fontSize(9);
  y += 28;

  // ── Signature block ──
  // Two sides: the store person who took it, and the rep who handed it over.
  // A one-sided note proves a drop-off happened, not who has it.
  const halfW = (usableW - 12) / 2;
  const boxH = 62;

  doc.rect(marginL, y, halfW, boxH).stroke();
  doc.font('Helvetica-Bold').fontSize(8);
  doc.text('RECEIVED BY (STORE)', marginL + 6, y + 5, { width: halfW - 12 });
  doc.font('Helvetica').fontSize(8).fillColor('#777777');
  doc.text('Name', marginL + 6, y + 20, { width: halfW - 12 });
  doc.text('Signature', marginL + 6, y + 36, { width: halfW - 12 });
  doc.text('Date', marginL + 6, y + 50, { width: halfW - 12 });
  doc.fillColor('#000000');

  const rBoxX = marginL + halfW + 12;
  doc.rect(rBoxX, y, halfW, boxH).stroke();
  doc.font('Helvetica-Bold').fontSize(8);
  doc.text('DELIVERED BY', rBoxX + 6, y + 5, { width: halfW - 12 });
  doc.font('Helvetica').fontSize(8).fillColor('#777777');
  doc.text(`Name: ${orDash(takenByName)}`, rBoxX + 6, y + 20, { width: halfW - 12 });
  doc.text('Signature', rBoxX + 6, y + 36, { width: halfW - 12 });
  doc.text(`Date: ${fmtDateTime(bookedOutAt)}`, rBoxX + 6, y + 50, { width: halfW - 12 });
  doc.fillColor('#000000');
  y += boxH + 14;

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
    } catch { /* skip */ }
  }
  doc.fillColor('#000000');

  doc.end();
  await new Promise<void>(resolve => doc.on('end', () => resolve()));
  return Buffer.concat(chunks);
}
