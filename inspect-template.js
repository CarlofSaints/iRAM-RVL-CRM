const x = require('xlsx');
const path = 'C:/Users/CarlDosSantos-(OUTER/IRAM/IRAM - In-store/RVL/OJ - RVL CRM/Phase 1/RVL CRM_Store List MASTER.xlsx';
const wb = x.readFile(path);
console.log('Sheets:', wb.SheetNames);
for (const s of wb.SheetNames) {
  const ws = wb.Sheets[s];
  const rows = x.utils.sheet_to_json(ws, { header: 1, defval: '' });
  console.log('--- Sheet:', s, '---');
  console.log('Total rows:', rows.length);
  console.log('First 5 rows:');
  rows.slice(0, 5).forEach((r, i) => console.log(i, JSON.stringify(r)));
}
