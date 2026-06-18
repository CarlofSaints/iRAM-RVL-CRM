import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadSettings, resolveLayout, profileFor, type StickerProfile } from '@/lib/settingsData';
import PDFDocument from 'pdfkit';

export const dynamic = 'force-dynamic';

const MM = 72 / 25.4;
const PAGE_W = 595.28; // A4 width (pt)
const PAGE_H = 841.89; // A4 height (pt)

/**
 * GET /api/stickers/test?format=roll|a4sheet — Generate a calibration PDF.
 *
 * Roll: 3 pages, each sized to label + gap, single label per page.
 * A4 Sheet: one A4 page with the full grid of bordered cells (matches the
 *           geometry the real generator uses) so 4-up alignment can be checked.
 */
export async function GET(req: NextRequest) {
  const guard = await requirePermission(req, 'manage_warehouses');
  if (guard instanceof NextResponse) return guard;

  const settings = await loadSettings();
  const layout = resolveLayout(settings, new URL(req.url).searchParams.get('format'));
  const profile = profileFor(settings, layout);

  const buffer = layout === 'a4sheet'
    ? await buildA4SheetTest(profile)
    : await buildRollTest(profile);

  const tag = layout === 'a4sheet' ? 'a4' : 'roll';
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="sticker-test-${tag}-${profile.widthMm}x${profile.heightMm}mm.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}

/** Draw the calibration marks for one label cell at (x, y). */
function drawCalibrationCell(
  doc: InstanceType<typeof PDFDocument>,
  x: number, y: number, w: number, h: number,
  profile: StickerProfile, caption: string,
) {
  const fontSize = Math.min(9, Math.max(5, h * 0.06));

  // Border
  doc.lineWidth(0.5).strokeColor('#000000').rect(x, y, w, h).stroke();

  // Corner L-marks
  const markLen = Math.min(5 * MM, w * 0.2, h * 0.2);
  doc.lineWidth(0.3).strokeColor('#666666');
  doc.moveTo(x, y + markLen).lineTo(x, y).lineTo(x + markLen, y).stroke();
  doc.moveTo(x + w - markLen, y).lineTo(x + w, y).lineTo(x + w, y + markLen).stroke();
  doc.moveTo(x, y + h - markLen).lineTo(x, y + h).lineTo(x + markLen, y + h).stroke();
  doc.moveTo(x + w - markLen, y + h).lineTo(x + w, y + h).lineTo(x + w, y + h - markLen).stroke();

  // Centre crosshair
  const cx = x + w / 2;
  const cy = y + h / 2;
  const crossLen = Math.min(4 * MM, w * 0.15, h * 0.15);
  doc.lineWidth(0.3).strokeColor('#999999');
  doc.moveTo(cx - crossLen, cy).lineTo(cx + crossLen, cy).stroke();
  doc.moveTo(cx, cy - crossLen).lineTo(cx, cy + crossLen).stroke();

  // Content-margin rectangle (dashed) if any margins set
  const mTop = profile.marginTop * MM, mBottom = profile.marginBottom * MM;
  const mLeft = profile.marginLeft * MM, mRight = profile.marginRight * MM;
  if (mTop > 0 || mBottom > 0 || mLeft > 0 || mRight > 0) {
    doc.lineWidth(0.3).strokeColor('#3B82F6').dash(2, { space: 2 });
    doc.rect(x + mLeft, y + mTop, w - mLeft - mRight, h - mTop - mBottom).stroke();
    doc.undash();
  }

  // Dimension + caption text
  doc.font('Helvetica').fontSize(fontSize).fillColor('#000000');
  doc.text(`${profile.widthMm} x ${profile.heightMm} mm`, x, cy - fontSize * 2, { width: w, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(fontSize).fillColor('#000000');
  doc.text(caption, x, cy - fontSize * 0.5, { width: w, align: 'center' });
  doc.font('Helvetica').fontSize(fontSize * 0.7).fillColor('#666666');
  doc.text('Border should align with label edges', x, cy + fontSize * 1, { width: w, align: 'center' });
}

/** A4 sheet test — full grid of bordered cells on one A4 page. */
function buildA4SheetTest(profile: StickerProfile): Promise<Buffer> {
  const w = profile.widthMm * MM;
  const h = profile.heightMm * MM;
  const gap = profile.gapMm * MM;

  const cols = Math.max(1, Math.floor((PAGE_W + gap) / (w + gap)));
  const rows = Math.max(1, Math.floor((PAGE_H + gap) / (h + gap)));
  const marginX = (PAGE_W - cols * w - (cols - 1) * gap) / 2;
  const marginY = (PAGE_H - rows * h - (rows - 1) * gap) / 2;
  const perPage = cols * rows;

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    bufferPages: true,
    info: { Title: 'Sticker Test Print (A4 Sheet)', Author: 'iRamFlow — OuterJoin' },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  for (let slot = 0; slot < perPage; slot++) {
    const col = slot % cols;
    const row = Math.floor(slot / cols);
    const x = marginX + col * (w + gap);
    const y = marginY + row * (h + gap);
    drawCalibrationCell(doc, x, y, w, h, profile, `Label ${slot + 1} of ${perPage}`);
  }

  doc.end();
  return new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

/** Roll test — 3 pages, each sized to label + gap, one label per page. */
function buildRollTest(profile: StickerProfile): Promise<Buffer> {
  const w = profile.widthMm * MM;
  const h = profile.heightMm * MM;
  const pageH = h + profile.gapMm * MM;

  const doc = new PDFDocument({
    size: [w, pageH],
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    bufferPages: true,
    info: { Title: 'Sticker Test Print (Roll)', Author: 'iRamFlow — OuterJoin' },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  for (let page = 0; page < 3; page++) {
    if (page > 0) doc.addPage({ size: [w, pageH], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    // Border around the label area only (not the gap)
    drawCalibrationCell(doc, 0, 0, w, h, profile, `Label ${page + 1} of 3`);
    if (profile.gapMm > 0) {
      const fontSize = Math.min(8, Math.max(4, h * 0.06));
      doc.font('Helvetica').fontSize(fontSize * 0.6).fillColor('#999999');
      doc.text(`Gap: ${profile.gapMm} mm`, 0, h / 2 + fontSize * 2.2, { width: w, align: 'center' });
    }
  }

  doc.end();
  return new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}
