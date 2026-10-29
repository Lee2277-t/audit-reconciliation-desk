#!/usr/bin/env node
/**
 * 一键归档包回归：CRC32 向量、store 布局、包内 xlsx 字节与收货单一致、README 字段。
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/archive-check.cjs
 *
 * 死守的口径：归档**只读** `lastExportReceipt.bytes`，不重新序列化、不改 `state`；
 * 只用 store（method 0），一旦改压缩，包内字节就不再等于卡片上的校验码。
 */
'use strict';
// Headless checks for the export archive: CRC32, store-only zip layout, entry names,
// inner xlsx byte equality with the receipt, README contents, and no state mutation.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const XLSX = require(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));

const APP = path.join(ROOT, 'assets', 'app.js');
// 产物写到临时目录，不留在仓库里（zip 与报告都只是这一轮的取证）。
const OUT_DIR = path.join(require('node:os').tmpdir(), 'recon-test-reports', 'archive-check-out');

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
  TextDecoder,
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

const result = vm.runInContext(`
  const results = [];
  let failures = 0;
  function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures += 1;
    results.push({ name, ok, actual, expected });
  }
  function checkTrue(name, actual) { check(name, Boolean(actual), true); }
  function checkIncludes(name, actual, needle) {
    const ok = String(actual).includes(needle);
    if (!ok) failures += 1;
    results.push({ name, ok, actual: String(actual).slice(0, 400), expected: needle });
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
    const ws = XLSX.utils.aoa_to_sheet([['企业名称', '金额'], ['甲公司', 1234.56], ['乙公司', -20]]);
    XLSX.utils.book_append_sheet(wb, ws, '对账汇总');
    return wb;
  }
  function u16(view, at) { return view.getUint16(at, true); }
  function u32(view, at) { return view.getUint32(at, true); }

  // Independent reader used only for assertions (does not call app extractor helpers).
  function readZip(bytes) {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const view = new DataView(buffer);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0; i -= 1) {
      if (u32(view, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return { ok: false };
    const count = u16(view, eocd + 10);
    const centralSize = u32(view, eocd + 12);
    const centralStart = u32(view, eocd + 16);
    const entries = [];
    let cursor = centralStart;
    for (let i = 0; i < count; i += 1) {
      if (u32(view, cursor) !== 0x02014b50) return { ok: false, why: 'central signature' };
      const flags = u16(view, cursor + 8);
      const method = u16(view, cursor + 10);
      const crc = u32(view, cursor + 16);
      const compSize = u32(view, cursor + 20);
      const size = u32(view, cursor + 24);
      const nameLen = u16(view, cursor + 28);
      const extraLen = u16(view, cursor + 30);
      const commentLen = u16(view, cursor + 32);
      const localOffset = u32(view, cursor + 42);
      const name = new TextDecoder('utf-8').decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));
      let data = new Uint8Array(0);
      if (u32(view, localOffset) !== 0x04034b50) return { ok: false, why: 'local signature' };
      const localNameLen = u16(view, localOffset + 26);
      const localExtraLen = u16(view, localOffset + 28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      data = bytes.subarray(dataStart, dataStart + compSize);
      entries.push({ name, flags, method, crc, compSize, size, localOffset, data });
      cursor += 46 + nameLen + extraLen + commentLen;
    }
    return { ok: true, count, centralSize, centralStart, entries, eocd, total: bytes.length };
  }

  // A. CRC32 向量
  {
    check('A crc32 123456789', crc32Bytes(utf8Bytes('123456789')), 0xCBF43926);
    check('A crc32 empty', crc32Bytes(new Uint8Array(0)), 0);
    check('A crc32 one zero', crc32Bytes(new Uint8Array([0])), 0xD202EF8D);
    check('A crc32 abc', crc32Bytes(utf8Bytes('abc')), 0x352441C2);
  }

  // B. 空 zip 的结构
  {
    const empty = buildStoreZip([]);
    check('B empty zip length', empty.length, 22);
    check('B empty zip eocd', empty[0] === 0x50 && empty[1] === 0x4b && empty[2] === 0x05 && empty[3] === 0x06, true);
    const parsed = readZip(empty);
    check('B empty count', parsed.ok && parsed.count, 0);
  }

  // C. 中文条目名、UTF-8 标记、存储模式、偏移自洽
  {
    const zip = buildStoreZip([
      { name: '甲表.xlsx', bytes: utf8Bytes('hello'), at: new Date(2026, 0, 2, 3, 4, 6) },
      { name: '校验码.txt', bytes: utf8Bytes('世界'), at: new Date(2026, 0, 2, 3, 4, 8) }
    ]);
    const parsed = readZip(zip);
    check('C parse ok', parsed.ok, true);
    check('C count', parsed.count, 2);
    check('C names', parsed.entries.map((entry) => entry.name), ['甲表.xlsx', '校验码.txt']);
    check('C utf8 flag', parsed.entries.map((entry) => (entry.flags & 0x0800) !== 0), [true, true]);
    check('C method store', parsed.entries.map((entry) => entry.method), [0, 0]);
    check('C sizes', parsed.entries.map((entry) => [entry.size, entry.compSize]), [[5, 5], [6, 6]]);
    check('C crc first', parsed.entries[0].crc, crc32Bytes(utf8Bytes('hello')));
    check('C data', Array.from(parsed.entries[1].data), Array.from(utf8Bytes('世界')));
    check('C central start', parsed.centralStart, 30 + 11 + 5 + 30 + 13 + 6);
    checkTrue('C central size sane', parsed.centralSize >= 46 * 2);
    check('C total', parsed.total, zip.length);
    check('C central ends at eocd', parsed.centralStart + parsed.centralSize, parsed.eocd);
  }

  // D. 导出 → 收货单 → 归档包
  {
    makeState([group('甲', '甲公司', 123456, 2000)]);
    const wb = makeWorkbook();
    const receipt = recordExportReceipt('standard', '双边对账_标准导出.xlsx', wb);
    checkTrue('D receipt bytes kept', receipt.bytes && receipt.bytes.length > 1000);
    check('D bytes size equals sizeBytes', receipt.bytes.length, receipt.sizeBytes);
    check('D companies', receipt.companies, 1);
    check('D records', receipt.records, 2);
    checkIncludes('D render archive button', els.exportReceiptBody.innerHTML, 'data-er-archive');
    checkIncludes('D render archive label', els.exportReceiptBody.innerHTML, '打成一个归档包');

    const before = state.groups.map((item) => [item.key, item.recvCents, item.payCents, item.netCents]);
    const archive = archiveExportReceipt();
    const after = state.groups.map((item) => [item.key, item.recvCents, item.payCents, item.netCents]);
    checkTrue('D archive returned', archive && archive.bytes && archive.bytes.length > receipt.bytes.length);
    check('D archive name suffix', /_归档_\\d{8}_\\d{4}\\.zip$/.test(archive.fileName), true);
    check('D archive name base', archive.fileName.startsWith('双边对账_标准导出_归档_'), true);
    check('D state untouched', after, before);
    check('D receipt untouched', lastExportReceipt.sha256, receipt.sha256);

    const parsed = readZip(archive.bytes);
    check('D zip parse', parsed.ok, true);
    check('D zip count', parsed.count, 2);
    check('D zip names', parsed.entries.map((entry) => entry.name), ['双边对账_标准导出.xlsx', '校验码.txt']);
    const inner = parsed.entries[0];
    const readme = parsed.entries[1];
    check('D inner xlsx size', inner.data.length, receipt.bytes.length);
    check('D inner xlsx bytes', sha256BytesHex(inner.data), receipt.sha256);
    check('D inner crc', inner.crc, crc32Bytes(receipt.bytes));
    check('D readme bom', Array.from(readme.data.subarray(0, 3)), [0xEF, 0xBB, 0xBF]);
    const text = new TextDecoder('utf-8').decode(readme.data.subarray(3));
    checkIncludes('D readme title', text, '双边对账工具 · 归档说明');
    checkIncludes('D readme kind', text, '导出方式：标准导出');
    checkIncludes('D readme file', text, '结果文件：双边对账_标准导出.xlsx');
    checkIncludes('D readme hash', text, '文件校验码（SHA-256）：' + receipt.sha256);
    checkIncludes('D readme fingerprint', text, '结果指纹（SHA-256）：' + receipt.fingerprint);
    checkIncludes('D readme companies', text, '企业数：1 家');
    checkIncludes('D readme records', text, '记录笔数：2 笔');
    checkIncludes('D readme version', text, '工具版本：v');
    checkIncludes('D readme how', text, '怎么核对');
    checkIncludes('D readme netting', text, '不代表会计上可以抵销');
    checkIncludes('D readme no compression', text, '包内文件与导出时的文件逐字节相同');
    check('D toast', __toasts[__toasts.length - 1][0].startsWith('归档包已下载：'), true);

    globalThis.__archive = archive;
    globalThis.__receiptSha = receipt.sha256;
    globalThis.__receipt = receipt;
  }

  // E. 分企业导出与底稿比对导出也能归档
  {
    const wb = makeWorkbook();
    const blocks = recordExportReceipt('blocks', '双边对账_分企业明细.xlsx', wb);
    const blocksArchive = archiveExportReceipt();
    check('E blocks kind', blocks.kindLabel, '分企业导出');
    check('E blocks archive base', blocksArchive.fileName.startsWith('双边对账_分企业明细_归档_'), true);
    checkIncludes('E blocks readme', buildArchiveReadme(blocks, new Date()), '导出方式：分企业导出');

    const wb2 = makeWorkbook();
    const snap = recordExportReceipt('snapshot', '双边对账_底稿比对.xlsx', wb2);
    check('E snapshot kind', snap.kindLabel, '底稿比对导出');
    checkIncludes('E snapshot readme', buildArchiveReadme(snap, new Date()), '导出方式：底稿比对导出');
  }

  // F. 没有收货单 / 旧收货单没有字节
  {
    lastExportReceipt = null;
    const empty = archiveExportReceipt();
    check('F no receipt null', empty, null);
    check('F no receipt toast', __toasts[__toasts.length - 1][0], '先导出一次文件，再把文件和校验码打包归档');
    check('F no receipt warn', __toasts[__toasts.length - 1][1], true);

    lastExportReceipt = { kind: 'standard', kindLabel: '标准导出', fileName: 'x.xlsx', sizeBytes: 10, sha256: 'a'.repeat(64), fingerprint: '', companies: 0, records: 0, at: Date.now() };
    const legacy = archiveExportReceipt();
    check('F legacy null', legacy, null);
    check('F legacy toast', __toasts[__toasts.length - 1][0], '先导出一次文件，再把文件和校验码打包归档');
  }

  // G. 归档不改文件内容：对同一收货单再打一次，包内 xlsx 仍等于原字节
  {
    const before = lastExportReceipt;
    lastExportReceipt = __receipt;
    const again = archiveExportReceipt();
    const parsed = readZip(again.bytes);
    check('G inner hash stable', sha256BytesHex(parsed.entries[0].data), __receiptSha);
    check('G same inner length', parsed.entries[0].data.length, __receipt.sizeBytes);
    lastExportReceipt = before;
  }

  ({ results, failures, zip: Array.from(__archive ? __archive.bytes : []), archiveName: __archive ? __archive.fileName : '', receiptSha: __receiptSha, receiptSize: __receipt.sizeBytes, failed: failures > 0 });
`, sandbox);

fs.mkdirSync(OUT_DIR, { recursive: true });
const zipPath = path.join(OUT_DIR, 'archive.zip');
const zipBytes = Buffer.from(result.zip);
fs.writeFileSync(zipPath, zipBytes);

// Independent Node-side extraction + hashing.
function readZipNode(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return { ok: false };
  const count = buffer.readUInt16LE(eocd + 10);
  const centralStart = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  let cursor = centralStart;
  for (let i = 0; i < count; i += 1) {
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const compSize = buffer.readUInt32LE(cursor + 20);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    entries.push({ name, data: buffer.subarray(dataStart, dataStart + compSize), crc: buffer.readUInt32LE(cursor + 16) });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return { ok: true, count, entries };
}

const checks = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({ name, ok, actual: ok ? undefined : actual, expected });
}
const parsedZip = readZipNode(zipBytes);
check('N zip parse', parsedZip.ok, true);
check('N zip entries', parsedZip.count, 2);
check('N zip names', parsedZip.entries ? parsedZip.entries.map((entry) => entry.name) : [], ['双边对账_标准导出.xlsx', '校验码.txt']);
if (parsedZip.ok) {
  const inner = parsedZip.entries[0].data;
  const innerHash = crypto.createHash('sha256').update(inner).digest('hex');
  check('N inner bytes match receipt size', inner.length, result.receiptSize);
  check('N inner sha equals receipt', innerHash, result.receiptSha);
  const readmeText = parsedZip.entries[1].data.subarray(3).toString('utf8');
  check('N readme carries hash', readmeText.includes(result.receiptSha), true);
  check('N readme carries size', readmeText.includes('企业数：1 家'), true);
}
check('N archive name', /_归档_\d{8}_\d{4}\.zip$/.test(result.archiveName), true);

const all = result.results.concat(checks);
const failures = all.filter((item) => !item.ok).length;
const report = { total: all.length, failures, resultFailures: result.failures, checks: all, zipPath, zipBytes: zipBytes.length };
fs.writeFileSync(path.join(OUT_DIR, 'archive-report.json'), JSON.stringify(report, null, 2), 'utf8');

const failed = all.filter((item) => !item.ok);
failed.slice(0, 12).forEach((item) => {
  console.log('FAIL ' + item.name + ' actual=' + JSON.stringify(item.actual) + ' expected=' + JSON.stringify(item.expected));
});
console.log('ARCHIVE_CHECK ' + (failures ? 'FAIL' : 'PASS') + ' failures=' + failures + ' total=' + all.length + ' zip=' + zipBytes.length);
process.exit(failures ? 1 : 0);
