const XLSX = require('xlsx');
const fs = require('fs');

const files = [
  'C:\\Users\\CarlDosSantos-(OUTER\\IRAM\\IRAM - In-store\\RVL\\OJ - RVL CRM\\Phase 1\\Aged stock list format examples\\MORE\\STA007 Aged Stock Weekly 18.2025 (6).xlsx',
  'C:\\Users\\CarlDosSantos-(OUTER\\IRAM\\IRAM - In-store\\RVL\\OJ - RVL CRM\\Phase 1\\Aged stock list format examples\\MORE\\March_Aged_Stock_SAFETOP.xlsx',
  'C:\\Users\\CarlDosSantos-(OUTER\\IRAM\\IRAM - In-store\\RVL\\OJ - RVL CRM\\Phase 1\\Aged stock list format examples\\MORE\\Topline aged stock - JUL2025.xlsx',
  'C:\\Users\\CarlDosSantos-(OUTER\\IRAM\\IRAM - In-store\\RVL\\OJ - RVL CRM\\Phase 1\\Aged stock list format examples\\MORE\\Usabco Home Storage Aged Stock 2 March 2026.xlsx',
];

let out = '';

for (const f of files) {
  const fname = f.split('\\').pop();
  out += '\n' + '='.repeat(80) + '\nFILE: ' + fname + '\n' + '='.repeat(80) + '\n';
  try {
    const wb = XLSX.readFile(f);
    for (const sheetName of wb.SheetNames) {
      out += '\n--- Sheet: "' + sheetName + '" ---\n';
      const ws = wb.Sheets[sheetName];
      const ref = ws['!ref'] || 'A1';
      const range = XLSX.utils.decode_range(ref);
      const totalRows = range.e.r + 1;
      const totalCols = range.e.c + 1;
      out += 'Rows: ' + totalRows + ', Cols: ' + totalCols + '\n\n';

      const rowsToDump = Math.min(10, totalRows);
      for (let r = 0; r < rowsToDump; r++) {
        let line = 'R' + (r + 1) + ': ';
        const cells = [];
        for (let c = 0; c <= range.e.c && c < 20; c++) {
          const addr = XLSX.utils.encode_cell({ r: r, c: c });
          const cell = ws[addr];
          const colLetter = c < 26 ? String.fromCharCode(65 + c) : String.fromCharCode(64 + Math.floor(c / 26)) + String.fromCharCode(65 + (c % 26));
          const val = cell ? String(cell.v).substring(0, 35) : '';
          cells.push('[' + colLetter + '=' + val + ']');
        }
        out += line + cells.join(' ') + '\n';
      }

      if (totalRows > 13) {
        out += '\n... (' + (totalRows - 13) + ' rows omitted) ...\n\n';
        for (let r = totalRows - 3; r < totalRows; r++) {
          let line = 'R' + (r + 1) + ': ';
          const cells = [];
          for (let c = 0; c <= range.e.c && c < 20; c++) {
            const addr = XLSX.utils.encode_cell({ r: r, c: c });
            const cell = ws[addr];
            const colLetter = c < 26 ? String.fromCharCode(65 + c) : String.fromCharCode(64 + Math.floor(c / 26)) + String.fromCharCode(65 + (c % 26));
            const val = cell ? String(cell.v).substring(0, 35) : '';
            cells.push('[' + colLetter + '=' + val + ']');
          }
          out += line + cells.join(' ') + '\n';
        }
      }
    }
  } catch (e) {
    out += 'ERROR: ' + e.message + '\n';
  }
}

fs.writeFileSync('C:\\Users\\CarlDosSantos-(OUTER\\iram-rvl-crm\\inspect-output.txt', out, 'utf-8');
