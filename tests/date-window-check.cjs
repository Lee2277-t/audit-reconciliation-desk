#!/usr/bin/env node
/**
 * 日期窗口提示回归：不依赖浏览器，用 vm 加载 app.js 跑真实解析 / 配对 / 导出。
 * 断言点：日期从账龄列或摘要取、同额多笔按日期就近配、合同号不当日期、远日期只提示不改金额。
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/date-window-check.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'assets', 'app.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'date-window.xlsx');
const XLSX = require(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));

let pass = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    return;
  }
  failures.push(detail ? `${name}（${detail}）` : name);
}

function createSandbox() {
  const captured = [];
  const stub = () => ({
    textContent: '',
    innerHTML: '',
    value: '',
    style: {},
    disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {},
    addEventListener() {},
    scrollIntoView() {},
    focus() {},
    select() {},
    click() {}
  });

  const sandbox = {
    XLSX,
    console,
    Intl,
    Date,
    Math,
    JSON,
    Number,
    String,
    Object,
    Array,
    Map,
    Set,
    RegExp,
    Error,
    parseInt,
    parseFloat,
    isNaN,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: () => {},
    encodeURIComponent,
    decodeURIComponent,
    TextDecoder,
    TextEncoder,
    Blob: function () {},
    URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
    navigator: {},
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => stub()
    },
    window: { addEventListener() {} }
  };

  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP, 'utf8'), sandbox);
  vm.runInContext(
    `['toast', 'runError', 'fileError', 'manualError'].forEach((id) => { els[id] = __stub(); });
     globalThis.__state = state;`,
    Object.assign(sandbox, { __stub: stub })
  );

  const originalWriteFile = XLSX.writeFile;
  XLSX.writeFile = (workbook) => {
    captured.push(workbook);
  };

  return { sandbox, captured, restore: () => { XLSX.writeFile = originalWriteFile; } };
}

function main() {
  const { sandbox, captured, restore } = createSandbox();

  const state = sandbox.__state;
  state.autoDetectCols = true;
  state.sort = 'netAbsDesc';
  state.pairPercent = 0;
  state.ageBaseDate = '2026-10-31';

  const workbook = XLSX.read(fs.readFileSync(FIXTURE), { type: 'buffer' });
  const fileName = 'date-window.xlsx';
  let seq = 0;
  const sources = workbook.SheetNames
    .map((sheetName) => sandbox.buildSource({ name: fileName, size: 1, lastModified: 1 }, workbook, sheetName, `${fileName}::${++seq}`))
    .filter(Boolean);

  check('两张表都可用', sources.length === 2 && sources.every((source) => source.usable), `sources=${sources.length}`);

  const ageColumns = sources.map((source) => sandbox.sourceAgeColumn(source));
  check('账龄列认成发生日期（C 列、按日期）', ageColumns.every((age) => age && age.index === 2 && age.kind === 'date'),
    JSON.stringify(ageColumns.map((age) => (age ? { index: age.index, kind: age.kind } : null))));

  const records = [];
  sources.forEach((source) => {
    sandbox.parseExcelSource(source).records.forEach((record) => records.push(record));
  });

  check('共 8 笔记录', records.length === 8, `records=${records.length}`);
  check('每笔都带 dateISO 字段', records.every((record) => Object.prototype.hasOwnProperty.call(record, 'dateISO')));

  const hengyuan = records.filter((record) => record.key && record.key.indexOf('恒远') >= 0);
  const hengyuanRecv = hengyuan.find((record) => record.dir === 'recv');
  check('合同号 HT-2026-011 不会被当成日期', hengyuanRecv && hengyuanRecv.dateISO === '' && hengyuanRecv.dateSource === '',
    hengyuanRecv ? `${hengyuanRecv.dateISO}|${hengyuanRecv.dateSource}` : 'missing');

  const extracted = [
    ['2025年1月10日付款', '2025-01-10'],
    ['2025-03-09 货款', '2025-03-09'],
    ['2025年3月付款', '2025-03-01'],
    ['合同HT-2026-011 货款', ''],
    ['HT-2026-01', ''],
    ['20260001', '']
  ];
  extracted.forEach(([text, expected]) => {
    const actual = sandbox.extractMemoDate(text);
    check(`摘要日期识别 ${text}`, actual === expected, `actual=${actual}`);
  });

  const groups = sandbox.buildGroups(records);
  state.groups = groups;
  const result = sandbox.runPairing(groups, 1);

  check('共 4 组配对', result.pairCount === 4, `pairCount=${result.pairCount}`);

  const huaxin = groups.find((group) => group.displayName.indexOf('华信') >= 0);
  check('华信 2 组配对', huaxin && huaxin.pairings.length === 2, huaxin ? `pairings=${huaxin.pairings.length}` : 'missing');

  if (huaxin && huaxin.pairings.length === 2) {
    const gaps = huaxin.pairings.map((pairing) => pairing.dateGapDays).sort((a, b) => a - b);
    check('华信两组日期差为 1 天和 2 天', JSON.stringify(gaps) === '[1,2]', JSON.stringify(gaps));

    const first = huaxin.pairings.find((pairing) => pairing.recvDateFrom === '2025-01-10');
    check('2025-01-10 配到 2025-01-12', first && first.payDateFrom === '2025-01-12', first ? first.payDateFrom : 'missing');
    const second = huaxin.pairings.find((pairing) => pairing.recvDateFrom === '2026-03-10');
    check('2026-03-10 配到 2026-03-09', second && second.payDateFrom === '2026-03-09', second ? second.payDateFrom : 'missing');
    check('华信没有远日期提醒', huaxin.pairings.every((pairing) => pairing.dateFar === false));
    check('华信日期文案含相差', huaxin.pairings.every((pairing) => sandbox.pairDateText(pairing).indexOf('相差') >= 0));
  }

  const yuanshan = groups.find((group) => group.displayName.indexOf('远山') >= 0);
  check('远山差 365 天且标为远日期',
    yuanshan && yuanshan.pairings.length === 1 && yuanshan.pairings[0].dateGapDays === 365 && yuanshan.pairings[0].dateFar === true,
    yuanshan && yuanshan.pairings[0] ? `${yuanshan.pairings[0].dateGapDays}|${yuanshan.pairings[0].dateFar}` : 'missing');
  check('远山日期文案带「请留意」', yuanshan && sandbox.pairDateText(yuanshan.pairings[0]).indexOf('请留意') >= 0);

  const hengyuanGroup = groups.find((group) => group.displayName.indexOf('恒远') >= 0);
  check('恒远没有可对照日期',
    hengyuanGroup && hengyuanGroup.pairings.length === 1 && hengyuanGroup.pairings[0].dateGapDays === null,
    hengyuanGroup && hengyuanGroup.pairings[0] ? String(hengyuanGroup.pairings[0].dateGapDays) : 'missing');
  check('没有日期时不出日期文案', hengyuanGroup && sandbox.pairDateText(hengyuanGroup.pairings[0]) === '');

  const stats = sandbox.computeStats(groups);
  check('日期可对照 3 组', stats.pairDateCount === 3, `pairDateCount=${stats.pairDateCount}`);
  check('远日期 1 组', stats.pairDateFarCount === 1, `pairDateFarCount=${stats.pairDateFarCount}`);
  check('远日期涉及 1 家', stats.pairDateFarGroups === 1, `pairDateFarGroups=${stats.pairDateFarGroups}`);

  const netSum = groups.reduce((sum, group) => sum + group.netCents, 0);
  check('日期提示不改变净额（全部已平）', netSum === 0, `netSum=${netSum}`);
  check('配对不改金额：已配对合计等于两侧总额',
    result.pairedRecvCents === 32000000 && result.pairedPayCents === 32000000,
    `${result.pairedRecvCents}|${result.pairedPayCents}`);

  state.groups = groups;
  const exportWorkbook = sandbox.buildExportWorkbook(groups, '测试范围');
  const pairSheet = exportWorkbook.Sheets['核销配对'];
  const pairMatrix = XLSX.utils.sheet_to_json(pairSheet, { header: 1, raw: true });
  check('核销配对表 12 列', pairMatrix[0].length === 12, `cols=${pairMatrix[0].length}`);
  check('最后一列是日期情况', pairMatrix[0][11] === '日期情况', String(pairMatrix[0][11]));
  check('配对表自动筛选到 L 列', pairSheet['!autofilter'] && pairSheet['!autofilter'].ref === `A1:L${pairMatrix.length}`,
    pairSheet['!autofilter'] ? pairSheet['!autofilter'].ref : 'none');
  check('远日期行写明 365 天', pairMatrix.some((row) => row[11] && String(row[11]).indexOf('365 天') >= 0));
  check('没有日期的行写明没有可对照的日期', pairMatrix.some((row) => row[11] === '没有可对照的日期'));

  const infoSheet = exportWorkbook.Sheets['对账说明'];
  const infoMatrix = XLSX.utils.sheet_to_json(infoSheet, { header: 1, raw: true });
  const dateRow = infoMatrix.find((row) => row[0] === '日期线索');
  check('对账说明有日期线索行', !!dateRow);
  check('对账说明写明 3 组可比、1 组超 90 天', !!dateRow && /3 组/.test(String(dateRow[1])) && /1 组相差超过 90 天/.test(String(dateRow[1])),
    dateRow ? String(dateRow[1]) : 'missing');

  // 日期只做提示：把日期字段抹掉后配对结果（金额与组数）不变
  const beforeShape = groups.map((group) => group.pairings.map((pairing) => `${pairing.recvCents}|${pairing.payCents}`).join(',')).join(';');
  groups.forEach((group) => group.rows.forEach((row) => { row.dateISO = ''; }));
  sandbox.runPairing(groups, 1);
  const afterShape = groups.map((group) => group.pairings.map((pairing) => `${pairing.recvCents}|${pairing.payCents}`).join(',')).join(';');
  check('去掉日期后配对组数与金额不变', beforeShape === afterShape, `${beforeShape} -> ${afterShape}`);

  restore();
  void captured;

  console.log(`DATE_WINDOW_CHECK ${failures.length ? 'FAIL' : 'PASS'} pass=${pass} fail=${failures.length} total=${pass + failures.length}`);
  failures.forEach((item) => console.log('  FAIL ' + item));
  process.exit(failures.length ? 1 : 0);
}

main();
