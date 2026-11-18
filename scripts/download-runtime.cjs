// 构建机的可选镜像下载；始终核对 SHASUMS256，不改变应用网络策略。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').devDependencies.electron;
const name = `electron-v${version}-win32-x64.zip`;
const mirror = process.env.ELECTRON_MIRROR || 'https://github.com/electron/electron/releases/download/';
const base = mirror.includes('github.com') ? `${mirror}v${version}/` : `${mirror}${version}/`;
const directory = path.join(root, '.build-cache');
fs.mkdirSync(directory, { recursive: true });
(async () => {
  const sumsResponse = await fetch(base + 'SHASUMS256.txt', { signal: AbortSignal.timeout(30000) });
  if (!sumsResponse.ok) throw new Error(`Checksum download failed: ${sumsResponse.status}`);
  const sums = await sumsResponse.text();
  const line = sums.split('\n').find(row => row.trim().endsWith(name));
  if (!line || !/^[a-f0-9]{64}\s/i.test(line)) throw new Error('No matching SHA-256 checksum');
  const expected = line.slice(0, 64).toLowerCase();
  const target = path.join(directory, name);
  const response = await fetch(base + name, { signal: AbortSignal.timeout(240000) });
  if (!response.ok) throw new Error(`Runtime download failed: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(target));
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
  if (hash.digest('hex') !== expected) throw new Error('Runtime checksum mismatch');
  console.log(`RUNTIME_VERIFIED ${target}`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
