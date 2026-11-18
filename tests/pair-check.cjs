#!/usr/bin/env node
/**
 * 配对引擎回归：一对一 + 多对一子集和 + 容差/比例 + 时间预算。
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/pair-check.cjs
 *
 * 死守的口径：一条记录只会被一组配对消费；配对不改任何 `cents`；
 * 超预算的企业整家清空并标 `pairLimited`，不给半吊子结果。
 */
'use strict';
// Headless checks for the pairing engine (一对一 + 多对一子集和).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const XLSX = require(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));

const APP = path.join(ROOT, 'assets', 'app.js');
const FIX = path.join(__dirname, 'fixtures');
// 详细报告写到临时目录，不留在仓库里（GBK 控制台打中文会乱码，看文件即可）。
const REPORT_DIR = path.join(require('node:os').tmpdir(), 'recon-test-reports');
fs.mkdirSync(REPORT_DIR, { recursive: true });

const sandbox = {
  XLSX,
  console,
  Intl,
  Date,
  Math,
  JSON,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: () => {},
  encodeURIComponent,
  decodeURIComponent,
  Blob: function () {},
  URL: { createObjectURL: () => '' },
  navigator: {},
  document: {
    addEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {} })
  },
  window: { addEventListener() {} }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(APP, 'utf8'), sandbox);
vm.runInContext(`
  const stub = () => ({ textContent: '', innerHTML: '', value: '', style: {}, disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, addEventListener() {}, scrollIntoView() {}, focus() {}, select() {}, click() {} });
  ['toast','runError','fileError','manualError','sourceList','sourceCount','previewTable','manualRecvCount','manualPayCount','dataCheck','totalsStrip','summaryGrid','filterChips','resultBody','pairTolerance']
    .forEach((id) => { els[id] = stub(); });
`, sandbox);

const results = [];
let failures = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  results.push({ name, ok, actual, expected });
}

function rec(dir, yuan, rowNo, key = '甲公司') {
  return {
    key: sandbox.normalizeName(key),
    company: sandbox.normalizeName(key),
    companyRaw: key,
    dir,
    cents: Math.round(yuan * 100),
    memo: '',
    rowNo,
    rawAmount: '',
    reclassified: false,
    zero: yuan === 0,
    inherited: false,
    sourceId: 's1',
    sourceShortLabel: '表A',
    sourceLabel: '表A',
    sourceKind: 'excel'
  };
}

function pairOf(records, toleranceCents, percent = 0) {
  const groups = sandbox.buildGroups(records);
  const summary = sandbox.runPairing(groups, toleranceCents, percent);
  return { group: groups[0], summary };
}

function shape(group) {
  return (group.pairings || []).map((pairing) => ({
    kind: pairing.kind,
    r: pairing.recvCents / 100,
    p: pairing.payCents / 100,
    d: pairing.diffCents / 100,
    rows: pairing.recvRows.map((row) => row.rowNo).join('+') + '|' + pairing.payRows.map((row) => row.rowNo).join('+')
  }));
}

// A. 一对一，金额完全一致
{
  const { group } = pairOf([rec('recv', 100, 3), rec('pay', 100, 8)], 1);
  check('A one-to-one exact', shape(group), [{ kind: 'one', r: 100, p: 100, d: 0, rows: '3|8' }]);
  check('A canPair', group.canPair, true);
  check('A flag', group.flags.includes('pair'), true);
}

// B. 容差边界
{
  const rows = [rec('recv', 100, 3), rec('pay', 99.95, 8)];
  check('B tol 0.01 no pair', shape(pairOf(rows, 1).group), []);
  check('B tol 0.05 pairs', shape(pairOf(rows, 5).group), [{ kind: 'one', r: 100, p: 99.95, d: 0.05, rows: '3|8' }]);
}

// C. 多对一凑数
{
  const { group } = pairOf([rec('recv', 30, 3), rec('recv', 70, 4), rec('pay', 100, 8)], 1);
  check('C 2对1', shape(group), [{ kind: 'payMany', r: 100, p: 100, d: 0, rows: '3+4|8' }]);
  check('C label 多对一', sandbox.pairKindLabel(group.pairings[0]), '2 对 1');

  const mirrored = pairOf([rec('recv', 100, 3), rec('pay', 30, 4), rec('pay', 70, 5)], 1);
  check('C label 一对多', sandbox.pairKindLabel(mirrored.group.pairings[0]), '1 对 2');
  check('C mirrored shape', shape(mirrored.group), [{ kind: 'recvMany', r: 100, p: 100, d: 0, rows: '3|4+5' }]);
}

// D. 一对一优先于凑数
{
  const { group } = pairOf([rec('recv', 100, 3), rec('recv', 60, 4), rec('recv', 40, 5), rec('pay', 100, 8)], 1);
  check('D prefers 1-1', shape(group), [{ kind: 'one', r: 100, p: 100, d: 0, rows: '3|8' }]);
}

// E. 一笔只能被用一次
{
  const { group } = pairOf([rec('recv', 100, 3), rec('pay', 100, 8), rec('pay', 100, 9)], 1);
  const s = shape(group);
  check('E one pair only', s.length, 1);
  const used = s[0].rows.split('|')[1];
  check('E pay consumed once', group.pairedPayCents / 100, 100);
  check('E recv consumed once', group.pairedRecvCents / 100, 100);
  void used;
}

// F. 单边企业不配对
{
  const { group } = pairOf([rec('recv', 100, 3), rec('recv', 50, 4)], 1);
  check('F single side', shape(group), []);
  check('F canPair false', group.canPair, false);
  check('F no pair flag', group.flags.includes('pair'), false);
}

// G. 5 笔上限
{
  const rows = [10, 20, 30, 40, 50].map((yuan, i) => rec('recv', yuan, i + 3));
  rows.push(rec('pay', 150, 9));
  const { group } = pairOf(rows, 1);
  check('G 5对1', shape(group), [{ kind: 'payMany', r: 150, p: 150, d: 0, rows: '3+4+5+6+7|9' }]);

  const rows6 = [5, 10, 20, 30, 40, 50].map((yuan, i) => rec('recv', yuan, i + 3));
  rows6.push(rec('pay', 100, 10), rec('pay', 55, 11));
  const g6 = pairOf(rows6, 1).group;
  const s6 = shape(g6);
  check('G6 two subset rounds', s6.length, 2);
  check('G6 covers both targets', s6.reduce((sum, item) => sum + item.p, 0), 155);
  check('G6 no overlap', s6.map((item) => item.rows).sort().join(' / '), '3+5+6|11 / 4+7+8|10');

  const rows12 = Array.from({ length: 12 }, (_, i) => rec('recv', 300 * (i + 1), i + 3));
  rows12.push(rec('pay', 23400, 90));
  const g12 = pairOf(rows12, 1).group;
  check('G12 12对1', shape(g12), [{
    kind: 'payMany', r: 23400, p: 23400, d: 0,
    rows: Array.from({ length: 12 }, (_, i) => i + 3).join('+') + '|90'
  }]);
}

// H. 残差恒等式（真实夹具）
{
  const files = fs.readdirSync(FIX).filter((f) => /\.xlsx$/i.test(f));
  const invariant = [];
  files.forEach((fileName) => {
    const workbook = XLSX.read(fs.readFileSync(path.join(FIX, fileName)), { type: 'buffer' });
    const file = { name: fileName, size: 1, lastModified: 1 };
    const sources = workbook.SheetNames
      .map((sheet) => sandbox.buildSource(file, workbook, sheet, `${fileName}::k`))
      .filter(Boolean);
    sources.forEach((source) => {
      source.included = source.usable && !source.amountDoubt && !source.companyDoubt;
    });
    const selected = sources.filter((source) => source.included);
    const records = [];
    selected.forEach((source) => records.push(...sandbox.parseExcelSource(source).records));
    if (!records.length) return;
    const groups = sandbox.buildGroups(records);
    const summary = sandbox.runPairing(groups, 1);
    groups.forEach((group) => {
      const unpairedRecv = group.recvCents - group.pairedRecvCents;
      const unpairedPay = group.payCents - group.pairedPayCents;
      const drift = Math.abs((unpairedRecv - unpairedPay) - group.netCents);
      if (drift > group.pairings.length * 1 + 0.0001) {
        invariant.push(`${fileName}/${group.displayName} drift ${drift}`);
      }
      if (group.pairedRecvCents > group.recvCents + 0.0001 || group.pairedPayCents > group.payCents + 0.0001) {
        invariant.push(`${fileName}/${group.displayName} over-consumed`);
      }
      const seen = new Set();
      group.pairings.forEach((pairing) => {
        pairing.recvRows.concat(pairing.payRows).forEach((row) => {
          if (seen.has(row)) invariant.push(`${fileName}/${group.displayName} reused row`);
          seen.add(row);
        });
      });
    });
    results.push({
      name: `H ${fileName}`,
      ok: true,
      actual: {
        groups: groups.length,
        pairs: summary.pairCount,
        pairedRecv: summary.pairedRecvCents / 100,
        pairedPay: summary.pairedPayCents / 100,
        ms: summary.elapsedMs
      }
    });
  });
  check('H invariants hold', invariant, []);
}

// I. 性能：两侧各 300 笔
{
  const rows = [];
  for (let i = 0; i < 300; i += 1) rows.push(rec('recv', 1000 + i * 7, i + 1, '大公司'));
  for (let i = 0; i < 300; i += 1) rows.push(rec('pay', 1000 + i * 7, i + 400, '大公司'));
  const groups = sandbox.buildGroups(rows);
  const started = Date.now();
  const summary = sandbox.runPairing(groups, 1);
  const elapsed = Date.now() - started;
  check('I 300x300 all paired', summary.pairCount, 300);
  check('I under 1200ms', elapsed < 1200, true);
  results.push({ name: 'I timing', ok: true, actual: { elapsed } });
}

// J. 大量同额（候选上限路径）
{
  const rows = [];
  for (let i = 0; i < 60; i += 1) rows.push(rec('recv', 500, i + 1, '同额公司'));
  for (let i = 0; i < 60; i += 1) rows.push(rec('pay', 500, i + 100, '同额公司'));
  const groups = sandbox.buildGroups(rows);
  const summary = sandbox.runPairing(groups, 1);
  check('J 60x60 same amount', summary.pairCount, 60);
  check('J limited flagged', groups[0].pairLimited, true);
}

// K. 零金额
{
  const { group } = pairOf([rec('recv', 0, 3), rec('pay', 0, 4)], 1);
  check('K zero pairing allowed', shape(group).length, 1);
}

// L. 手动容差换算
{
  check('L parse 0.01', sandbox.toleranceInputToCents('0.01'), 1);
  check('L parse 0', sandbox.toleranceInputToCents('0'), 0);
  check('L parse 1000 ok', sandbox.toleranceInputToCents('1000'), 100000);
  check('L parse 1001 reject', sandbox.toleranceInputToCents('1001'), null);
  check('L parse abc reject', sandbox.toleranceInputToCents('abc'), null);
  check('L parse negative reject', sandbox.toleranceInputToCents('-1'), null);
  check('L empty reject', sandbox.toleranceInputToCents(''), null);
  check('L blank reject', sandbox.toleranceInputToCents('   '), null);
  check('L undefined reject', sandbox.toleranceInputToCents(undefined), null);
  check('L 0.005 rounds to 1', sandbox.toleranceInputToCents('0.005'), 1);
}

// M. 比例容差
{
  check('M percent 0.1 pairs 600 diff', shape(pairOf([rec('recv', 1000000, 3), rec('pay', 999400, 8)], 1, 0.1).group).length, 1);
  check('M percent 0 same pair skipped', shape(pairOf([rec('recv', 1000000, 3), rec('pay', 999400, 8)], 1, 0).group).length, 0);
  check('M percent base is larger side (recv)', shape(pairOf([rec('recv', 100, 3), rec('pay', 99.5, 8)], 1, 0.5).group).length, 1);
  check('M percent base is larger side (pay)', shape(pairOf([rec('recv', 99.5, 3), rec('pay', 100, 8)], 1, 0.5).group).length, 1);
  check('M percent too far skipped', shape(pairOf([rec('recv', 200000, 3), rec('pay', 190000, 8)], 1, 1).group).length, 0);
  check('M percent applies to subset', shape(pairOf([rec('recv', 30, 3), rec('recv', 70, 4), rec('pay', 100.3, 8)], 1, 0.3).group).length, 1);
  check('M percent widens subset window', shape(pairOf([rec('recv', 60, 3), rec('recv', 45.2, 4), rec('pay', 100, 8)], 1, 5).group).length, 1);
  check('M percent still prompt only', (() => {
    const { group } = pairOf([rec('recv', 1000000, 3), rec('pay', 999400, 8)], 1, 0.1);
    return [group.netCents / 100, group.recvCents / 100, group.payCents / 100];
  })(), [600, 1000000, 999400]);
}

// N. 比例输入换算
{
  check('N parse empty as 0', sandbox.percentInputToValue(''), 0);
  check('N parse 0.1', sandbox.percentInputToValue('0.1'), 0.1);
  check('N parse 10 ok', sandbox.percentInputToValue('10'), 10);
  check('N parse 10.01 reject', sandbox.percentInputToValue('10.01'), null);
  check('N parse negative reject', sandbox.percentInputToValue('-1'), null);
  check('N parse abc reject', sandbox.percentInputToValue('abc'), null);
  check('N format 0.1', sandbox.formatPercentInput(0.1), '0.1');
  check('N format 0', sandbox.formatPercentInput(0), '0');
}

fs.writeFileSync(
  path.join(REPORT_DIR, 'pair-report.json'),
  JSON.stringify({ failures, results }, null, 1),
  'utf8'
);
console.log(`PAIR_CHECK ${failures === 0 ? 'PASS' : 'FAIL'} failures=${failures} total=${results.length}`);
