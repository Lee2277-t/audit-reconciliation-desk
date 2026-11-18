#!/usr/bin/env node
/**
 * 大表分批渲染回归：默认只画 100 家，可继续显示，打印时始终全量。
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/render-limit-check.cjs
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
    click() {},
    querySelectorAll: () => []
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
    `['resultBody', 'visibleCount', 'toast', 'runError', 'fileError', 'manualError'].forEach((id) => { els[id] = __stub(); });
     els.exportFiltered = { checked: false };
     groupMarkup = function (group) { return '<tr data-key="' + group.key + '"></tr>'; };
     globalThis.__state = state;
     globalThis.__els = els;`,
    Object.assign(sandbox, { __stub: stub })
  );

  return sandbox;
}

function makeRecord(company, cents, rowNo) {
  return {
    rowNo,
    companyRaw: company,
    key: company,
    dir: 'recv',
    cents,
    rawCents: cents,
    cellCents: cents,
    memo: '',
    docNo: '',
    docKey: '',
    memoKeys: [],
    ageBand: -1,
    hasAgeColumn: false,
    dateISO: '',
    dateSource: '',
    sourceId: 'src-1',
    sourceShortLabel: '测试表',
    sourceKind: 'excel',
    flags: []
  };
}

function main() {
  const sandbox = createSandbox();
  const state = sandbox.__state;
  const els = sandbox.__els;
  const records = [];
  for (let i = 0; i < 250; i += 1) records.push(makeRecord(`企业${String(i).padStart(3, '0')}`, 100 + i, i + 2));

  state.records = records;
  state.groups = sandbox.buildGroups(records);
  state.stats = sandbox.computeStats(state.groups);
  check('构造 250 家企业', state.groups.length === 250, `groups=${state.groups.length}`);

  sandbox.renderTable();
  check('默认显示前 100 家', state.renderLimit === 100 && els.visibleCount.textContent === '显示 100 / 250 家企业',
    `limit=${state.renderLimit} text=${els.visibleCount.textContent}`);
  check('页面只画 100 行', (els.resultBody.innerHTML.match(/<tr /g) || []).length === 101,
    `rows=${(els.resultBody.innerHTML.match(/<tr /g) || []).length}`);
  check('提示还有 150 家', els.resultBody.innerHTML.indexOf('还有 150 家企业') >= 0);
  check('提供继续显示按钮', els.resultBody.innerHTML.indexOf('data-render-more') >= 0 &&
    els.resultBody.innerHTML.indexOf('data-render-all') >= 0);

  state.renderLimit += 100;
  sandbox.renderTable();
  check('再显示 100 家后是 200', els.visibleCount.textContent === '显示 200 / 250 家企业',
    els.visibleCount.textContent);
  check('还剩 50 家的提示', els.resultBody.innerHTML.indexOf('还有 50 家企业') >= 0);

  state.renderLimit = Number.MAX_SAFE_INTEGER;
  sandbox.renderTable();
  check('全部显示后没有更多按钮', els.resultBody.innerHTML.indexOf('data-render-more') < 0);
  check('全部显示后计数正确', els.visibleCount.textContent === '显示 250 / 250 家企业',
    els.visibleCount.textContent);

  state.renderLimit = 100;
  state.printing = true;
  sandbox.renderTable();
  check('打印时不受分页限制', (els.resultBody.innerHTML.match(/<tr /g) || []).length === 250,
    `rows=${(els.resultBody.innerHTML.match(/<tr /g) || []).length}`);
  state.printing = false;

  state.search = '企业01';
  state.renderLimit = 100;
  sandbox.renderTable();
  const searched = sandbox.getVisibleGroups().length;
  check('搜索仍能筛出 10 家', searched === 10, `n=${searched}`);
  state.search = '';

  if (failures.length) {
    console.log(`RENDER_LIMIT_CHECK FAIL failures=${failures.length} total=${pass + failures.length}`);
    failures.forEach((item) => console.log(`  - ${item}`));
    process.exit(1);
  }
  console.log(`RENDER_LIMIT_CHECK PASS failures=0 total=${pass}`);
}

main();
