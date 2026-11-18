const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const files = ['index.html', 'assets/app.js', 'assets/styles.css', 'assets/favicon.svg', 'vendor/xlsx.full.min.js', 'version.txt', '更新说明.txt', '第三方许可.txt'];

function copyApp(destination) {
  const version = fs.readFileSync(path.join(root, 'version.txt'), 'utf8').trim();
  for (const name of files) {
    const source = path.join(root, name);
    const target = path.join(destination, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (name === 'index.html') {
      let html = fs.readFileSync(source, 'utf8').replaceAll('__APP_VERSION__', version);
      fs.writeFileSync(target, html);
    } else fs.copyFileSync(source, target);
  }
}
module.exports = { root, files, copyApp };
