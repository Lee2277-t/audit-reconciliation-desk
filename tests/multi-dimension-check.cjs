#!/usr/bin/env node
/**
 * 多币种 / 多主体回归：同一家企业按主体、按币种分开算，不同币种永不混加。
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/multi-dimension-check.cjs
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
    `['toast', 'runError', 'fileError', 'manualError', 'dataCheck'].forEach((id) => { els[id] = __stub(); });
     globalThis.__state = state;
     globalThis.__els = els;`,
    Object.assign(sandbox, { __stub: stub })
  );

  return sandbox;
}

function makeWorkbook() {
  const workbook = XLSX.utils.book_new();
  const recv = XLSX.utils.aoa_to_sheet([
    ['主体', '客户名称', '币种', '金额', '摘要', '辅助'],
    ['甲公司', '华信科技', '人民币', 1000, '货款', 'x'],
    ['甲公司', '华信科技', '美元', 200, '货款', 'x'],
    ['乙公司', '华信科技', '人民币', 300, '货款', 'x']
  ]);
  const pay = XLSX.utils.aoa_to_sheet([
    ['主体', '供应商名称', '币种', '金额', '摘要', '辅助'],
    ['甲公司', '华信科技', '人民币', 400, '货款', 'x'],
    ['甲公司', '华信科技', '美元', 50, '货款', 'x'],
    ['乙公司', '华信科技', '人民币', 300, '货款', 'x']
  ]);
  XLSX.utils.book_append_sheet(workbook, recv, '应收账款');
  XLSX.utils.book_append_sheet(workbook, pay, '应付账款');
  return workbook;
}

function groupOf(groups, entityLabel, currencyLabel) {
  return groups.find((group) => group.entityLabel === entityLabel && group.currencyLabel === currencyLabel);
}

function main() {
  const sandbox = createSandbox();
  const state = sandbox.__state;
  state.autoDetectCols = true;
  state.ageBaseDate = '2026-10-31';

  const workbook = makeWorkbook();
  const file = { name: '多币种测试.xlsx', size: 1, lastModified: 1 };
  const sources = ['应收账款', '应付账款']
    .map((sheetName, index) => sandbox.buildSource(file, workbook, sheetName, `multi::${index}`))
    .filter(Boolean);
  state.sources = sources;
  state.activeSourceId = sources[0] ? sources[0].id : '';

  check('两张表都导入成功', sources.length === 2, `sources=${sources.length}`);
  check('两张表都可用且默认不勾选', sources.every((source) => source.usable && !source.included),
    sources.map((source) => `${source.usable}/${source.included}`).join(','));
  sources.forEach((source) => { source.included = true; });

  const first = sources[0];
  const entityColumn = sandbox.sourceDimensionColumn(first, 'entity');
  const currencyColumn = sandbox.sourceDimensionColumn(first, 'currency');
  check('自动认出主体列', entityColumn && entityColumn.index === 0,
    entityColumn ? `col=${entityColumn.index}` : 'null');
  check('自动认出币种列', currencyColumn && currencyColumn.index === 2,
    currencyColumn ? `col=${currencyColumn.index}` : 'null');
  check('主体/币种不抢企业名称列', first.mapping.company !== 0 && first.mapping.company !== 2,
    `company=${first.mapping.company}`);
  check('主体/币种不抢金额列', first.mapping.amount !== 0 && first.mapping.amount !== 2,
    `amount=${first.mapping.amount}`);
  check('币种列不会被当成主体列', entityColumn && currencyColumn && entityColumn.index !== currencyColumn.index);
  check('已占用的列会被挡掉', sandbox.dimensionTakenColumns(first, 'currency').has(first.mapping.company)
    && sandbox.dimensionTakenColumns(first, 'entity').has(first.mapping.amount));

  const profile = sandbox.buildConfigProfile(first);
  check('列设置记住主体列与币种列',
    profile && profile.entityColumn === entityColumn.index && profile.currencyColumn === currencyColumn.index,
    profile ? `${profile.entityColumn}/${profile.currencyColumn}` : 'null');

  let records = [];
  let skipped = [];
  const controls = [];
  sources.forEach((source) => {
    const parsed = sandbox.parseExcelSource(source);
    records = records.concat(parsed.records);
    skipped = skipped.concat(parsed.skipped);
    const control = sandbox.buildSourceControl(source, parsed);
    if (control) controls.push(Object.assign({ sourceId: source.id, sheetName: source.sheetName, kind: 'excel' }, control));
  });
  state.records = records;
  state.skipped = skipped;
  state.controls = controls;

  check('六笔记录都带主体和币种', records.length === 6
    && records.every((row) => row.entityKey && row.currencyKey),
    records.map((row) => `${row.entityKey}/${row.currencyKey}`).join(','));
  check('人民币写法归一', records.some((row) => row.currencyKey === 'CNY'));
  check('美元写法归一', records.some((row) => row.currencyKey === 'USD'));
  check('取数核对仍然平', controls.length === 2
    && sandbox.combineControls(controls).ok === true,
    JSON.stringify(controls.map((control) => ({ ok: control.ok, diff: control.diffCells }))));
  check('取数核对记住币种', controls.every((control) => control.currencyMixed === true
    && control.currencyKeys.join(',') === 'CNY,USD'),
    controls.map((control) => (control.currencyKeys || []).join('+')).join(' | '));
  check('合并核对标记多币种', sandbox.combineControls(controls).currencyMixed === true);

  sandbox.renderDataCheck();
  const controlHtml = sandbox.__els.dataCheck.innerHTML;
  check('核对块不把不同币种加总写成人民币',
    controlHtml.indexOf('原表金额（不同币种只做原数相加）') !== -1
    && controlHtml.indexOf('这张表里有多种币种') !== -1,
    controlHtml.slice(0, 400));

  state.groups = sandbox.buildGroups(records);
  state.stats = sandbox.computeStats(state.groups);

  check('同一家企业按主体和币种拆成多组', state.groups.length === 3, `groups=${state.groups.length}`);
  const cnyA = groupOf(state.groups, '甲公司', '人民币');
  const usdA = groupOf(state.groups, '甲公司', '美元');
  const cnyB = groupOf(state.groups, '乙公司', '人民币');
  check('甲公司人民币组存在', Boolean(cnyA));
  check('甲公司美元组存在', Boolean(usdA));
  check('乙公司人民币组存在', Boolean(cnyB));
  check('人民币组不混入美元金额', cnyA && cnyA.recvCents === 100000 && cnyA.payCents === 40000 && cnyA.netCents === 60000,
    cnyA ? `${cnyA.recvCents}/${cnyA.payCents}/${cnyA.netCents}` : 'null');
  check('美元组单独算', usdA && usdA.recvCents === 20000 && usdA.payCents === 5000 && usdA.netCents === 15000,
    usdA ? `${usdA.recvCents}/${usdA.payCents}/${usdA.netCents}` : 'null');
  check('乙公司已轧平', cnyB && cnyB.netCents === 0, cnyB ? String(cnyB.netCents) : 'null');
  check('分组 key 带主体和币种前缀',
    Boolean(cnyA && usdA && cnyA.key !== usdA.key && cnyA.baseKey === usdA.baseKey),
    cnyA && usdA ? `${cnyA.key} / ${usdA.key}` : 'null');

  const coverageClean = sandbox.buildDimensionCoverageWarnings(records);
  check('完整币种列不误报没对齐', coverageClean.length === 0, JSON.stringify(coverageClean));
  const partialRecords = records.map((row) => (row.sourceId === sources[1].id
    ? Object.assign({}, row, { currencyRaw: '', currencyKey: '' })
    : row));
  const coverageWarned = sandbox.buildDimensionCoverageWarnings(partialRecords);
  check('一边有币种、一边没写时给出预警', coverageWarned.length === 1,
    JSON.stringify(coverageWarned.map((item) => item.name)));
  check('预警点明币种与涉及的表',
    coverageWarned.every((item) => item.kinds.join(',') === '币种' && item.sources.length === 2),
    JSON.stringify(coverageWarned));
  state.dimensionWarnings = coverageWarned;
  sandbox.renderDataCheck();
  const warnHtml = sandbox.__els.dataCheck.innerHTML;
  check('数据检查写出币种没对齐',
    warnHtml.indexOf('没对齐') !== -1 && warnHtml.indexOf('会被拆成两组') !== -1,
    warnHtml.slice(0, 400));
  state.dimensionWarnings = [];
  sandbox.renderDataCheck();

  const stats = state.stats;
  check('币种分桶两种', stats.currencyTotals.length === 2
    && stats.currencyTotals.map((bucket) => bucket.key).join(',') === 'CNY,USD',
    stats.currencyTotals.map((bucket) => bucket.key).join(','));
  check('汇总标记多币种', stats.mixedCurrency === true);
  const cnyBucket = stats.currencyTotals.find((bucket) => bucket.key === 'CNY');
  const usdBucket = stats.currencyTotals.find((bucket) => bucket.key === 'USD');
  check('人民币发生额只含人民币', cnyBucket && cnyBucket.grossRecvCents === 130000 && cnyBucket.grossPayCents === 70000,
    cnyBucket ? `${cnyBucket.grossRecvCents}/${cnyBucket.grossPayCents}` : 'null');
  check('美元发生额只含美元', usdBucket && usdBucket.grossRecvCents === 20000 && usdBucket.grossPayCents === 5000,
    usdBucket ? `${usdBucket.grossRecvCents}/${usdBucket.grossPayCents}` : 'null');
  check('主体分桶按主体加币种各一份', stats.hasEntity === true && stats.entityTotals.length === 3,
    `entityTotals=${stats.entityTotals.length}`);
  check('币种符号分开显示', sandbox.fmtMoneyIn(100000, 'CNY').indexOf('¥') !== -1
    && sandbox.fmtMoneyIn(100000, 'USD').indexOf('$') !== -1,
    `${sandbox.fmtMoneyIn(100000, 'CNY')} / ${sandbox.fmtMoneyIn(100000, 'USD')}`);

  const fingerprint = sandbox.buildResultFingerprint(state.groups);
  check('指纹是 64 位', /^[0-9a-f]{64}$/.test(fingerprint), fingerprint);
  check('同一状态指纹稳定', sandbox.buildResultFingerprint(state.groups) === fingerprint);

  // 分维度汇总表
  const dimHtml = sandbox.dimensionSummaryMarkup(stats);
  check('汇总区分币种一段', dimHtml.indexOf('按币种分开看') !== -1);
  check('汇总区分主体一段', dimHtml.indexOf('按主体分开看') !== -1);
  check('汇总文案说明不做汇率换算', dimHtml.indexOf('不做汇率换算') !== -1);
  check('汇总表带币种徽章', dimHtml.indexOf('dim-badge') !== -1);

  // 标准导出
  state.runInfo = { mode: 'excel', sources: sources.map((source) => ({ id: source.id, shortLabel: source.shortLabel })) };
  const exportBook = sandbox.buildExportWorkbook(state.groups, '全部企业');
  const summary = exportBook.Sheets['对账汇总'];
  const summaryHeader = XLSX.utils.sheet_to_json(summary, { header: 1 })[0];
  check('对账汇总带主体和币种列',
    summaryHeader[0] === '企业名称' && summaryHeader[1] === '主体' && summaryHeader[2] === '币种',
    summaryHeader.slice(0, 3).join(','));
  check('对账汇总金额写原币',
    summaryHeader.some((label) => label === '应收合计（原币）'),
    summaryHeader.join(','));
  check('对账汇总自动筛选覆盖全部列',
    summary['!autofilter'] && summary['!autofilter'].ref === `A1:${XLSX.utils.encode_col(summaryHeader.length - 1)}${1 + state.groups.length}`,
    summary['!autofilter'] ? summary['!autofilter'].ref : 'none');
  check('对账汇总金额列格式正确', summary.F2 && summary.F2.z === '#,##0.00',
    summary.F2 ? `${summary.F2.v}/${summary.F2.z}` : 'none');
  const detail = exportBook.Sheets['原始明细'];
  const detailHeader = XLSX.utils.sheet_to_json(detail, { header: 1 })[0];
  check('原始明细带主体和币种列',
    detailHeader[0] === '企业名称' && detailHeader[1] === '主体' && detailHeader[2] === '币种',
    detailHeader.slice(0, 3).join(','));
  check('原始明细金额写原币',
    detailHeader.some((label) => label === '金额（原币）'),
    detailHeader.join(','));
  const explanation = XLSX.utils.sheet_to_json(exportBook.Sheets['对账说明'], { header: 1 });
  check('对账说明写清主体与币种口径',
    explanation.some((row) => row[0] === '主体与币种' && String(row[1]).indexOf('不做汇率换算') !== -1),
    'missing');
  check('对账说明的取数核对写原数相加',
    explanation.some((row) => row[0] === '取数核对' && String(row[1]).indexOf('不同币种只做原数相加') !== -1),
    'missing');

  // 分企业导出
  const groupBook = sandbox.buildGroupSheetsWorkbook(state.groups, '全部企业');
  check('分企业导出表数正确', groupBook.SheetNames.length === state.groups.length + 1,
    groupBook.SheetNames.join(','));
  check('目录仍是第一张', groupBook.SheetNames[0] === '目录');
  check('工作表名带上主体和币种',
    groupBook.SheetNames.slice(1).some((name) => name.indexOf('·') !== -1),
    groupBook.SheetNames.join(','));
  const cover = XLSX.utils.sheet_to_json(groupBook.Sheets['目录'], { header: 1 });
  check('目录表头仍从第 9 行开始', cover[8][0] === '序号' && cover[8][1] === '企业名称',
    (cover[8] || []).slice(0, 2).join(','));
  check('目录表头尾部带主体和币种',
    cover[8][cover[8].length - 2] === '主体' && cover[8][cover[8].length - 1] === '币种',
    cover[8].join(','));
  check('目录数据行带主体和币种', cover[9][cover[9].length - 2] === '甲公司'
    || cover[9][cover[9].length - 2] === '乙公司', (cover[9] || []).join(','));
  const coverTotal = cover[9 + state.groups.length];
  check('多币种时目录合计不硬加', coverTotal[2] === '—' && coverTotal[3] === '—',
    (coverTotal || []).join(','));
  const firstGroupSheet = groupBook.Sheets[groupBook.SheetNames[1]];
  const groupRows = XLSX.utils.sheet_to_json(firstGroupSheet, { header: 1 });
  check('企业表带主体行', groupRows[1][0] === '主体', (groupRows[1] || []).join(','));
  check('企业表带币种行', groupRows[2][0] === '币种', (groupRows[2] || []).join(','));
  check('企业表金额写币种', groupRows.some((row) => row[0] === '应收合计（美元）' || row[0] === '应收合计（人民币）'),
    groupRows.slice(0, 10).map((row) => row[0]).join(','));

  // 快照与比对
  const payload = sandbox.buildSnapshotPayload(state.groups);
  check('快照总额按币种分桶', Array.isArray(payload.totals.currencyTotals)
    && payload.totals.currencyTotals.length === 2 && payload.totals.mixedCurrency === true,
    JSON.stringify(payload.totals.currencyTotals || null));
  check('快照企业条目带币种', payload.companies.some((entry) => entry.currencyKey === 'USD'));
  const snapshotFile = sandbox.buildSnapshotFile(state.groups);
  check('快照自校验码 64 位', /^[0-9a-f]{64}$/.test(snapshotFile.sha256), snapshotFile.sha256);
  const same = sandbox.compareSnapshotPayload(payload, payload);
  check('同一份快照比对无变化', same.items.length === 0 && same.totalChanges.length === 0,
    JSON.stringify(same.counts));

  const baselineMini = {
    companies: [{
      key: 'e:甲公司\u0001c:USD\u0002华信科技',
      name: '华信科技',
      aliases: [],
      recvCents: 20000,
      payCents: 5000,
      netCents: 15000,
      records: 1,
      flags: [],
      accepted: 0,
      rejected: 0,
      pending: 0,
      entity: '甲公司',
      entityKey: '甲公司',
      currency: '美元',
      currencyKey: 'USD',
      note: ''
    }],
    totals: {},
    fingerprint: ''
  };
  const currentMini = JSON.parse(JSON.stringify(baselineMini));
  currentMini.companies[0].key = 'e:甲公司\u0001c:CNY\u0002华信科技';
  currentMini.companies[0].currency = '人民币';
  currentMini.companies[0].currencyKey = 'CNY';
  const crossCurrency = sandbox.compareSnapshotPayload(baselineMini, currentMini);
  check('换币种不会被当成同一家的金额变化',
    crossCurrency.counts.added === 1 && crossCurrency.counts.removed === 1 && crossCurrency.counts.amount === 0,
    JSON.stringify(crossCurrency.counts));
  check('少了/多了的金额带币种符号',
    crossCurrency.items.some((item) => item.detail.indexOf('$') !== -1),
    crossCurrency.items.map((item) => item.detail).join(' | '));

  const changed = JSON.parse(JSON.stringify(payload));
  changed.totals.currencyTotals.find((bucket) => bucket.key === 'USD').grossRecvCents += 10000;
  const totalChanges = sandbox.snapshotTotalChanges(payload.totals, changed.totals);
  check('合计变化按币种分别写', totalChanges.some((line) => line.indexOf('（美元）') !== -1),
    totalChanges.join(' | '));
  check('合计变化不用人民币符号冒充美元', !totalChanges.some((line) => line.indexOf('（美元）') !== -1 && line.indexOf('¥') !== -1),
    totalChanges.join(' | '));

  // 手动改列后重认不覆盖（第 6 列「辅助」是空着的，不会被别的角色占走）
  sandbox.setSourceDimensionColumn(first, 'currency', 5);
  const manual = sandbox.sourceDimensionColumn(first, 'currency');
  check('手动指定币种列', manual && manual.index === 5 && manual.manual === true,
    manual ? `${manual.index}/${manual.manual}` : 'null');
  sandbox.refreshDimensionColumns(first);
  const afterRefresh = sandbox.sourceDimensionColumn(first, 'currency');
  check('重新认列不覆盖手动币种列', afterRefresh && afterRefresh.index === 5 && afterRefresh.manual === true,
    afterRefresh ? `${afterRefresh.index}/${afterRefresh.manual}` : 'null');
  sandbox.setSourceDimensionColumn(first, 'currency', -1);
  check('可以关掉币种列', sandbox.sourceDimensionColumn(first, 'currency') === null,
    String(sandbox.sourceDimensionColumn(first, 'currency')));

  if (failures.length) {
    console.log(`MULTI_DIMENSION_CHECK FAIL failures=${failures.length} total=${pass + failures.length}`);
    failures.forEach((item) => console.log(`  - ${item}`));
    process.exit(1);
  }
  console.log(`MULTI_DIMENSION_CHECK PASS failures=0 total=${pass}`);
}

main();
