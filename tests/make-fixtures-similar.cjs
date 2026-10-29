#!/usr/bin/env node
/**
 * 生成夹具 similar-and-docs.xlsx：疑似同一企业三档建议 + 同单据号提示 + 分公司否决。
 * 企业名与金额全部是编的，tests/ 不进交付包。
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/make-fixtures-similar.cjs
 */
'use strict';

const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'vendor', 'xlsx.full.min.js'));

const HEAD = ['企业名称', '金额', '摘要'];

const RECV = [
  ['北京华信科技有限公司', '100000.00', '发票号 20260009'],
  ['上海华信科技有限公司', '50000.00', '货款'],
  ['华信科技有限公司', '12000.00', '发票号 20260001'],
  ['恒远贸易有限公司', '30000.00', '单据号 20260002'],
  ['恒远贸易有限公司青岛分公司', '9000.00', '分公司货款'],
  ['苏州华达新材料科技有限公司', '20000.00', '合同 20260007'],
  ['苏州华达新材料科技有限全司', '20000.00', '合同 20260008'],
  ['蓝湖食品有限公司', '5000.00', '无单号'],
  ['合计', '226000.00', '']
];

const PAY = [
  ['北京华信科技有限公司', '8000.00', '采购款'],
  ['上海华信科技有限公司', '8000.00', '采购款'],
  ['华信科技有限公司', '12000.00', '发票号 20260001'],
  ['恒远贸易有限公司', '7500.00', '单据号 20260002'],
  ['苏州华达新材料科技有限公司', '20000.00', '合同 20260007'],
  ['蓝湖食品有限公司', '5000.00', '收据 20260011'],
  ['合计', '60500.00', '']
];

function sheet(rows) {
  const ws = XLSX.utils.aoa_to_sheet([HEAD].concat(rows));
  ws['!cols'] = [{ wch: 32 }, { wch: 14 }, { wch: 22 }];
  return ws;
}

const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, sheet(RECV), '应收账款明细');
XLSX.utils.book_append_sheet(workbook, sheet(PAY), '应付账款明细');
workbook.Props = { Title: '疑似同一企业与同单据号夹具', Author: '双边对账核销工具' };

const target = path.join(__dirname, 'fixtures', 'similar-and-docs.xlsx');
require('fs').writeFileSync(target, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
console.log('written: ' + target);
