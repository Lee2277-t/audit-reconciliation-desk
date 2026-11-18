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
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  fs.writeFileSync(path.join(out, name), buffer);
}

const recvRows = [
  ['应收账款底稿（2026年9月）'],
  ['企业名称', '业务摘要', '金额（元）'],
  ['北京华信科技有限公司', '9月货款', 128000],
  ['', '9月补记', 32000],
  ['上海恒远贸易有限公司', '设备款', 56800],
  ['杭州云帆信息技术有限公司', '技术服务', 15000],
  ['', '追加服务', 5000],
  ['重庆两江商贸有限公司', '货款', 120000],
  ['', '第二笔货款', 120000],
  ['南京博远贸易有限公司', '零星货款', 7800],
  ['合计', '', 484600]
];
const recvMerges = [
  { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } },
  { s: { r: 2, c: 0 }, e: { r: 3, c: 0 } },
  { s: { r: 5, c: 0 }, e: { r: 6, c: 0 } },
  { s: { r: 7, c: 0 }, e: { r: 8, c: 0 } }
];

const payRows = [
  ['应付账款底稿（2026年9月）'],
  ['企业名称', '业务摘要', '金额（元）'],
  ['北京华信科技有限公司', '材料款', 96000],
  ['上海恒远贸易有限公司', '设备款', 56800],
  ['杭州云帆信息技术有限公司', '服务费', 5000],
  ['重庆两江商贸有限公司', '货款', 120000],
  ['武汉长江器材有限公司', '材料款', 43000],
  ['', '补记材料款', 7000],
  ['合计', '', 327800]
];
const payMerges = [
  { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } },
  { s: { r: 6, c: 0 }, e: { r: 7, c: 0 } }
];

write('sample-two-sheets.xlsx', [
  { name: '应收账款底稿', aoa: recvRows, merges: recvMerges, widths: [38, 20, 16] },
  { name: '应付账款底稿', aoa: payRows, merges: payMerges, widths: [38, 20, 16] }
]);

write('recv-only-merged.xlsx', [
  { name: '应收账款底稿', aoa: recvRows, merges: recvMerges, widths: [38, 20, 16] }
]);

write('combined-direction.xlsx', [
  {
    name: 'Sheet1',
    aoa: [
      ['往来款项明细'],
      ['序号', '企业名称', '方向', '金额'],
      [1, '北京华信科技有限公司', '应收', 128000],
      [2, '北京华信科技有限公司', '应付', 96000],
      [3, '上海恒远贸易有限公司', '应收', 56800],
      [4, '上海恒远贸易有限公司', '应付', 56800],
      [5, '广州启明电子有限公司', '应收', 30000],
      [6, '广州启明电子有限公司', '应收', 30000]
    ],
    widths: [6, 36, 10, 16]
  }
]);

write('generic-sheet-no-direction.xlsx', [
  {
    name: 'Sheet1',
    aoa: [
      ['企业名称', '金额'],
      ['北京华信科技有限公司', 1000],
      ['上海恒远贸易有限公司', 2000]
    ],
    widths: [36, 16]
  }
]);

write('应付账款明细.xlsx', [
  {
    name: 'Sheet1',
    aoa: [
      ['企业名称', '金额'],
      ['北京华信科技有限公司', 1000],
      ['上海恒远贸易有限公司', 2000]
    ],
    widths: [36, 16]
  }
]);

write('title-inference.xlsx', [
  {
    name: 'Sheet1',
    aoa: [
      ['应收账款底稿'],
      ['企业名称', '金额'],
      ['北京华信科技有限公司', 1000],
      ['上海恒远贸易有限公司', 2000]
    ],
    merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }],
    widths: [36, 16]
  }
]);

write('blank-direction-fallback.xlsx', [
  {
    name: '应付账款底稿',
    aoa: [
      ['企业名称', '方向', '金额'],
      ['北京华信科技有限公司', '', 1000],
      ['上海恒远贸易有限公司', '', 2000]
    ],
    widths: [36, 10, 16]
  }
]);

console.log('fixtures written');
