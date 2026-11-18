# 黄金回归测试（不依赖 Electron / 浏览器）

这套测试只用 Node 和本地 `vendor/xlsx.full.min.js`，把 `assets/app.js` 装进 `vm` 里跑真实的导入 → 认列（含主体／币种）→ 解析 → 归并 → 核对 → 配对（含日期就近）→ 并归 → 账龄（含档位切换）→ 摘要线索 → 单据号归一 → 导出 → 分企业导出，结果与 `tests/golden/` 下的黄金文件逐字段比对。

`tests/` **不进交付 zip**：打包脚本 `scripts/pack-offline.py` 是白名单，只打 10 个交付文件，并逐字节核对。

## 怎么跑

```bash
# 本机有 Node（18 以上）
node tests/run-golden.cjs

# 本机没有 node 在 PATH 里（本项目开发机的常见情况）
cd "D:/审计双边对账工具"
ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/run-golden.cjs

# 只跑某几个夹具
node tests/run-golden.cjs red-font-negative.xlsx pairing-demo.xlsx
```

退出码：`0` 全过，`1` 有失败，`2` 找不到夹具。

## 一条命令跑完全部回归

```bash
ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/run-all.cjs
node tests/run-all.cjs --verbose          # 同时把每个套件的原始输出打出来
node tests/run-all.cjs --only source-list # 只跑名字里含这段的套件
```

`run-all.cjs` 用 `process.execPath` 起子进程（所以有没有 node 在 PATH 都能跑，4 个一批并行），只认每个套件自己打的汇总行 `failures=… total=…`，并把 `total` 和脚本里写死的期望断言数比对：

- 有断言失败 → `FAIL`；
- **断言数比期望少 → `SHRUNK`**（有人删掉一条断言而结果仍然全绿，这种情况只有这条能抓到）；
- 汇总行没打出来 / 子进程异常退出 → `ERROR`。

末行 `RUN_ALL PASS` 或 `RUN_ALL FAIL`，退出码 0 / 1。逐套件的耗时与失败明细写在 `%TEMP%\recon-test-reports\run-all.json`，控制台只留 ASCII 摘要（GBK 终端打中文会乱码）。

当前基线：**19 个套件、849 条断言全绿，约 20 秒**（黄金 27 项 + 名称相近 55 + 配对 77 + 快照 83 + 校验码 61 + 归档 69 + 差一点 48 + 其余专项）。

## 覆盖了什么

- **27 项 = 25 个夹具（24 个 .xlsx + 1 个 .csv）+ 手动粘贴 + 内置示例**。夹具覆盖：普通两表、合并单元格承上、方向补齐、标题/文件名推断方向、负数重分类、文本负数、红字转负、脏表头与辅助列、取数范围（同表多段）、数字格式认金额、人名/欠款人列、配对演示与压力表、比例容差（`pairing-percent.xlsx`）、名称相近与同单据号（`similar-and-docs.xlsx`）、**账龄档位（`aging.xlsx`，基准日固定为 2026-10-31、默认按年四档）**、**摘要里的合同/项目/部门线索（`memokey.xlsx`）**、**日期窗口（`date-window.xlsx`：同额多笔按日期就近、远日期提醒、合同号不当日期）**、**多主体多币种（`multi-dimension.xlsx`：主体/币种自动认列、留空承上、9 笔 4 组）**、CSV。
- 每个夹具固定记录：
  - 每个工作表的表头行 / 认出的四列 / 取数范围 / 单位 / 方向来源 / 是否猜的；
  - 每表与合并后的笔数 / 跳过原因 / 重分类 / 红字 / 承上 / 方向补齐 / 范围外 / 净额 / 企业数 / 重点复核家数 / 配对组数 / `docHintGroups` / `mergeGroups`；
  - **取数完整性核对**（`control`）：逐表 + 合计的 `raw / included / skipped / outside / unmatched` 五个金额与格数、`diff`、`unmatchedRows`、`missingRecordRows`、`ok`；
  - **疑似同一企业**（`similar`）：条数、按档计数（`core` / `region` / `similar`）、逐条明细；
  - **人工并归探针**（`mergeProbe`）：并归前后企业数、并归后那一家的笔数/净额/并入 key 数/有没有 `merge` 标记、撤销后是否恢复；
  - **同单据号**（`docHints`）：逐条的单据号、两侧行号与金额；
  - **摘要线索**（`memoKeys`）：逐条的「类型 / 摘要里写的 / 两侧笔数与金额 / 差额 / 行号」，且只收两侧都有的说法；
  - **账龄**（`age` / `ageByGroup`）：当前档位下各档的金额与笔数、原表没写账龄的金额与笔数、超 3 年金额、逐企业的两侧分档；
  - **日期窗口**（`date-window-check.cjs`，35 条断言，单独跑）：日期来源（账龄列 / 摘要）、合同号不当日期、同额多笔按日期就近配对、超过 90 天的提醒标记、导出「日期情况」列与「对账说明」的日期线索行；清空全部日期后配对形状与金额不变；
  - **列设置模板探针**（`profileProbe`）：按表头签名存盘再套回新表，断言套回结果与自动识别一致；再用一份把四列全设成 `-1` 的坏模板，断言模板真的盖过自动识别；
  - 默认容差（1 分）与容差 0 两套配对结果；
  - **导出工作簿每张表的逐行内容**：`对账汇总`、`原始明细`、`核销配对`、`同单据号`、`摘要线索`（后两张只在有提示时才出现）、`账龄分析`（有账龄列时才出现）、`对账说明`；外加 `decisionMarks`（本次打了几个采纳/不采纳标记）；
  - **分企业导出**（`blocks`）：`目录` 与每家一张表的表名、目录逐行（序号/企业/应收/应付/净额/净方向/笔数/工作表）、每张分表的表头三行、两侧小计、底部净额行与差异说明。
- 导出探针会把时间打成 `<导出时间>`，签字信息（索引号/编制人/复核人/复核日期/结论）用写死的固定值，所以**黄金文件不会跨天变红**——不要改成取当天日期。
- 手动粘贴 4 个用例：基础两栏、表头/合计/承上/括号负、制表符与千分位、千元单位；每个用例也跑取数核对与相似建议。
- 内置示例：额外断言 15 笔、承上 5、重分类 1、净应收 ¥197,200、净应付 ¥50,000、已平 1 家。
- 每个夹具的通用不变式（`checkInvariants`）：
  - `应收合计 − 应付合计 = 净应收 − 净应付`；
  - 一条记录不会被两组配对同时使用；配对差额不超过容差；容差 0 时差额必须为 0；配对覆盖金额不超过企业合计；
  - **取数核对恒等式**：逐表与合计的 `diffCents === 0`、`diffCells === 0`、`unmatchedCells === 0`、`missingRecordRows` 为空、`ok === true`；
  - 采纳/不采纳标记最多 2 组（探针只打两个）；
  - 疑似同一企业建议不超过 40 条上限；
  - 并归后企业数恰好少 1 家、撤销后恢复、并归那一家必须带 `merge` 标记；
  - 摘要线索只统计两侧都有记录的说法，且差额 = 应收 − 应付；线索企业数与企业汇总里的 `memoKeyGroups` 一致；
  - 账龄当前档位各档 + 「原表没写」必须等于该侧合计，分档笔数必须覆盖全部记录；
  - **分企业导出**：工作表数 = 企业数 + 1、第一张叫「目录」、表名不为空且不超过 31 字、不重名；目录按净额影响从大到小排；目录合计 = 逐企业合计；每张分表的应收/应付/净额与目录一致、小计之和 = 应收 + 应付、底部净额行与表头一致。

## 专项断言（也放在 tests/ 里，跑法相同）

这些脚本不比对黄金文件，直接用 `vm` 调内部函数做点对点断言，输出末行 `PASS/FAIL`：

| 脚本 | 覆盖 | 断言数 |
|---|---|---|
| `tests/similar-pairs-check.cjs` | 名称相近建议「结果不变 + 变快」：与每对现算的参照实现逐条比对、上界剪枝、40 条截断、八百家耗时 | 55 |
| `tests/pair-check.cjs` | 配对引擎：一对一／子集和、每行只被一组消费、容差与比例上限、时间预算与压力规模 | 77 |
| `tests/snapshot-check.cjs` | 底稿快照：格式与自校验、篡改拒绝、六种变化种类、并归旧名并进、导出表结构与 HTML 转义 | 83 |
| `tests/export-hash-check.cjs` | 导出校验码：SHA-256 向量、字节哈希、收货单、三态渲染、非法码与 32 MB 上限 | 61 |
| `tests/archive-check.cjs` | 归档包：CRC32 向量、store 方法与偏移、UTF-8 标志位、包内 xlsx 哈希等于收货单、无收货单守卫 | 69 |
| `tests/empty-source-check.cjs` | 导入默认零勾选、手动勾选后空表要点名、数据源列表逐行写出认了哪一列 | 33 |
| `tests/credit-negative-check.cjs` | 对账前两问：贷方写负数的门槛与读法、`cellCents` 仍按原表格子里的数、按主体分开只在会少对上时才问 | 95 |
| `tests/import-size-check.cjs` | 导入大小闸门：20 MB 提醒 / 60 MB 拒收、多文件归类、文案说清「怎么办」 | 17 |
| `tests/facet-filter-check.cjs` | 结果页分档筛选（净额／净方向／数据源）：依赖式计数、与搜索 chip 叠加、复制与导出跟随筛选、打印戳自证「只列筛出来的 N 家」、金额与企业数不动 | 66 |
| `tests/source-list-limit-check.cjs` | 配置页数据源列表分批：一次画 60 行、当前点开的表必须看得见、全选与参与对账仍看全部 | 39 |
| `tests/near-miss-check.cjs` | 「差一点就能配上」：门槛两处含等号（差 2 分＝容差两倍、差 1 万＝较大方 5%）、只吃配对余料不重复认领、每侧 20 笔上限、UI 8 条截断、导出「差一点」7 列与 `A1:G5`、指纹与所有 `cents` 不动、放宽比例后差一点被真配对吸收 | 48 |
| `tests/date-window-check.cjs` | 日期来源、合同号不当日期、同额多笔按日期就近、远日期提醒、导出日期列与说明 | 35 |
| `tests/normalize-check.cjs` | 摘要编号归一：大小写／空格／连字符／全角、弱编号不合并 | 17 |
| `tests/undo-check.cjs` | 通用撤销：栈深、标签、恢复不改金额、按钮态 | 17 |
| `tests/render-limit-check.cjs` | 分批渲染：首批 100、翻页、显示全部、重置、打印全量 | 11 |
| `tests/age-preset-check.cjs` | 账龄档位：两套边界、切换不改金额、导出表头跟随 | 20 |
| `tests/multi-dimension-check.cjs` | 多主体／多币种：自动认列、承上、分组、币种归一、混币提示、导出与快照 | 69 |
| `tests/browser-support-check.cjs` | 浏览器能力自检：IE、File/FileReader、canvas、PointerEvent | 10 |

`pair-check` / `snapshot-check` / `export-hash-check` / `archive-check` / `similar-pairs-check` 的报告与临时产物统一写到 `%TEMP%\recon-test-reports\`，**不在仓库里留生成物**。这几个套件不含任何真实底稿数据，可以随仓库走。

## 黄金文件怎么维护

`tests/golden/*.json` 是当前口径的定格快照。改动业务口径后：

```bash
node tests/run-golden.cjs --update
```

然后**人工看一遍 diff**：只应该出现你这次想改的字段。确认后再提交。`--update` 也会重写 `__manual__.json` 和 `__sample__.json`。

新增夹具只要在 `tests/fixtures/` 放文件、跑一次 `--update` 生成同名 `.json` 并人工核对，**不需要改 `run-golden.cjs`**；`tests/make-fixtures-similar.cjs`、`tests/make-fixtures-aging.cjs`、`tests/make-fixtures-memokey.cjs`、`tests/make-fixtures-percent.cjs`、`tests/make-fixtures-date-window.cjs`、`tests/make-fixtures-multi-dimension.cjs` 分别是本机生成 `similar-and-docs.xlsx`、`aging.xlsx`、`memokey.xlsx`、`pairing-percent.xlsx`、`date-window.xlsx`、`multi-dimension.xlsx` 的脚本，留作参考（夹具本身已入库）。`multi-dimension.xlsx` 里第 2 行主体与币种留空，用来验证承上；改这张夹具前先看 `tests/multi-dimension-check.cjs` 对列位与金额的断言。

夹具都是编造的企业名和金额，可以放心进版本库；不要往这里放真实底稿。

## 不覆盖什么

框选（canvas 拖框 / 预览表）、打印样式与 PDF、布局、剪贴板、真窗口交互需要真实坐标和窗口，见 `AGENTS.md` §8.3 的 Electron QA 脚本（`recon-qa6/7/8/9.cjs`）。这套黄金测试只保证计算口径和导出内容不漂移。
