#!/usr/bin/env node
/**
 * 底稿快照链路回归：保存 → 自校验 → 篡改拒绝 → 比对 → 导出。
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/snapshot-check.cjs
 *
 * 死守的口径：比对是纯函数，不碰 `state.groups`、不改任何金额；
 * `sha256` 必须对**原始 payload** 算，先收敛再校验永远对不上（见 AGENTS.md §9）。
 */
'use strict';
// Headless checks for the snapshot save / validate / diff / export chain.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const XLSX = require(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));

const APP = path.join(ROOT, 'assets', 'app.js');
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
  Number,
  String,
  Array,
  Object,
  Set,
  Map,
  RegExp,
  TextEncoder,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: () => {},
  encodeURIComponent,
  decodeURIComponent,
  Blob: function () {},
  URL: { createObjectURL: () => '', revokeObjectURL() {} },
  navigator: {},
  document: {
    addEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, remove() {}, click() {} }),
    body: { appendChild() {}, removeChild() {} }
  },
  window: { addEventListener() {} }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(APP, 'utf8'), sandbox);

const code = `
  const results = [];
  let failures = 0;
  function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures += 1;
    results.push({ name, ok, actual, expected });
  }
  function checkIncludes(name, actual, needle) {
    const ok = String(actual).includes(needle);
    if (!ok) failures += 1;
    results.push({ name, ok, actual, expected: needle });
  }
  function checkNotIncludes(name, actual, needle) {
    const ok = !String(actual).includes(needle);
    if (!ok) failures += 1;
    results.push({ name, ok, actual, expected: '不含 ' + needle });
  }

  globalThis.__toasts = [];
  showToast = (message, warn) => { globalThis.__toasts.push([String(message), !!warn]); };

  els.appVersion = { textContent: 'v-test.1' };
  els.snapshotDiff = {
    innerHTML: '', hidden: true,
    classList: {
      add(name) { if (name === 'hidden') this.owner.hidden = true; },
      remove(name) { if (name === 'hidden') this.owner.hidden = false; }
    },
    scrollIntoView() {}
  };
  els.snapshotDiff.classList.owner = els.snapshotDiff;

  function row(rowNo, dir, cents, extra) {
    return Object.assign({
      rowNo, dir, cents, rawCents: cents, companyRaw: '甲公司', memo: '', sourceShortLabel: '表A',
      sourceLabel: '表A', reclassified: false, redFlipped: false, hasAgeColumn: false, flags: []
    }, extra || {});
  }
  function pairing(kind, recv, pay, decision) {
    return {
      kind: kind || 'one',
      recvCents: recv, payCents: pay, diffCents: recv - pay,
      decision: decision || 'pending',
      recvRows: [row(2, 'recv', recv)],
      payRows: [row(9, 'pay', pay)]
    };
  }
  function group(key, name, recv, pay, opts) {
    const options = opts || {};
    const recvRows = Number(options.records || 1);
    const rows = [];
    for (let i = 0; i < recvRows; i += 1) rows.push(row(2 + i, i === 0 ? 'recv' : 'pay', i === 0 ? recv : pay));
    return {
      key,
      displayName: name,
      variantList: (options.aliases || [name]).map((alias) => [alias, 1]),
      recvCents: recv,
      payCents: pay,
      netCents: recv - pay,
      rows,
      flags: options.flags || [],
      pairings: options.pairings || []
    };
  }

  function makeState(groups, options) {
    const opts = options || {};
    state.groups = groups;
    state.records = groups.reduce((sum, item) => sum + item.rows.length, 0) > 0
      ? groups.flatMap((item) => item.rows)
      : [];
    state.controls = [];
    state.runInfo = { mode: 'excel', sources: [] };
    state.pairToleranceCents = opts.toleranceCents === undefined ? 1 : opts.toleranceCents;
    state.pairPercent = opts.percent === undefined ? 0 : opts.percent;
    state.ageBaseDate = opts.ageBaseDate || '2026-10-31';
    state.groupNotes = new Map(opts.notes || []);
    state.stats = { grossRecvCents: 0, grossPayCents: 0 };
  }

  // A. 保存结构、哈希与往返校验
  {
    makeState([
      group('甲', '甲公司', 10000, 3000, { records: 2, notes: [] }),
      group('乙', '乙公司', 0, 5000, { records: 1 })
    ], { notes: [['甲', '已函证']] });

    const file = buildSnapshotFile(state.groups);
    check('A format', file.format, 'audit-recon-snapshot');
    check('A version', file.formatVersion, 1);
    check('A hash 64 hex', /^[0-9a-f]{64}$/.test(file.sha256), true);
    check('A hash matches payload', file.sha256, sha256Hex(JSON.stringify(file.payload)));
    check('A payload version label', file.payload.appVersion, 'v-test.1');
    check('A company count', file.payload.companies.length, 2);
    check('A sorted by key', file.payload.companies.map((entry) => entry.key), ['乙', '甲']);
    check('A totals records', file.payload.totals.records, 3);
    check('A totals net recv', file.payload.totals.netRecvCents, 7000);
    check('A totals net pay', file.payload.totals.netPayCents, 5000);
    check('A note captured', file.payload.companies.find((entry) => entry.key === '甲').note, '已函证');
    check('A aliases captured', file.payload.companies.find((entry) => entry.key === '甲').aliases, ['甲公司']);
    check('A settings', file.payload.settings, { toleranceCents: 1, pairPercent: 0, ageBaseDate: '2026-10-31', ageBandPreset: 'year' });

    const accepted = validateSnapshotFile(JSON.parse(JSON.stringify(file)));
    check('A validate ok', accepted.ok, true);
    check('A validate keeps note', accepted.payload.companies.find((entry) => entry.key === '甲').note, '已函证');

    const tampered = JSON.parse(JSON.stringify(file));
    tampered.payload.companies[0].recvCents += 100;
    const tamperedResult = validateSnapshotFile(tampered);
    check('A tampered rejected', tamperedResult.ok, false);
    checkIncludes('A tampered message', tamperedResult.message, '校验码');

    check('A wrong format rejected', validateSnapshotFile({ format: 'x' }).ok, false);
    check('A wrong version rejected', validateSnapshotFile({ format: 'audit-recon-snapshot', formatVersion: 2, payload: {} }).ok, false);
    check('A missing payload rejected', validateSnapshotFile({ format: 'audit-recon-snapshot', formatVersion: 1 }).ok, false);
    check('A garbage rejected', validateSnapshotFile(null).ok, false);
  }

  // B. 同一份结果：无变化
  {
    makeState([group('甲', '甲公司', 10000, 3000, { records: 2, pairings: [pairing('one', 3000, 3000, 'accepted')] })]);
    const baseline = buildSnapshotPayload(state.groups);
    const current = buildSnapshotPayload(state.groups);
    const diff = compareSnapshotPayload(baseline, current);
    check('B no items', diff.items.length, 0);
    check('B same fingerprint', diff.sameFingerprint, true);
    check('B no settings', diff.settingChanges, []);
    check('B no totals', diff.totalChanges, []);
  }

  // C. 金额 / 笔数变化
  {
    makeState([group('甲', '甲公司', 10000, 3000, { records: 2 })]);
    const baseline = buildSnapshotPayload(state.groups);
    makeState([group('甲', '甲公司', 12000, 3000, { records: 3 })]);
    const current = buildSnapshotPayload(state.groups);
    const diff = compareSnapshotPayload(baseline, current);
    check('C one amount item', diff.items.length, 1);
    check('C kind amount', diff.items[0].kind, 'amount');
    checkIncludes('C recv old', diff.items[0].detail, '应收 ¥100.00 → ¥120.00');
    checkIncludes('C net old', diff.items[0].detail, '净额 ¥70.00 → ¥90.00');
    checkIncludes('C records change', diff.items[0].detail, '记录 2 笔 → 3 笔');
    check('C counts amount', diff.counts.amount, 1);
    check('C fingerprint changed', diff.sameFingerprint, false);
    checkIncludes('C headline', snapshotHeadline(diff), '金额/笔数 1 家');
  }

  // D. 新增 / 减少企业
  {
    makeState([group('甲', '甲公司', 10000, 0)]);
    const baseline = buildSnapshotPayload(state.groups);
    makeState([group('乙', '乙公司', 0, 5000)]);
    const current = buildSnapshotPayload(state.groups);
    const diff = compareSnapshotPayload(baseline, current);
    check('D two items', diff.items.length, 2);
    check('D added first', diff.items.map((item) => item.kind), ['added', 'removed']);
    checkIncludes('D added detail', diff.items[0].detail, '新增这家');
    checkIncludes('D removed detail', diff.items[1].detail, '少了这家');
    check('D added has no baseline', diff.items[0].baseline, null);
    check('D removed has no current', diff.items[1].current, null);
  }

  // E. 配对确认 / 差异说明 / 名称 / 标记
  {
    makeState([group('甲', '甲公司', 5000, 5000, {
      pairings: [pairing('one', 5000, 5000, 'accepted')]
    })], { notes: [['甲', '原来这样']] });
    const baseline = buildSnapshotPayload(state.groups);

    makeState([group('甲', '甲公司（新写法）', 5000, 5000, {
      pairings: [pairing('one', 5000, 5000, 'rejected')],
      flags: ['sameDup']
    })], { notes: [['甲', '后来改过']] });
    const current = buildSnapshotPayload(state.groups);
    const diff = compareSnapshotPayload(baseline, current);
    check('E one item', diff.items.length, 1);
    check('E kind decision wins', diff.items[0].kind, 'decision');
    checkIncludes('E decision detail', diff.items[0].detail, '配对确认：采纳 1 → 0、不采纳 0 → 1');
    checkIncludes('E note detail', diff.items[0].detail, '差异说明：「原来这样」 → 「后来改过」');
    checkIncludes('E name detail', diff.items[0].detail, '名称写法');
    checkIncludes('E flags detail', diff.items[0].detail, '多了标记：同向重复');
  }

  // F. 只有差异说明变化：指纹不变，但仍列出
  {
    makeState([group('甲', '甲公司', 1000, 0)], { notes: [['甲', 'a']] });
    const baseline = buildSnapshotPayload(state.groups);
    makeState([group('甲', '甲公司', 1000, 0)], { notes: [['甲', 'b']] });
    const current = buildSnapshotPayload(state.groups);
    const diff = compareSnapshotPayload(baseline, current);
    check('F same fingerprint', diff.sameFingerprint, true);
    check('F note item', diff.counts.note, 1);
    check('F no amount item', diff.counts.amount, 0);
    check('F note detail', diff.items[0].kind, 'note');
  }

  // G. 设置变化与合计变化
  {
    makeState([group('甲', '甲公司', 1000, 0)]);
    const baseline = buildSnapshotPayload(state.groups);
    const current = buildSnapshotPayload(state.groups);
    current.settings.toleranceCents = 50;
    current.settings.pairPercent = 0.5;
    current.settings.ageBaseDate = '2025-10-31';
    current.totals.records = 9;
    const diff = compareSnapshotPayload(baseline, current);
    check('G three settings', diff.settingChanges, [
      '核销容差 0.01 元 → 0.50 元',
      '比例容差 不用比例 → 0.5%',
      '账龄算到 2026-10-31 → 2025-10-31'
    ]);
    checkIncludes('G totals records', diff.totalChanges.join('；'), '记录笔数 1 笔 → 9 笔');
    check('G no company items', diff.items.length, 0);
  }

  // H. 名称写法归一后自动对上（key 变了）
  {
    makeState([group('key-old', '上海华信科技有限公司', 1000, 0)]);
    const baseline = buildSnapshotPayload(state.groups);
    makeState([group('key-new', '上海华信科技有限公司', 1000, 0)]);
    const current = buildSnapshotPayload(state.groups);
    const diff = compareSnapshotPayload(baseline, current);
    check('H matched by name', diff.items.length, 0);
    check('H no added', diff.counts.added, 0);
    check('H no removed', diff.counts.removed, 0);
  }

  // I. 人工并归：旧企业名出现在新企业的原始写法里
  {
    makeState([
      group('甲', '甲公司', 1000, 0),
      group('乙', '乙公司', 2000, 0)
    ]);
    const baseline = buildSnapshotPayload(state.groups);
    makeState([group('甲乙', '甲公司', 3000, 0, { aliases: ['甲公司', '乙公司'], flags: ['merge'] })]);
    const current = buildSnapshotPayload(state.groups);
    const diff = compareSnapshotPayload(baseline, current);
    check('I no added/removed', [diff.counts.added, diff.counts.removed], [0, 0]);
    check('I one company item', diff.items.length, 1);
    checkIncludes('I amount detail', diff.items[0].detail, '应收 ¥10.00 → ¥30.00');
    checkIncludes('I flags detail', diff.items[0].detail, '多了标记：已人工并归');
    checkIncludes('I merge note', diff.items[0].detail, '「乙公司」已经并进这家');
  }

  // J. 渲染与自动刷新所需的最小 UI
  {
    makeState([group('甲', '甲公司', 1000, 300, { pairings: [pairing('one', 300, 300)] })]);
    const baseline = buildSnapshotFile(state.groups).payload;
    snapshotBaseline = { payload: baseline, source: 'imported', fileName: '旧快照.json', importedAt: new Date() };
    makeState([group('甲', '甲公司', 1200, 300, { pairings: [pairing('one', 300, 300)] })]);
    renderSnapshotComparison();
    const html = els.snapshotDiff.innerHTML;
    checkIncludes('J summary', html, '和快照比有变化');
    checkIncludes('J baseline label', html, '旧快照.json');
    checkIncludes('J company name', html, '甲公司');
    checkIncludes('J detail', html, '应收 ¥10.00 → ¥12.00');
    checkIncludes('J export button', html, 'data-snap-export');
    check('J shown', els.snapshotDiff.hidden, false);
    check('J captured comparison', snapshotComparison.items.length, 1);
  }

  // K. 导出比对工作簿（桩掉写文件）
  {
    let exported = null;
    const originalWriteFile = XLSX.writeFile;
    XLSX.writeFile = (workbook, fileName) => { exported = { workbook, fileName }; };
    exportSnapshotComparison();
    XLSX.writeFile = originalWriteFile;

    check('K written', Boolean(exported), true);
    checkIncludes('K file name', exported && exported.fileName, '_底稿比对_');
    const sheet = exported.workbook.Sheets['底稿比对'];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
    check('K title', rows[0][0], '双边对账底稿比对');
    check('K header row', rows[12][0], '企业名称');
    check('K first company', rows[13][0], '甲公司');
    check('K old amount', rows[13][2], 10);
    check('K new amount', rows[13][3], 12);
    check('K detail column', String(rows[13][14]).includes('应收 ¥10.00 → ¥12.00'), true);
    check('K autofilter', sheet['!autofilter'].ref, 'A13:O13');
    check('K money format', sheet.C14.z, '#,##0.00');
    check('K toast', String(globalThis.__toasts[globalThis.__toasts.length - 1][0]).indexOf('比对结果已导出') === 0, true);
    check('K receipt hash', /^[0-9a-f]{64}$/.test(lastExportReceipt && lastExportReceipt.sha256), true);
    check('K receipt kind', lastExportReceipt && lastExportReceipt.kind, 'snapshot');
  }

  // L. 清空快照
  {
    clearSnapshot();
    check('L baseline cleared', snapshotBaseline, null);
    check('L comparison cleared', snapshotComparison, null);
    check('L hidden', els.snapshotDiff.hidden, true);
  }

  globalThis.__snapResults = { results, failures };
`;

vm.runInContext(code, sandbox);

const output = sandbox.__snapResults;
fs.writeFileSync(
  path.join(REPORT_DIR, 'snapshot-report.json'),
  JSON.stringify(output, null, 1),
  'utf8'
);
console.log(`SNAPSHOT_CHECK ${output.failures === 0 ? 'PASS' : 'FAIL'} failures=${output.failures} total=${output.results.length}`);
