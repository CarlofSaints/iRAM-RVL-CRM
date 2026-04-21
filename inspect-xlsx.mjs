import XLSX from 'xlsx';
import fs from 'fs';

const files = [
  'C:\\Users\\CarlDosSantos-(OUTER\\IRAM\\IRAM - In-store\\RVL\\OJ - RVL CRM\\Phase 1\\Aged stock list format examples\\MORE\\STA007 Aged Stock Weekly 18.2025 (6).xlsx',
  'C:\\Users\\CarlDosSantos-(OUTER\\IRAM\\IRAM - In-store\\RVL\\OJ - RVL CRM\\Phase 1\\Aged stock list format examples\\MORE\\March_Aged_Stock_SAFETOP.xlsx',
  'C:\\Users\\CarlDosSantos-(OUTER\\IRAM\\IRAM - In-store\\RVL\\OJ - RVL CRM\\Phase 1\\Aged stock list format examples\\MORE\\Topline aged stock - JUL2025.xlsx',
  'C:\\Users\\CarlDosSantos-(OUTER\\IRAM\\IRAM - In-store\\RVL\\OJ - RVL CRM\\Phase 1\\Aged stock list format examples\\MORE\\Usabco Home Storage Aged Stock 2 March 2026.xlsx',
];

let out = '';

for (const f of files) {
  out += `\n${'='.repeat(80)}\nFILE: ${f.split('\\').pop()}\n${'='.repeat(80)}\n`;
  try {
    const wb = XLSX.readFile(f);
    for (const sheetName of wb.SheetNames) {
      out += `\n--- Sheet: "${sheetName}" ---\n`;
      const ws = wb.Sheets[sheetName];
      const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
      const totalRows = range.e.r + 1;
      const totalCols = range.e.c + 1;
      out += `Rows: ${totalRows}, Cols: ${totalCols}\n\n`;

      // Dump first 10 rows
      const rowsToDump = Math.min(10, totalRows);
      for (let r = 0; r < rowsToDump; r++) {
        const cells = [];
        for (let c = 0; c <= range.e.c; c++) {
          const addr = XLSX.utils.encode_cell({ r, c });
          const cell = ws[addr];
          cells.push(cell ? String(cell.v).substring(0, 40) : '');
        }
        out += `R${r + 1}: ${cells.map((v, i) => `[${String.fromCharCode(65 + (i > 25 ? 64 + Math.floor(i/26) : 0)) + String.fromCharCode(65 + i%26)}=${v}]`).join(' ')}\n`;
      }

      // Also dump last 3 rows to see subtotals
      if (totalRows > 13) {
        out += `\n... (${totalRows - 13} rows omitted) ...\n\n`;
        for (let r = totalRows - 3; r < totalRows; r++) {
          const cells = [];
          for (let c = 0; c <= range.e.c; c++) {
            const addr = XLSX.utils.encode_cell({ r, c });
            const cell = ws[addr];
            cells.push(cell ? String(cell.v).substring(0, 40) : '');
          }
          out += `R${r + 1}: ${cells.map((v, i) => `[${String.fromCharCode(65 + (i > 25 ? 64 + Math.floor(i/26) : 0)) + String.fromCharCode(65 + i%26)}=${v}]`).join(' ')}\n`;
        }
      }
    }
  } catch (e) {
    out += `ERROR: ${e.message}\n`;
  }
}

fs.writeFileSync('C:\\Users\\CarlDosSantos-(OUTER\\iram-rvl-crm\\inspect-output.txt', out);
