#!/usr/bin/env node
/**
 * 「勾了却一笔都没算进去」的静默空跑回归：这种表必须被点名（数据检查 + toast + 导出说明）。
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/empty-source-check.cjs
 *
 * 场景来自真实底稿：① 一张名字列只有「合计／小计」的模板披露表（现在不自动勾选，用户勾了要能点名）；
 * ② 一张名字填了公司、金额却只写在「合计」行的表（会自动勾选，只能靠「一笔都没算进去」点名）。
 * 两种都静悄悄：取数核对恒等式照样平，旧版什么都不会报。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'assets', 'app.js');
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
    dataset: {},
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
    TypeError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => {},
    encodeURIComponent,
    decodeURIComponent,
    TextDecoder,
    TextEncoder,
    Blob: function () {},
    File: function () {},
    URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
    navigator: {},
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => stub()
    },
    window: { addEventListener() {}, confirm: () => true, print() {} }
  };

  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP, 'utf8'), sandbox);
  vm.runInContext(
    `['toast','runError','fileError','manualError','dataCheck','similarBox','resultBody','summary',
       'landingSection','configSection','resultSection','pairTolerance','pairPercent','searchInput',
       'sortSelect','exportFiltered','ageBandPreset','signoffDate','exportReceiptBody','snapshotDiff',
       'manualRecv','manualPay','manualUnit','sourceList','previewTable','columnStatus','sheetMap',
       'mapScroll','mapMeta','headerRowSelect','activeFileName','activeSheetName','resultMeta',
       'exportBtn','printBtn','undoBtn','nettingNote','sourceCount','sourceSelectAll',
       'sourceSelectNone','sourceSearch','sourceFilterNote'].forEach((id) => { els[id] = __stub(); });
     els.exportFiltered.checked = false;
     els.manualUnit.value = '1';
     renderSummary = renderChips = renderTable = renderSimilarBox = renderFingerprint =
       renderSnapshotComparison = renderExportReceipt = renderUndoButton = updateResultMeta =
       renderPreview = renderColumnStatus = function () {};
     globalThis.__state = state;
     globalThis.__els = els;`,
    Object.assign(sandbox, { __stub: stub })
  );

  const originalWriteFile = XLSX.writeFile;
  XLSX.writeFile = (workbook) => { captured.push(workbook); };
  return { sandbox, captured, restore: () => { XLSX.writeFile = originalWriteFile; } };
}

function moneySheet(rows) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  return sheet;
}

function buildWorkbook(withEmptyTemplate) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, moneySheet([
    ['应收账款明细'],
    ['编制单位：测试公司', '', '金额单位：元'],
    [],
    ['客户名称', '期末余额', '摘要'],
    ['甲公司', 100000, '货款'],
    ['乙公司', 250000, '货款'],
    ['丙公司', 60000, '服务费']
  ], '应收账款明细'), '应收账款明细');
  if (withEmptyTemplate) {
    // 真实底稿里最常见的两种空跑，来源都是模板页：
    // ① 整张表只有「合计／小计」这一列填了数 —— 名字列其实没有对手方，现在不再自动勾选（要用户自己勾）；
    // ② 名字列填了公司、金额却只写在「合计」那一行上 —— 列有数字、金额列证据也够，会自动勾选，结果一笔都没有。
    const rows = [
      ['应付账款明细'],
      ['编制单位：测试公司', '', '金额单位：元'],
      [],
      ['供应商名称', '期末余额', '摘要'],
      ['合计', 500000, ''],
      ['小计', 500000, ''],
      ['合计', 120000, '']
    ];
    XLSX.utils.book_append_sheet(book, moneySheet(rows), '应付账款明细');
    XLSX.utils.book_append_sheet(book, moneySheet([
      ['其他应付款明细'],
      ['编制单位：测试公司', '', '金额单位：元'],
      [],
      ['供应商名称', '期末余额', '摘要'],
      ['丁公司', '', '还没入账'],
      ['戊公司', '', '还没入账'],
      ['合计', 620000, '']
    ], '其他应付款明细'), '其他应付款明细');
  }
  return book;
}

function loadWorkbook(sandbox, book, fileName) {
  const buffer = new Uint8Array(XLSX.write(book, { bookType: 'xlsx', type: 'array' }));
  const workbook = sandbox.readWorkbook({ name: fileName }, buffer);
  const state = sandbox.__state;
  state.sources = workbook.SheetNames.map((sheetName, index) => (
    sandbox.buildSource({ name: fileName, size: 1, lastModified: 1 }, workbook, sheetName, `${fileName}::${index + 1}`)
  )).filter(Boolean);
  return state.sources;
}

function noteRows(sandbox, captured) {
  const book = captured[captured.length - 1];
  const sheet = book.Sheets['对账说明'];
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
  return grid.map((row) => [String(row[0]), String(row[1])]);
}

function main() {
  const { sandbox, captured, restore } = createSandbox();
  const state = sandbox.__state;
  const els = sandbox.__els;

  /* —— ① 导入后零勾选；用户自己勾，空表仍要在对账后被点名 —— */
  const sources = loadWorkbook(sandbox, buildWorkbook(true), '空模板底稿.xlsx');
  const emptySource = sources.find((source) => source.sheetName === '应付账款明细');
  const blankAmount = sources.find((source) => source.sheetName === '其他应付款明细');
  check('空模板表认到了对手方列', emptySource && emptySource.mapping.company === 0,
    emptySource ? `col=${emptySource.mapping.company}` : '没找到这张表');
  check('空模板表认到了金额列', emptySource && emptySource.mapping.amount === 1,
    emptySource ? `col=${emptySource.mapping.amount}` : '');
  check('导入后所有工作表默认都不勾选', sources.length === 3 && sources.every((source) => source.included === false),
    JSON.stringify(sources.map((source) => [source.sheetName, source.included])));
  check('金额只在合计行的表仍能认列，但默认不勾选', Boolean(blankAmount) && blankAmount.usable === true &&
    blankAmount.included === false && blankAmount.companyDoubt === false && blankAmount.amountDoubt === false,
    blankAmount ? `usable=${blankAmount.usable} included=${blankAmount.included} doubt=${blankAmount.amountDoubt}/${blankAmount.companyDoubt}` : '没找到这张表');
  sources.forEach((source) => { source.included = true; });   // 用户自己把要核对的表全部勾上

  sandbox.runReconciliation();
  const runSources = state.runInfo.sources;
  const emptyRun = runSources.find((item) => item.sheetName === '应付账款明细');
  const blankRun = runSources.find((item) => item.sheetName === '其他应付款明细');
  check('空模板表算出 0 笔', emptyRun && emptyRun.recordCount === 0, JSON.stringify(runSources.map((item) => [item.sheetName, item.recordCount])));
  check('只有名字的表也算出 0 笔', blankRun && blankRun.recordCount === 0, JSON.stringify(runSources.map((item) => [item.sheetName, item.recordCount])));
  check('有数据那张照常算', state.records.length === 3 && state.groups.length === 3,
    `${state.records.length}/${state.groups.length}`);
  check('空表不污染净额', state.stats.netRecvCents === 41000000 && state.stats.netPayCents === 0,
    `${state.stats.netRecvCents}/${state.stats.netPayCents}`);

  const names = sandbox.emptyIncludedSourceNames();
  check('两张空表都被点名', names.length === 2 && names.includes('应付账款明细') && names.includes('其他应付款明细'),
    JSON.stringify(names));

  /* 取数核对对这张表照样平（全是「正常跳过」）—— 这正是只有新预警能发现的场景 */
  const total = sandbox.combineControls(state.controls);
  const emptyControl = state.controls.find((control) => control.sheetName === '应付账款明细');
  check('空表的取数核对是平的', Boolean(emptyControl) && emptyControl.ok === true &&
    emptyControl.includedCents === 0 && emptyControl.skippedCents === 112000000,
    JSON.stringify(emptyControl && { ok: emptyControl.ok, inc: emptyControl.includedCents, skip: emptyControl.skippedCents }));
  const blankControl = state.controls.find((control) => control.sheetName === '其他应付款明细');
  check('金额只在合计行的表取数核对仍是平的', Boolean(blankControl) && blankControl.ok === true &&
    blankControl.includedCents === 0 && blankControl.rawCents === 62000000 && blankControl.skippedCents === 62000000,
    JSON.stringify(blankControl && { ok: blankControl.ok, raw: blankControl.rawCents, inc: blankControl.includedCents, skip: blankControl.skippedCents }));
  check('合并取数核对仍平', total.ok === true && total.includedCents === 41000000,
    `ok=${total.ok} inc=${total.includedCents}`);

  /* —— ①.5 列表里要直接写出「企业名、金额各看哪一列」，还要把 0 笔的表标出来 —— */
  sandbox.renderSourceList();
  const listHtml = String(els.sourceList.innerHTML);
  const strip = (text) => String(text).replace(/<[^>]*>/g, '').trim();
  const rows = listHtml.split('<div class="source-row').slice(1).map((block) => `${
    strip(block.split('class="source-name">')[1].split('</span>')[0])}｜${
    strip(block.split('class="source-sub">')[1].split('</button>')[0])}`);
  const recvLine = String(rows.find((row) => row.startsWith('应收账款明细｜')));
  const templateLine = String(rows.find((row) => row.startsWith('应付账款明细｜')));
  check('列表写出企业列是哪一列的什么表头', /企业名称看 A 列「客户名称」/.test(recvLine), recvLine);
  check('列表写出金额列是哪一列的什么表头', /金额看 B 列「期末余额」/.test(recvLine), recvLine);
  check('0 笔的表在列表里被标出来', rows.filter((row) => /一笔都没算进去/.test(row)).length === 2,
    JSON.stringify(rows));
  check('勾上的模板页也标了 0 笔', /一笔都没算进去/.test(templateLine), templateLine);
  check('标了 0 笔就告诉人怎么办', /source-empty-run"[^>]*title="[^"]*取消勾选/.test(listHtml),
    listHtml.slice(0, 160));

  /* —— ② 数据检查要说出来 —— */
  state.dataCheckOpen = true;
  sandbox.renderDataCheck();
  const html = els.dataCheck.innerHTML;
  check('数据检查判成警告', /data-check warn/.test(html), html.slice(0, 80));
  check('标题写了「一笔都没算进去」', /2 张勾选的表一笔都没算进去/.test(html));
  check('明细点名到表', /「应付账款明细」/.test(html) && /「其他应付款明细」/.test(html) && /取消勾选/.test(html));

  /* —— ③ toast 要说出来（排在「对账完成」之后，是最后一条）—— */
  check('toast 是空表预警', /一笔都没算进去/.test(els.toast.textContent), els.toast.textContent);

  /* —— ④ 导出说明要留痕 —— */
  els.dataCheckOpen = false;
  sandbox.exportResults();
  check('导出了文件', captured.length === 1, `captured=${captured.length}`);
  const notes = noteRows(sandbox, captured);
  const noteRow = notes.find(([label]) => label === '没算进记录的表');
  check('对账说明有「没算进记录的表」', Boolean(noteRow) && /应付账款明细/.test(noteRow[1]) && /其他应付款明细/.test(noteRow[1]),
    JSON.stringify(noteRow));
  const zeroLines = notes.filter(([label]) => label === '数据源').filter(([, text]) => /0 笔/.test(text));
  check('数据源行写明了 0 笔', zeroLines.length === 2, JSON.stringify(zeroLines.map(([label, text]) => text)));

  /* —— ⑤ 没有空表时不得无病呻吟 —— */
  const clean = loadWorkbook(sandbox, buildWorkbook(false), '干净底稿.xlsx');
  check('干净底稿只有一张表', clean.length === 1, `len=${clean.length}`);
  clean[0].included = true;   // 用户自己勾上这张要核对的数据表
  sandbox.runReconciliation();
  check('没空表时不点名', sandbox.emptyIncludedSourceNames().length === 0,
    JSON.stringify(sandbox.emptyIncludedSourceNames()));
  state.dataCheckOpen = true;
  sandbox.renderDataCheck();
  check('数据检查判成通过', /data-check ok/.test(els.dataCheck.innerHTML) && /数据检查通过/.test(els.dataCheck.innerHTML),
    els.dataCheck.innerHTML.slice(0, 120));
  check('toast 回到「对账完成」', /^对账完成/.test(els.toast.textContent), els.toast.textContent);
  captured.length = 0;
  sandbox.exportResults();
  const cleanNotes = noteRows(sandbox, captured);
  check('干净底稿的说明不多这一行', !cleanNotes.some(([label]) => label === '没算进记录的表'));

  /* —— ⑥ 手动粘贴一侧为空，同样要说出来 —— */
  els.manualRecv.value = '甲公司\t1000\n乙公司\t2000\n';
  els.manualPay.value = '随便一行没有金额\n';
  sandbox.runManualReconciliation();
  const manualNames = sandbox.emptyIncludedSourceNames();
  check('手动右侧为空也被点名', manualNames.length === 1 && manualNames[0] === '右侧粘贴', JSON.stringify(manualNames));
  check('手动模式只算左侧', state.records.length === 2 && state.stats.netPayCents === 0,
    `${state.records.length}/${state.stats.netPayCents}`);

  /* —— ⑦ 只有一张空表：走原有的「没有读到可用记录」，不该走到空表预警 —— */
  const only = loadWorkbook(sandbox, (() => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, moneySheet([
      ['应付账款明细'],
      ['供应商名称', '期末余额'],
      ['合计', 880000],
      ['小计', 880000]
    ]), '应付账款明细');
    return book;
  })(), '全是空表.xlsx');
  check('单独一张模板页也不自动勾选', only.length === 1 && only[0].usable === true &&
    only[0].included === false && only[0].companyDoubt === true,
    `included=${only[0].included} doubt=${only[0].companyDoubt}`);
  only[0].included = true;   // 用户还是把它勾上了
  sandbox.runReconciliation();
  check('只剩空表时按原有的报错停下', /没有读到可用记录/.test(els.runError.textContent), els.runError.textContent);

  restore();
  if (failures.length) {
    console.log(`EMPTY_SOURCE_CHECK FAIL failures=${failures.length} total=${pass + failures.length}`);
    failures.forEach((item) => console.log(`  - ${item}`));
    process.exit(1);
  }
  console.log(`EMPTY_SOURCE_CHECK PASS failures=0 total=${pass}`);
}

main();
