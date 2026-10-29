#!/usr/bin/env node
/**
 * 结果页分档筛选回归（G3）：净额大小 / 净方向 / 数据源三档，只筛显示与导出范围。
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/facet-filter-check.cjs
 *
 * 死守的口径：三档筛选**不改任何金额**、不改 state.groups 的长度与内容，
 * 只影响屏幕上渲染哪几家、以及勾了「仅导出筛选结果」时导出哪几家。
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
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {},
    addEventListener() {},
    querySelectorAll: () => [],
    scrollIntoView() {},
    focus() {},
    select() {},
    click() {}
  };
}

function createSandbox() {
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
      createElement: () => makeStubElement()
    },
    window: { addEventListener() {} }
  };

  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP, 'utf8'), sandbox);
  vm.runInContext(
    `['toast', 'runError', 'fileError', 'manualError', 'undoBtn', 'resultBody', 'visibleCount'].forEach((id) => { els[id] = __stub(); });
     els.facetBar = __stub();
     els.printStamp = __stub();
     els.exportFiltered = { checked: false };
     globalThis.__toasts = [];
     globalThis.__copied = [];
     globalThis.__stamps = [];
     window.print = function () { __stamps.push(String(els.printStamp.textContent)); };
     // 打印还原用的是 8 秒兜底定时器，无头环境里不需要真等，也不要把进程拖住。
     setTimeout = function () { return 0; };
     clearTimeout = function () {};
     showToast = function (msg, warn) { __toasts.push({ msg: String(msg), warn: Boolean(warn) }); };
     copyPlainText = async function (text) { __copied.push(text); return true; };
     renderSummary = renderTable = renderDataCheck = renderChips = renderSimilarBox = function () {};
     updateChipStates = updateResultMeta = renderFingerprint = scheduleSnapshotRefresh = function () {};
     globalThis.__state = state;
     globalThis.__els = els;`,
    Object.assign(sandbox, { __stub: makeStubElement })
  );

  return sandbox;
}

const makeRecord = (sandbox, company, cents, dir, rowNo, sourceId, sourceShortLabel) => ({
  rowNo,
  companyRaw: company,
  key: sandbox.normalizeName(company),
  dir,
  cents,
  rawCents: cents,
  cellCents: cents,
  memo: '',
  docNo: '',
  docKey: '',
  memoKeys: [],
  ageBand: -1,
  ageMonths: null,
  ageDateISO: '',
  ageRaw: '',
  hasAgeColumn: false,
  dateISO: '',
  dateSource: '',
  sourceId,
  sourceShortLabel,
  sourceKind: 'excel',
  flags: []
});

// 五家企业：净额分别是 +5万 / +0.5万 / -12万 / 0（两侧都有） / +150万
function seedGroups(sandbox) {
  const state = sandbox.__state;
  const records = [
    makeRecord(sandbox, '甲公司', 5000000, 'recv', 2, 'src-1', '应收表'),
    makeRecord(sandbox, '乙公司', 500000, 'recv', 3, 'src-1', '应收表'),
    makeRecord(sandbox, '丙公司', 12000000, 'pay', 2, 'src-2', '应付表'),
    makeRecord(sandbox, '丁公司', 1000000, 'recv', 4, 'src-1', '应收表'),
    makeRecord(sandbox, '丁公司', 1000000, 'pay', 5, 'src-2', '应付表'),
    makeRecord(sandbox, '戊公司', 200000000, 'recv', 6, 'src-1', '应收表'),
    makeRecord(sandbox, '戊公司', 50000000, 'pay', 7, 'src-2', '应付表')
  ];
  state.records = records;
  state.groups = sandbox.buildGroups(records);
  state.groups.forEach((group, index) => {
    group.idx = index;
  });
  state.stats = sandbox.computeStats(state.groups);
  return state;
}

function centsProbe(sandbox, abs, facetId) {
  return vm.runInContext(
    `groupMatchesNetFacet({ netCents: ${abs} }, '${facetId}')`,
    sandbox
  );
}

// 从一排 chip 里取第一个（「不限」）的计数
function firstCount(html) {
  const match = /<span class="count">(\d+)<\/span>/.exec(html);
  return match ? Number(match[1]) : NaN;
}

async function main() {
  const sandbox = createSandbox();
  const state = seedGroups(sandbox);
  const evaluate = (code) => vm.runInContext(code, sandbox);

  check('五家企业都建出来了', state.groups.length === 5, `${state.groups.length}`);
  const byName = new Map(state.groups.map((group) => [group.displayName, group]));
  check('戊公司净额按两侧相减', byName.get('戊公司').netCents === 150000000, `${byName.get('戊公司').netCents}`);
  check('丁公司两侧都有、净额为 0', byName.get('丁公司').netCents === 0 && byName.get('丁公司').rows.length === 2);

  // —— 分档边界：按「分」精确判定，边界归到高档 ——
  check('999,999 分算「1万以内」', centsProbe(sandbox, 999999, 'lt1w') === true && centsProbe(sandbox, 999999, 'lt10w') === false);
  check('整 1 万元算「1万～10万」', centsProbe(sandbox, 1000000, 'lt1w') === false && centsProbe(sandbox, 1000000, 'lt10w') === true);
  check('9,999,999 分仍是「1万～10万」', centsProbe(sandbox, 9999999, 'lt10w') === true && centsProbe(sandbox, 9999999, 'lt100w') === false);
  check('整 10 万元算「10万～100万」', centsProbe(sandbox, 10000000, 'lt100w') === true && centsProbe(sandbox, 10000000, 'lt10w') === false);
  check('整 100 万元算「100万以上」', centsProbe(sandbox, 100000000, 'ge100w') === true && centsProbe(sandbox, 99999999, 'ge100w') === false);
  check('净额 0 归进「1万以内」，另有一档「已平」', centsProbe(sandbox, 0, 'lt1w') === true && evaluate(`groupMatchesDirFacet({ netCents: 0 }, 'even')`) === true);
  check('负净额按绝对值分档', centsProbe(sandbox, -12000000, 'lt100w') === true);
  check('净额档「不限」永远通过', centsProbe(sandbox, 123456789, 'all') === true);

  check('方向档只认符号', evaluate(`groupMatchesDirFacet({ netCents: 5 }, 'recv') && groupMatchesDirFacet({ netCents: -5 }, 'pay') && !groupMatchesDirFacet({ netCents: 0 }, 'recv')`));

  const netIds = vm.runInContext('NET_FACETS.map((item) => item.id).join(",")', sandbox);
  const dirIds = vm.runInContext('DIR_FACETS.map((item) => item.id).join(",")', sandbox);
  check('档位表都以「不限」开头且不重复', netIds.startsWith('all,') && dirIds.startsWith('all,')
    && new Set(netIds.split(',')).size === netIds.split(',').length
    && new Set(dirIds.split(',')).size === dirIds.split(',').length, `${netIds} / ${dirIds}`);
  check('每档都有中文短标签（不给非技术用户看术语）', evaluate(`NET_FACETS.concat(DIR_FACETS).every((item) => /^[\\u4e00-\\u9fa50-9～万以内以上]+$/.test(item.label))`));

  // —— 默认态：三档都不限，可见 = 全部 ——
  check('默认三档都是不限', state.facetNet === 'all' && state.facetDir === 'all' && state.facetSource === 'all');
  check('默认态不算「有筛选」', evaluate('facetsActive()') === false);
  const defaultVisible = sandbox.getVisibleGroups();
  check('默认看到全部 5 家', defaultVisible.length === 5, `${defaultVisible.length}`);
  check('默认按净额影响大→小排序（净额 0 的丁公司排最后）',
    defaultVisible.map((g) => g.displayName).join(',') === '戊公司,丙公司,甲公司,乙公司,丁公司',
    defaultVisible.map((g) => g.displayName).join(','));

  // —— 单档筛选 ——
  evaluate(`state.facetDir = 'pay'`);
  check('只看净应付只剩丙公司', sandbox.getVisibleGroups().map((g) => g.displayName).join(',') === '丙公司');
  check('筛出来的企业金额本身没变', sandbox.getVisibleGroups()[0].netCents === -12000000);
  evaluate(`state.facetDir = 'even'`);
  check('只看已平只剩丁公司', sandbox.getVisibleGroups().map((g) => g.displayName).join(',') === '丁公司');
  evaluate(`state.facetDir = 'all'; state.facetNet = 'lt1w'`);
  check('只看净额 1 万以内是乙和丁（净额 0 也落在这一档）',
    sandbox.getVisibleGroups().map((g) => g.displayName).join(',') === '乙公司,丁公司',
    sandbox.getVisibleGroups().map((g) => g.displayName).join(','));
  evaluate(`state.facetNet = 'ge100w'`);
  check('只看 100 万以上只剩戊公司（150 万）', sandbox.getVisibleGroups().map((g) => g.displayName).join(',') === '戊公司');
  evaluate(`state.facetNet = 'all'; state.facetSource = '应付表'`);
  check('按数据源筛出丙/丁/戊（应付表里有记录的）',
    sandbox.getVisibleGroups().map((g) => g.displayName).sort().join(',') === '丙公司,丁公司,戊公司'.split(',').sort().join(','),
    sandbox.getVisibleGroups().map((g) => g.displayName).join(','));

  // —— 与 chips / 搜索叠加 ——
  evaluate(`state.facetSource = 'all'`);
  evaluate(`state.facetDir = 'recv'; state.filter = 'dup'`);
  check('「重复企业」chip 叠加净应收只剩戊公司', sandbox.getVisibleGroups().map((g) => g.displayName).join(',') === '戊公司',
    sandbox.getVisibleGroups().map((g) => g.displayName).join(','));
  evaluate(`state.filter = 'all'; state.search = '甲'`);
  check('搜索叠加净应收筛出甲公司', sandbox.getVisibleGroups().map((g) => g.displayName).join(',') === '甲公司');
  evaluate(`state.search = '不存在的名字'`);
  check('搜索叠到空集就是空集', sandbox.getVisibleGroups().length === 0);
  evaluate(`state.search = ''; resetFacets()`);
  check('清空三档后回到 5 家', sandbox.getVisibleGroups().length === 5 && evaluate('facetsActive()') === false);

  // —— 金额不变式：整个筛选过程只读 ——
  const amountSnapshot = evaluate(`JSON.stringify(state.groups.map((g) => [g.displayName, g.recvCents, g.payCents, g.netCents, g.rows.length]))`);
  evaluate(`state.facetNet = 'lt10w'; state.facetDir = 'recv'; state.facetSource = '应收表'`);
  const visibleNow = sandbox.getVisibleGroups().length;
  check('三档同时开着只剩甲公司（丁净额 0 不在 1 万～10 万这一档）', visibleNow === 1, `${visibleNow}`);
  check('筛选不改 state.groups 长度', state.groups.length === 5);
  check('筛选不改任何金额', evaluate(`JSON.stringify(state.groups.map((g) => [g.displayName, g.recvCents, g.payCents, g.netCents, g.rows.length]))`) === amountSnapshot);
  evaluate('resetFacets()');

  // —— 数据源档的条数：一家企业出现在两张表里时两张都算一次 ——
  const optionsJson = evaluate('JSON.stringify(sourceFacetOptions(state.groups))');
  const options = JSON.parse(optionsJson);
  check('数据源选项两张表都在', options.length === 2 && options.every((item) => item.count > 0), optionsJson);
  check('一张表里出现的每家企业算一次：应收表 4 家、应付表 3 家', options.find((item) => item.label === '应收表').count === 4
    && options.find((item) => item.label === '应付表').count === 3, optionsJson);

  // —— 分档计数（chip 上的数字）：按「其他档已经筛过」的那批来数 ——
  evaluate(`renderFacets()`);
  const barHtml = String(sandbox.__els.facetBar.innerHTML);
  check('筛选条画出三档', /按净额大小/.test(barHtml) && /按净方向/.test(barHtml) && /按数据源/.test(barHtml));
  check('筛选条用真实数字而不是占位', /<span class="count">5<\/span>/.test(barHtml), barHtml.slice(0, 400));
  check('数据源下拉带每张表的条数', /应收表（4 家）/.test(barHtml) && /应付表（3 家）/.test(barHtml), barHtml.slice(-700));
  check('说明写清「不改变任何金额」', /不改变任何金额/.test(barHtml));
  check('没有结果时筛选条整块收起', (() => {
    const keep = state.groups;
    state.groups = [];
    evaluate('renderFacets()');
    const hidden = sandbox.__els.facetBar.innerHTML === '';
    state.groups = keep;
    evaluate('renderFacets()');
    return hidden;
  })());

  evaluate(`state.facetNet = 'ge100w'; renderFacets()`);
  const staleHtml = String(sandbox.__els.facetBar.innerHTML);
  const netRow = staleHtml.split('<span class="facet-name">按净方向</span>')[0];
  const dirRow = staleHtml.split('<span class="facet-name">按净方向</span>')[1]
    .split('<span class="facet-name">按数据源</span>')[0];
  check('「不限」那一档数的是别的档筛过之后的那批（净额档自己不算进来）', firstCount(netRow) === 5, netRow);
  check('100 万以上开着时，「按净方向」整排只数这一档里的 1 家', firstCount(dirRow) === 1, dirRow);
  evaluate(`state.facetNet = 'lt10w'; state.facetSource = '应付表'; renderFacets()`);
  const keptHtml = String(sandbox.__els.facetBar.innerHTML);
  check('选中的数据源在别的档下没有企业时仍留在下拉里并写 0 家',
    /应付表（0 家）/.test(keptHtml) && /应付表" selected/.test(keptHtml), keptHtml.slice(-700));
  check('这种情况不偷偷改用户的选项', state.facetSource === '应付表' && state.facetNet === 'lt10w');
  check('这一档筛出来确实是空，工具不硬撑', sandbox.getVisibleGroups().length === 0);
  evaluate('resetFacets(); renderFacets()');

  check('缺少 facetBar 控件时不报错（无头环境）', (() => {
    const keep = sandbox.__els.facetBar;
    sandbox.__els.facetBar = null;
    try {
      evaluate('renderFacets()');
      sandbox.__els.facetBar = keep;
      return true;
    } catch (error) {
      sandbox.__els.facetBar = keep;
      return false;
    }
  })());

  // —— 导出范围 ——
  check('没勾「仅导出筛选结果」时导出全部 5 家', (() => {
    sandbox.__els.exportFiltered.checked = false;
    const scope = evaluate('resolveExportScope()');
    return scope.groups.length === 5 && /^全部结果（5 家）$/.test(scope.scopeLabel) && scope.onlyFiltered === false;
  })(), evaluate('resolveExportScope().scopeLabel'));

  const scopeLabel = (() => {
    sandbox.__els.exportFiltered.checked = true;
    evaluate(`state.facetNet = 'lt10w'; state.facetDir = 'recv'; state.search = '公司'`);
    const scope = evaluate('resolveExportScope()');
    return { count: scope.groups.length, label: scope.scopeLabel };
  })();
  check('勾上后导出的是筛出来的那 1 家', scopeLabel.count === 1, `${scopeLabel.count}`);
  check('导出范围写明是哪几档筛的', /净额1万～10万/.test(scopeLabel.label) && /净应收/.test(scopeLabel.label) && /搜索“公司”/.test(scopeLabel.label),
    scopeLabel.label);
  check('三档都不限时导出范围不多写字样', (() => {
    evaluate('resetFacets(); state.search = ""');
    sandbox.__els.exportFiltered.checked = true;
    const label = evaluate('resolveExportScope().scopeLabel');
    return !/净额|只看/.test(label) && /全部企业，5 家/.test(label);
  })(), evaluate('resolveExportScope().scopeLabel'));
  evaluate('state.facetDir = "pay"');
  check('只看来源时导出范围带表名', (() => {
    evaluate('state.facetSource = "应付表"');
    const label = evaluate('resolveExportScope().scopeLabel');
    return /只看「应付表」这张表/.test(label) && /净应付/.test(label);
  })(), evaluate('resolveExportScope().scopeLabel'));
  evaluate('resetFacets(); state.search = ""; els.exportFiltered.checked = false');

  // —— 复制当前筛选结果 ——
  evaluate(`state.facetNet = 'ge100w'`);
  const tsv = evaluate('filteredSummaryTsv(getVisibleGroups())').split('\n');
  const header = tsv[0].split('\t');
  check('复制的表头是 10 列', header.length === 10 && header[0] === '企业名称' && header[8] === '净方向', tsv[0]);
  check('只复制筛出来的那一家', tsv.length === 2 && tsv[1].startsWith('戊公司'), tsv.join('|'));
  check('金额是纯数字（两位小数），粘进 Excel 能算', /\t2000000\.00\t500000\.00\t1500000\.00\t净应收/.test(tsv[1]), tsv[1]);
  check('数据源列把两张表都写上', /应收表、应付表/.test(tsv[1]), tsv[1]);

  state.groupNotes.set(byName.get('甲公司').key, '已函证\n二次确认');
  evaluate('state.facetNet = "all"');
  const noted = evaluate('filteredSummaryTsv(state.groups)').split('\n').find((line) => line.startsWith('甲公司'));
  check('差异说明带上且换行压成空格', /已函证 二次确认$/.test(noted), noted);
  check('没写说明的企业该列留空而不是「undefined」', /undefined|NaN/.test(evaluate('filteredSummaryTsv(state.groups)')) === false);

  sandbox.__copied.length = 0;
  sandbox.__toasts.length = 0;
  await evaluate('copyFilteredSummary()');
  check('复制走的是一条剪贴板调用并提示家数', sandbox.__copied.length === 1 && /已复制 5 家企业/.test(sandbox.__toasts[0].msg),
    JSON.stringify(sandbox.__toasts));

  evaluate(`state.facetNet = 'ge100w'; state.search = '查不到'`);
  sandbox.__copied.length = 0;
  sandbox.__toasts.length = 0;
  await evaluate('copyFilteredSummary()');
  check('筛空了不复制，只说「先把上面那档改成不限」', sandbox.__copied.length === 0
    && sandbox.__toasts.length === 1 && /先放宽|改成不限/.test(sandbox.__toasts[0].msg) && sandbox.__toasts[0].warn === true,
    JSON.stringify(sandbox.__toasts));
  evaluate('resetFacets(); state.search = ""');

  // —— 结果指纹不受筛选影响（筛选不参与计算） ——
  const fpBefore = evaluate('buildResultFingerprint(state.groups)');
  evaluate(`state.facetNet = 'lt1w'; state.facetDir = 'recv'; state.facetSource = '应收表'`);
  const fpAfter = evaluate('buildResultFingerprint(state.groups)');
  check('开三档不改变结果指纹', fpBefore === fpAfter && /^[0-9a-f]{64}$/.test(fpAfter));
  evaluate('resetFacets()');

  // —— 打印件自己要说清「这次只打了筛出来的那几家」（纸上筛选条是藏起来的） ——
  function printStampWith(setup) {
    evaluate('state.printing = false; resetFacets(); state.filter = "all"; state.search = ""');
    if (setup) evaluate(setup);
    sandbox.__stamps.length = 0;
    evaluate('printReport()');
    return String(sandbox.__stamps[0] || '');
  }

  const plainStamp = printStampWith(null);
  check('没筛选时打印戳不多写「只列筛出来的」', /结果指纹 [0-9a-f]{16}$/.test(plainStamp) && !/只列筛出来的/.test(plainStamp), plainStamp);
  check('没筛选时 printScopeNote() 返回空串', evaluate('printScopeNote()') === '');

  const dirStamp = printStampWith(`state.facetDir = 'pay'`);
  check('只看净应付时打印戳写明 1 家 / 一共 5 家',
    /本页只列筛出来的 1 家（这台电脑上一共 5 家，净应付）/.test(dirStamp), dirStamp);

  const mixedStamp = printStampWith(`state.filter = 'dup'; state.search = '公司'; state.facetNet = 'ge100w'`);
  check('chip、搜索、净额档同时开着都在打印戳里点名',
    /标记筛选「重复企业」/.test(mixedStamp) && /搜索「公司」/.test(mixedStamp) && /净额100万以上/.test(mixedStamp), mixedStamp);
  check('打印戳给的是「怎么办」而不只是「少了」', /清掉搜索框/.test(mixedStamp) && /清空这三档/.test(mixedStamp), mixedStamp);
  check('打印戳里结果指纹仍然完整可抄', /结果指纹 [0-9a-f]{16}/.test(mixedStamp), mixedStamp);

  const emptyStamp = printStampWith(`state.search = '查不到的名字'`);
  check('筛到一家不剩时打印戳照样写明 0 家', /本页只列筛出来的 0 家/.test(emptyStamp), emptyStamp);
  check('打印只是加一句说明，不改任何金额', state.groups.length === 5
    && evaluate(`JSON.stringify(state.groups.map((g) => [g.displayName, g.recvCents, g.payCents, g.netCents, g.rows.length]))`) === amountSnapshot);

  const tail = `failures=${failures.length} total=${pass + failures.length}`;
  if (failures.length) {
    console.log(`FACET_FILTER_CHECK FAIL ${tail}`);
    failures.forEach((f) => console.log(`- ${f}`));
    process.exitCode = 1;
    return;
  }
  console.log(`FACET_FILTER_CHECK PASS ${tail}`);
}

main().catch((error) => {
  console.log(`FACET_FILTER_CHECK FAIL error=${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});
