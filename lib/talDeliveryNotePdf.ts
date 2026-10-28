/**
 * BSC Drop-off delivery note: the units of one Takealot booking handed to the
 * Bosch Service Centre in one drop-off. Paper sign-off (BSC signs the printout),
 * laid out like the swap-out delivery note.
 */
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { unitLabel, type TalUnit } from './talShared';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const bwipjs = require('bwip-js') as {
  toBuffer(opts: { bcid: string; text: string; scale: number; height: number; includetext: boolean }): Promise<Buffer>;
};

export interface TalDeliveryNoteParams {
  brn: string;
  supplierName?: string;
  bscName: string;
  bscAddress: string;
  droppedAt: string; // ISO
  droppedByName?: string;
  units: Pick<TalUnit, 'rrn' | 'noRrn' | 'description' | 'instructionNo'>[];
}

const TZ = 'Africa/Johannesburg';
const fmtDateTime = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { timeZone: TZ })} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ })}`;
};

export async function generateTalDeliveryNotePdf(p: TalDeliveryNoteParams): Promise<Buffer> {
  const pageW = 595.28, pageH = 841.89, margin = 40;
  const usableW = pageW - margin * 2;

  let logo: Buffer | null = null;
  try {
    const f = path.join(process.cwd(), 'public', 'iram-logo.png');
    if (fs.existsSync(f)) logo = fs.readFileSync(f);
  } catch { /* skip */ }
  let barcode: Buffer | null = null;
  try {
    barcode = await bwipjs.toBuffer({ bcid: 'code128', text: p.brn, scale: 3, height: 10, includetext: true });
  } catch { /* skip */ }

  const doc = new PDFDocument({
    size: 'A4', margins: { top: margin, bottom: margin, left: margin, right: margin }, bufferPages: true,
    info: { Title: `BSC Drop-off Delivery Note - ${p.brn}`, Author: 'iRamFlow — OuterJoin' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));

  let y = margin;
  if (logo) { try { doc.image(logo, margin, y, { height: 30 }); } catch { /* skip */ } }
  doc.font('Helvetica-Bold').fontSize(18).text('iRam Delivery Note', margin, y, { width: usableW, align: 'center' });
  y += 26;
  doc.font('Helvetica').fontSize(9).fillColor('#666666')
    .text('Takealot RFC stock delivered to the Bosch Service Centre', margin, y, { width: usableW, align: 'center' });
  doc.fillColor('#000000');
  y += 16;
  if (barcode) {
    try { doc.image(barcode, margin + (usableW - 200) / 2, y, { width: 200, height: 40 }); y += 48; } catch { /* skip */ }
  }

  const half = usableW / 2;
  doc.font('Helvetica-Bold').fontSize(10).text(`To: ${p.bscName}`, margin, y);
  doc.font('Helvetica').text(`Delivered: ${fmtDateTime(p.droppedAt)}`, margin + half, y, { width: half, align: 'right' });
  y += 15;
  doc.text(p.bscAddress || '—', margin, y, { width: half });
  doc.text(`By: ${p.droppedByName || '—'}`, margin + half, y, { width: half, align: 'right' });
  y += 15;
  doc.text(`From: iRam   |   Supplier: ${p.supplierName || 'Bosch'}   |   Booking: ${p.brn}`, margin, y, { width: usableW });
  y += 23;

  const colN = 30, colIns = 100, colRrn = 140, colDesc = usableW - colN - colIns - colRrn, rowH = 18;
  const header = () => {
    doc.rect(margin, y, usableW, 20).fillAndStroke('#f0f0f0', '#000000');
    doc.fillColor('#000000').font('Helvetica-Bold').fontSize(9);
    let x = margin;
    doc.text('#', x + 4, y + 6, { width: colN - 8 }); x += colN;
    doc.text('Instruction', x + 4, y + 6, { width: colIns - 8 }); x += colIns;
    doc.text('RRN', x + 4, y + 6, { width: colRrn - 8 }); x += colRrn;
    doc.text('Description', x + 4, y + 6, { width: colDesc - 8 });
    y += 20;
    doc.font('Helvetica').fontSize(9);
  };
  header();
  p.units.forEach((u, i) => {
    if (y + rowH > pageH - margin - 60) { doc.addPage(); y = margin; header(); }
    doc.rect(margin, y, usableW, rowH).stroke();
    let x = margin;
    doc.text(String(i + 1), x + 4, y + 5, { width: colN - 8 }); x += colN;
    doc.text(u.instructionNo, x + 4, y + 5, { width: colIns - 8 }); x += colIns;
    // ellipsis only shortens text that has a height to fit in; without one it wraps over the next rows.
    const cell = (w: number) => ({ width: w - 8, height: rowH - 6, ellipsis: true, lineBreak: false });
    doc.text(u.noRrn ? 'NO RRN' : u.rrn, x + 4, y + 5, cell(colRrn)); x += colRrn;
    doc.text(u.description || (u.noRrn ? unitLabel(u) : '—'), x + 4, y + 5, cell(colDesc));
    y += rowH;
  });
  doc.rect(margin, y, usableW, 24).stroke();
  doc.font('Helvetica-Bold').fontSize(11)
    .text('Total units delivered', margin + 8, y + 7, { width: usableW - 100 })
    .text(String(p.units.length), margin + usableW - 78, y + 7, { width: 70, align: 'right' });
  y += 44;

  if (y + 60 > pageH - margin) { doc.addPage(); y = margin; }
  doc.font('Helvetica').fontSize(9);
  const sigW = usableW * 0.55, dateW = usableW * 0.35;
  doc.rect(margin, y, sigW, 35).stroke();
  doc.text('BSC Representative Name & Signature', margin + 4, y + 12);
  doc.rect(margin + usableW - dateW, y, dateW, 35).stroke();
  doc.text('Date', margin + usableW - dateW + 4, y + 12);

  doc.end();
  return new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}
