#!/usr/bin/env node
/**
 * 生成夹具 pairing-percent.xlsx：比例容差的三档预期（0% / 0.1% / 1%）。
 * 企业名与金额全部是编的，tests/ 不进交付包。
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/make-fixtures-percent.cjs
 */
'use strict';

const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'vendor', 'xlsx.full.min.js'));

const HEAD = ['企业名称', '金额（元）', '摘要'];
const RECV_ROWS = [
  ['华信科技有限公司', '1000000.00', '货款'],
  ['恒远贸易有限公司', '500000.00', '设备款'],
  ['蓝湖食品有限公司', '200000.00', '尾款'],
  ['启明智能装备有限公司', '123456.78', '质保金'],
  ['合计', '1823456.78', '']
];
const PAY_ROWS = [
  ['华信科技有限公司', '999400.00', '货款'],
  ['恒远贸易有限公司', '500000.00', '设备款'],
  ['蓝湖食品有限公司', '190000.00', '尾款'],
  ['启明智能装备有限公司', '123000.00', '质保金'],
  ['合计', '1812400.00', '']
];

function sheet(rows) {
  const ws = XLSX.utils.aoa_to_sheet([HEAD].concat(rows));
  ws['!cols'] = [{ wch: 28 }, { wch: 15 }, { wch: 16 }];
  return ws;
}

const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, sheet(RECV_ROWS), '应收账款明细');
XLSX.utils.book_append_sheet(workbook, sheet(PAY_ROWS), '应付账款明细');
workbook.Props = { Title: '比例容差夹具', Author: '双边对账核销工具' };

const target = path.join(__dirname, 'fixtures', 'pairing-percent.xlsx');
require('fs').writeFileSync(target, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
console.log('written: ' + target);
