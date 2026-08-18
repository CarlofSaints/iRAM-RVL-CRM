'use client';

/**
 * Excel output for the reports pages, in the three shapes a client asks for:
 *
 *   combined   one sheet, everything in it, with a split column so the groups
 *              are still filterable in Excel
 *   sheets     one workbook, one sheet per group
 *   zip        one workbook per group, delivered as a zip
 *
 * All three run in the browser. The rows are already in memory once a report
 * has been run, so round-tripping them through the server would only add the
 * ~4.5MB request-body ceiling for no benefit.
 */

import * as XLSX from 'xlsx';
import JSZip from 'jszip';

export type ExcelViewMode = 'combined' | 'sheets' | 'zip';

export const EXCEL_VIEW_LABELS: Record<ExcelViewMode, string> = {
  combined: 'All in one sheet (combined)',
  sheets: 'Separate sheets (one document)',
  zip: 'Separate documents (zip)',
};

export interface ReportGroup {
  /** Group name — becomes the sheet name, the file name, or the split column. */
  name: string;
  /** Already-formatted rows, key order defining column order. */
  rows: Array<Record<string, string | number>>;
}

/**
 * Excel sheet names are limited to 31 characters and reject : \ / ? * [ ].
 * A truncated name can also collide with another truncated name, which silently
 * overwrites a sheet — so uniqueness is enforced with a numeric suffix.
 */
export function safeSheetName(raw: string, taken: Set<string>): string {
  let base = (raw || 'Sheet').replace(/[:\\/?*[\]]/g, '-').trim().slice(0, 31) || 'Sheet';
  let name = base;
  let n = 2;
  while (taken.has(name.toUpperCase())) {
    const suffix = ` (${n})`;
    base = base.slice(0, 31 - suffix.length);
    name = `${base}${suffix}`;
    n++;
  }
  taken.add(name.toUpperCase());
  return name;
}

/** Strip characters Windows rejects in a file name. */
export function safeFileName(raw: string): string {
  return (raw || 'report').replace(/[\\/:*?"<>|]/g, '-').trim();
}

function sheetFrom(rows: Array<Record<string, string | number>>): XLSX.WorkSheet {
  const ws = XLSX.utils.json_to_sheet(rows);
  // Column widths from the header plus a sample of the body — a report full of
  // ####### columns is not a report anyone can read.
  const headers = Object.keys(rows[0] ?? {});
  ws['!cols'] = headers.map((h) => {
    let width = h.length;
    for (const r of rows.slice(0, 200)) {
      const v = r[h];
      if (v != null) width = Math.max(width, String(v).length);
    }
    return { wch: Math.min(Math.max(width + 2, 8), 55) };
  });
  return ws;
}

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Hand a workbook to the browser.
 *
 * Deliberately NOT `XLSX.writeFile`, which runs its own download internally.
 * Chrome blocks a page's second automatic download unless the user grants the
 * permission, and when it does, SheetJS reports success anyway — the export
 * silently produces no file. Going through one blob path means every mode
 * behaves the same and there is a single place to change if it ever breaks.
 */
function downloadWorkbook(wb: XLSX.WorkBook, fileName: string) {
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  download(
    new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    fileName
  );
}

/**
 * Write the groups out in the chosen shape.
 *
 * `splitColumn` is the header used for the group name in combined mode. Without
 * it a combined export loses which group each row came from, which is the whole
 * reason the groups exist.
 */
export async function exportReport(opts: {
  mode: ExcelViewMode;
  groups: ReportGroup[];
  /** Base name, without extension. */
  baseName: string;
  /** Column header carrying the group name in combined mode. */
  splitColumn?: string;
}): Promise<{ files: number; rows: number }> {
  const { mode, groups, baseName, splitColumn } = opts;
  const usable = groups.filter((g) => g.rows.length > 0);
  if (usable.length === 0) throw new Error('There is nothing to export.');

  const totalRows = usable.reduce((t, g) => t + g.rows.length, 0);

  if (mode === 'combined') {
    // Only add the split column when there is more than one group; a single
    // group would get a column of one repeated value for no reason.
    const rows =
      usable.length > 1 && splitColumn
        ? usable.flatMap((g) => g.rows.map((r) => ({ [splitColumn]: g.name, ...r })))
        : usable.flatMap((g) => g.rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheetFrom(rows), 'Report');
    downloadWorkbook(wb, `${safeFileName(baseName)}.xlsx`);
    return { files: 1, rows: totalRows };
  }

  if (mode === 'sheets') {
    const wb = XLSX.utils.book_new();
    const taken = new Set<string>();
    for (const g of usable) {
      XLSX.utils.book_append_sheet(wb, sheetFrom(g.rows), safeSheetName(g.name, taken));
    }
    downloadWorkbook(wb, `${safeFileName(baseName)}.xlsx`);
    return { files: 1, rows: totalRows };
  }

  // zip — one workbook per group
  const zip = new JSZip();
  const taken = new Set<string>();
  for (const g of usable) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheetFrom(g.rows), safeSheetName(g.name, new Set()));
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
    // Two groups whose names differ only in a forbidden character would collide
    // inside the zip and silently drop one.
    let entry = `${safeFileName(g.name)}.xlsx`;
    let n = 2;
    while (taken.has(entry.toUpperCase())) entry = `${safeFileName(g.name)} (${n++}).xlsx`;
    taken.add(entry.toUpperCase());
    zip.file(entry, buf);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  download(blob, `${safeFileName(baseName)}.zip`);
  return { files: usable.length, rows: totalRows };
}
