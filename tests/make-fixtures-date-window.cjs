// 生成 tests/fixtures/date-window.xlsx：同额多笔、日期乱序，用来验证「日期近的先配」与远日期提示
// 运行：ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/make-fixtures-date-window.cjs
const fs = require('fs');
const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'vendor', 'xlsx.full.min.js'));

const recvRows = [
  ['客户名称', '期末余额', '发生日期', '摘要'],
  ['华信科技', 100000, '2025-01-10', '货款'],
  ['华信科技', 100000, '2026-03-10', '货款'],
  ['恒远贸易', 50000, '', '合同HT-2026-011 货款'],
  ['远山实业', 70000, '2025-06-01', '货款'],
  ['合计', 320000, '', '']
];

const payRows = [
  ['供应商名称', '金额', '发生日期', '摘要'],
  ['华信科技', 100000, '2026-03-09', '货款'],
  ['华信科技', 100000, '2025-01-12', '货款'],
  ['恒远贸易', 50000, '2026-02-01', '合同HT-2026-011 付货款'],
  ['远山实业', 70000, '2026-06-01', '货款'],
  ['合计', 390000, '', '']
];

const workbook = XLSX.utils.book_new();
const recvSheet = XLSX.utils.aoa_to_sheet(recvRows);
recvSheet['!cols'] = [{ wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 28 }];
XLSX.utils.book_append_sheet(workbook, recvSheet, '应收账款明细');

const paySheet = XLSX.utils.aoa_to_sheet(payRows);
paySheet['!cols'] = [{ wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 28 }];
XLSX.utils.book_append_sheet(workbook, paySheet, '应付账款明细');

const target = path.join(__dirname, 'fixtures', 'date-window.xlsx');
fs.writeFileSync(target, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
console.log('已写出 ' + target);
