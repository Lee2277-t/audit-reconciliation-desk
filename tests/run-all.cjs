// 一条命令跑完全部回归：黄金测试 + 十八个专项断言套件。
//
//   ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/run-all.cjs
//   node tests/run-all.cjs [--verbose] [--only 名字片段]
//
// 每个套件只认它自己打的那一行汇总（failures=… total=…），total 和下面写死的
// 期望值比对：套件里有人删掉一条断言而结果仍然全绿，这里会红。
// 详细报告写到 %TEMP%\recon-test-reports\run-all.json，控制台保持 ASCII，
// 避免 GBK 终端把中文断言名打成乱码。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// [套件文件, 期望断言数（黄金测试时期望项数）]
const SUITES = [
  ['run-golden.cjs', 27],
  ['similar-pairs-check.cjs', 55],
  ['pair-check.cjs', 77],
  ['snapshot-check.cjs', 83],
  ['export-hash-check.cjs', 61],
  ['archive-check.cjs', 69],
  ['empty-source-check.cjs', 33],
  ['credit-negative-check.cjs', 95],
  ['import-size-check.cjs', 17],
  ['facet-filter-check.cjs', 66],
  ['source-list-limit-check.cjs', 39],
  ['multi-dimension-check.cjs', 69],
  ['age-preset-check.cjs', 20],
  ['date-window-check.cjs', 35],
  ['normalize-check.cjs', 17],
  ['near-miss-check.cjs', 48],
  ['undo-check.cjs', 17],
  ['render-limit-check.cjs', 11],
  ['browser-support-check.cjs', 10]
];

const PARALLEL = 4;
const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const onlyIndex = argv.indexOf('--only');
const onlyFilter = onlyIndex >= 0 ? argv[onlyIndex + 1] : '';
const REPORT_DIR = path.join(os.tmpdir(), 'recon-test-reports');
const expectedOf = new Map(SUITES);

function parseSummary(fileName, text) {
  if (fileName === 'run-golden.cjs') {
    const pass = text.match(/全部通过：(\d+)\s*项/);
    if (pass) return { failures: 0, total: Number(pass[1]), extra: '' };
    const fail = text.match(/通过\s*(\d+)\s*项，失败\s*(\d+)\s*项/);
    if (fail) return { failures: Number(fail[2]), total: Number(fail[1]) + Number(fail[2]), extra: '' };
    return null;
  }
  // 各套件的汇总行有两种写法：failures=N total=M（多数）与 pass=P fail=Q total=M（date-window）。
  const hit = text.match(/fail(?:ures)?=(\d+)\s+total=(\d+)/);
  if (!hit) return null;
  const zip = text.match(/zip=(\d+)/);
  const perf = text.match(/SIMILAR_PAIRS_PERF\s+(.+)/);
  return {
    failures: Number(hit[1]),
    total: Number(hit[2]),
    extra: zip ? `zip=${zip[1]}` : (perf ? perf[1].trim() : '')
  };
}

function runSuite(fileName) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, fileName)], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
      if (verbose) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      err += chunk.toString('utf8');
      if (verbose) process.stderr.write(chunk);
    });
    child.on('error', (error) => {
      resolve({ fileName, status: 'ERROR', note: String(error && error.message), elapsedMs: Date.now() - started });
    });
    child.on('close', (code) => {
      const summary = parseSummary(fileName, out);
      const expected = expectedOf.get(fileName);
      if (!summary) {
        resolve({
          fileName,
          status: 'ERROR',
          note: `no summary line (exit=${code}) ${(err.trim() || out.trim()).split('\n').slice(-1)[0] || ''}`.slice(0, 300),
          elapsedMs: Date.now() - started
        });
        return;
      }
      let status = 'PASS';
      const notes = [];
      if (summary.failures > 0) {
        status = 'FAIL';
        notes.push(`failures=${summary.failures}`);
        const failedLines = out.split('\n').filter((line) => /^FAIL\s/.test(line)).slice(0, 8);
        if (failedLines.length) notes.push(failedLines.join(' | ').slice(0, 500));
      }
      if (summary.total !== expected) {
        status = status === 'PASS' ? 'SHRUNK' : status;
        notes.push(`total=${summary.total} expected=${expected}`);
      }
      if (code !== 0 && status === 'PASS') {
        status = 'ERROR';
        notes.push(`exit=${code}`);
      }
      resolve({
        fileName,
        status,
        failures: summary.failures,
        total: summary.total,
        expected,
        extra: summary.extra,
        note: notes.join('; '),
        elapsedMs: Date.now() - started
      });
    });
  });
}

async function main() {
  const suites = SUITES.filter(([fileName]) => !onlyFilter || fileName.includes(onlyFilter));
  if (!suites.length) {
    console.log(`RUN_ALL ERROR no suite matches --only ${onlyFilter}`);
    process.exitCode = 1;
    return;
  }

  const results = new Array(suites.length);
  let cursor = 0;
  async function worker() {
    while (cursor < suites.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await runSuite(suites[index][0]);
      if (!verbose) process.stderr.write('.');
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, suites.length) }, worker));
  if (!verbose) process.stderr.write('\n');

  const bad = results.filter((item) => item.status !== 'PASS');
  const totalExpected = results.reduce((sum, item) => sum + (item.expected || 0), 0);
  const totalRun = results.reduce((sum, item) => sum + (item.total || 0), 0);

  console.log('RUN_ALL ===================================================');
  results.forEach((item) => {
    console.log(
      `${item.status.padEnd(6)} ${item.fileName.padEnd(28)} ${item.total || 0}/${item.expected || 0}` +
      `${item.extra ? `  ${item.extra}` : ''}${item.note ? `  <-- ${item.note}` : ''}`
    );
  });
  console.log(`RUN_ALL suites=${results.length} ok=${results.length - bad.length} bad=${bad.length} assertions=${totalRun}/${totalExpected}`);
  console.log(bad.length ? 'RUN_ALL FAIL' : 'RUN_ALL PASS');

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(REPORT_DIR, 'run-all.json'),
    `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`,
    'utf8'
  );
  process.exitCode = bad.length ? 1 : 0;
}

main();
