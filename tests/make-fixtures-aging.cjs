#!/usr/bin/env node
/**
 * 生成夹具 aging.xlsx：账龄的三种原表写法（文字档位 / 日期 / 天数）与「原表没写账龄」。
 * 企业名、人名与金额全部是编的，tests/ 不进交付包。
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/make-fixtures-aging.cjs
 */
'use strict';

const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'vendor', 'xlsx.full.min.js'));

const BAND = ['企业名称', '金额（元）', '账龄', '摘要'];
const BAND_ROWS = [
  ['华信科技有限公司', '120000.00', '1年以内', '货款'],
  ['华信科技有限公司', '80000.00', '1-2年', '货款'],
  ['恒远贸易有限公司', '45000.00', '逾期2年', '设备款'],
  ['恒远贸易有限公司', '30000.00', '三年以上', '质保金'],
  ['蓝湖食品有限公司', '12000.00', '', '尾款未结'],
  ['启明智能装备有限公司', '9000.00', '8个月', '货款'],
  ['启明智能装备有限公司', '5000.00', '逾期45天', '违约金'],
  ['合计', '301000.00', '', '']
];

const DATE = ['供应商名称', '金额（元）', '发生日期', '备注'];
const DATE_ROWS = [
  ['华信科技有限公司', '20000.00', '2026-05-20', '采购原料'],
  ['华信科技有限公司', '15000.00', '2025-06-30', '采购辅料'],
  ['恒远贸易有限公司', '9000.00', '2024-01-15', '设备尾款'],
  ['恒远贸易有限公司', '6000.00', '2022-03-10', '质保金挂账'],
  ['蓝湖食品有限公司', '3000.00', '', '单据未到'],
  ['苏州华达新材料科技有限公司', '4000.00', '2026/9/1', '辅料'],
  ['小计', '57000.00', '', '']
];

const DAYS = ['序号', '欠款人', '余额', '账龄（天）', '说明'];
const DAYS_ROWS = [
  ['1', '王强', '8000.00', '1200', '出差借款'],
  ['2', '李娜', '2500.00', '400', '项目备用金'],
  ['3', '陈涛', '1200.00', '30', '报销在途'],
  ['4', '王强', '600.00', '750', '培训费'],
  ['5', '赵敏', '300.00', '', '未记录']
];

function sheet(head, rows, widths) {
  const ws = XLSX.utils.aoa_to_sheet([head].concat(rows));
  ws['!cols'] = widths.map((wch) => ({ wch }));
  return ws;
}

const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, sheet(BAND, BAND_ROWS, [26, 14, 12, 16]), '应收账款账龄表');
XLSX.utils.book_append_sheet(workbook, sheet(DATE, DATE_ROWS, [26, 14, 14, 16]), '应付账款账龄表');
XLSX.utils.book_append_sheet(workbook, sheet(DAYS, DAYS_ROWS, [8, 14, 12, 12, 16]), '其他应收账龄（天数）');
workbook.Props = { Title: '账龄区间拆分夹具', Author: '双边对账核销工具' };

const target = path.join(__dirname, 'fixtures', 'aging.xlsx');
require('fs').writeFileSync(target, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
console.log('written: ' + target);
