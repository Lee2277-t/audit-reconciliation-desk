// 可选：用 Playwright 验收实际打包后的 Windows 程序。
const { _electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = path.join(__dirname, 'evidence/distribution-desktop');
fs.mkdirSync(out, { recursive: true });
(async () => {
  const app = await _electron.launch({ executablePath: path.join(root, 'release/win-unpacked/audit-recon.exe') });
  const checks = [];
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('#sampleRunBtn');
    assert.equal(await page.evaluate(() => typeof require), 'undefined');
    checks.push('renderer has no Node.js access');
    const prefs = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.ok(prefs.sandbox && prefs.contextIsolation && !prefs.nodeIntegration);
    checks.push('renderer isolation');
    await page.locator('#sampleRunBtn').click();
    await page.waitForFunction(() => state.records.length === 15);
    assert.ok(await page.evaluate(() => state.groups.length === 6 && state.stats.netRecvCents === 19720000 && state.stats.netPayCents === 5000000));
    checks.push('sample accounting totals');
    const target = path.join(out, 'desktop-export.xlsx');
    fs.rmSync(target, { force: true });
    await app.evaluate(({ BrowserWindow }, target) => {
      BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => item.setSavePath(target));
    }, target);
    await page.locator('#exportBtn').click();
    await page.waitForFunction(() => !!lastExportReceipt);
    for (let attempt = 0; attempt < 100 && !fs.existsSync(target); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(fs.statSync(target).size > 1000);
    checks.push('Excel export from packaged application');
    assert.ok(await app.evaluate(async ({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      try { await wc.session.fetch('https://example.com'); return false; } catch { return true; }
    }));
    checks.push('desktop session blocks external requests');
    assert.ok(await page.evaluate(() => hasWorkInProgress()));
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.listenerCount('will-prevent-unload')), 1);
    checks.push('unsaved work detection and native close handler installed');
    await page.screenshot({ path: path.join(out, 'packaged-app.png') });
    fs.writeFileSync(path.join(out, 'desktop-report.json'), JSON.stringify({ status: 'PASS', checks }, null, 2));
    console.log(JSON.stringify({ status: 'PASS', checks }));
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
