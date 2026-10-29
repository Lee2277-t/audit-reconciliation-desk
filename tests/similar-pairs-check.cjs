#!/usr/bin/env node
/**
 * 名称相近建议的「结果不变 + 变快」回归：
 * 把 §5.16 的口径按最直白的方式（每对都现算一遍）写成参照实现，与工具里的实现逐条比对，
 * 再量一次八百家的耗时。
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/similar-pairs-check.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'assets', 'app.js');
const XLSX = require(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));
// 报告写到临时目录，不留生成物在仓库里。
const REPORT_DIR = path.join(require('os').tmpdir(), 'recon-test-reports');
fs.mkdirSync(REPORT_DIR, { recursive: true });

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
    performance,
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
     renderSummary = renderTable = renderDataCheck = renderChips = renderSimilarBox = function () {};
     updateChipStates = updateResultMeta = renderFingerprint = scheduleSnapshotRefresh = function () {};`,
    Object.assign(sandbox, { __stub: stub })
  );

  return sandbox;
}

// 参照实现：逐字照 §5.16 的口径写，每次比较都从头算，不共享任何缓存。
function referenceSuggestions(sandbox, groups) {
  const normalizeName = sandbox.normalizeName;
  const nameCoreOf = sandbox.nameCoreOf;
  const leadingRegionOf = sandbox.leadingRegionOf;
  const nameSimilarity = sandbox.nameSimilarity;
  const branchRe = /分公司|分厂|办事处|支行|分行|分部|营业部|经营部|代表处|项目部/;
  const STRONG = 0.6;

  const list = (groups || []).filter((g) => g && g.key && g.displayName);
  const items = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      if ((a.entityKey || '') !== (b.entityKey || '')) continue;
      if ((a.currencyKey || '') !== (b.currencyKey || '')) continue;
      const textA = normalizeName(a.displayName);
      const textB = normalizeName(b.displayName);
      if (textA === textB) continue;
      if (branchRe.test(a.displayName) !== branchRe.test(b.displayName)) continue;
      const coreA = nameCoreOf(a.displayName);
      const coreB = nameCoreOf(b.displayName);
      const score = nameSimilarity(textA, textB);
      const sameCore = coreA.length >= 2 && coreA === coreB;
      if (!sameCore && score < STRONG) continue;
      const regionA = leadingRegionOf(a.displayName);
      const regionB = leadingRegionOf(b.displayName);
      const regionDiff = !!regionA && !!regionB && regionA !== regionB;
      let tier = 'similar';
      let reason = `名字只差几个字（${Math.round(score * 100)}% 相同）`;
      if (sameCore && regionDiff) {
        tier = 'region';
        reason = `字号都是「${coreA}」，但一个写${regionA}、一个写${regionB}，很可能是两家`;
      } else if (sameCore) {
        tier = 'core';
        reason = `字号相同（${coreA}），只是地区、行业或写法不一样`;
      }
      items.push({
        tier,
        reason,
        score,
        keyA: a.key,
        keyB: b.key,
        nameA: a.displayName,
        nameB: b.displayName,
        netA: a.netCents,
        netB: b.netCents,
        rowsA: a.rows.length,
        rowsB: b.rows.length,
        id: [String(a.key), String(b.key)].sort().join('<->')
      });
    }
  }
  const order = { core: 0, region: 1, similar: 2 };
  items.sort((x, y) =>
    (order[x.tier] - order[y.tier])
    || (Math.abs(y.netA) + Math.abs(y.netB)) - (Math.abs(x.netA) + Math.abs(x.netB))
    || y.score - x.score);
  return items.slice(0, 40);
}

function makeGroup(sandbox, displayName, cents, entityKey, currencyKey) {
  const baseKey = sandbox.normalizeName(displayName);
  return {
    key: baseKey,
    baseKey,
    displayName,
    entityKey: entityKey || '',
    currencyKey: currencyKey || '',
    netCents: cents,
    rows: [{ rowNo: 2 }, { rowNo: 3 }]
  };
}

const REGION_PREFIX = ['', '北京', '上海', '苏州', '深圳', '成都', '武汉', '杭州市', '广东省'];
const CORE_NAMES = [
  '华信', '华芯', '恒远', '远山', '蓝湖', '启明', '华强', '强华', '华', 'AB12', '星海',
  '金盛', '盛金', '东方红', '红方东', '宏大', '大王', '长信', '信长'
];
const INDUSTRY = ['', '科技', '贸易', '实业', '科技有限公司', '贸易有限公司', '有限责任公司', '集团', '有限公司', '中心', '研究所'];
const BRANCH = ['', '分公司', '营业部', '项目部'];

function curatedCases(sandbox) {
  const cases = [];
  const g = (name, cents, e, c) => makeGroup(sandbox, name, cents === undefined ? 100 : cents, e, c);

  cases.push([
    g('北京华信科技有限公司'),
    g('上海华信科技有限公司'),
    g('华信科技'),
    g('苏州华达新材料科技有限公司'),
    g('苏州华达新材料有限全司'),
    g('北京华信科技有限公司分公司'),
    g('北京华信科技有限公司'),
    g('华强贸易', 900),
    g('强华贸易', 800),
    g('恒远', 700),
    g('恒远实业', 600),
    g('蓝湖实业', 500),
    g('蓝湖实业股份有限公司', 400),
    g('东方红', 300),
    g('红方东', 200),
    g('长信', 100),
    g('信长', 50),
    g('公司', 40),
    g('有限公司', 30),
    g('星海', 20)
  ]);

  // 主体／币种分开算的企业不能互相提示并归
  cases.push([
    g('华信科技', 100, '甲主体', 'CNY'),
    g('华信科技有限公司', 200, '乙主体', 'CNY'),
    g('华信科技有限公司', 300, '甲主体', 'USD'),
    g('华信科技有限公司', 400, '甲主体', 'CNY')
  ]);

  // 长度差很大但字号相同（剪枝不能误杀 core 档）
  cases.push([
    g('华信', 100),
    g('华信科技发展国际贸易中心', 200),
    g('大王', 300),
    g('王大大王', 400)
  ]);

  // 分公司字样两边都要有（veto）
  cases.push([
    g('华信科技有限公司分公司', 100),
    g('华信科技', 200),
    g('华信科技有限公司营业部', 300)
  ]);

  return cases;
}

function randomCase(sandbox, seed) {
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s;
  };
  const pick = (arr) => arr[next() % arr.length];
  const groups = [];
  const n = 26 + (next() % 22);
  for (let i = 0; i < n; i += 1) {
    const name = `${pick(REGION_PREFIX)}${pick(CORE_NAMES)}${pick(INDUSTRY)}${pick(BRANCH)}`;
    groups.push(makeGroup(
      sandbox,
      name,
      (next() % 200000) - 100000,
      next() % 5 === 0 ? '甲主体' : '',
      next() % 4 === 0 ? 'USD' : ''
    ));
  }
  return groups;
}

function bigCase(sandbox, count) {
  const groups = [];
  for (let i = 0; i < count; i += 1) {
    const region = REGION_PREFIX[i % REGION_PREFIX.length];
    const core = CORE_NAMES[(i * 7 + 3) % CORE_NAMES.length];
    const industry = INDUSTRY[(i * 5) % INDUSTRY.length];
    groups.push(makeGroup(sandbox, `${region}${core}${core === '华' ? '' : 'X' + (i % 40)}${industry}`, (i % 9) * 100000 - 50000));
  }
  return groups;
}

function main() {
  const sandbox = createSandbox();
  const suites = curatedCases(sandbox);
  for (let seed = 1; seed <= 40; seed += 1) suites.push(randomCase(sandbox, seed));

  let comparedPairs = 0;
  let sawCore = 0;
  let sawRegion = 0;
  let sawSimilar = 0;

  suites.forEach((groups, index) => {
    const actual = sandbox.buildSimilarSuggestions(groups);
    const expected = referenceSuggestions(sandbox, groups);
    comparedPairs += groups.length * (groups.length - 1) / 2;
    actual.forEach((item) => {
      if (item.tier === 'core') sawCore += 1;
      else if (item.tier === 'region') sawRegion += 1;
      else sawSimilar += 1;
    });
    check(
      `第 ${index + 1} 组建议与参照实现逐条相同`,
      JSON.stringify(actual) === JSON.stringify(expected),
      `实际 ${actual.length} 条 / 参照 ${expected.length} 条：`
        + JSON.stringify({ actual: actual.slice(0, 3), expected: expected.slice(0, 3) })
    );
  });

  check('用例覆盖到 core 档', sawCore > 0, `core=${sawCore}`);
  check('用例覆盖到 region 档', sawRegion > 0, `region=${sawRegion}`);
  check('用例覆盖到 similar 档', sawSimilar > 0, `similar=${sawSimilar}`);
  check('参与比对的 pair 数够多', comparedPairs > 10000, `pairs=${comparedPairs}`);

  // 三家企业的真实形状：与 §5.16 文档一致的排序
  const tiny = [
    makeGroup(sandbox, '北京华信科技有限公司', 500000),
    makeGroup(sandbox, '上海华信科技有限公司', 400000),
    makeGroup(sandbox, '华信科技', 300000)
  ];
  const tinyResult = sandbox.buildSimilarSuggestions(tiny);
  check('同字号不同地区落 region 档', tinyResult.some((p) => p.tier === 'region'));
  check('region 档文案写「很可能是两家」', tinyResult.every((p) => p.tier !== 'region' || /很可能是两家/.test(p.reason)));
  check('core 档排在 region 前面', tinyResult.some((p) => p.tier === 'core')
    ? tinyResult.findIndex((p) => p.tier === 'core') < tinyResult.findIndex((p) => p.tier === 'region')
    : true);

  const big = bigCase(sandbox, 800);
  const startedAt = Date.now();
  const bigResult = sandbox.buildSimilarSuggestions(big);
  const elapsedMs = Date.now() - startedAt;
  const referenceStartedAt = Date.now();
  const referenceBig = referenceSuggestions(sandbox, big);
  const referenceMs = Date.now() - referenceStartedAt;

  check('八百家与参照实现结果相同', JSON.stringify(bigResult) === JSON.stringify(referenceBig),
    `实际 ${bigResult.length} 条 / 参照 ${referenceBig.length} 条`);
  check('建议列表确实被截到 40 条', bigResult.length === 40, `${bigResult.length} 条`);
  check('八百家耗时远低于老写法', elapsedMs < referenceMs / 2,
    `新 ${elapsedMs}ms / 参照（每对现算）${referenceMs}ms`);
  check('八百家耗时在 1.5 秒内', elapsedMs < 1500, `${elapsedMs}ms`);

  const summary = {
    suites: suites.length,
    comparedPairs,
    tiers: { core: sawCore, region: sawRegion, similar: sawSimilar },
    big800: { elapsedMs, referenceMs, suggestions: bigResult.length }
  };
  fs.writeFileSync(path.join(REPORT_DIR, 'similar-pairs-report.json'), JSON.stringify(summary, null, 2), 'utf8');

  const tail = `failures=${failures.length} total=${pass + failures.length}`;
  if (failures.length) {
    console.log(`SIMILAR_PAIRS_CHECK FAIL ${tail}`);
    failures.slice(0, 8).forEach((f) => console.log(`- ${f}`));
    process.exitCode = 1;
    return;
  }
  console.log(`SIMILAR_PAIRS_CHECK PASS ${tail}`);
  console.log(`SIMILAR_PAIRS_PERF 800家 新=${elapsedMs}ms 参照=${referenceMs}ms 建议=${bigResult.length}条`);
}

main();
