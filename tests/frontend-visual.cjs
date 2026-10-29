// 可选视觉验收：本机 Playwright + Edge；截图留在 tests/evidence，不进入交付包。
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const phase = process.env.RECON_VISUAL_PHASE || 'after';
const out = path.join(__dirname, 'evidence/frontend-craft', phase);
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const checks = [];
  const errors = [];
  try {
    for (const width of [1280, 800, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      page.on('dialog', dialog => dialog.accept());
      await page.goto(process.env.RECON_TEST_URL || pathToFileURL(path.join(root, 'index.html')).href);
      async function capture(name, selector) {
        await page.locator(selector).scrollIntoViewIfNeeded();
        if (name === 'landing') await page.evaluate(() => window.scrollTo(0, 0));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width} ${name}: 页面不应横向溢出`);
        await page.screenshot({ path: path.join(out, `${width}-${name}.png`) });
        checks.push(`${width} ${name}: no page overflow`);
      }
      await capture('landing', '.hero');
      await page.locator('[data-mode="manual"]').click();
      await capture('manual', '#manualPanel');
      await page.locator('[data-mode="excel"]').click();
      await page.locator('#fileInput').setInputFiles(path.join(__dirname, 'fixtures/sample-two-sheets.xlsx'));
      await page.waitForFunction(() => state.sources.length === 2);
      await capture('config', '#configSection');
      if (phase !== 'before') {
        const panel = await page.locator('.source-panel').boundingBox();
        for (const selector of ['#sourceSelectAll', '#sourceSelectNone']) {
          const button = await page.locator(selector).boundingBox();
          assert.ok(button.x >= panel.x && button.x + button.width <= panel.x + panel.width, '工作表全选按钮不能被裁掉');
        }
        checks.push(`${width} source selection controls visible`);
      }
      await page.locator('#sourceSelectAll').click();
      await page.locator('#runBtn').click();
      await page.waitForFunction(() => state.groups.length > 0);
      await capture('result', '#resultSection');
      await capture('filters', '.result-toolbar');
      await page.locator('#searchInput').fill('找不到的企业名称');
      await page.waitForFunction(() => getVisibleGroups().length === 0);
      await capture('empty', '.table-card');
      await page.locator('#searchInput').fill('');
      if (phase !== 'before') {
        await page.locator('#searchInput').focus();
        assert.ok(await page.locator('#searchInput').evaluate(el => getComputedStyle(el).outlineStyle !== 'none'));
        checks.push(`${width} visible keyboard focus`);
        if (width === 390) {
          assert.ok(await page.locator('select:visible, textarea:visible, input:not([type="checkbox"]):not([type="file"]):visible').evaluateAll(elements => elements.every(el => parseFloat(getComputedStyle(el).fontSize) >= 16)), '手机输入控件避免因字号过小被自动放大');
          const targets = await page.locator('.result-actions .btn, .mode-tab').evaluateAll(elements => elements.filter(el => el.getClientRects().length).every(el => el.getBoundingClientRect().height >= 44));
          assert.ok(targets, '手机主要按钮触摸高度至少 44px');
          checks.push('mobile inputs and primary touch targets');
        }
        if (width <= 800) {
          const company = page.locator('.group-row > td:first-child').first();
          const before = (await company.boundingBox()).x;
          await page.locator('.table-scroll-main').evaluate(el => { el.scrollLeft = 420; });
          assert.ok(Math.abs((await company.boundingBox()).x - before) <= 1, '横向查看金额时仍能看到企业名称');
          await capture('table-scroll', '.table-card');
          checks.push(`${width} company column stays visible`);
        }
        const pulse = await page.locator('.pulse').evaluate(el => getComputedStyle(el).animationDuration);
        assert.ok(pulse === '0s' || parseFloat(pulse) <= 0.01);
        checks.push(`${width} reduced motion`);
        if (width === 1280) {
          await page.emulateMedia({ media: 'print' });
          assert.equal(await page.locator('.topbar').isVisible(), false);
          assert.equal(await page.locator('.skip-link').isVisible(), false);
          assert.equal(await page.locator('.recon-table').isVisible(), true);
          await page.pdf({ path: path.join(out, 'print.pdf'), format: 'A4', printBackground: true });
          checks.push('print hides navigation and keeps report table');
        }
      }
      await page.close();
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ status: 'PASS', checks, errors }, null, 2));
    console.log(`FRONTEND_VISUAL PASS checks=${checks.length} errors=0`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
