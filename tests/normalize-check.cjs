#!/usr/bin/env node
/**
 * 摘要编号规范化回归：单据号/合同号带大小写、全半角、空格、连接符差异时按同一个编号对上。
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/normalize-check.cjs
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
     els.exportFiltered = { checked: false };
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

  const docA = sandbox.extractDocNo('合同 HT-2026-011 货款');
  const docB = sandbox.extractDocNo('合同 ht 2026-011 付货款');
  const docC = sandbox.extractDocNo('合同 HT2026011');
  check('带字母的合同号能认出来', docA === 'HT-2026-011', `docA=${docA}`);
  check('三种写法归一后是同一个编号',
    sandbox.docKeyOf(docA) === sandbox.docKeyOf(docB) && sandbox.docKeyOf(docB) === sandbox.docKeyOf(docC),
    [sandbox.docKeyOf(docA), sandbox.docKeyOf(docB), sandbox.docKeyOf(docC)].join('|'));
  check('太短的编号不当单据号', sandbox.docKeyOf('A1') === '');

  const keysA = sandbox.extractMemoKeys('合同 HT-2026-011 货款');
  const keysB = sandbox.extractMemoKeys('合同 ht 2026 011 付货款');
  const keysC = sandbox.extractMemoKeys('合同 HT2026011');
  check('摘要线索认出合同编号', keysA.length === 1 && keysA[0].label === '合同' && keysA[0].value === 'HT-2026-011',
    JSON.stringify(keysA));
  check('摘要线索比较时忽略大小写/空格/连接符',
    keysA[0] && keysB[0] && keysC[0] && keysA[0].norm === keysB[0].norm && keysB[0].norm === keysC[0].norm,
    [keysA[0] && keysA[0].norm, keysB[0] && keysB[0].norm, keysC[0] && keysC[0].norm].join('|'));

  const makeRecord = (dir, cents, memo, rowNo) => {
    const docNo = sandbox.extractDocNo(memo);
    return {
      rowNo,
      companyRaw: '甲公司',
      key: '甲公司',
      dir,
      cents,
      rawCents: dir === 'recv' ? cents : -cents,
      memo,
      docNo,
      docKey: sandbox.docKeyOf(docNo),
      memoKeys: sandbox.extractMemoKeys(memo),
      ageBand: -1,
      hasAgeColumn: false,
      dateISO: '',
      dateSource: '',
      sourceId: 'src-1',
      sourceLabel: '测试表',
      sourceShortLabel: '测试表',
      sourceKind: 'excel',
      flags: []
    };
  };

  const records = [
    makeRecord('recv', 10000, '合同 HT-2026-011 货款', 2),
    makeRecord('pay', 10000, '合同 ht 2026-011 付货款', 2),
    makeRecord('recv', 5000, '项目 二期扩建', 3),
    makeRecord('pay', 5000, '项目二期扩建', 3)
  ];
  const groups = sandbox.buildGroups(records);
  state.groups = groups;
  state.records = records;
  sandbox.runPairing(groups, 1);

  const group = groups[0];
  check('一个企业一组', groups.length === 1, `groups=${groups.length}`);
  check('单据号不同写法合成 1 条提示', group.docHints.length === 1, `docHints=${group.docHints.length}`);
  check('单据号提示保留两种原写法', group.docHints[0] && group.docHints[0].docVariants.length === 2,
    group.docHints[0] ? JSON.stringify(group.docHints[0].docVariants) : 'missing');
  check('摘要线索不同写法合成 2 条', group.memoKeyHints.length === 2, `memoKeyHints=${group.memoKeyHints.length}`);
  const contract = group.memoKeyHints.find((hint) => hint.label === '合同');
  check('合同线索保留两种原写法', contract && contract.variants.length === 2,
    contract ? JSON.stringify(contract.variants) : 'missing');

  const html = sandbox.pairZoneMarkup(group);
  check('页面列 1 个单据号 + 2 条摘要线索', (html.match(/class="pair-doc"/g) || []).length === 3,
    `count=${(html.match(/class="pair-doc"/g) || []).length}`);
  check('页面提示里写明原表写法', html.indexOf('原表写法') >= 0);

  state.stats = sandbox.computeStats(groups);
  sandbox.exportResults();
  const workbook = captured[captured.length - 1];
  check('导出了同单据号表', workbook.SheetNames.indexOf('同单据号') >= 0, workbook.SheetNames.join(','));
  const docRows = XLSX.utils.sheet_to_json(workbook.Sheets['同单据号'], { header: 1 });
  check('同单据号表只有 1 行数据', docRows.length === 2, `rows=${docRows.length}`);
  check('同单据号表显示原写法', docRows[1] && docRows[1][1] === 'HT-2026-011', docRows[1] ? docRows[1][1] : 'missing');
  const memoRows = XLSX.utils.sheet_to_json(workbook.Sheets['摘要线索'], { header: 1 });
  check('摘要线索表有 2 行数据', memoRows.length === 3, `rows=${memoRows.length}`);

  const fingerprint = sandbox.buildResultFingerprint(groups);
  check('结果指纹是 64 位', /^[0-9a-f]{64}$/.test(fingerprint), fingerprint);

  restore();
  if (failures.length) {
    console.log(`NORMALIZE_CHECK FAIL failures=${failures.length} total=${pass + failures.length}`);
    failures.forEach((item) => console.log(`  - ${item}`));
    process.exit(1);
  }
  console.log(`NORMALIZE_CHECK PASS failures=0 total=${pass}`);
}

main();
