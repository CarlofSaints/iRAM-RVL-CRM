/**
 * Pick slip PDF renderer.
 *
 * Generates a single pick slip matching the iRam "Uplift Instructions Form"
 * layout. Uses pdfkit for code-first PDF generation — no headless browser.
 *
 * Layout (A4 portrait):
 *   - Title: "iRam Uplift Instructions Form"  |  "Page X of Y" (right)
 *   - Header: client/vendor, warehouse, store, date, pick slip ID, reference
 *   - Table: 10 columns (Product Code, Article Number, Product, Value,
 *            Uplift Qty, Uplifted, Display, Store Refuse, Not Found, Damage)
 *   - Footer: Total qty, No. Boxes, Signature block
 *   - Branding: iRam logo (top-left) + "Powered by OuterJoin" with OJ logo
 */

import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';

export interface PickSlipPdfRow {
  barcode: string;
  articleCode: string;
  description: string;
  qty: number;
  val: number;
}

export interface PickSlipPdfParams {
  pickSlipId: string;
  clientName: string;
  vendorNumber: string;
  siteName: string;
  siteCode: string;
  warehouse: string;
  loadDate: string; // YYYY-MM-DD
  rows: PickSlipPdfRow[];
}

/**
 * Generate a single pick slip PDF. Returns the PDF as a Buffer.
 */
export async function generatePickSlipPdf(params: PickSlipPdfParams): Promise<Buffer> {
  const {
    pickSlipId, clientName, vendorNumber, siteName, siteCode,
    warehouse, loadDate, rows,
  } = params;

  // Page setup
  const pageW = 595.28; // A4 width in points
  const marginL = 40;
  const marginR = 40;
  const marginT = 40;
  const usableW = pageW - marginL - marginR;

  // Column widths (10 columns) — proportional allocation
  const colWidths = [
    100, // Product Code
    48,  // Article Number
    130, // Product (description + barcode)
    45,  // Value
    35,  // Uplift Qty
    35,  // Uplifted
    35,  // Display
    38,  // Store Refuse
    30,  // Not Found
    35,  // Damage  — total ~531, leaving ~usableW ~515
  ];
  // Scale columns to fit usable width
  const totalColW = colWidths.reduce((a, b) => a + b, 0);
  const scale = usableW / totalColW;
  const cols = colWidths.map(w => Math.round(w * scale));
  // Fix rounding drift on last col
  const sumCols = cols.reduce((a, b) => a + b, 0);
  cols[cols.length - 1] += (Math.round(usableW) - sumCols);

  const headerLabels = [
    'Product Code', 'Article\nNumber', 'Product', 'Value',
    'Uplift\nQty', 'Uplift\ned', 'Display', 'Store\nRefuse',
    'Not\nFound', 'Damage',
  ];

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

  // Calculate pagination — how many data rows fit per page
  const headerBlockH = 100; // title + header info
  const tableHeaderH = 30;
  const rowH = 28; // enough for 2-line product descriptions
  const footerH = 120; // total row + boxes row + signature + branding
  const pageH = 841.89; // A4 height
  const marginB = 40;
  const contentAreaFirstPage = pageH - marginT - marginB - headerBlockH - tableHeaderH - footerH;
  const contentAreaNextPage = pageH - marginT - marginB - tableHeaderH - footerH;
  const rowsPerFirstPage = Math.max(1, Math.floor(contentAreaFirstPage / rowH));
  const rowsPerNextPage = Math.max(1, Math.floor(contentAreaNextPage / rowH));

  let totalPages = 1;
  if (rows.length > rowsPerFirstPage) {
    totalPages = 1 + Math.ceil((rows.length - rowsPerFirstPage) / rowsPerNextPage);
  }

  // Start building PDF
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: marginT, bottom: marginB, left: marginL, right: marginR },
    bufferPages: true,
    info: {
      Title: `Pick Slip ${pickSlipId}`,
      Author: 'iRam RVL CRM — OuterJoin',
    },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  const totalQty = rows.reduce((sum, r) => sum + r.qty, 0);

  let currentPage = 0;
  let rowIdx = 0;

  function drawPage() {
    currentPage++;
    const isFirstPage = currentPage === 1;
    let y = marginT;

    // ── iRam logo (top-left, only first page) ──
    if (isFirstPage && iramLogoBuffer) {
      try {
        doc.image(iramLogoBuffer, marginL, y, { height: 30 });
      } catch { /* skip if image fails */ }
    }

    // ── Title ──
    if (isFirstPage) {
      doc.font('Helvetica-Bold').fontSize(16);
      doc.text('iRam Uplift Instructions Form', marginL, y, {
        width: usableW,
        align: 'center',
      });
      // Page X of Y (top right)
      doc.font('Helvetica').fontSize(9);
      doc.text(`Page ${currentPage} of ${totalPages}`, marginL, y + 2, {
        width: usableW,
        align: 'right',
      });
      y += 28;

      // ── Header block ──
      const leftX = marginL;
      const rightX = marginL + usableW / 2;

      // Row 1: Client - VendorNumber  |  iRam Warehouse {warehouse}
      doc.font('Helvetica-Bold').fontSize(10);
      doc.text(`${clientName} - ${vendorNumber}`, leftX, y);
      doc.font('Helvetica').fontSize(10);
      doc.text(`iRam Warehouse ${warehouse}`, rightX, y, {
        width: usableW / 2,
        align: 'right',
      });
      y += 15;

      // Row 2: StoreName - SiteCode  |  Date
      doc.font('Helvetica-Bold').fontSize(10);
      doc.text(`${siteName} - ${siteCode}`, leftX, y);
      doc.font('Helvetica').fontSize(10);
      doc.text(loadDate, rightX, y, {
        width: usableW / 2,
        align: 'right',
      });
      y += 15;

      // Row 3: PickSlipId  |  Reference ___________
      doc.font('Helvetica').fontSize(10);
      doc.text(pickSlipId, leftX, y);
      doc.text('Reference ________________________________', rightX, y, {
        width: usableW / 2,
        align: 'right',
      });
      y += 15;

      // Row 4: RTV NUMBERS - {siteCode}
      doc.font('Helvetica-Bold').fontSize(10);
      doc.text(`RTV NUMBERS - ${siteCode}`, leftX, y);
      y += 20;
    } else {
      // Continuation pages — lighter header
      doc.font('Helvetica').fontSize(9);
      doc.text(`Page ${currentPage} of ${totalPages}`, marginL, y, {
        width: usableW,
        align: 'right',
      });
      doc.font('Helvetica-Bold').fontSize(10);
      doc.text(`${pickSlipId} — ${siteName} - ${siteCode}`, marginL, y);
      y += 18;
    }

    // ── Table header ──
    const tableX = marginL;
    let colX = tableX;
    doc.font('Helvetica-Bold').fontSize(7);
    const thY = y;

    // Draw header cells
    for (let c = 0; c < cols.length; c++) {
      doc.rect(colX, thY, cols[c], tableHeaderH).stroke();
      doc.text(headerLabels[c], colX + 2, thY + 3, {
        width: cols[c] - 4,
        height: tableHeaderH - 4,
        align: 'left',
      });
      colX += cols[c];
    }
    y = thY + tableHeaderH;

    // ── Table rows ──
    const maxRows = isFirstPage ? rowsPerFirstPage : rowsPerNextPage;
    const endIdx = Math.min(rowIdx + maxRows, rows.length);

    doc.font('Helvetica').fontSize(7);
    while (rowIdx < endIdx) {
      const r = rows[rowIdx];
      const productText = `${r.description} - ${r.barcode}`.trim().replace(/ - $/, '');

      // Measure needed height for product text
      const neededH = Math.max(rowH, doc.heightOfString(productText, { width: cols[2] - 4 }) + 6);
      const rh = Math.min(neededH, 45); // cap at ~3 lines

      colX = tableX;
      const cellVals = [
        r.barcode,
        r.articleCode,
        productText,
        r.val.toString(),
        r.qty.toString(),
        '', '', '', '', '', // Uplifted, Display, Store Refuse, Not Found, Damage — empty
      ];

      for (let c = 0; c < cols.length; c++) {
        doc.rect(colX, y, cols[c], rh).stroke();
        if (cellVals[c]) {
          doc.text(cellVals[c], colX + 2, y + 3, {
            width: cols[c] - 4,
            height: rh - 4,
            align: c >= 3 && c <= 4 ? 'right' : 'left', // right-align Value & Qty
          });
        }
        colX += cols[c];
      }
      y += rh;
      rowIdx++;
    }

    // ── Footer (only on last page) ──
    if (rowIdx >= rows.length) {
      // Total row
      const totalLabelW = cols[0] + cols[1] + cols[2] + cols[3];
      doc.font('Helvetica-Bold').fontSize(8);
      doc.rect(tableX, y, totalLabelW, 18).stroke();
      doc.text('Total', tableX + totalLabelW - 40, y + 4, { width: 36, align: 'right' });
      doc.rect(tableX + totalLabelW, y, cols[4], 18).stroke();
      doc.text(totalQty.toString(), tableX + totalLabelW + 2, y + 4, { width: cols[4] - 4, align: 'right' });
      // Draw remaining empty cells on total row
      let tx = tableX + totalLabelW + cols[4];
      for (let c = 5; c < cols.length; c++) {
        doc.rect(tx, y, cols[c], 18).stroke();
        tx += cols[c];
      }
      y += 18;

      // No. Boxes row
      doc.font('Helvetica').fontSize(8);
      doc.rect(tableX, y, totalLabelW, 18).stroke();
      doc.text('No. Boxes', tableX + totalLabelW - 55, y + 4, { width: 50, align: 'right' });
      doc.rect(tableX + totalLabelW, y, cols[4], 18).stroke();
      tx = tableX + totalLabelW + cols[4];
      for (let c = 5; c < cols.length; c++) {
        doc.rect(tx, y, cols[c], 18).stroke();
        tx += cols[c];
      }
      y += 30;

      // Signature block
      const sigW = usableW * 0.6;
      const dateW = usableW * 0.35;
      doc.rect(tableX, y, sigW, 30).stroke();
      doc.font('Helvetica').fontSize(8);
      doc.text('Store Employee Name & Sign', tableX + 4, y + 10);
      doc.rect(tableX + usableW - dateW, y, dateW, 30).stroke();
      doc.text('Date', tableX + usableW - dateW + 4, y + 10);
      y += 40;

      // Branding footer
      const brandY = pageH - marginB - 20;
      doc.font('Helvetica').fontSize(7).fillColor('#888888');
      if (ojLogoBuffer) {
        try {
          const logoH = 16;
          const logoW = logoH * 2; // approximate aspect ratio
          const textW = doc.widthOfString('Powered by OuterJoin');
          const totalW = logoW + 6 + textW;
          const startX = marginL + (usableW - totalW) / 2;
          doc.image(ojLogoBuffer, startX, brandY - 2, { height: logoH });
          doc.text('Powered by OuterJoin', startX + logoW + 6, brandY + 2);
        } catch {
          doc.text('Powered by OuterJoin', marginL, brandY, { width: usableW, align: 'center' });
        }
      } else {
        doc.text('Powered by OuterJoin', marginL, brandY, { width: usableW, align: 'center' });
      }
      doc.fillColor('#000000');
    }
  }

  // Draw pages
  drawPage();
  while (rowIdx < rows.length) {
    doc.addPage();
    drawPage();
  }

  doc.end();

  return new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}
