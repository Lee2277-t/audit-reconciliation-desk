// 可选浏览器回归：需要开发环境可加载 playwright，并已安装新版 Edge。
// node tests/ui-smoke.cjs；截图、下载与报告写入 tests/evidence/refactor/（不进交付包）。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const XLSX = require('../vendor/xlsx.full.min.js');
const root = path.resolve(__dirname, '..');
const out = path.resolve(process.env.RECON_EVIDENCE || path.join(__dirname, 'evidence/refactor'));
fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const errors = [];
  const checks = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('dialog', dialog => dialog.accept());
  async function check(name, predicate) {
    assert.ok(await predicate(), name);
    checks.push(name);
  }
  async function shot(name) {
    await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: false });
  }
  async function download(selector, name) {
    const pending = page.waitForEvent('download');
    await page.locator(selector).click();
    const item = await pending;
    const target = path.join(out, name);
    await item.saveAs(target);
    assert.equal(await item.failure(), null);
    checks.push(`download ${name}`);
    return target;
  }
  try {
    await page.goto(process.env.RECON_TEST_URL || pathToFileURL(path.join(root, 'index.html')).href);
    await check('file version', async () => await page.locator('#appVersion').textContent() === fs.readFileSync(path.join(root, 'version.txt'), 'utf8').trim());
    await page.locator('#sampleRunBtn').click();
    await page.waitForFunction(() => state.records.length === 15);
    await check('sample totals', () => page.evaluate(() => state.groups.length === 6 && state.stats.netRecvCents === 19720000 && state.stats.netPayCents === 5000000));
    const fingerprint = await page.evaluate(() => buildResultFingerprint(state.groups));
    await page.locator('#resultSection').scrollIntoViewIfNeeded();
    await shot('sample');

    await page.locator('button[data-facet="dir"][data-value="recv"]').click();
    await check('facet filters screen only', () => page.evaluate(() => getVisibleGroups().every(g => g.netCents > 0) && state.records.length === 15 && buildResultFingerprint(state.groups) === document.querySelector('[data-fp-copy]').dataset.fpCopy));
    await page.locator('[data-facet-clear]').click();
    await page.locator('#searchInput').fill('华信');
    await page.waitForFunction(() => state.search === '华信');
    await check('search', () => page.evaluate(() => getVisibleGroups().length === 1));
    await page.locator('#searchInput').fill('');
    await page.waitForFunction(() => state.search === '');
    await page.locator('#sortSelect').selectOption('name');
    await page.locator('button.detail-btn').first().click();
    const decision = page.locator('button[data-pair-decision="accepted"]').first();
    // 示例的第一家未必有配对；选择确实有配对的企业展开。
    if (!(await decision.count())) {
      const idx = await page.evaluate(() => state.groups.find(g => g.pairings.length).idx);
      await page.locator(`button.detail-btn[data-idx="${idx}"]`).click();
    }
    await page.locator('button[data-pair-decision="accepted"]').first().click();
    await check('pair decision', () => page.evaluate(() => state.groups.some(g => g.pairings.some(p => p.decision === 'accepted'))));
    await page.locator('#undoBtn').click();
    await check('undo decision restores fingerprint', () => page.evaluate(expected => buildResultFingerprint(state.groups) === expected, fingerprint));
    const note = page.locator('textarea[data-note-key]').first();
    await note.fill('浏览器回归差异说明');
    await check('note preserves fingerprint', () => page.evaluate(expected => buildResultFingerprint(state.groups) === expected, fingerprint));
    await page.locator('#undoBtn').click();
    await check('undo note', () => page.evaluate(() => !Array.from(state.groupNotes.values()).some(Boolean)));
    await page.locator('#signoffIndex').fill('REFACTOR-QA');
    await check('signoff', () => page.evaluate(() => state.signoff.index === 'REFACTOR-QA'));
    await page.locator('#dataCheckBtn').click();
    await check('data check toggle', () => page.evaluate(() => state.dataCheckOpen));
    await page.evaluate(() => { window.__prints = 0; window.print = () => { window.__prints++; }; });
    await page.locator('#printBtn').click();
    await check('print', () => page.evaluate(() => window.__prints === 1 && state.printing));
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await check('print cleanup', () => page.evaluate(() => !state.printing));

    const exported = await download('#exportBtn', 'standard.xlsx');
    const workbook = XLSX.read(fs.readFileSync(exported), { type: 'buffer' });
    await check('export sheet contents', () => workbook.SheetNames.includes('对账说明') && XLSX.utils.sheet_to_json(workbook.Sheets['对账汇总']).length === 6);
    await download('#exportBlocksBtn', 'blocks.xlsx');
    const snapshot = await download('#saveSnapshotBtn', 'snapshot.json');
    await page.evaluate(() => clearSnapshot());
    await page.locator('#snapshotInput').setInputFiles(snapshot);
    await page.waitForFunction(() => snapshotBaseline !== null);
    await check('snapshot imported', () => page.evaluate(() => snapshotBaseline !== null));
    await download('[data-er-archive]', 'archive.zip');

    await page.locator('#reimportBtn').click();
    await page.locator('#fileInput').setInputFiles(path.join(__dirname, 'fixtures/pairing-percent.xlsx'));
    await page.waitForFunction(() => state.sources.length === 2);
    await check('excel default selection', () => page.evaluate(() => state.sources.every(s => !s.included)));
    await page.locator('#sourceSearch').fill('应付');
    await page.waitForFunction(() => state.sourceFilter === '应付');
    await page.locator('#sourceSelectAll').click();
    await check('select filtered sources only', () => page.evaluate(() => state.sources.filter(s => s.included).length === 1));
    await page.locator('#sourceSearch').press('Escape');
    await page.locator('#sourceSelectAll').click();
    await page.locator('#runBtn').click();
    await page.waitForFunction(() => state.records.length === 8);
    const net = await page.evaluate(() => state.groups.map(g => g.netCents));
    await page.locator('#pairPercent').fill('1');
    await page.locator('#pairPercent').press('Tab');
    await check('percent change', () => page.evaluate(() => state.pairResult.pairCount === 3));
    assert.deepEqual(await page.evaluate(() => state.groups.map(g => g.netCents)), net);
    checks.push('percent preserves net amounts');
    await page.locator('#undoBtn').click();
    await check('undo percent', () => page.evaluate(() => state.pairPercent === 0 && state.pairResult.pairCount === 1));
    await page.locator('#resultSection').scrollIntoViewIfNeeded();
    await shot('excel');
    await page.setViewportSize({ width: 390, height: 844 });
    await check('mobile root width', () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    await shot('mobile');

    await page.locator('#reimportBtn').click();
    await page.locator('[data-mode="manual"]').click();
    await page.locator('#manualRecv').fill('甲公司\t100\n乙公司\t-20');
    await page.locator('#manualPay').fill('甲公司\t80');
    await page.locator('#manualRunBtn').click();
    await page.waitForFunction(() => state.runInfo && state.runInfo.mode === 'manual');
    await check('manual reconciliation', () => page.evaluate(() => state.records.length === 3 && state.reclassRows.length === 1 && state.stats.netRecvCents === 2000 && state.stats.netPayCents === 2000));
    await page.locator('#resultSection').scrollIntoViewIfNeeded();
    await shot('manual');
    await check('no browser errors', () => errors.length === 0);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ ok: true, checks, errors }, null, 2));
    console.log(`UI_SMOKE PASS checks=${checks.length} errors=${errors.length}`);
  } catch (error) {
    await shot('failure');
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ ok: false, checks, errors, failure: error.stack }, null, 2));
    throw error;
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
