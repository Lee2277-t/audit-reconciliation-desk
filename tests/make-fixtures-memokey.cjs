// 生成 tests/fixtures/memokey.xlsx：摘要里带合同/项目/部门线索的两张表
// 运行：ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/make-fixtures-memokey.cjs
const fs = require('fs');
const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'vendor', 'xlsx.full.min.js'));

const recvRows = [
  ['客户名称', '期末余额', '摘要'],
  ['甲公司', 120000, '合同HT-2026-011 货款'],
  ['甲公司', 80000, '项目：二期扩建 工程款'],
  ['乙公司', 45000, '销售部发货运费'],
  ['乙公司', 5000, '合同扫描件'],
  ['丙公司', 30000, '货款'],
  ['合计', 280000, '']
];

const payRows = [
  ['供应商名称', '金额', '摘要'],
  ['甲公司', 100000, '合同HT-2026-011 付货款'],
  ['甲公司', 80000, '项目二期扩建进度款'],
  ['乙公司', 45000, '销售部货款'],
  ['乙公司', 6000, '合同扫描件'],
  ['丙公司', 30000, '货款'],
  ['合计', 261000, '']
];

const workbook = XLSX.utils.book_new();
const recvSheet = XLSX.utils.aoa_to_sheet(recvRows);
recvSheet['!cols'] = [{ wch: 16 }, { wch: 14 }, { wch: 34 }];
XLSX.utils.book_append_sheet(workbook, recvSheet, '应收账款明细');

const paySheet = XLSX.utils.aoa_to_sheet(payRows);
paySheet['!cols'] = [{ wch: 16 }, { wch: 14 }, { wch: 34 }];
XLSX.utils.book_append_sheet(workbook, paySheet, '应付账款明细');

const target = path.join(__dirname, 'fixtures', 'memokey.xlsx');
fs.writeFileSync(target, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
console.log('已写出 ' + target);
