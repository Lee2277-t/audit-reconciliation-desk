# 网页版与三系统软件版

## 共用逻辑

根目录的 `index.html`、`assets/`、`vendor/` 是唯一应用源文件。网页和桌面版都通过 `scripts/release-files.cjs` 白名单复制这些文件，不另外实现对账逻辑。表格与结果不上传；网页版只需下载页面资源。桌面窗口禁止外部网络请求、页面跳转和弹出新窗口，渲染页面没有 Node.js 权限。没有自动更新和底稿持久化。

## 本地开发与打包

安装 Node.js 22 或更新版及 pnpm 11.25.0，然后执行：

```text
pnpm install --frozen-lockfile
pnpm test
pnpm build:web
pnpm start
```

`web-dist/` 可直接部署到任意 HTTPS 静态托管；只上传这个目录，不能上传整个项目。`node scripts/preview-web.cjs` 提供只监听本机的网页预览。

```text
pnpm dist:win
pnpm dist:mac
pnpm dist:linux
```

安装包位于 `release/`。原有离线 ZIP 用 `python scripts/pack-offline.py` 生成并自动核对文件一致性，也可额外传入输出路径。应在对应系统打包；macOS 的签名和公证必须在 macOS 环境完成。不要把 Windows 成功构建视为其他系统已经验证。

| 系统 | 构建目标 | 兼容范围 |
|---|---|---|
| Windows | x64、ARM64；安装程序、免安装 exe | Windows 10 / 11 |
| macOS | Intel x64、Apple Silicon ARM64；dmg、zip | macOS 13 及以上 |
| Linux | x64、ARM64；AppImage、deb | 仍受 Chromium 和发行版维护的系统 |
| 手机 | 网页 | 新版 Safari / Chrome，表格较大时建议电脑 |

以上是固定使用的 Electron 45 的目标范围，实测结果应单独记录。Linux 还受 glibc、图形环境及系统依赖影响，不承诺所有发行版。旧 Windows、旧 macOS 不通过捆绑过期 Electron 扩大兼容范围。

## GitHub 发布

`.github/workflows/release.yml` 在 `main` 推送、`v*` 标签推送或手动触发时，分别在 Windows、macOS、Linux runner 构建两种架构，先跑同一套回归，再收集安装包。六种构建全部成功后，自动发布到 GitHub Releases 的预发布版本。当前流程生成未签名安装包，不代表通过 Apple 公证或 Windows 可信发布验证。面向用户正式分发前，应接入开发者自己的签名凭据；凭据仅存 GitHub Secrets，不写进源码。

`release-downloads.json` 维护网页上的三个系统下载地址；没有真实安装包时保持 `url: null`，页面明确显示尚未发布，不能填不存在的地址。可填写对应 GitHub Release 页面或稳定的 HTTPS 下载链接。修改后重新 `pnpm build:web` 并发布网页。

本项目只包含工具代码与合成测试数据。任何真实审计底稿、导出的业务结果、账号凭据均不得上传仓库。`node_modules/`、`release/`、测试证据和构建目录已列入 `.gitignore`。

## Sites

本站身份保存在 `sites/audit-recon/.openai/hosting.json`。Sites 仓库只同步经过白名单构建的 `dist/` 与托管配置。本站已按用户明确授权改为公开访问，持有链接的人可以使用；导入的表格仍只留在访问者设备内。不要将桌面安装包塞进静态网页资源，使用 GitHub Releases 承载。

## 验收

`node tests/run-all.cjs` 检查对账口径。`tests/ui-smoke.cjs` 需要开发环境中的 Playwright 和 Edge，设置 `RECON_TEST_URL` 可检查本机网页，设置 `RECON_EVIDENCE` 可指定证据目录。桌面还需检查实际打包后的应用启动、导入、下载、断网运行、退出提醒以及系统权限边界。
