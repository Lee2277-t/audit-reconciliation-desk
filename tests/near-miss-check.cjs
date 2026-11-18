#!/usr/bin/env node
/**
 * 「差一点就能配上」回归：配对剩下的记录里列出差额最小的一对，只给参照，
 * 不进 group.pairings、不改任何金额、不进结果指纹。
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/near-miss-check.cjs
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
     globalThis.__state = state;
     globalThis.__peek = (expr) => eval(expr);`,
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
  const peek = sandbox.__peek;
  const POOL = peek('PAIR_NEAR_MISS_POOL');
  const SHOWN = peek('PAIR_NEAR_MISS_MAX');

  const makeRecord = (company, dir, cents, rowNo) => ({
    rowNo,
    companyRaw: company,
    key: company,
    dir,
    cents,
    rawCents: dir === 'recv' ? cents : -cents,
    memo: '',
    docNo: '',
    docKey: '',
    memoKeys: [],
    ageBand: -1,
    hasAgeColumn: false,
    dateISO: '',
    dateSource: '',
    sourceId: 'src-1',
    sourceLabel: '测试表',
    sourceShortLabel: '测试表',
    sourceKind: 'excel',
    flags: []
  });

  const records = [
    // 甲公司：一笔正好对上；差 6 元那对不到较大一方 5%（算差一点）；
    //        差 100 元、差 500.01 元两对都超出门槛（5% 那条分别只有 45 元、5000 元）
    makeRecord('甲公司', 'recv', 500000, 2),
    makeRecord('甲公司', 'pay', 500000, 3),
    makeRecord('甲公司', 'recv', 100000, 4),
    makeRecord('甲公司', 'pay', 99400, 5),
    makeRecord('甲公司', 'recv', 90000, 6),
    makeRecord('甲公司', 'pay', 80000, 7),
    makeRecord('甲公司', 'recv', 1000000, 8),
    makeRecord('甲公司', 'pay', 949999, 9),
    // 乙公司：差额正好是较大一方的 5%（边界上，算差一点）
    makeRecord('乙公司', 'recv', 2000000, 2),
    makeRecord('乙公司', 'pay', 1900000, 3),
    // 丙公司：只有应收，没有可对照的一侧
    makeRecord('丙公司', 'recv', 88000, 2),
    // 丁公司：差 2 分 = 容差的 2 倍，靠「容差两倍」这条门槛进来（5% 那条只有 1 分）
    makeRecord('丁公司', 'recv', 20, 2),
    makeRecord('丁公司', 'pay', 18, 3),
    // 戊公司：两笔同额应收对一笔应付，只允许认领一次
    makeRecord('戊公司', 'recv', 100000, 2),
    makeRecord('戊公司', 'recv', 100000, 3),
    makeRecord('戊公司', 'pay', 99400, 4)
  ];

  const groups = sandbox.buildGroups(records);
  state.groups = groups;
  state.records = records;
  const byName = (name) => groups.find((group) => group.displayName === name);
  check('夹具归成 5 家企业', groups.length === 5, `groups=${groups.length}`);

  const moneyBefore = groups.map((group) => `${group.displayName}:${group.recvCents}/${group.payCents}/${group.netCents}`).join('|');

  const result = sandbox.runPairing(groups, 1, 0);
  state.pairResult = result;

  const jia = byName('甲公司');
  const yi = byName('乙公司');
  const bing = byName('丙公司');
  const ding = byName('丁公司');
  const wu = byName('戊公司');

  check('默认容差下只配上一对（金额正好相等）', result.pairCount === 1, `pairCount=${result.pairCount}`);
  check('甲公司配对只有 1 组', jia.pairings.length === 1, `pairings=${jia.pairings.length}`);
  check('甲公司列出 1 对差一点', jia.nearMiss.length === 1, `nearMiss=${jia.nearMiss.length}`);
  check('差 ¥6 的那对算差一点（不到较大一方 5%，容差两倍只有 2 分）',
    jia.nearMiss[0].diffCents === 600 && jia.nearMiss[0].recvRow.rowNo === 4 && jia.nearMiss[0].payRow.rowNo === 5,
    JSON.stringify(jia.nearMiss.map((item) => [item.recvRow.rowNo, item.payRow.rowNo, item.diffCents])));
  check('差 100 元的那对不算差一点（超过容差两倍、也超过 5%）',
    !jia.nearMiss.some((item) => item.recvRow.rowNo === 6),
    JSON.stringify(jia.nearMiss.map((item) => [item.recvRow.rowNo, item.payRow.rowNo])));
  check('差 500.01 元的那对刚好超过 5%，不算差一点',
    !jia.nearMiss.some((item) => item.recvRow.rowNo === 8),
    JSON.stringify(jia.nearMiss.map((item) => [item.recvRow.rowNo, item.payRow.rowNo])));
  check('正好等于较大一方 5% 的算差一点（边界）',
    yi.nearMiss.length === 1 && yi.nearMiss[0].diffCents === 100000,
    yi.nearMiss.map((item) => item.diffCents).join(','));
  check('单边企业没有差一点', bing.nearMiss.length === 0 && bing.hasNearMiss === false);
  check('差 2 分 = 容差两倍，靠容差这条门槛算差一点（5% 只有 1 分）',
    ding.nearMiss.length === 1 && ding.nearMiss[0].diffCents === 2,
    ding.nearMiss.map((item) => item.diffCents).join(','));
  check('两笔同额只被认领一次', wu.nearMiss.length === 1, `nearMiss=${wu.nearMiss.length}`);
  check('戊公司认领的是行号小的那笔', wu.nearMiss[0].recvRow.rowNo === 2, `rowNo=${wu.nearMiss[0].recvRow.rowNo}`);

  check('差一点的记录不进 pairings', jia.pairings.every((pairing) =>
    pairing.recvRows.every((row) => !jia.nearMiss.some((item) => item.recvRow === row))));
  check('差一点不重复认领同一条记录', (() => {
    const used = [];
    groups.forEach((group) => (group.nearMiss || []).forEach((item) => {
      used.push(`r${group.displayName}#${item.recvRow.rowNo}`, `p${group.displayName}#${item.payRow.rowNo}`);
    }));
    return used.length === 8 && new Set(used).size === used.length;
  })(), '重复行号');

  const moneyAfter = groups.map((group) => `${group.displayName}:${group.recvCents}/${group.payCents}/${group.netCents}`).join('|');
  check('跑完差一点，五家合计与净额一个都没变', moneyBefore === moneyAfter, `${moneyBefore} => ${moneyAfter}`);
  check('每笔记录的 cents 没被改过', records.every((record) =>
    record.cents === Math.abs(record.rawCents)), 'cents 被动过');

  const stats = sandbox.computeStats(groups);
  state.stats = stats;
  check('统计：4 家有差一点', stats.nearMissGroups === 4, `nearMissGroups=${stats.nearMissGroups}`);
  check('统计：共 4 对', stats.nearMissCount === 4, `nearMissCount=${stats.nearMissCount}`);

  const fpWithNear = sandbox.buildResultFingerprint(groups);
  groups.forEach((group) => { group.nearMiss = []; group.hasNearMiss = false; });
  const fpWithout = sandbox.buildResultFingerprint(groups);
  check('结果指纹不受差一点影响', fpWithNear === fpWithout, `${fpWithNear.slice(0, 12)} vs ${fpWithout.slice(0, 12)}`);
  sandbox.runPairing(groups, 1, 0);

  check('筛选 chip 里有「差一点就能配上」',
    peek('CHIP_DEFS').some((item) => item.id === 'nearMiss' && item.label === '差一点就能配上' && item.match(jia)));

  const htmlFull = sandbox.pairZoneMarkup(jia);
  check('有配对的企业也显示差一点块', htmlFull.indexOf('pair-near') >= 0);
  check('差一点块写明把容差改成 6.00 元', htmlFull.indexOf('把「核销容差」改成 6.00 元就能配上') >= 0, htmlFull.slice(0, 300));
  check('差一点块写明原表行', htmlFull.indexOf('第 4 行') >= 0 && htmlFull.indexOf('第 5 行') >= 0, htmlFull.slice(0, 300));
  check('差一点块说明不改金额', htmlFull.indexOf('不改任何金额') >= 0);
  check('2 分那对写成把容差改成 0.02 元',
    sandbox.pairZoneMarkup(ding).indexOf('把「核销容差」改成 0.02 元就能配上') >= 0);
  const htmlEmpty = sandbox.pairZoneMarkup(yi);
  check('没有配对的企业照样显示差一点块', htmlEmpty.indexOf('pair-zone empty') >= 0 && htmlEmpty.indexOf('pair-near') >= 0);
  check('没配对时也不承诺「有全部」', htmlEmpty.indexOf('另有') < 0);
  check('单边企业不显示配对区', sandbox.pairZoneMarkup(bing) === '');

  sandbox.exportResults();
  const workbook = captured[captured.length - 1];
  check('导出多了「差一点」这张表', workbook.SheetNames.indexOf('差一点') >= 0, workbook.SheetNames.join(','));
  const nearRows = XLSX.utils.sheet_to_json(workbook.Sheets['差一点'], { header: 1 });
  check('差一点表头 7 列', nearRows[0].length === 7, `cols=${nearRows[0].length}`);
  check('差一点表头写法', nearRows[0].join('|') ===
    '企业名称|应收原表行号|应收金额（元）|应付原表行号|应付金额（元）|差额（元）|数据源',
    nearRows[0].join('|'));
  check('差一点表列出全部 4 对', nearRows.length === 5, `rows=${nearRows.length}`);
  const jiaRow = nearRows.slice(1).find((row) => row[0] === '甲公司');
  check('差一点表把甲公司差 6 元那对写成一行的差额',
    jiaRow && jiaRow[1] === '4' && jiaRow[3] === '5' && jiaRow[2] === 1000 && jiaRow[4] === 994 &&
    jiaRow[5] === 6 && jiaRow[6] === '测试表',
    JSON.stringify(jiaRow));
  check('差一点表把丁公司 2 分那对也列出来',
    nearRows.some((row) => row[0] === '丁公司' && row[1] === '2' && row[3] === '3' && row[5] === 0.02),
    nearRows.slice(1).map((row) => row.join(',')).join(' / '));
  const nearSheet = workbook.Sheets['差一点'];
  check('差一点表带筛选', nearSheet['!autofilter'].ref === 'A1:G5', nearSheet['!autofilter'].ref);
  check('差一点表金额列是数字格式',
    nearSheet.C2.z === '#,##0.00' && nearSheet.E2.z === '#,##0.00' && nearSheet.F2.z === '#,##0.00',
    [nearSheet.C2.z, nearSheet.E2.z, nearSheet.F2.z].join('|'));
  check('差一点表行号列不是数字格式', nearSheet.B2.z === undefined && nearSheet.G2.z === undefined,
    [nearSheet.B2.z, nearSheet.G2.z].join('|'));

  const pairRows = XLSX.utils.sheet_to_json(workbook.Sheets['核销配对'], { header: 1 });
  check('「核销配对」表仍然只有配上的那 1 组', pairRows.length === 2, `rows=${pairRows.length}`);

  const infoRows = XLSX.utils.sheet_to_json(workbook.Sheets['对账说明'], { header: 1 });
  const nearNote = infoRows.find((row) => row[0] === '差一点');
  check('对账说明里有「差一点」这一行', !!nearNote);
  check('对账说明写清口径与上限', nearNote
    && nearNote[1].indexOf('把「核销容差」改成那一行的差额就能配上') >= 0
    && nearNote[1].indexOf(`每家最多列差额最小的 ${POOL} 对`) >= 0
    && nearNote[1].indexOf('不改任何金额') >= 0,
    nearNote ? nearNote[1] : 'missing');

  // 容差放宽到 1%：甲公司 ¥6 和戊公司 ¥6 那两对都升级成正式配对，差一点里不该再有
  sandbox.runPairing(groups, 1, 1);
  state.stats = sandbox.computeStats(groups);
  check('比例放到 1% 后甲公司多配上一组', byName('甲公司').pairings.length === 2, `pairings=${byName('甲公司').pairings.length}`);
  check('配上的那对不再出现在差一点里',
    !byName('甲公司').nearMiss.some((item) => item.diffCents === 600),
    byName('甲公司').nearMiss.map((item) => item.diffCents).join(','));
  check('戊公司那对 ¥6 差额在 1% 下也配上了', byName('戊公司').pairings.length === 1,
    `pairings=${byName('戊公司').pairings.length}`);
  check('比例放到 1% 后统计变成 2 家 2 对',
    state.stats.nearMissGroups === 2 && state.stats.nearMissCount === 2,
    `${state.stats.nearMissGroups}/${state.stats.nearMissCount}`);
  sandbox.runPairing(groups, 1, 0);
  state.stats = sandbox.computeStats(groups);

  // 候选上限：两边各 25 笔只差 2 分，最多只留差额最小的 POOL 对
  const many = [];
  for (let i = 0; i < 25; i += 1) {
    many.push(makeRecord('己公司', 'recv', 100000 + i * 10, i + 2));
    many.push(makeRecord('己公司', 'pay', 100002 + i * 10, i + 30));
  }
  const manyGroups = sandbox.buildGroups(many);
  const ji = manyGroups[0];
  sandbox.runPairing(manyGroups, 1, 0);
  check('候选两侧各截 20 笔', ji.nearMiss.length === POOL, `nearMiss=${ji.nearMiss.length}`);
  check('差一点不跨企业认领', ji.nearMiss.every((item) => item.recvRow.key === '己公司' && item.payRow.key === '己公司'));
  check('超出 20 对时不做「全部都有」的口头承诺',
    ji.nearMiss.length <= POOL && sandbox.pairZoneMarkup(ji).indexOf(`另有 ${ji.nearMiss.length - SHOWN} 对只差一点`) >= 0,
    `nearMiss=${ji.nearMiss.length}`);
  check('己公司一笔都没配上（差额 2 分 > 容差 1 分）', ji.pairings.length === 0, `pairings=${ji.pairings.length}`);

  restore();
  if (failures.length) {
    console.log(`NEAR_MISS_CHECK FAIL failures=${failures.length} total=${pass + failures.length}`);
    failures.forEach((item) => console.log(`  - ${item}`));
    process.exit(1);
  }
  console.log(`NEAR_MISS_CHECK PASS failures=0 total=${pass}`);
}

main();
