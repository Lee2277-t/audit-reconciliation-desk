#!/usr/bin/env node
/**
 * 浏览器兼容自检回归：检查项是否覆盖浏览器能力、IE 是否被明确拦下。
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/browser-support-check.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'assets', 'app.js');

let pass = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    return;
  }
  failures.push(detail ? `${name}（${detail}）` : name);
}

function stub() {
  return {
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
  };
}

function createSandbox() {
  const sandbox = {
    XLSX: require(path.join(ROOT, 'vendor', 'xlsx.full.min.js')),
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
    File: function () {},
    FileReader: function () {},
    URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
    navigator: { userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36' },
    location: { protocol: 'http:', hostname: '127.0.0.1', port: '8768', href: 'http://127.0.0.1:8768/' },
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
    `['toast', 'selfCheckOut'].forEach((id) => { els[id] = __stub(); });
     globalThis.__els = els;`,
    Object.assign(sandbox, { __stub: stub })
  );
  return sandbox;
}

function main() {
  const sandbox = createSandbox();

  const items = sandbox.browserCapabilityChecks();
  check('自检返回四项浏览器能力检查', items.length === 4, `items=${items.length}`);
  check('新版 Chrome 不会被判成 IE', items[0].ok === true && items[0].text.indexOf('Chrome') !== -1,
    items[0].text);
  check('浏览器建议写全新版与 IE 不支持', items[0].text.indexOf('Edge') !== -1
    && items[0].text.indexOf('Firefox') !== -1 && items[0].text.indexOf('Safari') !== -1,
    items[0].text);
  check('核心功能齐全时通过', items[1].ok === true && items[1].text.indexOf('都在') !== -1,
    items[1].text);
  check('画不了图时指路下拉框', items[2].ok === false && items[2].text.indexOf('列下拉') !== -1,
    items[2].text);
  check('不支持拖框时仍不阻断，只指路下拉框',
    items[3].ok === true && items[3].text.indexOf('列下拉') !== -1,
    items[3].text);

  sandbox.navigator.userAgent = 'Mozilla/5.0 (Windows NT 6.1; Trident/7.0; rv:11.0) like Gecko';
  const ieItems = sandbox.browserCapabilityChecks();
  check('IE 内核被判为不可用', ieItems[0].ok === false && ieItems[0].text.indexOf('IE 内核') !== -1,
    ieItems[0].text);
  sandbox.navigator.userAgent = 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36';

  sandbox.runSelfCheck();
  const html = sandbox.__els.selfCheckOut.innerHTML;
  check('自检结果列出浏览器能力', html.indexOf('浏览器功能') !== -1 && html.indexOf('工作表图片概览') !== -1,
    html.slice(0, 300));
  check('自检结果列出拖框状态', html.indexOf('鼠标拖框') !== -1, html.slice(0, 300));
  check('自检能读出本机小服务', html.indexOf('本机小服务') !== -1, html.slice(0, 300));

  if (failures.length) {
    console.log(`BROWSER_SUPPORT_CHECK FAIL failures=${failures.length} total=${pass + failures.length}`);
    failures.forEach((item) => console.log(`  - ${item}`));
    process.exit(1);
  }
  console.log(`BROWSER_SUPPORT_CHECK PASS failures=0 total=${pass}`);
}

main();
