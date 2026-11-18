#!/usr/bin/env node
/**
 * 导出文件校验码回归：SHA-256 向量、收货单留痕、三态渲染、回选核对、三种导出。
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/export-hash-check.cjs
 *
 * 死守的口径：核对文件是**只读**，不写任何 `state`、不改当前结果；
 * 哈希只对 `XLSX.write` 返回的字节算，不把 workbook 对象 JSON 化。
 */
'use strict';
// Headless checks for export-file receipts: byte hash, rendering, verify flow, export wiring.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
  Uint8Array,
  ArrayBuffer,
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

  els.exportReceiptBody = { innerHTML: '' };
  els.exportVerifyOut = { innerHTML: '', className: 'export-verify-out hidden' };
  els.exportExpectInput = { value: '' };
  els.exportFiltered = { checked: false };
  state.filter = 'all';
  state.search = '';
  state.sort = 'netAbsDesc';

  function row(rowNo, dir, cents) {
    return {
      rowNo, dir, cents, rawCents: cents, companyRaw: '甲公司', memo: '', sourceShortLabel: '表A',
      sourceLabel: '表A', reclassified: false, redFlipped: false, hasAgeColumn: false, flags: []
    };
  }
  function group(key, name, recv, pay) {
    return {
      key, displayName: name, variantList: [[name, 1]],
      recvCents: recv, payCents: pay, netCents: recv - pay,
      rows: [row(2, 'recv', recv), row(5, 'pay', pay)],
      flags: [], pairings: []
    };
  }
  function makeState(groups) {
    state.groups = groups;
    state.records = groups.flatMap((item) => item.rows);
    state.controls = [];
    state.runInfo = { mode: 'excel', sources: [] };
    state.pairToleranceCents = 1;
    state.pairPercent = 0;
    state.ageBaseDate = '2026-10-31';
    state.groupNotes = new Map();
    state.stats = { grossRecvCents: 0, grossPayCents: 0 };
  }
  function makeWorkbook() {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([['企业名称', '金额'], ['甲公司', 1234.56]]);
    XLSX.utils.book_append_sheet(wb, ws, '对账汇总');
    return wb;
  }
  function bytesOfWorkbook(wb) {
    const raw = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  }
  function fakeFile(name, bytes, sizeOverride) {
    return {
      name,
      size: sizeOverride === undefined ? bytes.byteLength : sizeOverride,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    };
  }

  // A. 哈希本身
  {
    check('A sha256 abc', sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    check('A sha256 empty', sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    const wide = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) wide[i] = i;
    check('A bytes 0-255 length', sha256BytesHex(wide).length, 64);
    globalThis.__wideHash = sha256BytesHex(wide);
    globalThis.__utfHash = sha256Hex('审计¥ − 1,234.56');
  }

  // B. 校验码输入归一
  {
    const code = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    check('B uppercase', normalizeExportCode(code.toUpperCase()), code);
    check('B spaces', normalizeExportCode('  ba78 16bf 8f01 '), 'ba7816bf8f01');
    check('B sha256 prefix', normalizeExportCode('SHA256: ' + code), code);
    check('B chinese colon', normalizeExportCode('sha-256：' + code), code);
    check('B empty', normalizeExportCode('   '), '');
  }

  // C. 导出留痕与渲染
  {
    makeState([group('甲', '甲公司', 1000, 300)]);
    const wb = makeWorkbook();
    const receipt = recordExportReceipt('standard', '双边对账_标准导出.xlsx', wb);
    check('C receipt exists', Boolean(receipt), true);
    check('C sha length', receipt.sha256.length, 64);
    check('C sha hex', /^[0-9a-f]{64}$/.test(receipt.sha256), true);
    check('C kind label', receipt.kindLabel, '标准导出');
    check('C size', receipt.sizeBytes > 1000, true);
    check('C fingerprint', /^[0-9a-f]{64}$/.test(receipt.fingerprint), true);
    check('C stored', lastExportReceipt.sha256, receipt.sha256);
    globalThis.__receipt = receipt;
    globalThis.__stdHash = sha256BytesHex(bytesOfWorkbook(wb));
  }

  {
    const html = els.exportReceiptBody.innerHTML;
    checkIncludes('C render file name', html, '双边对账_标准导出.xlsx');
    checkIncludes('C render short code', html, __receipt.sha256.slice(0, 24) + '…');
    checkIncludes('C render copy', html, 'data-er-copy="' + __receipt.sha256 + '"');
    checkIncludes('C render label', html, '复制完整校验码');
    checkIncludes('C render fingerprint', html, __receipt.fingerprint.slice(0, 16) + '…');
    checkIncludes('C render size', html, 'KB');
    checkNotIncludes('C no stale', html, '导出之后结果又改过');
  }

  // D. 改名转义 + 结果改动提示
  {
    const wb = makeWorkbook();
    recordExportReceipt('standard', '<img src=x onerror=alert(1)>.xlsx', wb);
    const html = els.exportReceiptBody.innerHTML;
    checkNotIncludes('D escaped img', html, '<img src=x');
    checkIncludes('D escaped text', html, '&lt;img src=x onerror=alert(1)&gt;.xlsx');

    makeState([group('甲', '甲公司', 2000, 300)]);
    renderExportReceipt();
    checkIncludes('D stale after result change', els.exportReceiptBody.innerHTML, '导出之后结果又改过');
    lastExportReceipt = null;
    renderExportReceipt();
    checkIncludes('D empty state', els.exportReceiptBody.innerHTML, '还没有导出过文件');
  }

  // E. 核对文件（本次会话有留痕）
  {
    makeState([group('甲', '甲公司', 1000, 300)]);
    const wb = makeWorkbook();
    const receipt = recordExportReceipt('standard', '导出.xlsx', wb);
    const bytes = bytesOfWorkbook(wb);
    await verifyExportFile({ target: { files: [fakeFile('导出.xlsx', bytes)], value: 'x' } });
    const html = els.exportVerifyOut.innerHTML;
    checkIncludes('E match headline', html, '一致：这个文件就是当时导出的那一份');
    checkIncludes('E match hash', html, receipt.sha256);
    check('E match class', els.exportVerifyOut.className, 'export-verify-out ok');
    check('E match toast', __toasts[__toasts.length - 1][0], '校验码一致');
    check('E match toast warn', __toasts[__toasts.length - 1][1], false);

    const tampered = bytes.slice();
    tampered[tampered.length - 1] ^= 0xff;
    await verifyExportFile({ target: { files: [fakeFile('导出-改过.xlsx', tampered)], value: 'x' } });
    const badHtml = els.exportVerifyOut.innerHTML;
    checkIncludes('E mismatch headline', badHtml, '对不上：这个文件和记下的那份不是同一份');
    checkIncludes('E mismatch expected', badHtml, receipt.sha256);
    checkIncludes('E mismatch actual', badHtml, sha256BytesHex(tampered));
    check('E mismatch class', els.exportVerifyOut.className, 'export-verify-out bad');
    check('E mismatch toast warn', __toasts[__toasts.length - 1][1], true);
  }

  // F. 用底稿上记的校验码核对（不依赖本次会话留痕）
  {
    lastExportReceipt = null;
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const code = sha256BytesHex(bytes);
    els.exportExpectInput.value = code.toUpperCase().replace(/(.{16})/g, '$1 ');
    await verifyExportFile({ target: { files: [fakeFile('旧导出.xlsx', bytes)], value: 'x' } });
    check('F pasted match class', els.exportVerifyOut.className, 'export-verify-out ok');
    checkIncludes('F pasted source', els.exportVerifyOut.innerHTML, '底稿上记下的校验码');

    els.exportExpectInput.value = code;
    await verifyExportFile({ target: { files: [fakeFile('旧导出.xlsx', new Uint8Array([9, 9, 9]))], value: 'x' } });
    check('F pasted mismatch class', els.exportVerifyOut.className, 'export-verify-out bad');
    checkIncludes('F pasted mismatch actual', els.exportVerifyOut.innerHTML, sha256BytesHex(new Uint8Array([9, 9, 9])));
    els.exportExpectInput.value = '';
  }

  // G. 没有留痕也没有记校验码：只报文件自己的校验码
  {
    lastExportReceipt = null;
    els.exportExpectInput.value = '';
    const bytes = new Uint8Array([4, 5, 6]);
    await verifyExportFile({ target: { files: [fakeFile('陌生文件.xlsx', bytes)], value: 'x' } });
    check('G info class', els.exportVerifyOut.className, 'export-verify-out info');
    checkIncludes('G info headline', els.exportVerifyOut.innerHTML, '这个文件的校验码');
    checkIncludes('G info hash', els.exportVerifyOut.innerHTML, sha256BytesHex(bytes));
    checkIncludes('G info hint', els.exportVerifyOut.innerHTML, '底稿上记的逐位对照');
  }

  // H. 非法输入拦截
  {
    const before = els.exportVerifyOut.innerHTML;
    await verifyExportFile({ target: { files: [fakeFile('对账.csv', new Uint8Array([1]))], value: 'x' } });
    checkIncludes('H csv rejected', __toasts[__toasts.length - 1][0], '请选工具导出的 .xlsx 文件');
    check('H csv leaves output', els.exportVerifyOut.innerHTML, before);

    await verifyExportFile({ target: { files: [fakeFile('大文件.xlsx', new Uint8Array([1]), 40 * 1024 * 1024)], value: 'x' } });
    checkIncludes('H oversize rejected', __toasts[__toasts.length - 1][0], '文件太大了');

    els.exportExpectInput.value = 'abc123';
    await verifyExportFile({ target: { files: [fakeFile('坏校验码.xlsx', new Uint8Array([1]))], value: 'x' } });
    checkIncludes('H bad code rejected', __toasts[__toasts.length - 1][0], '64 位');
    els.exportExpectInput.value = '';
  }

  // I. 三条导出链路都留痕
  {
    makeState([group('甲', '甲公司', 1000, 300)]);
    const wb = makeWorkbook();
    const originalWrite = XLSX.writeFile;
    const originalBuild = buildExportWorkbook;
    const originalName = buildExportFileName;
    const originalGroupBuild = buildGroupSheetsWorkbook;
    const originalGroupName = buildGroupSheetsFileName;
    const written = [];
    XLSX.writeFile = (workbook, fileName) => { written.push({ workbook, fileName }); };
    buildExportWorkbook = () => wb;
    buildExportFileName = () => '标准.xlsx';
    buildGroupSheetsWorkbook = () => wb;
    buildGroupSheetsFileName = () => '分企业.xlsx';

    exportResults();
    check('I standard kind', lastExportReceipt.kind, 'standard');
    check('I standard name', lastExportReceipt.fileName, '标准.xlsx');
    check('I standard toast', __toasts[__toasts.length - 1][0].includes('校验码'), true);
    check('I standard hash', lastExportReceipt.sha256, sha256BytesHex(bytesOfWorkbook(written[0].workbook)));

    exportGroupSheets();
    check('I blocks kind', lastExportReceipt.kind, 'blocks');
    check('I blocks label', lastExportReceipt.kindLabel, '分企业导出');
    check('I blocks name', lastExportReceipt.fileName, '分企业.xlsx');
    check('I blocks toast', __toasts[__toasts.length - 1][0].includes('校验码'), true);

    XLSX.writeFile = originalWrite;
    buildExportWorkbook = originalBuild;
    buildExportFileName = originalName;
    buildGroupSheetsWorkbook = originalGroupBuild;
    buildGroupSheetsFileName = originalGroupName;
  }

  // J. 再算一次仍得到同一个校验码（两次写字节必须一致）
  {
    makeState([group('甲', '甲公司', 1000, 300)]);
    const wb = makeWorkbook();
    const receipt = recordExportReceipt('snapshot', '比对.xlsx', wb);
    const bytes = bytesOfWorkbook(wb);
    check('J snapshot label', receipt.kindLabel, '底稿比对导出');
    check('J rehash equals receipt', sha256BytesHex(bytes), receipt.sha256);
  }

  globalThis.__hashResults = { results, failures };
`;

(async () => {
  try {
    await vm.runInContext(`(async () => {${code}})().catch((error) => { globalThis.__hashError = error; })`, sandbox);
  } catch (error) {
    sandbox.__hashError = error;
  }
  if (sandbox.__hashError) {
    console.error(sandbox.__hashError);
    process.exit(1);
  }
  const output = sandbox.__hashResults;
  if (!output) {
    console.error('no results');
    process.exit(1);
  }
  const expectedWide = crypto.createHash('sha256').update(Buffer.from(Array.from({ length: 256 }, (_v, i) => i))).digest('hex');
  const expectedUtf = crypto.createHash('sha256').update('审计¥ − 1,234.56', 'utf8').digest('hex');
  const extra = [
    ['outer bytes hash', sandbox.__wideHash === expectedWide, sandbox.__wideHash, expectedWide],
    ['outer utf8 hash', sandbox.__utfHash === expectedUtf, sandbox.__utfHash, expectedUtf],
    ['outer standard hash', sandbox.__receipt && sandbox.__receipt.sha256 === sandbox.__stdHash, sandbox.__stdHash, sandbox.__receipt && sandbox.__receipt.sha256]
  ];
  extra.forEach(([name, ok, actual, expected]) => {
    if (!ok) output.failures += 1;
    output.results.push({ name, ok, actual, expected });
  });
  fs.writeFileSync(path.join(REPORT_DIR, 'export-hash-report.json'), JSON.stringify(output, null, 1), 'utf8');
  console.log(`EXPORT_HASH_CHECK ${output.failures === 0 ? 'PASS' : 'FAIL'} failures=${output.failures} total=${output.results.length}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
