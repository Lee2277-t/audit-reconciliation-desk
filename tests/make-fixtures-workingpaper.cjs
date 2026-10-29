const XLSX = require('../vendor/xlsx.full.min.js');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, 'fixtures');
fs.mkdirSync(out, { recursive: true });

function write(name, sheets) {
  const wb = XLSX.utils.book_new();
  sheets.forEach(({ name: sheetName, aoa, merges, widths }) => {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    if (merges) ws['!merges'] = merges;
    if (widths) ws['!cols'] = widths.map((width) => ({ wch: width }));
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  });
  fs.writeFileSync(path.join(out, name), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

const payableSheet = {
  name: '其他应付款明细表',
  aoa: [
    ['其他应付款明细表', '', '', '', '', '', '', '', '', ''],
    ['被审计单位：泓宇实业集团有限公司', '', '编制单位：泓宇实业', '', '期间：2026年12月31日', '', '单位：万元', '', '', ''],
    ['序号', '项目名称', '款项性质', '本期未审', '', '', '', '企业调整', '', '期末审定数'],
    ['', '', '', '期初金额', '本期借方', '本期贷方', '期末金额', '审计调整', '重分类调整', '审定金额'],
    ['一', '合并范围内关联方', '', '3,000.00', '1,200.00', '1,500.00', '3,300.00', '-', '-', '3,300.00'],
    ['1', '甲公司', '资金拆借', '1,000.00', '0', '500.00', '1,500.00', '-', '-', '1,500.00'],
    ['2', '乙公司', '押金保证金', '200.00', '200.00', '200.00', '-', '-', '-', '-'],
    ['3', '丙公司', '往来款', '800.00', '-', '-', '800.00', '-', '-', '800.00'],
    ['二', '外部单位', '', '1,000.00', '-', '-', '1,000.00', '-', '-', '1,000.00'],
    ['4', '丁公司', '质保金', '600.00', '-', '-', '600.00', '-', '-', '600.00'],
    ['5', '戊成建设有限公司', '红字退回', '-', '300.00', '-', '-300.00', '-', '-', '-300.00'],
    ['', '合计', '', '5,000.00', '1,500.00', '1,500.00', '3,600.00', '-', '-', '3,600.00']
  ],
  merges: [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 9 } },
    { s: { r: 2, c: 0 }, e: { r: 3, c: 0 } },
    { s: { r: 2, c: 1 }, e: { r: 3, c: 1 } },
    { s: { r: 2, c: 2 }, e: { r: 3, c: 2 } },
    { s: { r: 2, c: 3 }, e: { r: 2, c: 6 } },
    { s: { r: 2, c: 7 }, e: { r: 2, c: 8 } }
  ],
  widths: [6, 28, 14, 12, 12, 12, 12, 12, 12, 12]
};

write('workingpaper-other-payable.xlsx', [payableSheet]);

write('workingpaper-multi-sheet.xlsx', [
  {
    name: '封面',
    aoa: [
      ['应收应付核对工作簿'],
      ['被审计单位：泓宇实业集团有限公司'],
      ['编制日期：2026年1月8日']
    ],
    widths: [40]
  },
  {
    name: '目录',
    aoa: [
      ['目录'],
      ['序号', '科目名称', '页次'],
      ['1', '应收账款', '3'],
      ['2', '其他应付款', '7']
    ],
    widths: [8, 24, 8]
  },
  {
    name: '试算平衡表',
    aoa: [
      ['试算平衡表', '单位：元'],
      ['科目名称', '期末余额', '期初余额'],
      ['应收账款', '350.00', '400.00'],
      ['其他应付款', '29,000,000.00', '28,000,000.00']
    ],
    widths: [20, 18, 18]
  },
  {
    name: '应收账款明细表',
    aoa: [
      ['企业名称', '金额（元）', '摘要'],
      ['甲公司', 100, '货款'],
      ['乙公司', 250, '货款']
    ],
    widths: [30, 14, 18]
  },
  payableSheet
]);

console.log('working paper fixtures written');
