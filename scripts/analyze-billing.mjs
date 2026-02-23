import XLSX from 'xlsx';

const workbook = XLSX.readFile('attached_assets/Mappe3_1771844395244.xlsx');

console.log('=== SHEET NAMES ===');
console.log(workbook.SheetNames);

for (const sheetName of workbook.SheetNames) {
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  
  console.log(`\n=== SHEET: "${sheetName}" (${rows.length} Zeilen) ===`);
  
  if (rows.length > 0) {
    console.log('SPALTEN:', Object.keys(rows[0]));
    console.log('\nERSTE 5 ZEILEN:');
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      console.log(JSON.stringify(rows[i]));
    }
    console.log('\nLETZTE 3 ZEILEN:');
    for (let i = Math.max(0, rows.length - 3); i < rows.length; i++) {
      console.log(JSON.stringify(rows[i]));
    }
  }
}
