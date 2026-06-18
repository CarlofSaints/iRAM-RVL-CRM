import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { loadSettings, resolveLayout, profileFor } from '@/lib/settingsData';
import PDFDocument from 'pdfkit';

export const dynamic = 'force-dynamic';

const MM = 72 / 25.4;

/**
 * GET /api/stickers/test — Generate a test sticker PDF (3 pages).
 *
 * Each page is sized to label + gap. Content (border, dimensions) is
 * drawn within the label area only. Printing 3 pages lets the user
 * verify alignment doesn't drift across multiple labels.
 */
export async function GET(req: NextRequest) {
  const guard = await requirePermission(req, 'manage_warehouses');
  if (guard instanceof NextResponse) return guard;

  const settings = await loadSettings();
  const layout = resolveLayout(settings, new URL(req.url).searchParams.get('format'));
  const { widthMm, heightMm, gapMm, marginTop, marginBottom, marginLeft, marginRight } = profileFor(settings, layout);
  const w = widthMm * MM;
  const h = heightMm * MM;
  const pageH = h + (gapMm ?? 0) * MM;

  const doc = new PDFDocument({
    size: [w, pageH],
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    bufferPages: true,
    info: {
      Title: 'Sticker Test Print',
      Author: 'iRamFlow — OuterJoin',
    },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  const mTop = marginTop * MM;
  const mBottom = marginBottom * MM;
  const mLeft = marginLeft * MM;
  const mRight = marginRight * MM;
  const hasMargins = mTop > 0 || mBottom > 0 || mLeft > 0 || mRight > 0;
  const fontSize = Math.min(8, Math.max(4, h * 0.06));

  for (let page = 0; page < 3; page++) {
    if (page > 0) doc.addPage({ size: [w, pageH], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

    // Border around the label area only (not the gap)
    doc.lineWidth(0.5).strokeColor('#000000').rect(1, 1, w - 2, h - 2).stroke();

    // Corner marks (5mm L-shaped marks)
    const markLen = Math.min(5 * MM, w * 0.2, h * 0.2);
    doc.lineWidth(0.3).strokeColor('#666666');
    doc.moveTo(0, markLen).lineTo(0, 0).lineTo(markLen, 0).stroke();
    doc.moveTo(w - markLen, 0).lineTo(w, 0).lineTo(w, markLen).stroke();
    doc.moveTo(0, h - markLen).lineTo(0, h).lineTo(markLen, h).stroke();
    doc.moveTo(w - markLen, h).lineTo(w, h).lineTo(w, h - markLen).stroke();

    // Crosshairs at label centre
    const cx = w / 2;
    const cy = h / 2;
    const crossLen = Math.min(4 * MM, w * 0.15, h * 0.15);
    doc.lineWidth(0.3).strokeColor('#999999');
    doc.moveTo(cx - crossLen, cy).lineTo(cx + crossLen, cy).stroke();
    doc.moveTo(cx, cy - crossLen).lineTo(cx, cy + crossLen).stroke();

    // Margin rectangle
    if (hasMargins) {
      doc.lineWidth(0.3).strokeColor('#3B82F6').dash(2, { space: 2 });
      doc.rect(mLeft, mTop, w - mLeft - mRight, h - mTop - mBottom).stroke();
      doc.undash();
    }

    // Dimension text
    doc.font('Helvetica').fontSize(fontSize).fillColor('#000000');
    doc.text(`${widthMm} x ${heightMm} mm`, 0, cy - fontSize * 2, {
      width: w,
      align: 'center',
    });
    doc.font('Helvetica-Bold').fontSize(fontSize).fillColor('#000000');
    doc.text(`Label ${page + 1} of 3`, 0, cy - fontSize * 0.5, {
      width: w,
      align: 'center',
    });
    doc.font('Helvetica').fontSize(fontSize * 0.7).fillColor('#666666');
    doc.text('Border should align with label edges', 0, cy + fontSize * 1, {
      width: w,
      align: 'center',
    });

    if (gapMm > 0) {
      doc.font('Helvetica').fontSize(fontSize * 0.6).fillColor('#999999');
      doc.text(`Gap: ${gapMm} mm`, 0, cy + fontSize * 2.2, {
        width: w,
        align: 'center',
      });
    }
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
