import ExcelJS from 'exceljs';
import type { UnreturnedStockRow } from './pickSlipData';

const PRIMARY = '7CC042';
const HEADER_BG = '2D2D2D';

export interface UnreturnedExcelOpts {
  pickSlipRef: string;
  storeName: string;
  storeCode: string;
  clientName: string;
  vendorNumber: string;
  repName: string;
  grnDate: string;
  captureDate: string;
  rows: UnreturnedStockRow[];
}

export async function generateUnreturnedStockExcel(
  opts: UnreturnedExcelOpts,
): Promise<{ buffer: Buffer; filename: string }> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'iRamFlow';
  const ws = wb.addWorksheet('Unreturned Stock');

  // Column widths
  ws.columns = [
    { width: 16 }, // A – Article Code
    { width: 36 }, // B – Description
    { width: 14 }, // C – Pick Slip Qty
    { width: 12 }, // D – Collected
    { width: 12 }, // E – On Display
    { width: 14 }, // F – Store Refused
    { width: 12 }, // G – Not Found
    { width: 12 }, // H – Damaged
  ];

  // ── Branding header ──
  const titleRow = ws.addRow(['iRamFlow — Aged Stock Collection Confirmation']);
  ws.mergeCells(titleRow.number, 1, titleRow.number, 8);
  const titleCell = titleRow.getCell(1);
  titleCell.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${PRIMARY}` } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  titleRow.height = 32;

  // ── Metadata rows ──
  const meta: [string, string][] = [
    ['Pick Slip Ref', opts.pickSlipRef],
    ['Store', `${opts.storeName} (${opts.storeCode})`],
    ['Principal / Vendor', `${opts.clientName} — ${opts.vendorNumber}`],
    ['GRN/GRV Date', opts.grnDate || '—'],
    ['Collecting Rep', opts.repName],
    ['Capture Date', opts.captureDate],
  ];
  for (const [label, value] of meta) {
    const row = ws.addRow([label, value]);
    row.getCell(1).font = { bold: true, size: 10, color: { argb: 'FF666666' } };
    row.getCell(2).font = { size: 10 };
    ws.mergeCells(row.number, 2, row.number, 8);
  }

  ws.addRow([]); // spacer

  // ── Product table header ──
  const headers = ['Article Code', 'Description', 'Pick Slip Qty', 'Collected', 'On Display', 'Store Refused', 'Not Found', 'Damaged'];
  const headerRow = ws.addRow(headers);
  for (let i = 1; i <= 8; i++) {
    const cell = headerRow.getCell(i);
    cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${HEADER_BG}` } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FF999999' } },
    };
  }
  headerRow.height = 22;

  // ── Data rows ──
  let totalPsQty = 0;
  let totalCollected = 0;
  let totalDisplay = 0;
  let totalRefused = 0;
  let totalNotFound = 0;
  let totalDamaged = 0;

  for (const r of opts.rows) {
    const collected = r.pickSlipQty - (r.display + r.storeRefused + r.notFound + r.damaged);
    totalPsQty += r.pickSlipQty;
    totalCollected += collected;
    totalDisplay += r.display;
    totalRefused += r.storeRefused;
    totalNotFound += r.notFound;
    totalDamaged += r.damaged;

    const row = ws.addRow([
      r.articleCode,
      r.description,
      r.pickSlipQty,
      collected,
      r.display,
      r.storeRefused,
      r.notFound,
      r.damaged,
    ]);

    row.getCell(1).font = { size: 10 };
    row.getCell(2).font = { size: 10 };
    for (let i = 3; i <= 8; i++) {
      row.getCell(i).alignment = { horizontal: 'center' };
      row.getCell(i).font = { size: 10 };
    }
    // Highlight collected in green if > 0
    if (collected > 0) {
      row.getCell(4).font = { size: 10, bold: true, color: { argb: 'FF2E7D32' } };
    }
  }

  // ── Summary row ──
  const summaryRow = ws.addRow(['', 'TOTALS', totalPsQty, totalCollected, totalDisplay, totalRefused, totalNotFound, totalDamaged]);
  for (let i = 1; i <= 8; i++) {
    const cell = summaryRow.getCell(i);
    cell.font = { bold: true, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
    cell.border = { top: { style: 'thin', color: { argb: 'FF999999' } } };
    if (i >= 3) cell.alignment = { horizontal: 'center' };
  }

  const buf = await wb.xlsx.writeBuffer();
  const filename = `Unreturned_Stock_${opts.pickSlipRef.replace(/[^a-zA-Z0-9-]/g, '_')}.xlsx`;

  return { buffer: Buffer.from(buf), filename };
}
