const fs = require('node:fs');
const path = require('node:path');
const { root, copyApp } = require('./release-files.cjs');
const destination = path.join(root, 'web-dist');
copyApp(destination);
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'release-downloads.json'), 'utf8'));
function escape(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function downloadLink(item) {
  const url = new URL(item.url);
  if (url.protocol !== 'https:') throw new Error('安装包地址必须使用 HTTPS');
  return `<a href="${escape(url.href)}" rel="noreferrer">${escape(item.label || '下载安装包')}</a>`;
}
const choices = catalog.map(item => {
  let link = '<span class="distribution-status">安装包下载地址待发布</span>';
  if (item.url) {
    link = [item, ...(item.alternatives || [])].map(downloadLink).join('<br>');
  }
  return `<article class="distribution-option"><h3>${escape(item.name)}</h3><p>${escape(item.support)}</p>${link}</article>`;
}).join('\n');
const htmlPath = path.join(destination, 'index.html');
fs.writeFileSync(htmlPath, fs.readFileSync(htmlPath, 'utf8')
  .replace('<section hidden class="distribution-card"', '<section class="distribution-card"')
  .replace('<!-- DESKTOP_DOWNLOADS -->', choices));
// 静态托管平台可识别的安全响应头；浏览器同时受页面 meta CSP 约束。
fs.writeFileSync(path.join(destination, '_headers'), '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n');
console.log(`WEB_READY ${destination}`);
