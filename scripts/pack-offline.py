"""生成原有离线压缩包，并逐项核对源码字节。"""
import hashlib
from pathlib import Path
import sys
import zipfile

root = Path(__file__).resolve().parent.parent
target = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'release' / '审计双边对账工具.zip'
items = [
    'index.html', 'assets/app.js', 'assets/styles.css', 'assets/favicon.svg',
    'vendor/xlsx.full.min.js', '打开对账工具.bat', 'serve.ps1',
    'version.txt', '更新说明.txt', '第三方许可.txt',
]
target.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in items:
        assert (root / name).stat().st_size > 0, name
        archive.write(root / name, name)
with zipfile.ZipFile(target) as archive:
    assert archive.namelist() == items
    assert archive.testzip() is None
    for name in items:
        assert archive.read(name) == (root / name).read_bytes(), name
print('OFFLINE_ZIP_PASS', len(items), hashlib.sha256(target.read_bytes()).hexdigest())
print(target)
