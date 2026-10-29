#!/usr/bin/env node
/**
 * 通用撤销回归：撤销栈、并归撤销、忽略撤销、重置与上限。
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/undo-check.cjs
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
    `['toast', 'runError', 'fileError', 'manualError', 'undoBtn', 'similarBox'].forEach((id) => { els[id] = __stub(); });
     els.exportFiltered = { checked: false };
     renderSummary = renderTable = renderDataCheck = renderChips = renderSimilarBox = function () {};
     updateChipStates = updateResultMeta = renderFingerprint = scheduleSnapshotRefresh = function () {};
     globalThis.__state = state;`,
    Object.assign(sandbox, { __stub: stub })
  );

  return sandbox;
}

const makeRecord = (sandbox, company, cents, rowNo) => ({
  rowNo,
  companyRaw: company,
  key: sandbox.normalizeName(company),
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
});

function main() {
  const sandbox = createSandbox();
  const state = sandbox.__state;
  const evaluate = (code) => vm.runInContext(code, sandbox);

  check('一开始撤销按钮不可用', evaluate('undoStack.length') === 0);

  const records = [
    makeRecord(sandbox, '华信科技', 10000, 2),
    makeRecord(sandbox, '北京华信科技有限公司', 20000, 3),
    makeRecord(sandbox, '远山贸易', 5000, 4)
  ];
  state.records = records;
  state.groups = sandbox.buildGroups(records);
  state.stats = sandbox.computeStats(state.groups);
  state.similarSuggestions = sandbox.buildSimilarSuggestions(state.groups);
  check('名称相近建议生成', state.similarSuggestions.length >= 1, `n=${state.similarSuggestions.length}`);

  const beforeGroups = state.groups.length;
  const pair = state.similarSuggestions[0];
  sandbox.mergeSimilarPair(pair.id, 'a');
  check('并归后企业数减 1', state.groups.length === beforeGroups - 1, `${beforeGroups}→${state.groups.length}`);
  check('并归后按钮文字带标签', evaluate('els.undoBtn.textContent').indexOf('并归企业') >= 0,
    evaluate('els.undoBtn.textContent'));
  check('并归后栈里有 1 条', evaluate('undoStack.length') === 1);

  state.groupNotes.set('华信科技', '原备注');
  sandbox.undoLastAction();
  check('撤销后企业数恢复', state.groups.length === beforeGroups, `groups=${state.groups.length}`);
  check('撤销后栈清空', evaluate('undoStack.length') === 0);
  check('撤销后按钮回到不可用', evaluate('els.undoBtn.disabled') === true);

  // 忽略 / 恢复的撤销
  state.dismissedPairs = new Set();
  state.similarSuggestions = [
    { id: 'a|b' }, { id: 'a|c' }
  ];
  sandbox.dismissAllSimilar();
  check('全部忽略写入两对', state.dismissedPairs.size === 2, `size=${state.dismissedPairs.size}`);
  sandbox.undoLastAction();
  check('撤销全部忽略后清空', state.dismissedPairs.size === 0, `size=${state.dismissedPairs.size}`);

  state.dismissedPairs = new Set(['a|b', 'a|c']);
  sandbox.restoreDismissedPairs();
  check('恢复后忽略集合清空', state.dismissedPairs.size === 0);
  sandbox.undoLastAction();
  check('撤销恢复后忽略集合回来', state.dismissedPairs.size === 2, `size=${state.dismissedPairs.size}`);

  // 撤销栈上限与重置
  sandbox.resetUndoHistory();
  const hits = [];
  for (let i = 0; i < 60; i += 1) {
    sandbox.pushUndo(`第${i}步`, () => hits.push(i));
  }
  check('撤销栈最多保留 50 条', evaluate('undoStack.length') === 50, `len=${evaluate('undoStack.length')}`);
  sandbox.undoLastAction();
  check('撤销执行的是最后一条', hits.length === 1 && hits[0] === 59, JSON.stringify(hits));

  // 撤销过程中再次 push 应被忽略
  sandbox.resetUndoHistory();
  sandbox.pushUndo('外层', () => {
    sandbox.pushUndo('内层', () => {});
  });
  sandbox.undoLastAction();
  check('撤销过程中不写入新记录', evaluate('undoStack.length') === 0, `len=${evaluate('undoStack.length')}`);

  sandbox.resetUndoHistory();
  check('重置撤销历史后按钮不可用', evaluate('els.undoBtn.disabled') === true);

  const keys = evaluate('Object.keys(state).length');
  check('state 结构仍在', keys > 20, `keys=${keys}`);

  if (failures.length) {
    console.log(`UNDO_CHECK FAIL failures=${failures.length} total=${pass + failures.length}`);
    failures.forEach((item) => console.log(`  - ${item}`));
    process.exit(1);
  }
  console.log(`UNDO_CHECK PASS failures=0 total=${pass}`);
}

main();
