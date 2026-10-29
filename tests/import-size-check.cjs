#!/usr/bin/env node
/**
 * 导入体积判定回归（G5）：大文件不再让页面「看起来像坏了」。
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/import-size-check.cjs
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

const MB = 1024 * 1024;

function createSandbox() {
  const stub = () => ({
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
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
    Promise,
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
    window: { addEventListener() {} }
  };

  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP, 'utf8'), sandbox);
  vm.runInContext(
    `['toast', 'runError', 'fileError', 'manualError', 'undoBtn', 'runBtn', 'dropzone',
       'landingSection', 'configSection', 'resultSection', 'sourceSearch', 'sourceList',
       'sheetMap', 'previewTable', 'columnStatus', 'headerRowSelect'].forEach((id) => { els[id] = __stub(); });
     globalThis.__fileErrors = [];
     globalThis.__toasts = [];
     showFileError = function (msg) { __fileErrors.push(msg); };
     hideFileError = function () {};
     setDropzoneBusy = function () {};
     showToast = function (msg) { __toasts.push(msg); };
     activateSource = function () {};
     renderSourceList = function () {};
     renderColumnStatus = function () {};
     renderPreview = function () {};
     renderSheetMap = function () {};
     updateFileMeta = function () {};
     globalThis.__state = state;`,
    Object.assign(sandbox, { __stub: stub })
  );

  return sandbox;
}

const fake = (name, size) => ({ name, size, lastModified: 1, arrayBuffer: async () => new ArrayBuffer(0) });

async function main() {
  const sandbox = createSandbox();
  const classify = sandbox.classifyImportFiles;
  // 顶层 const 不挂在 globalThis 上（AGENTS.md §9），只能按名在上下文里读。
  const warnBytes = vm.runInContext('IMPORT_WARN_BYTES', sandbox);
  const maxBytes = vm.runInContext('IMPORT_MAX_BYTES', sandbox);

  check('常量就位', warnBytes === 20 * MB && maxBytes === 60 * MB, `warn=${warnBytes} max=${maxBytes}`);

  const normal = classify([fake('应收.xlsx', 2 * MB), fake('应付.csv', 30 * 1024)]);
  check('正常体积全部进 supported', normal.supported.length === 2 && !normal.oversize.length && !normal.rejected.length,
    JSON.stringify(normal));
  check('最大体积取受支持文件里的最大值', normal.largestBytes === 2 * MB, `${normal.largestBytes}`);

  const atLimit = classify([fake('整六十.xlsx', 60 * MB)]);
  check('正好 60 MB 仍然导入', atLimit.supported.length === 1 && !atLimit.oversize.length);

  const over = classify([fake('客户往来余额.xlsx', 60 * MB + 1)]);
  check('超过 60 MB 判为过大', over.supported.length === 0 && over.oversize.length === 1);
  check('过大名单带文件名与体积', /客户往来余额\.xlsx/.test(over.oversize[0]) && /60\.0 MB/.test(over.oversize[0]),
    over.oversize[0]);
  check('过大文件不计入最大体积（不给它弹「再等一会儿」）', over.largestBytes === 0, `${over.largestBytes}`);

  const wrongType = classify([fake('底稿.pdf', 5 * MB), fake('报告.docx', 5 * MB)]);
  check('不支持的类型进 rejected', wrongType.rejected.length === 2 && !wrongType.supported.length);

  const mixed = classify([fake('大.xlsx', 80 * MB), fake('坏.pdf', 1 * MB), fake('好.xlsx', 5 * MB)]);
  check('混合批次只拦该拦的', mixed.supported.length === 1 && mixed.supported[0].name === '好.xlsx'
    && mixed.oversize.length === 1 && mixed.rejected.length === 1);

  const empty = classify([]);
  check('空批次不报错', empty.supported.length === 0 && empty.oversize.length === 0 && empty.rejected.length === 0);

  // 文案必须说清「怎么办」，不能只报「文件太大」
  await sandbox.handleFiles([fake('客户往来余额.xlsx', 80 * MB)]);
  const message = (sandbox.__fileErrors || []).join(' ');
  check('全是过大文件时报错并给办法', /太大/.test(message) && /只留下要核对的那几张表/.test(message) && /另存成一个新文件/.test(message),
    message);
  check('报错文案里带具体体积', /80\.0 MB/.test(message), message);

  // 只有不支持的类型时，保持原来的提示
  sandbox.__fileErrors.length = 0;
  await sandbox.handleFiles([fake('照片.png', 3 * MB)]);
  check('类型不支持时仍是原文案', /这些文件类型暂时不支持/.test(sandbox.__fileErrors.join(' ')), sandbox.__fileErrors.join(' '));

  // 大但可接受的文件：读表前先给一句「没卡住」
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['企业名称', '金额'], ['甲公司', 100]]);
  XLSX.utils.book_append_sheet(wb, sheet, '应收账款底稿');
  const bytes = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const bigish = { name: '很大的底稿.xlsx', size: 25 * MB, lastModified: 1, arrayBuffer: async () => bytes.slice(0) };
  sandbox.__toasts.length = 0;
  sandbox.__fileErrors.length = 0;
  await sandbox.handleFiles([bigish]);
  check('过提醒线的文件先打「要等一会儿」', sandbox.__toasts.some((t) => /25\.0 MB/.test(t) && /没卡住/.test(t)),
    JSON.stringify(sandbox.__toasts));
  check('过提醒线仍然真的导入', sandbox.__state.sources.length === 1, `${sandbox.__state.sources.length}`);
  check('导入后的汇总仍会提示体积', sandbox.__toasts.some((t) => /读表要等一会儿/.test(t)));

  const small = { name: '小表.xlsx', size: bytes.byteLength, lastModified: 1, arrayBuffer: async () => bytes.slice(0) };
  sandbox.__state.sources.length = 0;
  sandbox.__toasts.length = 0;
  await sandbox.handleFiles([small]);
  check('小文件不打扰', sandbox.__state.sources.length === 1 && !sandbox.__toasts.some((t) => /没卡住/.test(t)),
    JSON.stringify(sandbox.__toasts));

  const tail = `failures=${failures.length} total=${pass + failures.length}`;
  if (failures.length) {
    console.log(`IMPORT_SIZE_CHECK FAIL ${tail}`);
    failures.forEach((f) => console.log(`- ${f}`));
    process.exitCode = 1;
    return;
  }
  console.log(`IMPORT_SIZE_CHECK PASS ${tail}`);
}

main();
