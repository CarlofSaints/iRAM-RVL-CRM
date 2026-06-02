import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadSettings } from '@/lib/settingsData';
import PDFDocument from 'pdfkit';

export const dynamic = 'force-dynamic';

const MM = 72 / 25.4;

/**
 * GET /api/stickers/test — Generate a test sticker PDF.
 *
 * Prints a single page at the configured sticker dimensions with a border,
 * dimension text, and crosshairs so the user can verify the PDF page size
 * matches their physical label.
 */
export async function GET(req: NextRequest) {
  const guard = await requirePermission(req, 'manage_warehouses');
  if (guard instanceof NextResponse) return guard;

  const settings = await loadSettings();
  const { widthMm, heightMm, marginTop, marginBottom, marginLeft, marginRight } = settings.sticker;
  const w = widthMm * MM;
  const h = heightMm * MM;

  const doc = new PDFDocument({
    size: [w, h],
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    bufferPages: true,
    info: {
      Title: 'Sticker Test Print',
      Author: 'iRamFlow — OuterJoin',
    },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  // Full-page border (0.5pt)
  doc.lineWidth(0.5).strokeColor('#000000').rect(1, 1, w - 2, h - 2).stroke();

  // Corner marks (5mm L-shaped marks in each corner)
  const markLen = 5 * MM;
  doc.lineWidth(0.3).strokeColor('#666666');
  // Top-left
  doc.moveTo(0, markLen).lineTo(0, 0).lineTo(markLen, 0).stroke();
  // Top-right
  doc.moveTo(w - markLen, 0).lineTo(w, 0).lineTo(w, markLen).stroke();
  // Bottom-left
  doc.moveTo(0, h - markLen).lineTo(0, h).lineTo(markLen, h).stroke();
  // Bottom-right
  doc.moveTo(w - markLen, h).lineTo(w, h).lineTo(w, h - markLen).stroke();

  // Crosshairs at centre
  const cx = w / 2;
  const cy = h / 2;
  const crossLen = 4 * MM;
  doc.lineWidth(0.3).strokeColor('#999999');
  doc.moveTo(cx - crossLen, cy).lineTo(cx + crossLen, cy).stroke();
  doc.moveTo(cx, cy - crossLen).lineTo(cx, cy + crossLen).stroke();

  // Margin rectangle (if margins > 0)
  const mTop = marginTop * MM;
  const mBottom = marginBottom * MM;
  const mLeft = marginLeft * MM;
  const mRight = marginRight * MM;
  if (mTop > 0 || mBottom > 0 || mLeft > 0 || mRight > 0) {
    doc.lineWidth(0.3).strokeColor('#3B82F6').dash(2, { space: 2 });
    doc.rect(mLeft, mTop, w - mLeft - mRight, h - mTop - mBottom).stroke();
    doc.undash();
  }

  // Dimension text (centred)
  const fontSize = Math.min(8, Math.max(4, h * 0.06));
  doc.font('Helvetica').fontSize(fontSize).fillColor('#000000');
  doc.text(`${widthMm} × ${heightMm} mm`, 0, cy - fontSize * 1.5, {
    width: w,
    align: 'center',
  });
  doc.font('Helvetica').fontSize(fontSize * 0.75).fillColor('#666666');
  doc.text('TEST PRINT — this should fit exactly on one label', 0, cy + fontSize * 0.5, {
    width: w,
    align: 'center',
  });

  if (mTop > 0 || mBottom > 0 || mLeft > 0 || mRight > 0) {
    doc.font('Helvetica').fontSize(fontSize * 0.6).fillColor('#3B82F6');
    doc.text(
      `Margins: T${marginTop} B${marginBottom} L${marginLeft} R${marginRight} mm`,
      0, cy + fontSize * 2,
      { width: w, align: 'center' },
    );
  }

  doc.end();

  const buffer = await new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="sticker-test-${widthMm}x${heightMm}mm.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}
