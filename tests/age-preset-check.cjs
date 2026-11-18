#!/usr/bin/env node
/**
 * 账龄档位回归：默认按年四档；切到半年起五档后分档、企业统计、指纹和快照设置同步变化。
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/age-preset-check.cjs
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
    `['resultBody', 'toast', 'runError', 'fileError', 'manualError', 'ageBandPreset', 'ageBandField'].forEach((id) => { els[id] = __stub(); });
     els.exportFiltered = { checked: false };
     renderSummary = renderDataCheck = renderChips = renderTable = renderSimilarBox = function () {};
     globalThis.__state = state;
     globalThis.__els = els;
     globalThis.__AGE_BANDS = AGE_BANDS;`,
    Object.assign(sandbox, { __stub: stub })
  );

  return sandbox;
}

function makeRecord(months, cents, rowNo) {
  return {
    rowNo,
    companyRaw: '甲公司',
    key: '甲公司',
    dir: 'recv',
    cents,
    rawCents: cents,
    cellCents: cents,
    memo: '',
    docNo: '',
    docKey: '',
    memoKeys: [],
    ageRaw: `${months} 个月`,
    ageMonths: months,
    ageBand: 0,
    ageShown: 0,
    hasAgeColumn: true,
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

  check('默认是按年四档', state.ageBandPreset === 'year' && sandbox.__AGE_BANDS.length === 4,
    `${state.ageBandPreset}/${sandbox.__AGE_BANDS.join(',')}`);
  check('7 个月在默认第一档', sandbox.ageBandIndex(7) === 0);
  check('13 个月在默认第二档', sandbox.ageBandIndex(13) === 1);

  sandbox.applyAgeBandPreset('half');
  check('切到半年起五档', state.ageBandPreset === 'half' && sandbox.__AGE_BANDS.length === 5,
    `${state.ageBandPreset}/${sandbox.__AGE_BANDS.join(',')}`);
  check('五档标签正确', sandbox.__AGE_BANDS[0] === '6个月以内' && sandbox.__AGE_BANDS[4] === '3年以上',
    sandbox.__AGE_BANDS.join(','));
  check('7 个月落到 6-12 个月', sandbox.ageBandIndex(7) === 1, `idx=${sandbox.ageBandIndex(7)}`);
  check('13 个月落到 1-2 年', sandbox.ageBandIndex(13) === 2, `idx=${sandbox.ageBandIndex(13)}`);
  check('30 个月落到 2-3 年', sandbox.ageBandIndex(30) === 3, `idx=${sandbox.ageBandIndex(30)}`);
  check('40 个月落到 3 年以上', sandbox.ageBandIndex(40) === 4, `idx=${sandbox.ageBandIndex(40)}`);

  const records = [makeRecord(7, 10000, 2), makeRecord(13, 20000, 3), makeRecord(40, 30000, 4)];
  state.records = records;
  state.groups = sandbox.buildGroups(records);
  state.groups = state.groups.map((group) => {
    group.ageStats = sandbox.buildAgeStats(group, sandbox.ageBaseDateValue());
    group.hasAge = group.ageStats.applicable > 0;
    group.ageLong = group.ageStats.maxBand === sandbox.__AGE_BANDS.length - 1;
    return group;
  });
  state.stats = sandbox.computeStats(state.groups);

  sandbox.applyAgeBandPreset('half');
  sandbox.refreshAgeBands();
  const group = state.groups[0];
  check('切档后每笔重新分档', records.map((row) => row.ageShown).join(',') === '1,2,4',
    records.map((row) => row.ageShown).join(','));
  check('企业五档金额正确', group.ageStats.recv.map((cell) => cell.cents).join(',') === '0,10000,20000,0,30000',
    group.ageStats.recv.map((cell) => cell.cents).join(','));
  check('账龄超 3 年仍是最后一档', group.ageLong === true && group.ageStats.maxBand === 4,
    `long=${group.ageLong} max=${group.ageStats.maxBand}`);
  check('汇总条档位是五个', state.stats.ageRecvBands.length === 5, `len=${state.stats.ageRecvBands.length}`);

  const halfPrint = sandbox.buildResultFingerprint(state.groups);
  check('半年档指纹是 64 位', /^[0-9a-f]{64}$/.test(halfPrint), halfPrint);
  const payload = sandbox.buildSnapshotPayload(state.groups);
  check('快照设置记住档位', payload.settings.ageBandPreset === 'half', JSON.stringify(payload.settings));

  sandbox.applyAgeBandPreset('year');
  sandbox.refreshAgeBands();
  check('切回按年档后恢复四档', sandbox.__AGE_BANDS.length === 4 && records.map((row) => row.ageShown).join(',') === '0,1,3',
    `${sandbox.__AGE_BANDS.length}/${records.map((row) => row.ageShown).join(',')}`);
  check('按年档企业金额恢复', group.ageStats.recv.map((cell) => cell.cents).join(',') === '10000,20000,0,30000',
    group.ageStats.recv.map((cell) => cell.cents).join(','));
  const yearPrint = sandbox.buildResultFingerprint(state.groups);
  check('切回默认档指纹复原', yearPrint !== halfPrint && /^[0-9a-f]{64}$/.test(yearPrint));
  check('默认档快照设置', sandbox.buildSnapshotPayload(state.groups).settings.ageBandPreset === 'year');

  els.ageBandPreset.value = 'half';
  check('控件值可同步', els.ageBandPreset.value === 'half');

  if (failures.length) {
    console.log(`AGE_PRESET_CHECK FAIL failures=${failures.length} total=${pass + failures.length}`);
    failures.forEach((item) => console.log(`  - ${item}`));
    process.exit(1);
  }
  console.log(`AGE_PRESET_CHECK PASS failures=0 total=${pass}`);
}

main();
