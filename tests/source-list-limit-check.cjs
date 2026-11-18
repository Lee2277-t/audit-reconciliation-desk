#!/usr/bin/env node
/**
 * 配置页数据源列表分批渲染回归（G4）。
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/source-list-limit-check.cjs
 *
 * 死守的口径：分批**只决定「这里画几行」**。
 * 「全选/全不选」、「已选 N / M 张」、哪些表参与对账、筛选后只作用在筛出来的表上 ——
 * 这些看的一直是完整列表，一个字节都不受 state.sourceLimit 影响。
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

function makeStubElement() {
  return {
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    style: {},
    disabled: false,
    title: '',
    dataset: {},
    listeners: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {},
    hasAttribute() { return false; },
    addEventListener(type, handler) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(handler);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    scrollIntoView() {},
    focus() {},
    select() {},
    click() {},
    __fire(type, event) {
      (this.listeners[type] || []).forEach((handler) => handler(event));
    }
  };
}

function createSandbox() {
  const byId = new Map();
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
      getElementById: (id) => {
        if (!byId.has(id)) byId.set(id, makeStubElement());
        return byId.get(id);
      },
      createElement: () => makeStubElement()
    },
    window: { addEventListener() {} }
  };

  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP, 'utf8'), sandbox);
  // 控件全部用 stub，然后真跑一遍 cacheElements + bindEvents：
  // 「再显示 / 显示全部」走的是 #sourceList 上的点击委托，不绑就测不到。
  vm.runInContext(
    `globalThis.__toasts = [];
     globalThis.__activated = [];
     globalThis.__invalidated = 0;
     showToast = function (msg, warn) { __toasts.push({ msg: String(msg), warn: Boolean(warn) }); };
     activateSource = function (id) { __activated.push(id); };
     populateSheetSelect = function () {};
     renderColumnStatus = function () {};
     invalidateResults = function () { __invalidated += 1; };
     renderSummary = renderTable = renderDataCheck = renderChips = renderSimilarBox = function () {};
     renderFingerprint = renderSnapshotComparison = renderExportReceipt = scheduleSnapshotRefresh = function () {};
     renderSheetMap = paintSheetMap = renderPreview = updateFileMeta = updateManualCounts = function () {};
     updateChipStates = updateResultMeta = updateAgeBaseField = function () {};
     cacheElements();
     bindEvents();
     globalThis.__state = state;
     globalThis.__els = els;
     globalThis.__SOURCE_PAGE_SIZE = SOURCE_PAGE_SIZE;`,
    Object.assign(sandbox, { __stub: makeStubElement })
  );

  return sandbox;
}

function makeSource(index, total) {
  const isTarget = index % 7 === 0;
  return {
    id: `src-${index}`,
    fileName: index % 3 === 0 ? '应收底稿.xlsx' : '应付底稿.xlsx',
    sheetName: `表${index + 1}${isTarget ? '（客户往来余额）' : ''}`,
    label: `表${index + 1}`,
    shortLabel: `表${index + 1}`,
    rows: [],
    sheet: null,
    rowOffset: 0,
    headerRow: 0,
    groupHeaderRow: -1,
    headerLabels: ['企业名称', '金额', '摘要', '备注'],
    mapping: { company: 0, amount: 1, direction: -1, memo: 2 },
    guessedFields: [],
    unit: 1,
    hiddenRows: new Set(),
    dataRange: { fromRow: 1, toRow: 4, manual: false, note: '', outside: 0 },
    columnWindow: null,
    mapBox: null,
    directionOverride: 'auto',
    directionColumnManual: false,
    inferredDirection: 'recv',
    inferenceSource: '工作表名',
    ageColumn: null,
    entityColumn: null,
    currencyColumn: null,
    usable: true,
    included: index < 3,
    noAmount: false,
    amountDoubt: false,
    companyDoubt: false,
    profileUsed: '',
    sourceKind: 'excel',
    fileSize: 0
  };
}

function seedSources(sandbox, count) {
  const state = sandbox.__state;
  state.sources = Array.from({ length: count }, (unused, index) => makeSource(index, count));
  state.activeSourceId = 'src-0';
  state.sourceFilter = '';
  state.sourceLimit = sandbox.__SOURCE_PAGE_SIZE;
  state.runInfo = { mode: 'excel', sources: [] };
  sandbox.__els.sourceSearch.value = '';
  state.groups = [];
  return state;
}

function rowCount(html) {
  return (html.match(/class="source-row /g) || []).length;
}

function includedFlags(state) {
  return state.sources.map((source) => source.included).join(',');
}

function clickTarget(action, id) {
  return {
    closest(selector) {
      if (action === 'more' && selector.includes('data-src-more')) {
        return { hasAttribute: (name) => name === 'data-src-more', dataset: {} };
      }
      if (action === 'all' && selector.includes('data-src-all')) {
        return { hasAttribute: (name) => name === 'data-src-all', dataset: {} };
      }
      if (action === 'activate' && selector.includes('activate')) {
        return { hasAttribute: () => false, dataset: { id } };
      }
      return null;
    }
  };
}

function measure(sandbox, code) {
  const start = process.hrtime.bigint();
  vm.runInContext(code, sandbox);
  return Number(process.hrtime.bigint() - start) / 1e6;
}

async function main() {
  const sandbox = createSandbox();
  check('state 一建出来列表上限就是一批', sandbox.__state.sourceLimit === sandbox.__SOURCE_PAGE_SIZE,
    `${sandbox.__state.sourceLimit}`);
  const state = seedSources(sandbox, 200);
  const els = sandbox.__els;
  const evaluate = (code) => vm.runInContext(code, sandbox);

  check('列表每批画 60 张（和结果页的 100 家各管一处）',
    evaluate('SOURCE_PAGE_SIZE') === 60, `${evaluate('SOURCE_PAGE_SIZE')}`);

  evaluate('renderSourceList()');
  let html = String(els.sourceList.innerHTML);
  check('200 张表默认只画前 60 行', rowCount(html) === 60, `${rowCount(html)}`);
  check('没画出来的表不在 DOM 里', html.includes('data-id="src-59"') && !html.includes('data-id="src-60"'));
  check('底部写「还有 140 张表没列出来」', /还有 140 张表没列出来/.test(html), html.slice(-600));
  check('翻页行带「再显示 60 张」和「显示全部」两个按钮',
    /data-src-more/.test(html) && /显示全部/.test(html) && /再显示 60 张/.test(html));
  check('明说分批不影响全选、也不影响哪些表参与对账',
    /不影响「全选\/全不选」/.test(html) && /不影响哪些表参与对账/.test(html));
  check('「已选 N / M 张」数的还是全部 200 张', els.sourceCount.textContent === '已选 3 / 200 张工作表', els.sourceCount.textContent);
  check('每一行照样写出「企业名和金额看哪一列」',
    /企业名称看 A 列「企业名称」，金额看 B 列「金额」/.test(html), html.slice(0, 900));
  check('没到分批线时不出现翻页行', (() => {
    const keep = state.sources;
    state.sources = keep.slice(0, 40);
    evaluate('renderSourceList()');
    const ok = !String(els.sourceList.innerHTML).includes('data-src-more');
    state.sources = keep;
    evaluate('renderSourceList()');
    return ok;
  })());

  // —— 点「再显示」：只长列表，不碰任何 included ——
  const includedBefore = includedFlags(state);
  els.sourceList.__fire('click', { target: clickTarget('more') });
  check('点「再显示 60 张」画到 120 行', state.sourceLimit === 120 && rowCount(String(els.sourceList.innerHTML)) === 120,
    `${state.sourceLimit}`);
  els.sourceList.__fire('click', { target: clickTarget('more') });
  check('再点一次到 180 行', state.sourceLimit === 180 && rowCount(String(els.sourceList.innerHTML)) === 180);
  check('只剩 20 张时按钮写「再显示 20 张」而不是 60',
    /再显示 20 张/.test(String(els.sourceList.innerHTML)), String(els.sourceList.innerHTML).slice(-500));
  els.sourceList.__fire('click', { target: clickTarget('more') });
  check('画满 200 行后翻页行整块消失',
    rowCount(String(els.sourceList.innerHTML)) === 200 && !String(els.sourceList.innerHTML).includes('data-src-more'),
    `${rowCount(String(els.sourceList.innerHTML))}`);

  state.sourceLimit = 60;
  evaluate('renderSourceList()');
  els.sourceList.__fire('click', { target: clickTarget('all') });
  check('点「显示全部」一次画完 200 行', rowCount(String(els.sourceList.innerHTML)) === 200 && state.sourceLimit === 200);
  check('翻页只改画几行，200 张表的勾选状态一个都没变', includedFlags(state) === includedBefore);

  // —— 全选/全不选看的是完整列表 ——
  state.sourceLimit = 60;
  evaluate('renderSourceList()');
  evaluate(`setAllSourcesIncluded(true)`);
  check('只画 60 行时「全选」仍然勾上全部 200 张', state.sources.every((source) => source.included));
  check('全选后 toast 写的是「全部 200 张」（不是只勾了画出来的 60 张）',
    /已勾选全部 200 张工作表/.test(String(sandbox.__toasts.slice(-1)[0].msg)),
    String(sandbox.__toasts.slice(-1)[0].msg));
  evaluate(`setAllSourcesIncluded(false)`);
  check('「全不选」同样一次清完 200 张', state.sources.every((source) => !source.included));

  // —— 筛选态：全选只作用在筛出来的表上（这条必须保住） ——
  evaluate(`state.sourceFilter = '客户往来'; state.sourceLimit = 60; renderSourceList()`);
  const filteredCount = evaluate('getVisibleSources().length');
  html = String(els.sourceList.innerHTML);
  check('筛选后仍按 60 张一批（筛出来的不到一批就不出翻页行）',
    rowCount(html) === Math.min(60, filteredCount) && (filteredCount > 60) === html.includes('data-src-more'),
    `${filteredCount}`);
  check('筛选头部写明「这时全选只作用在筛选出的表上」',
    /筛选出 \d+ \/ 200 张，这时「全选」只作用在筛选出的表上/.test(els.sourceFilterNote.textContent),
    els.sourceFilterNote.textContent);
  check('筛选态下「全选」按钮的悬浮说明带张数', els.sourceSelectAll.title === `全选筛选出的 ${filteredCount} 张`, els.sourceSelectAll.title);
  evaluate('setAllSourcesIncluded(true)');
  check('筛选态全选只勾筛出来的那几张', state.sources.filter((s) => s.included).length === filteredCount,
    `${state.sources.filter((s) => s.included).length}`);
  check('没被筛中的表保持原样（没被顺手勾上）',
    state.sources.filter((s) => s.included).every((s) => s.sheetName.includes('客户往来')));

  // —— 搜索框改动会回到第一批 ——
  state.sourceLimit = 200;
  els.sourceSearch.value = '应收底稿';
  els.sourceSearch.__fire('input', {});
  await new Promise((resolve) => setTimeout(resolve, 180));
  check('输入搜索词后回到 60 张一批', state.sourceLimit === 60 && state.sourceFilter === '应收底稿', `${state.sourceLimit}`);
  state.sourceLimit = 200;
  els.sourceSearch.value = 'x';
  els.sourceSearch.__fire('keydown', { key: 'Escape' });
  check('按 Esc 清空筛选并回到 60 张一批',
    state.sourceFilter === '' && state.sourceLimit === 60 && els.sourceSearch.value === '');

  // —— 点开的那张表必须看得见 ——
  evaluate(`state.sourceLimit = 60; state.activeSourceId = 'src-150'; renderSourceList()`);
  html = String(els.sourceList.innerHTML);
  check('第 151 张被点开时列表撑到那一行，不让用户找不到自己点了什么',
    html.includes('data-id="src-150"') && /class="source-row active/.test(html), `${rowCount(html)}`);
  check('撑高只到那一行，后面照样没画（第 199 张仍不在 DOM）', !html.includes('data-id="src-199"'));
  evaluate(`state.activeSourceId = 'src-2'; renderSourceList()`);
  check('点开的表在本批里时上限保持 60、不多画',
    rowCount(String(els.sourceList.innerHTML)) === 60 && state.sourceLimit === 60);

  // —— 委托没被新分支带偏 ——
  sandbox.__activated.length = 0;
  els.sourceList.__fire('click', { target: clickTarget('activate', 'src-7') });
  check('列表里点某一张表照常走「点开这张表」', sandbox.__activated.join(',') === 'src-7', sandbox.__activated.join(','));
  els.sourceList.__fire('click', { target: clickTarget(null) });
  check('点到别处（空白）不会报错也不会长列表', state.sourceLimit === 60);

  // —— 边界与退化 ——
  evaluate(`state.sourceLimit = 0; renderSourceList()`);
  check('上限被写成 0 时退回一批 60 张（不会画空列表）', rowCount(String(els.sourceList.innerHTML)) === 60);
  evaluate(`state.sourceLimit = -5; renderSourceList()`);
  check('负数同样退回 60 张', rowCount(String(els.sourceList.innerHTML)) === 60);
  check('筛选词命中 0 张时不报错且明说没找到', (() => {
    state.sourceFilter = '根本不存在的表名';
    evaluate('renderSourceList()');
    const out = String(els.sourceList.innerHTML);
    state.sourceFilter = '';
    return /没有名字里带/.test(out) && !out.includes('data-src-more');
  })());
  check('一张表都没有时只写「还没有导入工作表」', (() => {
    const keep = state.sources;
    state.sources = [];
    evaluate('renderSourceList()');
    const out = String(els.sourceList.innerHTML);
    state.sources = keep;
    evaluate('renderSourceList()');
    return out === '<div class="source-empty">还没有导入工作表。</div>';
  })());
  check('表名里的 HTML 片段不会漏成标签', (() => {
    const keep = state.sources;
    state.sources = [makeSource(0, 1)];
    state.sources[0].sheetName = '<img src=x onerror=alert(1)>';
    evaluate('renderSourceList()');
    const out = String(els.sourceList.innerHTML);
    state.sources = keep;
    evaluate('renderSourceList()');
    return !out.includes('<img src=x') && out.includes('&lt;img');
  })());

  // —— 性能：整本底稿 1098 张时一次画完 vs 分批 ——
  const big = 1098;
  seedSources(sandbox, big);
  evaluate('state.sourceLimit = 60');
  const chunkedMs = measure(sandbox, 'renderSourceList()');
  evaluate('state.sourceLimit = 1098');
  const fullMs = measure(sandbox, 'renderSourceList()');
  check('上千张表时分批确实明显快过一次画完',
    chunkedMs > 0 && fullMs > 0 && chunkedMs < fullMs * 0.6,
    `分批 ${chunkedMs.toFixed(1)}ms / 全量 ${fullMs.toFixed(1)}ms`);
  evaluate('state.sourceLimit = 60; renderSourceList()');
  check('1098 张表默认只画 60 行、底部写还有 1038 张',
    rowCount(String(els.sourceList.innerHTML)) === 60
    && /还有 1038 张表没列出来/.test(String(els.sourceList.innerHTML)));
  check('分批时「已选」仍数全部 1098 张', els.sourceCount.textContent === `已选 3 / ${big} 张工作表`, els.sourceCount.textContent);

  if (failures.length) {
    failures.forEach((line) => console.log(`FAIL ${line}`));
    console.log(`SOURCE_LIST_LIMIT_CHECK FAIL failures=${failures.length} total=${pass + failures.length}`);
    process.exitCode = 1;
    return;
  }
  console.log(`分批 ${chunkedMs.toFixed(1)}ms / 全量 ${fullMs.toFixed(1)}ms`);
  console.log(`SOURCE_LIST_LIMIT_CHECK PASS failures=0 total=${pass}`);
}

main().catch((error) => {
  console.log(`SOURCE_LIST_LIMIT_CHECK ERROR ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
