# 双边对账核销工具

**应收、应付逐家核对净额。** 把两边的账放进来，按企业算出净额，再逐家看差异、导出底稿。

数据全部在本机计算：**不上传、不联网**，关掉页面就不留底稿。表格和结果不经过任何服务器。

- 网页版：双击 `index.html` 即用，手机浏览器也能开
- 桌面版：Electron 打包的 Windows / macOS / Linux 应用，断网可对账
- 一套代码，两种形态，对账口径完全一致

> 这是一个辅助核对工具，只做归并和提示，**不能替代审计程序，也不作为审计证据**；结论以人工复核和原始凭证为准。

---

## 它做什么

| 能力 | 说明 |
|---|---|
| 导入 | 拖入 Excel，或直接从 Excel 复制「企业名称 + 金额」两列粘贴；可一次选两个文件 |
| 方向识别 | 工作表名/文件名含「应收账款 / 应付账款」即可识别；有「应收/应付」列也可以直接选；没有就整表按一个方向 |
| 多表处理 | 一个工作簿里的多张表可一起导入，默认一张都不勾，自己决定核对哪几张 |
| 容差核销 | 按企业归并，差额在容差内自动配上；配不上的会列出「差一点就能配上」的候选并给出建议容差 |
| 净额与筛选 | 每家算应收合计、应付合计、净额（大减小）；可按净额档位、净方向、单表筛选 |
| 账龄 / 币种 / 主体 | 可选按账龄分档统计；多币种分开算不做汇率换算；多主体按主体分开算 |
| 导出 | 导出 Excel 底稿（含「对账说明」页）；可打印/存 PDF；支持仅导出筛选结果 |
| 底稿快照 | 存一次结果，下次改完再比，逐条列出变化 |
| 导出校验码 | 按文件字节算校验码，之后可核对是不是同一份导出 |

**净额只是排序和准备函证用的差值，不代表两笔可以抵销。** 账上要不要抵销，取决于合同里有没有抵销权、报表怎么列报。明细里的「自动核销」也只是提示，点「采纳」不会改动任何金额。

支持的金额写法：数字、文本金额、千分位、括号负数；单位可选元 / 千元 / 万元；负数会取绝对值并改记到对立方向；红字（正数但标红）按负数处理，明细里标「红字转负」。

浏览器要求：新版 Edge / Chrome / Firefox / Safari，IE 不支持。页面里有「检查运行环境」，会逐项说明缺什么。

## 三种用法

### 1. 网页版（最省事）

下载本仓库，**保持 `index.html`、`assets/`、`vendor/` 在同一层目录**，双击 `index.html`。

如果公司电脑限制安装软件，用这个。

### 2. 桌面版（断网可用）

从 [Releases](../../releases) 下载对应系统的安装包；没有安装包时也可以自己构建：

```bash
pnpm install --frozen-lockfile
pnpm start          # 开发态启动
pnpm dist:win       # 或 dist:mac / dist:linux
```

产物在 `release/`。Windows 的 `打开对账工具.bat` 也可以直接拉起本地服务。

### 3. 开发

```bash
pnpm install --frozen-lockfile
pnpm test           # 对账口径回归
pnpm build:web      # 生成 web-dist/
pnpm start          # Electron
```

需要 Node.js 22+ 与 pnpm 11.25.0。

## 项目结构

```text
index.html          应用本体（单页，无框架）
assets/             app.js / styles.css / favicon
vendor/             xlsx.full.min.js（离线 Excel 解析）
desktop/            Electron 主进程
scripts/            构建、打包、预览
tests/              对账口径回归与合成夹具
web-dist/           构建产物（不入库，pnpm build:web 生成）
release/            安装包（不入库）
```

`index.html` + `assets/` + `vendor/` 是唯一应用源文件，网页版和桌面版都通过 `scripts/release-files.cjs` 白名单复制，不另外实现一套对账逻辑。

## 测试

```bash
pnpm test           # = node tests/run-all.cjs
```

回归用例覆盖：账龄预设、归档、浏览器支持、贷方负数、日期窗口、桌面冒烟、空源表、导出哈希、facet 筛选、导入规模、多维度、近似匹配、规范化、配对、渲染上限、快照、源表数量上限、UI 冒烟、撤销等。`tests/fixtures/` 里的夹具全部是合成数据。

详见 [`tests/README.md`](tests/README.md)。

## 隐私与数据边界

- 所有计算在浏览器/本机完成，**没有后端服务**，页面不发起外部请求
- 关闭页面即丢弃数据；要留档请先导出的 Excel
- 桌面窗口禁止外部网络请求、页面跳转和新窗口，渲染进程没有 Node.js 权限
- 没有自动更新，也没有底稿持久化
- 仓库里只有工具代码与合成测试数据；**任何真实底稿、业务结果、账号凭据都不应提交**

打包与分发细节见 [`DISTRIBUTION.md`](DISTRIBUTION.md)。

## 系统支持

| 系统 | 构建目标 | 兼容范围 |
|---|---|---|
| Windows | x64 / ARM64；安装程序、免安装 exe | Windows 10 / 11 |
| macOS | Intel x64 / Apple Silicon；dmg、zip | macOS 13+ |
| Linux | x64 / ARM64；AppImage、deb | 仍受 Chromium 与发行版维护的系统 |
| 手机 | 网页 | 新版 Safari / Chrome，表格大时建议用电脑 |

兼容范围来自 Electron 45 的固定目标，实测结果另行记录。构建应在对应系统上进行；macOS 的签名与公证必须在 macOS 完成。

## 许可

MIT，见 [LICENSE](LICENSE)。第三方组件许可见 [第三方许可.txt](第三方许可.txt)。

---

## English

**Bilateral reconciliation for receivables and payables.** Import two ledgers, match them per counterparty, and review the net difference — all computed locally in the browser.

- No upload, no network requests, no server. Closing the page discards the data.
- Runs as a single-page web app (`index.html`, no framework) and as an Electron desktop app on Windows, macOS and Linux.
- Excel import by drag-and-drop or pasted columns; automatic direction detection; per-sheet selection; tolerance-based write-off with near-miss suggestions; net amount, aging buckets, multi-currency and multi-entity handling; Excel/PDF export with an audit-trail sheet; result snapshots and export checksums.

The net amount is a difference for prioritising and preparing confirmations — **it does not mean the two balances may be offset**; that depends on contracts and reporting policy. The tool only aggregates and flags; it is not a substitute for audit procedures or audit evidence.

**Quick start:** open `index.html` (keep `assets/` and `vendor/` beside it), or `pnpm install --frozen-lockfile && pnpm start` for the desktop app; `pnpm test` runs the reconciliation regression suite.

MIT licensed. Bundled third-party notices are in `第三方许可.txt`.
