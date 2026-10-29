#!/usr/bin/env node
/**
 * 生成夹具 multi-dimension.xlsx：同一家企业按主体、按币种分开算，不同币种不混加。
 * 第 2 行的主体与币种留空，用来验证合并单元格承上。
 * 企业名与金额全部是编的，tests/ 不进交付包。
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/make-fixtures-multi-dimension.cjs
 */
'use strict';

const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'vendor', 'xlsx.full.min.js'));

const RECV = ['主体', '客户名称', '币种', '金额', '摘要'];
const RECV_ROWS = [
  ['甲公司', '华信科技有限公司', '人民币', '1000000.00', '货款'],
  ['', '华信科技有限公司', '', '300000.00', '补充货款'],
  ['甲公司', '华信科技有限公司', '美元', '200000.00', '出口货款'],
  ['乙公司', '华信科技有限公司', '人民币', '400000.00', '货款'],
  ['甲公司', '恒远贸易有限公司', '人民币', '500000.00', '货款'],
  ['', '合计', '', '2400000.00', '']
];

const PAY = ['主体', '供应商名称', '币种', '金额', '摘要'];
const PAY_ROWS = [
  ['甲公司', '华信科技有限公司', '人民币', '900000.00', '采购款'],
  ['甲公司', '华信科技有限公司', '美元', '180000.00', '进口货款'],
  ['乙公司', '华信科技有限公司', '人民币', '400000.00', '采购款'],
  ['甲公司', '恒远贸易有限公司', '人民币', '500000.00', '采购款'],
  ['', '合计', '', '1980000.00', '']
];

function sheet(head, rows, widths) {
  const ws = XLSX.utils.aoa_to_sheet([head].concat(rows));
  ws['!cols'] = widths.map((wch) => ({ wch }));
  return ws;
}

const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, sheet(RECV, RECV_ROWS, [12, 26, 10, 16, 16]), '应收账款');
XLSX.utils.book_append_sheet(workbook, sheet(PAY, PAY_ROWS, [12, 26, 10, 16, 16]), '应付账款');
workbook.Props = { Title: '多主体多币种夹具', Author: '双边对账核销工具' };

const target = path.join(__dirname, 'fixtures', 'multi-dimension.xlsx');
require('fs').writeFileSync(target, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
console.log('written: ' + target);
