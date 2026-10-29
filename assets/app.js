// 代码导航与重构验证见开发文档 REFACTORING.md；本文件保持普通脚本，兼容 file://。
'use strict';

const FLAG_DEFS = {
  sameDup: {
    label: '同向重复',
    tone: 'red',
    title: '同一方向、同一金额出现两次及以上，建议核对是否重复入账'
  },
  variant: {
    label: '名称不一',
    tone: 'blue',
    title: '归一后为同一企业，但原始名称写法不同，已合并展示'
  },
  merge: {
    label: '已人工并归',
    tone: 'teal',
    title: '名称写法不同，经人工确认是同一家企业后合并到了一起'
  },
  equal: {
    label: '同额对冲',
    tone: 'green',
    title: '同一企业存在金额相同的应收与应付记录'
  },
  single: {
    label: '单边记录',
    tone: 'amber',
    title: '只有应收或只有应付，没有另一方对冲'
  },
  dup: {
    label: '重复企业',
    tone: 'neutral',
    title: '同一企业出现多笔记录，已自动合并汇总'
  },
  reclass: {
    label: '负数重分类',
    tone: 'amber',
    title: '原表金额为负数，已按绝对值改记到对立方向（应收↔应付），请复核'
  },
  pair: {
    label: '可自动核销',
    tone: 'teal',
    title: '该企业内已找到逐笔可对冲的应收与应付组合，展开可见配对明细'
  },
  zero: {
    label: '金额为 0',
    tone: 'neutral',
    title: '金额为 0 的记录'
  },
  ageLong: {
    label: '账龄超 3 年',
    tone: 'amber',
    title: '有挂账超过 3 年的记录，一般要单独说明还能不能收回来、要不要提坏账'
  }
};

const CHIP_DEFS = [
  { id: 'all', label: '全部企业', match: () => true },
  { id: 'key', label: '重点复核', match: (g) => g.keyReview },
  { id: 'dup', label: '重复企业', match: (g) => g.rows.length > 1 },
  { id: 'equal', label: '同额对冲', match: (g) => g.equalPair },
  { id: 'sameDup', label: '同向重复', match: (g) => g.sameDirDup },
  { id: 'single', label: '单边记录', match: (g) => !(g.hasRecv && g.hasPay) },
  { id: 'reclass', label: '负数重分类', match: (g) => g.hasReclass },
  { id: 'pair', label: '可自动核销', match: (g) => g.canPair },
  { id: 'doc', label: '同单据号', match: (g) => g.hasDocHint },
  { id: 'memoKey', label: '摘要里有相同线索', match: (g) => g.hasMemoKey },
  { id: 'nearMiss', label: '差一点就能配上', match: (g) => g.hasNearMiss },
  { id: 'variant', label: '名称不一', match: (g) => g.variantList.length > 1 },
  { id: 'ageLong', label: '账龄超 3 年', match: (g) => g.ageLong },
  { id: 'merge', label: '已人工并归', match: (g) => g.manualMerge }
];

// 结果页的三个「分档筛选」：净额大小 / 净方向 / 数据源。
// 按净额绝对值分档，只为了「先挑大的看」，不改变任何金额，也不参与计算。
const NET_FACETS = [
  { id: 'all', label: '不限', title: '不按净额大小筛', test: () => true },
  { id: 'lt1w', label: '1万以内', title: '净额不到 1 万元', test: (abs) => abs < 1000000 },
  { id: 'lt10w', label: '1万～10万', title: '净额 1 万到 10 万元之间', test: (abs) => abs >= 1000000 && abs < 10000000 },
  { id: 'lt100w', label: '10万～100万', title: '净额 10 万到 100 万元之间', test: (abs) => abs >= 10000000 && abs < 100000000 },
  { id: 'ge100w', label: '100万以上', title: '净额 100 万元及以上', test: (abs) => abs >= 100000000 }
];

const DIR_FACETS = [
  { id: 'all', label: '不限', title: '不按净方向筛', test: () => true },
  { id: 'recv', label: '净应收', title: '应收比应付大的那几家', test: (group) => group.netCents > 0 },
  { id: 'pay', label: '净应付', title: '应付比应收大的那几家', test: (group) => group.netCents < 0 },
  { id: 'even', label: '已平', title: '两边刚好对上、净额为 0 的那几家', test: (group) => group.netCents === 0 }
];

const BENIGN_SKIP_REASONS = new Set(['合计/小计行', '重复表头行', '金额为 -（原表无余额）']);

const FOOTER_ROW_RE = /^(注|备注|说明|以上|上述|本表|本行|填表|制表|编制|复核|审批|签章|负责人|财务主管|第\s*\d+\s*页|页次|共\s*\d+\s*页)/;
const BLOCK_TITLE_RE = /(明细表|明细清单|明细|汇总表|汇总|余额表|清单|底稿|分析表|对账表|测试表|一览表)$/;
const PERSON_LABEL_RE = /欠款人|借款人|出借人|付款方|收款方|交易对手|对手方|往来对象|债务人|债权人|户名|姓名|员工|职工|个人名称/;
const DATEISH_RE = /^\d{4}[-/.年]\d{1,2}([-/.月]\d{1,2}日?)?$/;
const MAX_BLANK_GAP = 5;

// 账龄：底稿常见的「1年以内 / 1-2年 / 2-3年 / 3年以上」四档，或逾期天数、或发生日期推算。
const AGE_BAND_PRESETS = {
  year: {
    label: '按年四档',
    bands: ['1年以内', '1-2年', '2-3年', '3年以上'],
    ends: [12, 24, 36]
  },
  half: {
    label: '半年起五档',
    bands: ['6个月以内', '6-12个月', '1-2年', '2-3年', '3年以上'],
    ends: [6, 12, 24, 36]
  }
};
// 当前分档标签（切换 preset 时原地更新，所有展示都读这一份）
const AGE_BANDS = AGE_BAND_PRESETS.year.bands.slice();
const AGE_LABEL_RE = /账龄|库龄|逾期|超期|挂账时间|欠款时间|发生日期|业务日期|记账日期|入账日期|开票日期|单据日期|交易日期|到期日|截止日|结算日期|起算日/;
const AGE_DATE_RE = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/;
const AGE_BAND_RE = /^(?:逾期|超期|挂账|欠款)?(?<lo>\d+(?:\.\d+)?)(?:\s*[-~～–—到至]\s*(?<hi>\d+(?:\.\d+)?))?年(?<cap>以内|内|以下|以上|起)?$/;
const AGE_RANGE_RE = /^(?:逾期|超期|挂账|账龄|欠款)?(?<lo>\d+(?:\.\d+)?)\s*[-~～–—到至]\s*(?<hi>\d+(?:\.\d+)?)(?<unit>天|日|个月|月|年)(?:以内|内|以上)?$/;
const AGE_SINGLE_RE = /^(?:逾期|超期|挂账|账龄|欠款|其中)?(?<lo>\d+(?:\.\d+)?)(?:\s*(?<unit>天|日|个月|月|年))?(?<cap>以内|内|以下|以上|起)?$/;
const AGE_CN_RE = /^(?<num>[一二两三四五六七八九十半]+)(?<unit>个?月|年|天|日)(?<cap>以内|内|以下|以上|起)?$/;
const AGE_YM_RE = /^(?<y>\d{4})[-/.年](?<mo>\d{1,2})月?$/;
const AGE_NUM_LABEL_RE = /账龄|库龄|逾期|超期|挂账|欠款时间|欠款天数/;

const PAIR_DEFAULT_TOLERANCE_CENTS = 1;
// 比例容差：差额不到较大一方的这个百分比也算近似一致；0 表示不用。
const PAIR_DEFAULT_PERCENT = 0;
const PAIR_MAX_PERCENT = 10;
const PAIR_MAX_SUBSET_SIZE = 12;
const PAIR_MAX_SUBSET_POOL = 16;
const PAIR_MAX_NODES = 20000;
const PAIR_MAX_CANDIDATES_PER_ROW = 40;
const PAIR_TIME_BUDGET_MS = 1200;
const PAIR_MAX_SHOWN = 12;
// 日期提示：金额一样的候选里优先配日期更近的；两侧日期相差超过这个天数时只提示、不改变配对结果。
const PAIR_DATE_WARN_DAYS = 90;
const PAIR_DATE_MATCH_LIMIT = 40000;
// 「差一点」提示：配对完剩下的记录里，两边最接近的一对。只是告诉用户把容差放到多少能配上，
// 不进 group.pairings、不参与任何金额计算，所以黄金测试的配对断言与结果指纹都不受影响。
// 每家企业屏幕上最多列 8 对，数据里留全（两侧候选各截 20 笔，所以最多 20 对），导出的「差一点」表列全。
const PAIR_NEAR_MISS_MAX = 8;
const PAIR_NEAR_MISS_POOL = 20;
const PAIR_NEAR_MISS_RATIO = 0.05;

// 底稿快照：把本次结果存成一个小 JSON，下次导入后和当前结果比对。
const SNAPSHOT_FORMAT = 'audit-recon-snapshot';
const SNAPSHOT_FORMAT_VERSION = 1;
const SNAPSHOT_MAX_SHOWN = 20;
const SNAPSHOT_MAX_COMPANIES = 5000;
const SNAPSHOT_MAX_BYTES = 5 * 1024 * 1024;

// 导出校验码：导出后按文件字节算一次，用户可抄在底稿上，日后选回文件核对。
const EXPORT_VERIFY_MAX_BYTES = 32 * 1024 * 1024;
// 导入体积：整个读表在浏览器主线程里跑，文件太大页面会像卡死。超过硬上限直接拒并说清怎么办；
// 到提醒线仍然继续读，只是先打一句「可能要等一会儿」。
const IMPORT_WARN_BYTES = 20 * 1024 * 1024;
const IMPORT_MAX_BYTES = 60 * 1024 * 1024;

const NAME_SUFFIXES = [
  '集团有限责任公司',
  '股份有限公司',
  '有限责任公司',
  '集团有限公司',
  '有限公司',
  '集团',
  '公司'
];

// 与 version.txt 同步改；file:// 直开时页脚版本号的兜底文案。
const APP_VERSION_FALLBACK = 'v2026.11.06-r3';

const RENDER_PAGE_SIZE = 100;

// 配置页的工作表列表也分批画：整本底稿上千张表，一次画完会卡住（实测 60 张约 12 ms）。
const SOURCE_PAGE_SIZE = 60;

const state = {
  importMode: 'excel',
  sources: [],
  activeSourceId: '',
  records: [],
  groups: [],
  skipped: [],
  reclassRows: [],
  redRows: [],
  unknownDirections: [],
  inheritedRows: 0,
  directionFallbackRows: 0,
  outOfRangeRows: 0,
  stats: null,
  runInfo: null,
  filter: 'all',
  search: '',
  sort: 'netAbsDesc',
  facetNet: 'all',
  facetDir: 'all',
  facetSource: 'all',
  expanded: new Set(),
  dataCheckOpen: false,
  pairToleranceCents: PAIR_DEFAULT_TOLERANCE_CENTS,
  pairPercent: PAIR_DEFAULT_PERCENT,
  pairResult: null,
  sourceFilter: '',
  sourceLimit: SOURCE_PAGE_SIZE,
  autoDetectCols: true,
  guessWarnings: [],
  dimensionWarnings: [],
  unitConfirmSignature: '',
  controls: [],
  ageBaseDate: '',
  ageBandPreset: 'year',
  signoff: { index: '', preparedBy: '', reviewedBy: '', date: '', conclusion: '', note: '' },
  groupNotes: new Map(),
  configProfiles: [],
  merges: new Map(),
  mergeLog: [],
  dismissedSimilar: new Set(),
  dismissedPairs: new Set(),
  similarSuggestions: [],
  renderLimit: RENDER_PAGE_SIZE,
  printing: false,
  recentErrors: []
};

const ROLE_FIELDS = ['company', 'amount', 'direction', 'memo'];
const ROLE_LABELS = { company: '企业名称', amount: '金额', direction: '收付方向', memo: '摘要' };
const ROLE_PICK_HINTS = {
  company: '只点中写着公司名的那一列',
  amount: '只点中有数字的那一列',
  direction: '只点中写应收/应付的那一列'
};
const WEAK_ROLE_HINTS = {
  company: '看不到企业名',
  amount: '没几个金额数字',
  direction: '分不清应收应付'
};
const colPick = { sourceId: '', from: -1, to: -1, dragging: false };
const mapPick = { sourceId: '', r1: -1, c1: -1, r2: -1, c2: -1, dragging: false };
let mapImage = null;

const MAP_MAX_COLS = 60;
const MAP_COLORS = {
  card: '#fffdf8',
  grid: '#e6e1d4',
  header: '#243029',
  headerText: '#f6f2e6',
  name: '#145a4a',
  num: '#315f7d',
  dir: '#93621c',
  faint: '#c3bcab',
  range: '#93621c',
  box: '#145a4a'
};
const MAP_ROLE_FILL = {
  company: 'rgba(20, 90, 74, 0.10)',
  amount: 'rgba(49, 95, 125, 0.12)',
  direction: 'rgba(147, 98, 28, 0.12)',
  memo: 'rgba(198, 161, 91, 0.10)'
};

const els = {};
let toastTimer = null;
let searchTimer = null;
let sourceFilterTimer = null;
let sourceSeq = 0;
let printRestoreTimer = null;
let snapshotBaseline = null;
let snapshotComparison = null;
let snapshotRefreshTimer = null;
let lastExportReceipt = null;
const undoStack = [];
let undoApplying = false;

const moneyFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

document.addEventListener('DOMContentLoaded', init);

// ===== 启动与事件绑定 =====

function init() {
  cacheElements();
  bindEvents();

  // serve.ps1 会把 index.html 里的 __APP_VERSION__ 换成 version.txt 的内容；
  // 直接双击 html（file://）时占位符不会被替换，这里兜底显示同一版本。
  if (els.appVersion && els.appVersion.textContent.indexOf('__APP_VERSION__') !== -1) {
    els.appVersion.textContent = APP_VERSION_FALLBACK;
    els.appVersion.title = '直接用浏览器打开，版本号来自页面内置';
  }

  if (typeof XLSX === 'undefined') {
    els.libError.classList.remove('hidden');
    els.dropzone.setAttribute('aria-disabled', 'true');
    els.dropzone.style.pointerEvents = 'none';
    els.dropzone.style.opacity = '0.55';
  }

  state.ageBaseDate = todayIsoDate();
  if (els.ageBaseDate) els.ageBaseDate.value = state.ageBaseDate;
  applyAgeBandPreset('year');
  if (els.ageBandPreset) els.ageBandPreset.value = 'year';
}

function cacheElements() {
  const ids = [
    'libError', 'landingSection', 'configSection', 'resultSection', 'dropzone',
    'fileInput', 'sampleBtn', 'sampleRunBtn', 'helpBtn', 'helpPanel', 'fileError', 'fileExt',
    'cfgFileName', 'cfgFileMeta', 'changeFileBtn', 'sheetSelect', 'headerRowSelect',
    'unitSelect', 'companyCol', 'amountCol', 'directionCol', 'memoCol', 'ageCol',
    'currencyCol', 'entityCol',
    'previewTable', 'runBtn', 'runBtnLabel', 'runError', 'resultTitle', 'resultMeta',
    'reimportBtn', 'exportBtn', 'exportBlocksBtn', 'summaryGrid', 'dimSummary', 'totalsStrip', 'dataCheck', 'searchInput',
    'filterChips', 'facetBar', 'sortSelect', 'exportFiltered', 'visibleCount', 'resultBody', 'toast',
    'pairTolerance', 'pairPercent', 'ageBaseField', 'ageBaseDate', 'ageBandField', 'ageBandPreset',
    'excelPanel', 'manualPanel', 'manualRecv', 'manualPay', 'manualRecvCount',
    'manualPayCount', 'manualUnit', 'manualRunBtn', 'manualError', 'sourceList', 'sourceCount',
    'sourceSelectAll', 'sourceSelectNone', 'sourceSearch', 'sourceFilterNote',
    'columnStatus', 'pickBar', 'pickText', 'pickClear', 'manualCols',
    'sheetMap', 'sheetMapMeta', 'mapScroll', 'mapBar', 'mapText', 'mapNote',
    'autoDetectCols', 'appVersion', 'selfCheckBtn', 'selfCheckOut', 'diagBtn',
    'printBtn', 'signoffIndex', 'signoffPrepared', 'signoffReviewed', 'signoffDate',
    'signoffConclusion', 'saveConfigBtn', 'loadConfigBtn', 'configInput', 'configNote',
    'printStamp', 'printNote', 'nettingNote', 'similarBox', 'fingerprintLine',
    'snapshotDiff', 'saveSnapshotBtn', 'compareSnapshotBtn', 'snapshotInput',
    'exportCard', 'exportReceiptBody', 'exportVerifyOut', 'verifyExportBtn',
    'verifyExportInput', 'exportExpectInput', 'undoBtn'
  ];
  ids.forEach((id) => {
    els[id] = document.getElementById(id);
  });
}

function bindEvents() {
  bindImportEvents();
  bindPageEvents();
  bindSavedConfigAndSnapshotEvents();
  bindSimilarCompanyEvents();
  bindUndoEvents();
  bindSourceSelectionEvents();
  bindColumnPickEvents();
  bindManualInputEvents();
  bindSourceControlEvents();
  bindColumnMappingEvents();
  bindAgeSettingsEvents();
  bindRunAndExportEvents();
  bindResultFilterEvents();
  bindPairSettingsEvents();
  bindResultDetailEvents();
}

function bindImportEvents() {
  document.querySelectorAll('.mode-tab').forEach((button) => {
    button.addEventListener('click', () => switchImportMode(button.dataset.mode));
  });

  els.dropzone.addEventListener('click', () => els.fileInput.click());
  els.dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      els.fileInput.click();
    }
  });
  els.dropzone.addEventListener('dragenter', handleDragOver);
  els.dropzone.addEventListener('dragover', handleDragOver);
  els.dropzone.addEventListener('dragleave', (event) => {
    if (!els.dropzone.contains(event.relatedTarget)) {
      els.dropzone.classList.remove('dragover');
    }
  });
  els.dropzone.addEventListener('drop', handleDrop);

  window.addEventListener('dragover', (event) => {
    if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files')) {
      event.preventDefault();
    }
  });
  window.addEventListener('drop', (event) => {
    if (event.target.closest && event.target.closest('#dropzone')) return;
    event.preventDefault();
  });

  els.fileInput.addEventListener('change', (event) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = '';
    if (files.length) handleFiles(files);
  });

  els.sampleBtn.addEventListener('click', downloadSample);
  els.sampleRunBtn.addEventListener('click', runBuiltinSample);
  els.helpBtn.addEventListener('click', toggleHelp);
  els.selfCheckBtn.addEventListener('click', runSelfCheck);
  els.changeFileBtn.addEventListener('click', () => els.fileInput.click());
}

function bindPageEvents() {
  window.addEventListener('beforeunload', (event) => {
    if (!hasWorkInProgress()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  window.addEventListener('error', (event) => {
    const text = event && event.message ? String(event.message) : '';
    if (!text) return;
    if (state.recentErrors.indexOf(text) === -1) state.recentErrors.push(text);
    if (state.recentErrors.length > 6) state.recentErrors.shift();
  });

  els.diagBtn.addEventListener('click', exportDiagnostics);
  if (els.printBtn) els.printBtn.addEventListener('click', printReport);
  [['index', els.signoffIndex], ['preparedBy', els.signoffPrepared], ['reviewedBy', els.signoffReviewed],
    ['date', els.signoffDate], ['conclusion', els.signoffConclusion], ['note', els.printNote]].forEach(([key, input]) => {
    if (!input) return;
    input.addEventListener('input', () => {
      state.signoff[key] = input.value;
    });
  });
}

function bindSavedConfigAndSnapshotEvents() {
  if (els.saveConfigBtn) els.saveConfigBtn.addEventListener('click', saveColumnConfig);
  if (els.loadConfigBtn) els.loadConfigBtn.addEventListener('click', () => els.configInput.click());
  if (els.configInput) els.configInput.addEventListener('change', importColumnConfig);
  if (els.saveSnapshotBtn) els.saveSnapshotBtn.addEventListener('click', saveSnapshotFile);
  if (els.compareSnapshotBtn && els.snapshotInput) {
    els.compareSnapshotBtn.addEventListener('click', () => els.snapshotInput.click());
  }
  if (els.snapshotInput) els.snapshotInput.addEventListener('change', importSnapshotFile);
  if (els.snapshotDiff) els.snapshotDiff.addEventListener('click', (event) => {
    if (event.target.closest('[data-snap-export]')) exportSnapshotComparison();
    else if (event.target.closest('[data-snap-clear]')) clearSnapshot();
  });
}

function bindSimilarCompanyEvents() {
  if (els.similarBox) els.similarBox.addEventListener('click', (event) => {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    if (button.dataset.act === 'merge') mergeSimilarPair(button.dataset.id, button.dataset.keep);
    else if (button.dataset.act === 'dismiss') {
      const id = button.dataset.id;
      const previous = new Set(state.dismissedPairs);
      pushUndo('不是同一家', () => {
        state.dismissedPairs = previous;
        renderSimilarBox();
      });
      state.dismissedPairs.add(id);
      renderSimilarBox();
      showToast('已标成不是同一家，下次重新对账也不会再问这一对；想改回来点「恢复」');
    } else if (button.dataset.act === 'dismiss-all') dismissAllSimilar();
    else if (button.dataset.act === 'restore-dismissed') restoreDismissedPairs();
    else if (button.dataset.act === 'undo-merge') undoLastMerge();
  });
}

function bindUndoEvents() {
  if (els.undoBtn) els.undoBtn.addEventListener('click', undoLastAction);
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
    if (String(event.key).toLowerCase() !== 'z') return;
    const target = event.target;
    const tag = target && target.tagName ? String(target.tagName).toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (target && target.isContentEditable)) return;
    if (!undoStack.length) return;
    event.preventDefault();
    undoLastAction();
  });
}

function bindSourceSelectionEvents() {
  els.reimportBtn.addEventListener('click', resetWorkbench);
  els.sourceSelectAll.addEventListener('click', () => setAllSourcesIncluded(true));
  els.sourceSelectNone.addEventListener('click', () => setAllSourcesIncluded(false));

  els.sourceSearch.addEventListener('input', () => {
    clearTimeout(sourceFilterTimer);
    sourceFilterTimer = setTimeout(() => {
      state.sourceFilter = els.sourceSearch.value;
      state.sourceLimit = SOURCE_PAGE_SIZE;
      renderSourceList();
    }, 120);
  });
  els.sourceSearch.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    els.sourceSearch.value = '';
    state.sourceFilter = '';
    state.sourceLimit = SOURCE_PAGE_SIZE;
    renderSourceList();
  });
}

function bindColumnPickEvents() {
  els.autoDetectCols.addEventListener('change', () => {
    state.autoDetectCols = els.autoDetectCols.checked;
    showToast(
      state.autoDetectCols
        ? '以后导入的表会自动认列，认错的话在图片里框一下就能改'
        : '以后导入的表不自动认列，自己在整张表的图片里框出企业名和金额就能对账',
      !state.autoDetectCols
    );
  });

  els.pickBar.addEventListener('click', (event) => {
    const role = event.target.closest('[data-role]');
    if (role) {
      applyPickedRole(role.dataset.role);
      return;
    }
    if (event.target.closest('#pickClear')) clearPick();
  });

  els.columnStatus.addEventListener('click', (event) => {
    if (event.target.closest('#autoRemapBtn')) remapActiveSource();
    if (event.target.closest('#rangeWholeBtn')) applyMapPick('whole');
  });

  bindPreviewPick();
  bindSheetMap();
}

function bindManualInputEvents() {
  els.manualRecv.addEventListener('input', updateManualCounts);
  els.manualPay.addEventListener('input', updateManualCounts);
  els.manualRunBtn.addEventListener('click', runManualReconciliation);
}

function bindSourceControlEvents() {
  els.sourceList.addEventListener('click', (event) => {
    const more = event.target.closest('[data-src-more], [data-src-all]');
    if (more) {
      const base = Number.isFinite(state.sourceLimit) && state.sourceLimit > 0 ? state.sourceLimit : SOURCE_PAGE_SIZE;
      state.sourceLimit = more.hasAttribute('data-src-all')
        ? getVisibleSources().length
        : base + SOURCE_PAGE_SIZE;
      renderSourceList();
      return;
    }

    const button = event.target.closest('[data-act="activate"]');
    if (button) activateSource(button.dataset.id);
  });
  els.sourceList.addEventListener('change', (event) => {
    const checkbox = event.target.closest('input[data-act="include"]');
    if (checkbox) {
      const source = getSource(checkbox.dataset.id);
      if (!source) return;
      source.included = checkbox.checked;
      renderSourceList();
      populateSheetSelect();
      invalidateResults();
      return;
    }

    const select = event.target.closest('select[data-act="direction"]');
    if (select) {
      const source = getSource(select.dataset.id);
      if (!source) return;
      source.directionOverride = select.value;
      renderSourceList();
      populateSheetSelect();
      updateFileMeta(source);
      invalidateResults();
    }
  });

  els.sheetSelect.addEventListener('change', () => {
    if (els.sheetSelect.value) activateSource(els.sheetSelect.value);
  });
  els.headerRowSelect.addEventListener('change', () => {
    const source = getActiveSource();
    if (!source) return;
    applyHeaderRow(source, Number(els.headerRowSelect.value) || 0);
    populateMappingSelects(source);
    els.unitSelect.value = String(source.unit);
    renderSourceList();
    clearPick();
    renderPreview(source);
    renderColumnStatus(source);
    updateFileMeta(source);
    invalidateResults();
  });
}

function bindColumnMappingEvents() {
  [
    ['company', els.companyCol],
    ['amount', els.amountCol],
    ['direction', els.directionCol],
    ['memo', els.memoCol],
  ].forEach(([field, select]) => {
    select.addEventListener('change', () => {
      const source = getActiveSource();
      if (source) setColumnMapping(source, field, Number(select.value));
    });
  });

  if (els.ageCol) {
    els.ageCol.addEventListener('change', () => {
      const source = getActiveSource();
      if (!source) return;
      const picked = Number(els.ageCol.value);
      if (picked >= 0) {
        const taken = ROLE_FIELDS.map((field) => source.mapping[field]);
        if (taken.includes(picked)) {
          els.ageCol.value = String((sourceAgeColumn(source) || { index: -1 }).index);
          showToast('这一列已经用在别的地方了：换一列，或先把那一列改掉', true);
          return;
        }
      }
      setSourceAgeColumn(source, picked);
      els.ageCol.value = String(picked);
      renderColumnStatus(source);
      invalidateResults();
      showToast(picked >= 0
        ? `账龄列已设为 ${XLSX.utils.encode_col(picked)} 列，重新点「开始对账」就能看到每家的账龄分布`
        : '已设为不用账龄；重新点「开始对账」就不会再统计账龄');
    });
  }

  [['entity', els.entityCol], ['currency', els.currencyCol]].forEach(([field, select]) => {
    if (!select) return;
    select.addEventListener('change', () => {
      const source = getActiveSource();
      if (!source) return;
      const picked = Number(select.value);
      if (picked >= 0 && dimensionTakenColumns(source, field).has(picked)) {
        const previous = sourceDimensionColumn(source, field);
        select.value = String(previous ? previous.index : -1);
        showToast('这一列已经用在别的地方了：换一列，或先把那一列改掉', true);
        return;
      }
      setSourceDimensionColumn(source, field, picked);
      select.value = String(picked);
      renderColumnStatus(source);
      invalidateResults();
      const label = field === 'entity' ? '主体列' : '币种列';
      showToast(picked >= 0
        ? `${label}已设为 ${XLSX.utils.encode_col(picked)} 列，重新点「开始对账」就会分开算`
        : `已设为不用${field === 'entity' ? '主体' : '币种'}；重新点「开始对账」就按原来的方式算`);
    });
  });
}

function bindAgeSettingsEvents() {
  if (els.ageBaseDate) {
    els.ageBaseDate.addEventListener('change', () => {
      const value = cleanCell(els.ageBaseDate.value);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        els.ageBaseDate.value = ageBaseDateValue();
        showToast('账龄算到哪天，用日期选择器点一天就行', true);
        return;
      }
      const before = state.ageBaseDate;
      if (before === value) return;
      pushUndo('账龄基准日', () => {
        state.ageBaseDate = before;
        if (els.ageBaseDate) els.ageBaseDate.value = before;
        refreshAgeBands();
      });
      state.ageBaseDate = value;
      refreshAgeBands();
    });
  }

  if (els.ageBandPreset) {
    els.ageBandPreset.addEventListener('change', () => {
      const next = els.ageBandPreset.value === 'half' ? 'half' : 'year';
      const before = state.ageBandPreset;
      if (before === next) return;
      pushUndo('账龄档位', () => {
        applyAgeBandPreset(before);
        if (els.ageBandPreset) els.ageBandPreset.value = before;
        refreshAgeBands();
      });
      applyAgeBandPreset(next);
      els.ageBandPreset.value = next;
      refreshAgeBands();
      showToast(`账龄已按「${ageBandPreset().label}」分开；只影响分档展示，不改任何金额`);
    });
  }
}

function bindRunAndExportEvents() {
  els.unitSelect.addEventListener('change', () => {
    const source = getActiveSource();
    if (source) source.unit = Number(els.unitSelect.value) || 1;
    invalidateResults();
    hideRunError();
  });

  els.runBtn.addEventListener('click', runReconciliation);
  els.exportBtn.addEventListener('click', exportResults);
  els.exportBlocksBtn.addEventListener('click', exportGroupSheets);

  if (els.verifyExportBtn && els.verifyExportInput) {
    els.verifyExportBtn.addEventListener('click', () => els.verifyExportInput.click());
    els.verifyExportInput.addEventListener('change', verifyExportFile);
  }
  if (els.exportExpectInput) {
    els.exportExpectInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (els.verifyExportBtn) els.verifyExportBtn.click();
    });
  }
  if (els.exportCard) {
    els.exportCard.addEventListener('click', async (event) => {
      if (event.target.closest('[data-er-archive]')) {
        archiveExportReceipt();
        return;
      }
      const button = event.target.closest('[data-er-copy]');
      if (!button) return;
      const copied = await copyPlainText(button.dataset.erCopy || '');
      button.textContent = copied ? '已复制' : '复制失败';
      clearTimeout(button.copyTimer);
      button.copyTimer = setTimeout(() => {
        button.textContent = button.dataset.erLabel || '复制';
      }, 1600);
      showToast(copied ? '校验码已复制' : '浏览器拦住了复制，可以手动选中校验码复制', !copied);
    });
  }
}

function bindResultFilterEvents() {
  els.filterChips.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-filter]');
    if (!button) return;
    state.filter = button.dataset.filter;
    state.renderLimit = RENDER_PAGE_SIZE;
    updateChipStates();
    renderFacets();
    renderTable();
  });

  if (els.facetBar) {
    els.facetBar.addEventListener('click', (event) => {
      if (event.target.closest('button[data-facet-clear]')) {
        if (!facetsActive()) return;
        resetFacets();
        state.renderLimit = RENDER_PAGE_SIZE;
        renderFacets();
        renderTable();
        return;
      }
      if (event.target.closest('button[data-copy-filtered]')) {
        copyFilteredSummary();
        return;
      }
      const button = event.target.closest('button[data-facet]');
      if (!button) return;
      const key = button.dataset.facet === 'net' ? 'facetNet' : 'facetDir';
      const value = button.dataset.value;
      if (state[key] === value) return;
      state[key] = value;
      state.renderLimit = RENDER_PAGE_SIZE;
      renderFacets();
      renderTable();
    });

    els.facetBar.addEventListener('change', (event) => {
      if (event.target.id !== 'sourceFacetSelect') return;
      state.facetSource = event.target.value || 'all';
      state.renderLimit = RENDER_PAGE_SIZE;
      renderFacets();
      renderTable();
    });
  }

  els.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = els.searchInput.value.trim();
      state.renderLimit = RENDER_PAGE_SIZE;
      renderFacets();
      renderTable();
    }, 120);
  });

  els.sortSelect.addEventListener('change', () => {
    state.sort = els.sortSelect.value;
    state.renderLimit = RENDER_PAGE_SIZE;
    renderTable();
  });
}

function bindPairSettingsEvents() {
  els.pairTolerance.addEventListener('change', () => {
    const cents = toleranceInputToCents(els.pairTolerance.value);
    if (cents === null) {
      els.pairTolerance.value = (state.pairToleranceCents / 100).toFixed(2);
      showToast('核销容差请填 0 到 1000 之间的数字', true);
      return;
    }
    const before = state.pairToleranceCents;
    if (before === cents) return;
    pushUndo('核销容差', () => {
      state.pairToleranceCents = before;
      if (els.pairTolerance) els.pairTolerance.value = (before / 100).toFixed(2);
      refreshPairing();
    });
    state.pairToleranceCents = cents;
    els.pairTolerance.value = (cents / 100).toFixed(2);
    refreshPairing();
  });

  if (els.pairPercent) {
    els.pairPercent.addEventListener('change', () => {
      const value = percentInputToValue(els.pairPercent.value);
      if (value === null) {
        els.pairPercent.value = formatPercentInput(state.pairPercent);
        showToast(`比例容差请填 0 到 ${PAIR_MAX_PERCENT} 之间的数字；填 0 表示不用比例`, true);
        return;
      }
      const before = state.pairPercent;
      if (before === value) return;
      pushUndo('比例容差', () => {
        state.pairPercent = before;
        if (els.pairPercent) els.pairPercent.value = formatPercentInput(before);
        refreshPairing();
      });
      state.pairPercent = value;
      els.pairPercent.value = formatPercentInput(value);
      refreshPairing();
    });
  }
}

function bindResultDetailEvents() {
  if (els.fingerprintLine) {
    els.fingerprintLine.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-fp-copy]');
      if (!button) return;
      const copied = await copyPlainText(button.dataset.fpCopy || '');
      button.textContent = copied ? '已复制' : '复制失败';
      clearTimeout(button.copyTimer);
      button.copyTimer = setTimeout(() => { button.textContent = '复制完整指纹'; }, 1600);
      showToast(copied ? '结果指纹已复制' : '浏览器拦住了复制，可以手动选中指纹复制', !copied);
    });
  }

  els.resultBody.addEventListener('click', (event) => {
    const decisionButton = event.target.closest('button[data-pair-decision]');
    if (decisionButton) {
      const group = state.groups.find((item) => item.idx === Number(decisionButton.dataset.idx));
      const pairing = group && group.pairings ? group.pairings[Number(decisionButton.dataset.pi)] : null;
      if (!pairing) return;
      const next = decisionButton.dataset.pairDecision;
      const previous = pairing.decision || 'pending';
      const signature = pairingSignature(pairing);
      const groupKey = group.key;
      pushUndo('采纳标记', () => {
        const targetGroup = findGroupByKey(groupKey);
        const targetPairing = findPairing(targetGroup, signature);
        if (!targetPairing) return;
        targetPairing.decision = previous;
        renderSummary();
        renderTable();
      });
      pairing.decision = pairing.decision === next ? 'pending' : next;
      renderSummary();
      renderTable();
      const fresh = els.resultBody.querySelector(
        `button[data-pair-decision="${next}"][data-idx="${decisionButton.dataset.idx}"][data-pi="${decisionButton.dataset.pi}"]`
      );
      if (fresh) fresh.focus({ preventScroll: true });
      return;
    }

    const copyButton = event.target.closest('button.copy-btn');
    if (copyButton) {
      copyTextArea(copyButton);
      return;
    }

    const moreButton = event.target.closest('[data-render-more], [data-render-all]');
    if (moreButton) {
      state.renderLimit = moreButton.hasAttribute('data-render-all')
        ? Number.MAX_SAFE_INTEGER
        : (state.renderLimit || RENDER_PAGE_SIZE) + RENDER_PAGE_SIZE;
      renderTable();
      return;
    }

    const button = event.target.closest('button.detail-btn');
    if (!button) return;
    const idx = Number(button.dataset.idx);
    if (state.expanded.has(idx)) {
      state.expanded.delete(idx);
    } else {
      state.expanded.add(idx);
    }
    renderTable();
    const freshButton = els.resultBody.querySelector(`button.detail-btn[data-idx="${idx}"]`);
    if (freshButton) freshButton.focus({ preventScroll: true });
  });

  els.resultBody.addEventListener('focusin', (event) => {
    const area = event.target.closest('textarea[data-note-key]');
    if (!area) return;
    area.dataset.undoBase = state.groupNotes.get(area.dataset.noteKey) || '';
    delete area.dataset.undoPushed;
  });

  els.resultBody.addEventListener('input', (event) => {
    const area = event.target.closest('textarea[data-note-key]');
    if (!area) return;
    const noteKey = area.dataset.noteKey;
    if (!area.dataset.undoPushed) {
      const base = area.dataset.undoBase !== undefined
        ? area.dataset.undoBase
        : (state.groupNotes.get(noteKey) || '');
      pushUndo('差异说明', () => {
        state.groupNotes.set(noteKey, base);
        renderTable();
        scheduleSnapshotRefresh();
      });
      area.dataset.undoPushed = '1';
    }
    state.groupNotes.set(noteKey, area.value);
    const mirror = area.parentElement ? area.parentElement.querySelector('.group-note-print') : null;
    if (mirror) mirror.textContent = area.value.trim() ? area.value : '—';
    scheduleSnapshotRefresh();
  });

  els.dataCheck.addEventListener('click', (event) => {
    if (!event.target.closest('#dataCheckBtn')) return;
    state.dataCheckOpen = !state.dataCheckOpen;
    renderDataCheck();
    const button = els.dataCheck.querySelector('#dataCheckBtn');
    if (button) button.focus({ preventScroll: true });
  });
}

// ===== 导入与数据源建立 =====

function handleDragOver(event) {
  event.preventDefault();
  event.stopPropagation();
  els.dropzone.classList.add('dragover');
}

function handleDrop(event) {
  event.preventDefault();
  event.stopPropagation();
  els.dropzone.classList.remove('dragover');
  const files = event.dataTransfer.files ? Array.from(event.dataTransfer.files) : [];
  if (files.length) handleFiles(files);
}

function toggleHelp() {
  const isHidden = els.helpPanel.classList.toggle('hidden');
  els.helpBtn.setAttribute('aria-expanded', String(!isHidden));
  els.helpBtn.textContent = isHidden ? '需要准备哪些列？' : '收起准备说明';
}

// 导入前的体积判定：只看文件类型与大小，不读任何内容。
function classifyImportFiles(files) {
  const supported = [];
  const rejected = [];
  const oversize = [];
  let largestBytes = 0;

  (files || []).forEach((file) => {
    if (!/\.(xlsx|xls|csv|txt)$/i.test(file.name)) {
      rejected.push(file.name);
      return;
    }
    if (file.size > IMPORT_MAX_BYTES) {
      oversize.push(`${file.name}（${formatBytes(file.size)}）`);
      return;
    }
    if (file.size > largestBytes) largestBytes = file.size;
    supported.push(file);
  });

  return { supported, rejected, oversize, largestBytes };
}

async function handleFiles(files) {
  const { supported, rejected, oversize, largestBytes } = classifyImportFiles(files);

  if (!supported.length) {
    if (oversize.length) {
      showFileError(`这几个文件太大，工具一次读不动：${oversize.join('；')}。请在 Excel 里只留下要核对的那几张表，另存成一个新文件后再导入。`);
      return;
    }
    showFileError('这些文件类型暂时不支持。请选择 .xlsx、.xls、.csv 或 .txt 文件。');
    return;
  }

  // 大文件先给一句「在算，不是卡住」，否则读表那几十秒里屏幕上什么都没有。
  if (largestBytes > IMPORT_WARN_BYTES) {
    showToast(`这个文件有 ${formatBytes(largestBytes)}，读表要等一会儿，没卡住`, true);
  }

  hideFileError();
  setDropzoneBusy(true);
  els.runBtn.disabled = true;

  const added = [];
  const failures = [];
  let duplicateFiles = 0;

  try {
    for (const file of supported) {
      const fileKey = `${file.name}::${file.size}::${file.lastModified}`;
      if (state.sources.some((source) => source.fileKey === fileKey)) {
        duplicateFiles += 1;
        continue;
      }

      try {
        const buffer = await file.arrayBuffer();
        const workbook = readWorkbook(file, buffer);
        const sheetNames = workbook.SheetNames.filter((name) => {
          const sheet = workbook.Sheets[name];
          return sheet && sheet['!ref'];
        });
        const fileSources = sheetNames
          .map((sheetName) => buildSource(file, workbook, sheetName, fileKey))
          .filter(Boolean);

        if (!fileSources.length) {
          failures.push(`${file.name}：没有可读取的数据表`);
          continue;
        }

        // 导入不替人做决定：哪怕这个文件只有一张表，也一张都不勾。
        fileSources.forEach((source) => {
          state.sources.push(source);
          added.push(source);
        });
      } catch (error) {
        console.error(error);
        failures.push(`${file.name}：${friendlyError(error)}`);
      }
    }

    if (!added.length) {
      if (failures.length) {
        showFileError(`读取失败：${failures.join('；')}`);
      } else if (duplicateFiles) {
        showFileError('这些文件已经在数据源列表里了，无需重复导入。');
      } else {
        showFileError('没有读到可用的数据表。');
      }
      return;
    }

    refreshSourceShortLabels();
    invalidateResults();
    els.landingSection.classList.add('hidden');
    els.configSection.classList.remove('hidden');
    els.resultSection.classList.add('hidden');
    els.sourceSearch.value = '';
    state.sourceFilter = '';
    state.sourceLimit = SOURCE_PAGE_SIZE;
    activateSource(added[0].id);

    const suggested = added.filter((source) => source.usable).length;
    const silent = added.filter((source) => source.noAmount).length;
    const summary = [`已导入 ${added.length} 张工作表，这次没有替你勾选任何一张`];
    summary.push(suggested
      ? `其中 ${suggested} 张认出了企业名称列和金额列（每一行都写了看的是哪一列），要核对哪几张就勾哪几张`
      : '要核对哪几张就在下面勾上；表多就先点「全选」，再把不要的取消掉');
    if (silent) summary.push(`${silent} 张表里没有金额（整列是横线或空白），不用管它`);
    if (duplicateFiles) summary.push(`${duplicateFiles} 个重复文件已跳过`);
    if (rejected.length) summary.push(`${rejected.length} 个不支持的文件已忽略`);
    if (oversize.length) summary.push(`${oversize.length} 个文件太大没导入（${oversize[0]}）`);
    if (failures.length) summary.push(`${failures.length} 个文件读取失败`);
    showToast(summary.join('，'), failures.length > 0);

    requestAnimationFrame(() => {
      els.configSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  } finally {
    setDropzoneBusy(false);
    els.runBtn.disabled = false;
  }
}

function buildSource(file, workbook, sheetName, fileKey) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet || !sheet['!ref']) return null;

  const range = XLSX.utils.decode_range(sheet['!ref']);
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: true
  });

  while (rows.length && (rows[rows.length - 1] || []).every((value) => cleanCell(value) === '')) {
    rows.pop();
  }
  if (!rows.length) return null;
  if (!rows.some((row) => (row || []).some((value) => cleanCell(value) !== ''))) return null;

  sourceSeq += 1;
  const hiddenRows = new Set();
  (sheet['!rows'] || []).forEach((prop, index) => {
    if (prop && prop.hidden) hiddenRows.add(index - range.s.r);
  });

  const redCells = collectRedCells(workbook, sheetName, range ? range.s.r : 0);

  const source = {
    id: `src-${Date.now()}-${sourceSeq}`,
    kind: 'excel',
    fileKey,
    fileName: file.name,
    fileSize: file.size,
    sheetName,
    rows,
    sheet,
    rowOffset: range ? range.s.r : 0,
    hiddenRows,
    redCells,
    headerRow: 0,
    groupHeaderRow: -1,
    headerLabels: [],
    dataRange: null,
    columnWindow: null,
    mapBox: null,
    mapping: { company: -1, amount: -1, direction: -1, memo: -1 },
    entityColumn: null,
    currencyColumn: null,
    guessedFields: [],
    unit: 1,
    directionOverride: 'auto',
    directionColumnManual: false,
    inferredDirection: '',
    inferenceSource: '',
    usable: false,
    noAmount: false,
    included: false,
    shortLabel: sheetName,
    label: `${file.name} · ${sheetName}`
  };

  const layout = detectHeaderLayout(rows);
  source.headerRow = layout.headerRow;
  syncHeaderLabels(source);
  if (state.autoDetectCols) autoMapColumns(source);
  source.dataRange = detectDataRegion(source);
  source.profileUsed = applyConfigProfile(source);
  refreshSourceInference(source);
  source.usable = isSourceUsable(source);
  // 「这张表没有金额」只看整表扫描的结果，不看认没认到金额列：
  // 一整列写 0 的余额列也会被认成金额列，但表里其实一分钱都没有。
  source.noAmount = !source.usable && !sourceHasAnyAmount(source);
  source.amountDoubt = source.usable && !amountColumnEvidence(source);
  source.companyDoubt = source.usable && !companyColumnEvidence(source);
  // 到这里这张表「能不能对上」已经判完了（usable / 两个 doubt / noAmount 只用于列表上的说明），
  // 但参与不参与对账始终由人勾选决定，导入时一张都不勾。
  source.included = false;
  return source;
}

// ===== 列设置模板 =====

function sourceHeaderSignature(source) {
  const labels = getHeaderLabels(source);
  const parts = [];
  for (let i = 0; i < labels.length; i += 1) {
    const label = normalizeForSearch(cleanCell(labels[i]));
    if (label) parts.push(`${i}:${label}`);
  }
  return parts.join('|');
}

function buildConfigProfile(source) {
  const signature = sourceHeaderSignature(source);
  if (!signature) return null;
  const range = source.dataRange;
  return {
    signature,
    sheetName: source.sheetName,
    headerLabels: getHeaderLabels(source).slice(0, 40).map((label) => cleanCell(label)),
    headerRow: source.headerRow,
    mapping: { ...source.mapping },
    ageColumn: (sourceAgeColumn(source) || { index: -1 }).index,
    entityColumn: (sourceDimensionColumn(source, 'entity') || { index: -1 }).index,
    currencyColumn: (sourceDimensionColumn(source, 'currency') || { index: -1 }).index,
    unit: source.unit,
    directionOverride: source.directionOverride || 'auto',
    directionColumnManual: !!source.directionColumnManual,
    columnWindow: source.columnWindow ? { ...source.columnWindow } : null,
    manualRange: range && range.manual
      ? { fromOffset: range.fromRow - source.headerRow, toOffset: range.toRow - source.headerRow }
      : null
  };
}

function applyConfigProfile(source) {
  const profiles = state.configProfiles || [];
  if (!profiles.length) return null;
  const signature = sourceHeaderSignature(source);
  const profile = profiles.find((item) => item && item.signature === signature);
  if (!profile) return null;

  const columnCount = getColumnCount(source);
  const used = new Set();
  ROLE_FIELDS.forEach((field) => {
    const index = profile.mapping ? profile.mapping[field] : -1;
    if (Number.isInteger(index) && index >= 0 && index < columnCount && !used.has(index)) {
      source.mapping[field] = index;
      used.add(index);
    } else {
      source.mapping[field] = -1;
    }
  });
  source.guessedFields = [];
  const ageIndex = profile.ageColumn;
  if (Number.isInteger(ageIndex) && ageIndex >= 0 && ageIndex < columnCount && !used.has(ageIndex)) {
    setSourceAgeColumn(source, ageIndex);
    used.add(ageIndex);
  } else if (ageIndex === -1) {
    setSourceAgeColumn(source, -1);
  }
  DIMENSION_FIELDS.forEach((field) => {
    const index = field === 'entity' ? profile.entityColumn : profile.currencyColumn;
    if (Number.isInteger(index) && index >= 0 && index < columnCount && !used.has(index)) {
      setSourceDimensionColumn(source, field, index);
      used.add(index);
    } else if (index === -1) {
      setSourceDimensionColumn(source, field, -1);
    }
  });
  if ([1, 1000, 10000].includes(profile.unit)) source.unit = profile.unit;
  if (['auto', 'recv', 'pay'].includes(profile.directionOverride)) source.directionOverride = profile.directionOverride;
  source.directionColumnManual = !!profile.directionColumnManual && source.mapping.direction >= 0;

  const window = profile.columnWindow;
  if (window && Number.isInteger(window.from) && Number.isInteger(window.to)
    && window.from >= 0 && window.to >= window.from && window.to < columnCount) {
    source.columnWindow = { from: window.from, to: window.to };
  } else {
    source.columnWindow = null;
  }

  const range = profile.manualRange;
  if (range) {
    const fromRow = source.headerRow + range.fromOffset;
    const toRow = source.headerRow + range.toOffset;
    if (fromRow > source.headerRow && fromRow < source.rows.length) {
      setManualDataRange(source, fromRow, Math.min(toRow, source.rows.length - 1));
    }
  }
  return profile;
}

function collectConfigProfiles() {
  const profiles = [];
  const seen = new Set();
  state.sources.forEach((source) => {
    if (!source.profileUsed && !isSourceUsable(source)) return;
    const profile = buildConfigProfile(source);
    if (!profile || seen.has(profile.signature)) return;
    seen.add(profile.signature);
    profiles.push(profile);
  });
  return profiles;
}

function saveColumnConfig() {
  const profiles = collectConfigProfiles();
  if (!profiles.length) {
    showToast('还没有能保存的列设置：先导入表格并把列认对', true);
    return;
  }
  const payload = {
    kind: 'recon-column-config',
    version: 1,
    savedAt: new Date().toISOString(),
    appVersion: els.appVersion && els.appVersion.textContent ? els.appVersion.textContent : APP_VERSION_FALLBACK,
    profiles
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `对账工具列设置-${formatFileStamp(new Date())}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  state.configProfiles = profiles.slice();
  if (els.configNote) els.configNote.textContent = `已保存 ${profiles.length} 张表的列设置，下次导入同表头的表会自动套用。`;
  showToast(`列设置已存成文件（${profiles.length} 张表）。设置里只有列位置，没有金额和企业名。`);
}

function importColumnConfig(event) {
  const input = event && event.target;
  const file = input && input.files ? input.files[0] : null;
  if (input) input.value = '';
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    let payload;
    try {
      payload = JSON.parse(String(reader.result || ''));
    } catch (error) {
      showToast('这个文件读不了：请用「保存列设置」导出的那个文件', true);
      return;
    }
    const profiles = Array.isArray(payload && payload.profiles) ? payload.profiles : [];
    const valid = profiles.filter((item) => item && typeof item.signature === 'string' && item.mapping);
    if (!valid.length) {
      showToast('文件里没有列设置，请重新导出一份', true);
      return;
    }
    mergeConfigProfiles(valid);
    const { applied, changed } = applyProfilesToSources();
    renderSourceList();
    const activeSource = getActiveSource();
    if (activeSource) {
      populateMappingSelects(activeSource);
      renderColumnStatus(activeSource);
      renderPreview(activeSource);
    }
    if (changed) invalidateResults();
    if (els.configNote) {
      els.configNote.textContent = `读入 ${valid.length} 条列设置，${applied} 张当前表已套用。`;
    }
    showToast(`列设置已载入（${valid.length} 张表）${applied ? `，当前有 ${applied} 张表套上了` : ''}${changed ? '；列的位置变了，回到上面重新点「开始对账」' : ''}`);
  };
  reader.onerror = () => showToast('这个文件打不开，请重新导出一份', true);
  reader.readAsText(file, 'utf-8');
}

function mergeConfigProfiles(profiles) {
  const map = new Map();
  (state.configProfiles || []).forEach((item) => {
    if (item && item.signature) map.set(item.signature, item);
  });
  profiles.forEach((item) => {
    if (item && item.signature) map.set(item.signature, item);
  });
  state.configProfiles = Array.from(map.values());
}

function sourceConfigStamp(source) {
  return [
    source.mapping.company, source.mapping.amount, source.mapping.direction, source.mapping.memo,
    (sourceAgeColumn(source) || { index: -1 }).index,
    (sourceDimensionColumn(source, 'entity') || { index: -1 }).index,
    (sourceDimensionColumn(source, 'currency') || { index: -1 }).index,
    source.unit, source.directionOverride, source.directionColumnManual ? 1 : 0,
    source.columnWindow ? `${source.columnWindow.from}-${source.columnWindow.to}` : '',
    source.dataRange ? `${source.dataRange.fromRow}-${source.dataRange.toRow}-${source.dataRange.manual ? 1 : 0}` : ''
  ].join('|');
}

function applyProfilesToSources() {
  let applied = 0;
  let changed = false;
  state.sources.forEach((source) => {
    const before = sourceConfigStamp(source);
    const profile = applyConfigProfile(source);
    if (!profile) return;
    source.profileUsed = profile;
    syncHeaderLabels(source);
    refreshSourceInference(source);
    refreshSourceSelection(source);
    applied += 1;
    if (sourceConfigStamp(source) !== before) changed = true;
  });
  return { applied, changed };
}

// ===== 列识别、账龄与主体币种 =====

function applyHeaderRow(source, index) {
  source.headerRow = Math.max(0, index);
  source.dataRange = null;
  syncHeaderLabels(source);
  autoMapColumns(source);
  source.dataRange = detectDataRegion(source);
  refreshSourceInference(source);
  refreshSourceSelection(source);
}

function refreshSourceInference(source) {
  const inference = inferDirectionForSource(source);
  source.inferredDirection = inference.direction;
  source.inferenceSource = inference.source;
}

const AGE_BAND_LABEL_RE = /^(\d+\s*(年|个月|月)\s*(以内|以下|内)?)|(\d+\s*[-~至]\s*\d+\s*(年|个月|月))|(\d+\s*年以上)|(逾期\s*\d+\s*天)/;

function amountColumnEvidence(source) {
  const index = source && source.mapping ? source.mapping.amount : -1;
  if (index < 0) return false;
  if (source.profileUsed) return true;
  const label = cleanCell(getHeaderLabels(source)[index]).replace(/\s+/g, '');
  if (AGE_BAND_LABEL_RE.test(label)) return false;
  if (scoreAmountLabel(label) > 0) return true;
  const fmt = columnMoneyFormatRatio(source, index);
  return fmt.numeric >= 2 && fmt.ratio >= 0.5;
}

// 归并企业靠的是「对手方」这一列。表头写着客户／供应商／单位名称，或整列内容确实是公司字号，
// 才算有依据；只有「项目」「科目」这类分析行的表，自动勾进来只会算出一堆假的「企业」。
function companyColumnEvidence(source) {
  const index = source && source.mapping ? source.mapping.company : -1;
  if (index < 0) return false;
  if (source.profileUsed) return true;
  const label = cleanCell(getHeaderLabels(source)[index]).replace(/\s+/g, '');
  if (isInstrumentLabel(label) || SELF_ENTITY_LABEL_RE.test(label)) return false;
  const profile = companyColumnProfile(source, index);
  // 这一列一个名字都没有，就谈不上「对手方列」——表头写得再像也不算依据。
  if (profile.filled === 0) return false;
  if (scoreCompanyLabel(label) >= 9) return true;
  return profile.entityRatio >= 0.3;
}

function isSourceUsable(source) {
  const hasCoreColumns = source.mapping.company >= 0 && source.mapping.amount >= 0;
  const hasDataRows = source.headerRow < source.rows.length - 1;
  return hasCoreColumns && resolveSourceDirection(source).via !== 'none' && hasDataRows;
}

function sourceConfidence(source) {
  const items = [];
  const guessed = new Set(source.guessedFields || []);
  ROLE_FIELDS.forEach((field) => {
    if (source.mapping[field] >= 0 && guessed.has(field)) {
      items.push({ field, text: `${ROLE_LABELS[field]}列是按内容认出的` });
    }
  });
  const direction = resolveSourceDirection(source);
  if (direction.via === 'inferred' && source.inferenceSource === '文件名') {
    items.push({ field: 'direction', text: '整表方向是按文件名认出的' });
  }
  return items;
}

function refreshSourceSelection(source) {
  source.usable = isSourceUsable(source);
  source.noAmount = !source.usable && !sourceHasAnyAmount(source);
  // 重认列、改表头行、重新框选都不动勾选状态 —— 参与不参与始终由人决定，
  // usable / amountDoubt / companyDoubt 只用来在列表上写说明。
}

function refreshSourceShortLabels() {
  const counts = new Map();
  state.sources.forEach((source) => {
    counts.set(source.sheetName, (counts.get(source.sheetName) || 0) + 1);
  });

  state.sources.forEach((source) => {
    source.shortLabel = counts.get(source.sheetName) > 1
      ? `${source.sheetName}（${truncate(fileBaseName(source.fileName), 16)}）`
      : source.sheetName;
  });
}

function fileBaseName(fileName) {
  return String(fileName || '').replace(/\.[^.]+$/, '') || '文件';
}

function getSource(id) {
  return state.sources.find((source) => source.id === id) || null;
}

function getActiveSource() {
  return getSource(state.activeSourceId);
}

function activateSource(id) {
  const source = getSource(id);
  if (!source) return;

  state.activeSourceId = id;
  populateSheetSelect();
  populateHeaderRowSelect(source);
  populateMappingSelects(source);
  els.unitSelect.value = String(source.unit);
  renderSourceList();
  clearPick();
  renderPreview(source);
  renderColumnStatus(source);
  updateFileMeta(source);
  hideRunError();
}

function populateSheetSelect() {
  if (!state.sources.length) {
    els.sheetSelect.innerHTML = '<option value="">（还没有导入）</option>';
    els.sheetSelect.disabled = true;
    return;
  }

  els.sheetSelect.disabled = false;
  els.sheetSelect.innerHTML = state.sources.map((source) => {
    const mark = source.included ? '' : '（未勾选）';
    return `<option value="${source.id}">${escapeHtml(`${source.fileName} · ${source.sheetName}${mark}`)}</option>`;
  }).join('');

  if (getSource(state.activeSourceId)) {
    els.sheetSelect.value = state.activeSourceId;
  } else {
    state.activeSourceId = state.sources[0].id;
    els.sheetSelect.value = state.activeSourceId;
  }
}

function populateHeaderRowSelect(source) {
  const rows = source.rows;
  const limit = Math.min(rows.length, 30);
  let html = '';

  for (let i = 0; i < limit; i += 1) {
    const cells = (rows[i] || []).map(cleanCell).filter(Boolean);
    const preview = truncate(cells.slice(0, 8).join(' · '), 72);
    const rowNumber = source.rowOffset + i + 1;
    html += `<option value="${i}">第 ${rowNumber} 行${preview ? ` · ${escapeHtml(preview)}` : ' · （空行）'}</option>`;
  }

  if (!html) html = '<option value="0">（没有数据）</option>';
  els.headerRowSelect.innerHTML = html;
  els.headerRowSelect.value = String(source.headerRow);
  els.headerRowSelect.disabled = rows.length === 0;
}

function getColumnCount(source) {
  const header = getHeaderLabels(source);
  let count = header.length;
  const end = Math.min(source.rows.length, source.headerRow + 31);

  for (let i = source.headerRow; i < end; i += 1) {
    count = Math.max(count, (source.rows[i] || []).length);
  }

  return Math.min(count, 100);
}

const COUNTERPARTY_LABEL_RE = /客户名称|客户全称|供应商名称|客商名称|客商全称|往来单位|往来客户|往来对象|往来户|对方单位|对方名称|对方公司|债务人|债权人|贷款单位|借款单位|收款单位|付款单位|结算单位|挂账单位/;

// 「核算单位／记账单位／被审计单位」写的是**我们自己的账套主体**，不是对账的对手方。
// 这类列几乎总在底稿第一列，认成企业列会把整张往来表归并成一家，净额全错。
// 只锚末尾：分组表头会把上一行字样拼在前面，精确匹配会漏。
const SELF_ENTITY_LABEL_RE = /(核算单位|记账单位|记帐单位|被审计单位|编制单位|公司代码|法人代码|会计主体|核算主体)$/;

// 「债券名称／基金名称／理财产品名称」这类列写的是金融工具，可单元格偏偏都带着发行公司的字号，
// 靠内容兜底时最容易被当成企业列。宁可让这张表不参与，也不能凭空多出几家「企业」。
const INSTRUMENT_LABEL_RE = /(债券|证券|理财产品|基金|信托计划|资管计划|票据|存单)(名称|品种|全称)$/;

function isInstrumentLabel(label) {
  return INSTRUMENT_LABEL_RE.test(cleanCell(label).replace(/\s+/g, ''));
}

function scoreCompanyLabel(text) {
  if (!text) return 0;
  if (/经费|薪酬|社保|公积金|税额|税金|准备|账龄|序号|日期|金额|余额|合计|小计|比率|比例|利率|汇率/.test(text)) return 0;
  if (SELF_ENTITY_LABEL_RE.test(text)) return 0;
  if (isInstrumentLabel(text)) return 0;
  // 底稿里「公司代码／公司名称」是**我们自己的主体**，「客户名称／供应商名称」才是对账的对手方。
  // 两边同时出现时必须选后者，否则整张往来余额表会被归并成一家。
  if (COUNTERPARTY_LABEL_RE.test(text)) return 10;
  if (/企业名称|公司名称|单位名称/.test(text)) return 9;
  if (/客户|供应商|客商|往来/.test(text) && !/编号|代码|编码|号码|账号|号$/.test(text)) return 9;
  if (PERSON_LABEL_RE.test(text)) return 9;
  if (/企业|公司|单位|客户|供应商|往来|名称/.test(text)) return 6;
  if (/欠款|借款|出借|对手|付款方|收款方|甲方|乙方/.test(text)) return 6;
  if (/项目名称|项目明细|项目/.test(text)) return 4;
  if (/对方|商户|业主|房东|个人|挂账/.test(text)) return 4;
  return 0;
}

function scoreAmountLabel(text) {
  if (!text) return 0;
  // 排名、比例、索引号这类列里也是数字，但永远不是金额；底稿的辅助列十有八九是它们。
  if (/排名|序号|笔数|天数|汇率|折算率|比例|占比|百分比|%|索引/.test(text)) return 0;
  if (!/金额|余额|发生额|价税|价款|审定|数目|账面价值|公允价值|净额|额度/.test(text)) return 0;

  let score = 3;
  if (/期末余额|期末金额|期末数|账面余额|价税合计|应收金额|应付金额|应收余额|应付余额|应收账款|应付账款|本期金额|发生额/.test(text)) score = 8;
  else if (/余额|发生额|价税|价款|价值|净额/.test(text)) score = 5;
  // 「审定数／审定期末余额」是底稿里最终认账的那一列，对账就要用它
  if (/审定/.test(text)) score = Math.max(score, 8);

  if (/期初|上年|上期/.test(text)) score -= 6;
  if (/借方|贷方/.test(text)) score -= 4;
  if (/调整|差异/.test(text)) score -= 5;
  // 「合并数／合并抵消后」是抵消掉关联方之后的口径，不是对手方的余额
  if (/合并|抵消|抵销/.test(text)) score -= 5;
  if (/未审|账龄|备注|摘要|税/.test(text)) score -= 2;
  if (/合计|小计|总计/.test(text)) score -= 2;

  return score;
}

function scoreDirectionLabel(text) {
  if (!text) return 0;
  if (/应收应付|收付方向|收支方向|方向|借贷|借款还款/.test(text)) return 9;
  if (/性质|类别|类型/.test(text)) return 5;
  return 0;
}

function scoreMemoLabel(text) {
  if (!text) return 0;
  if (/摘要|备注|说明|事由|用途|业务内容/.test(text)) return 7;
  if (/凭证|单号|日期|期间/.test(text)) return 4;
  return 0;
}

function getMapColumnBounds(source) {
  const count = getColumnCount(source);
  const win = source && source.columnWindow;
  if (!win) return { from: 0, to: count - 1 };
  const from = Math.max(0, Math.min(win.from, count - 1));
  const to = Math.max(from, Math.min(win.to, count - 1));
  return { from, to };
}

function autoMapColumns(source) {
  const labels = getHeaderLabels(source);
  const bounds = getMapColumnBounds(source);
  const used = new Set();

  const pick = (scoreFor, accept) => {
    const candidates = [];

    for (let i = bounds.from; i <= bounds.to; i += 1) {
      if (used.has(i)) continue;
      const labelScore = scoreFor(cleanCell(labels[i]).replace(/\s+/g, ''));
      if (labelScore > 0) candidates.push({ index: i, labelScore });
    }

    candidates.sort((a, b) => b.labelScore - a.labelScore || a.index - b.index);

    for (const candidate of candidates) {
      if (accept(candidate.index, candidate.labelScore)) {
        used.add(candidate.index);
        return candidate.index;
      }
    }

    return -1;
  };

  let company = pick(scoreCompanyLabel, (index, labelScore) => {
    const stats = columnRatio(source, index, (cell) => parseAmount(cell) === null);
    // 整列空着的候选直接出局：底稿里「与供应商对账情况」「发函情况」这类列是留着人填的，
    // 表头带「供应商」却被当成企业列，勾进来只能算出 0 笔。
    if (stats.filled === 0) return false;
    if (stats.filled >= 2) return stats.ratio >= 0.6;
    return labelScore >= 9;
  });

  let amount = pick(scoreAmountLabel, (index, labelScore) => {
    const stats = columnRatio(source, index, (cell) => parseAmount(cell) !== null);
    if (stats.filled >= 1 && stats.ratio >= 0.6) return true;
    // 「期末审定数」这类余额列常被「一、合并范围内」这种小节行掺进文字，数字占比会掉到 0.6 以下。
    // 表头已经明写余额／审定（强分值）且确实有一堆数字时仍然认它，别让它输给水写的「本期贷方发生额」。
    return labelScore >= 8 && stats.filled >= 2 && stats.ratio >= 0.4;
  });

  const direction = pick(scoreDirectionLabel, (index) => {
    if (/借方|贷方/.test(cleanCell(labels[index]))) return false;
    const stats = columnRatio(source, index, (cell) => parseDirection(cell) !== '');
    return stats.filled >= 1 && stats.ratio >= 0.6;
  });

  let memo = pick(scoreMemoLabel, () => true);

  const guessed = [];
  if (company < 0) {
    company = guessCompanyColumn(source, used);
    if (company >= 0) guessed.push('company');
  }
  if (amount < 0) {
    amount = guessAmountColumn(source, used);
    if (amount >= 0) guessed.push('amount');
  }

  source.mapping = { company, amount, direction, memo };
  source.guessedFields = guessed;
  source.directionColumnManual = false;
  source.unit = detectUnitForSource(source, labels);
  refreshDimensionColumns(source);
}

const ENTITY_HINT_RE = /公司|集团|银行|信用社|合作社|事务所|工作室|商场|超市|酒店|饭店|农场|研究院|研究所|医院|学校|大学|商户|个体|事业部|分公司|门市部|经营部|粮油站|供销站|中心/;

const NOISE_LABEL_RE = /序号|编号|代码|占比|比例|汇率|数量|单价|账龄|天数|笔数|税额|税率|日期|期间|年度|月份|行号|页次|页码|电话|传真|地址|统一社会|信用代码|注册号|证件|身份证|银行账号|账号|开户行|科目|凭证号|单据号/;

function guessCompanyColumn(source, used) {
  const labels = getHeaderLabels(source);
  const bounds = getMapColumnBounds(source);
  let best = { index: -1, entityRatio: 0, textRatio: 0 };

  for (let i = bounds.from; i <= bounds.to; i += 1) {
    if (used.has(i)) continue;
    const label = cleanCell(labels[i]).replace(/\s+/g, '');
    if (isInstrumentLabel(label) || SELF_ENTITY_LABEL_RE.test(label)) continue;
    if (scoreMemoLabel(label) >= 7 || scoreAmountLabel(label) > 0 || scoreDirectionLabel(label) >= 9) continue;

    const entity = columnRatio(source, i, (cell) => ENTITY_HINT_RE.test(cell));
    const text = columnRatio(source, i, (cell) => parseAmount(cell) === null);
    if (entity.filled < 1 || entity.ratio < 0.3 || text.ratio < 0.6) continue;

    if (entity.ratio > best.entityRatio || (entity.ratio === best.entityRatio && text.ratio > best.textRatio)) {
      best = { index: i, entityRatio: entity.ratio, textRatio: text.ratio };
    }
  }

  if (best.index >= 0) {
    used.add(best.index);
    return best.index;
  }

  // 整列都是「不像数字、也不像日期」的文字时，按最靠左的原则认作名称列（欠款人、经办人之类）
  for (let i = bounds.from; i <= bounds.to; i += 1) {
    if (used.has(i)) continue;
    const label = cleanCell(labels[i]).replace(/\s+/g, '');
    if (scoreMemoLabel(label) >= 7 || scoreAmountLabel(label) > 0 || scoreDirectionLabel(label) >= 9) continue;
    if (isInstrumentLabel(label) || SELF_ENTITY_LABEL_RE.test(label)) continue;
    if (NOISE_LABEL_RE.test(label)) continue;

    const profile = companyColumnProfile(source, i);
    if (profile.filled < 3) continue;
    if (profile.textRatio < 0.7 || profile.distinctRatio < 0.6) continue;
    if (profile.dateRatio >= 0.3 || profile.seqRatio >= 0.5) continue;
    if (profile.avgLen < 2 || profile.avgLen > 30) continue;

    used.add(i);
    return i;
  }

  return -1;
}

function guessAmountColumn(source, used) {
  const labels = getHeaderLabels(source);
  const bounds = getMapColumnBounds(source);
  const rows = sampleRowBounds(source);
  let best = { index: -1, ratio: 0, nonZero: 0, money: 0 };

  for (let i = bounds.from; i <= bounds.to; i += 1) {
    if (used.has(i)) continue;
    if (NOISE_LABEL_RE.test(cleanCell(labels[i]).replace(/\s+/g, ''))) continue;
    if (AGE_BAND_LABEL_RE.test(cleanCell(labels[i]).replace(/\s+/g, ''))) continue;

    let filled = 0;
    let hits = 0;
    let nonZero = 0;
    const integers = new Set();
    let allSmallInt = true;

    for (let r = rows.from; r <= rows.to; r += 1) {
      const cell = cleanCell((source.rows[r] || [])[i]);
      if (isPlaceholderCell(cell)) continue;
      filled += 1;
      const value = parseAmount(cell);
      if (value === null) continue;
      hits += 1;
      if (value !== 0) nonZero += 1;
      if (!Number.isInteger(value) || value < 1 || value > 9999) allSmallInt = false;
      else integers.add(value);
    }

    if (!filled) continue;
    const ratio = hits / filled;
    if (ratio < 0.6 || nonZero < 1) continue;
    if (allSmallInt && integers.size === hits && Math.max(...integers) <= hits + 2) continue;

    const fmt = columnMoneyFormatRatio(source, i);
    const money = fmt.numeric >= 2 ? fmt.ratio : 0;
    const better = money > best.money
      || (money === best.money && ratio > best.ratio)
      || (money === best.money && ratio === best.ratio && nonZero > best.nonZero)
      || (money === best.money && ratio === best.ratio && nonZero === best.nonZero && i > best.index);
    if (better) best = { index: i, ratio, nonZero, money };
  }

  if (best.index >= 0) used.add(best.index);
  return best.index;
}

// 这张表里到底有没有金额。用于把「列没认准」和「这张表本来就没有金额」分开告诉用户——
// 后者是常见的往来情况表（整列都是横线），不该让人去确认一个根本不存在的列。
// 这里要扫整张表而不是认列时的那 40 行样本：真实底稿里有的一张 200 多行全是横线、
// 只有最后一行填了数，按样本说「没有金额」就是假话。序号、日期这类列不算金额。
function sourceHasAnyAmount(source) {
  const labels = getHeaderLabels(source);
  const usedColumns = [];
  for (let c = 0; c < labels.length; c += 1) {
    if (NOISE_LABEL_RE.test(cleanCell(labels[c]).replace(/\s+/g, ''))) continue;
    usedColumns.push(c);
  }
  for (let r = source.headerRow + 1; r < source.rows.length; r += 1) {
    const row = source.rows[r] || [];
    for (let i = 0; i < usedColumns.length; i += 1) {
      const cell = cleanCell(row[usedColumns[i]]);
      if (!cell || isPlaceholderCell(cell)) continue;
      const value = parseAmount(cell);
      if (value !== null && value !== 0) return true;
    }
  }
  return false;
}

function detectUnitForSource(source, labels) {
  const amountLabel = cleanCell(labels[source.mapping.amount] || '');
  if (/万元/.test(amountLabel)) return 10000;
  if (/千元/.test(amountLabel)) return 1000;

  const above = [];
  for (let i = 0; i < source.headerRow; i += 1) {
    above.push((source.rows[i] || []).map(cleanCell).join(' '));
  }
  const head = above.join(' ');

  if (/单位[:：]\s*(人民币)?万元|[（(]\s*万元\s*[)）]/.test(head)) return 10000;
  if (/单位[:：]\s*(人民币)?千元|[（(]\s*千元\s*[)）]/.test(head)) return 1000;
  return 1;
}

const AGE_CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function cnNumberToNumber(text) {
  const value = cleanCell(text);
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value === '半') return 0.5;

  let total = 0;
  let rest = value;
  const tenAt = value.indexOf('十');
  if (tenAt >= 0) {
    if (tenAt > 1) return null;
    if (tenAt === 1 && AGE_CN_DIGITS[value[0]] === undefined) return null;
    total = (tenAt === 0 ? 1 : AGE_CN_DIGITS[value[0]]) * 10;
    rest = value.slice(tenAt + 1);
  }
  if (rest === '半') total += 0.5;
  else if (rest) {
    if (rest.length !== 1 || AGE_CN_DIGITS[rest] === undefined) return null;
    total += AGE_CN_DIGITS[rest];
  }
  return total;
}

function ageUnitKey(text) {
  if (text === '天' || text === '日') return 'days';
  if (text === '年') return 'years';
  return 'months';
}

function ageUnitToMonths(count, unit) {
  if (!Number.isFinite(count) || count < 0) return null;
  if (unit === 'days') return (count * 12) / 365;
  if (unit === 'years') return count * 12;
  return count;
}

function ageBandPreset() {
  return AGE_BAND_PRESETS[state.ageBandPreset] || AGE_BAND_PRESETS.year;
}

function applyAgeBandPreset(presetId) {
  state.ageBandPreset = AGE_BAND_PRESETS[presetId] ? presetId : 'year';
  const preset = ageBandPreset();
  AGE_BANDS.length = 0;
  preset.bands.forEach((label) => AGE_BANDS.push(label));
}

function ageBandIndex(months) {
  if (!Number.isFinite(months) || months < 0) return -1;
  const ends = ageBandPreset().ends;
  for (let i = 0; i < ends.length; i += 1) {
    if (months < ends[i]) return i;
  }
  return ends.length;
}

function ageBandLabel(band) {
  return band >= 0 && band < AGE_BANDS.length ? AGE_BANDS[band] : '';
}

function recordAgeMonths(record, baseIso) {
  if (Number.isFinite(record.ageMonths)) return record.ageMonths;
  if (record.ageDateISO) return ageDateToMonths(record.ageDateISO, baseIso);
  return null;
}

function recordAgeBand(record, baseIso) {
  if (record.ageBand >= 0) return record.ageBand;
  const months = recordAgeMonths(record, baseIso);
  return months === null ? -1 : ageBandIndex(months);
}

function parseAgeDateText(value) {
  const text = toHalfWidth(cleanCell(value)).replace(/\s+/g, '');
  if (!text) return '';

  let match = AGE_DATE_RE.exec(text);
  let year = match ? Number(match[1]) : 0;
  let month = match ? Number(match[2]) : 0;
  let day = match ? Number(match[3]) : 1;

  if (!match) {
    match = AGE_YM_RE.exec(text);
    if (match) {
      year = Number(match.groups.y);
      month = Number(match.groups.mo);
      day = 1;
    }
  }
  if (!match) return '';
  if (year < 1900 || year > 2999 || month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function ageDateToMonths(isoDate, baseIsoDate) {
  if (!isoDate || !baseIsoDate) return null;
  const from = parseAgeDateParts(isoDate);
  const to = parseAgeDateParts(baseIsoDate);
  if (!from || !to) return null;
  const whole = (to.year - from.year) * 12 + (to.month - from.month) + (to.day - from.day) / 30;
  return whole > 0 ? whole : 0;
}

function parseAgeDateParts(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function parseAgeCell(value, unitHint) {
  const text = toHalfWidth(cleanCell(value)).replace(/\s+/g, '');
  if (!text || isPlaceholderCell(text)) return null;

  const isoDate = parseAgeDateText(text);
  if (isoDate) return { form: 'date', band: -1, months: null, date: isoDate };

  let match = AGE_BAND_RE.exec(text);
  if (match) {
    const low = Number(match.groups.lo);
    const cap = match.groups.cap;
    const months = cap === '以内' || cap === '内' || cap === '以下' ? low * 12 - 0.01 : low * 12;
    return { form: 'band', band: ageBandIndex(months), months, date: '' };
  }

  match = AGE_RANGE_RE.exec(text);
  if (match) {
    const months = ageUnitToMonths(Number(match.groups.lo), ageUnitKey(match.groups.unit));
    return { form: 'band', band: ageBandIndex(months), months, date: '' };
  }

  match = AGE_CN_RE.exec(text);
  if (match) {
    const count = cnNumberToNumber(match.groups.num);
    if (count !== null) {
      const months = ageUnitToMonths(count, ageUnitKey(match.groups.unit.replace(/^个/, '')));
      const cap = match.groups.cap;
      const adjusted = cap === '以内' || cap === '内' || cap === '以下' ? months - 0.01 : months;
      return { form: 'band', band: ageBandIndex(adjusted), months: adjusted, date: '' };
    }
  }

  match = AGE_SINGLE_RE.exec(text);
  if (match) {
    const low = Number(match.groups.lo);
    const unit = match.groups.unit;
    const cap = match.groups.cap;
    if (!Number.isFinite(low) || low > 20000) return null;
    if (!unit && !cap && !unitHint) return null;
    const months = ageUnitToMonths(low, unit ? ageUnitKey(unit) : unitHint || 'days');
    const adjusted = cap === '以内' || cap === '内' || cap === '以下' ? months - 0.01 : months;
    if (!unit && !cap) return { form: 'number', band: -1, months, date: '' };
    return { form: 'band', band: ageBandIndex(adjusted), months: adjusted, date: '' };
  }

  return null;
}

function ageUnitHintFromLabel(label) {
  const text = cleanCell(label).replace(/\s+/g, '');
  if (!text) return '';
  if (/天\s*[）)]|天数|逾期|超期/.test(text)) return 'days';
  if (/月\s*[）)]|个月/.test(text)) return 'months';
  if (/年\s*[）)]|年限/.test(text)) return 'years';
  return '';
}

function ageKindText(age) {
  if (age.kind === 'band') return '按原表写的档位';
  if (age.kind === 'date') return `按日期算到 ${ageBaseDateValue()}`;
  return `按${age.unit === 'years' ? '年数' : age.unit === 'months' ? '月数' : '天数'}折算`;
}

function ageColumnProfile(source, index, unitHint) {
  const bounds = sampleRowBounds(source);
  const stats = { filled: 0, band: 0, date: 0, number: 0, maxNumber: 0 };

  for (let r = bounds.from; r <= bounds.to; r += 1) {
    if (isHiddenRow(source, r)) continue;
    const text = cleanCell((source.rows[r] || [])[index]);
    if (isPlaceholderCell(text)) continue;
    stats.filled += 1;

    const parsed = parseAgeCell(text, unitHint);
    if (!parsed) continue;
    stats[parsed.form] += 1;
    if (parsed.form === 'number') {
      const raw = Number(toHalfWidth(text).replace(/\s+/g, ''));
      if (Number.isFinite(raw)) stats.maxNumber = Math.max(stats.maxNumber, raw);
    }
  }

  return stats;
}

function ageKindFromStats(stats, hasAgeLabel) {
  if (!stats.filled) return null;
  if (stats.band / stats.filled >= 0.6) return 'band';
  if (stats.date / stats.filled >= 0.6) return hasAgeLabel ? 'date' : null;
  if (stats.number / stats.filled >= 0.6) return hasAgeLabel ? 'number' : null;
  return null;
}

function ageKindScore(kind, stats) {
  const ratio = stats[kind] / stats.filled;
  const base = kind === 'band' ? 40 : kind === 'date' ? 20 : 10;
  return base + ratio * 10;
}

function detectAgeColumn(source) {
  const labels = getHeaderLabels(source);
  const bounds = getMapColumnBounds(source);
  const taken = new Set(ROLE_FIELDS.map((field) => source.mapping[field]).filter((i) => i >= 0));

  let best = null;
  for (let i = bounds.from; i <= bounds.to; i += 1) {
    if (taken.has(i)) continue;
    const label = cleanCell(labels[i]).replace(/\s+/g, '');
    const hint = ageUnitHintFromLabel(label);
    const stats = ageColumnProfile(source, i, hint);
    const hasAgeLabel = AGE_LABEL_RE.test(label);
    const kind = ageKindFromStats(stats, hasAgeLabel);
    if (!kind) continue;
    if (kind === 'number' && (stats.maxNumber < 1 || stats.maxNumber > 3650)) continue;
    if (kind === 'number' && !AGE_NUM_LABEL_RE.test(label)) continue;

    const score = ageKindScore(kind, stats) + (hasAgeLabel ? 5 : 0);
    if (!best || score > best.score || (score === best.score && i < best.index)) {
      best = { index: i, kind, score };
    }
  }

  if (!best) return null;
  return describeAgeColumn(source, best.index, best.kind, false);
}

function describeAgeColumn(source, index, kind, manual) {
  const labels = getHeaderLabels(source);
  const label = cleanCell(labels[index]).replace(/\s+/g, '') || '（空表头）';
  const hint = ageUnitHintFromLabel(label);
  const stats = ageColumnProfile(source, index, hint);
  const detected = kind && kind !== 'number' ? kind : ageKindFromStats(stats, true) || 'number';
  let unit = '';
  if (detected === 'number') {
    unit = hint || (stats.maxNumber > 31 ? 'days' : 'months');
  }

  return {
    index,
    kind: detected,
    unit,
    label,
    manual: Boolean(manual),
    hits: stats[detected] || 0,
    filled: stats.filled
  };
}

function ageColumnStamp(source) {
  const mapping = source.mapping || {};
  const win = source.columnWindow;
  const range = source.dataRange;
  return [
    source.headerRow,
    mapping.company, mapping.amount, mapping.direction, mapping.memo,
    win ? `${win.from}-${win.to}` : '',
    range ? `${range.fromRow}-${range.toRow}-${range.manual ? 1 : 0}` : '',
    (source.rows || []).length
  ].join('|');
}

function sourceAgeColumn(source) {
  if (!source || !source.rows || !source.rows.length) return null;
  const stamp = ageColumnStamp(source);
  const held = source.ageColumn;

  if (held && held.index >= 0) {
    const taken = new Set(ROLE_FIELDS.map((field) => source.mapping[field]).filter((i) => i >= 0));
    if (held.manual) {
      if (!taken.has(held.index)) return held;
    } else if (held.stamp === stamp && !taken.has(held.index)) {
      return held;
    }
  } else if (held && (held.manual || held.stamp === stamp)) {
    return null;
  }

  const found = detectAgeColumn(source);
  source.ageColumn = found
    ? Object.assign(found, { stamp })
    : { index: -1, kind: '', unit: '', label: '', manual: false, stamp };
  return found;
}

function setSourceAgeColumn(source, index) {
  if (!source) return null;
  const picked = Number(index);
  if (!Number.isFinite(picked) || picked < 0) {
    source.ageColumn = { index: -1, kind: '', unit: '', label: '', manual: true, stamp: ageColumnStamp(source) };
    return null;
  }
  const label = cleanCell(getHeaderLabels(source)[picked]);
  const stats = ageColumnProfile(source, picked, ageUnitHintFromLabel(label));
  const kind = ageKindFromStats(stats, true) || 'number';
  source.ageColumn = Object.assign(describeAgeColumn(source, picked, kind, true), { stamp: ageColumnStamp(source) });
  return source.ageColumn;
}

// 主体／币种是可选的第五、第六个角色：不映射进 mapping，单独挂在 source 上，
// 这样老表（没有这两列）的分组键、指纹和导出列完全不变。
const DIMENSION_FIELDS = ['entity', 'currency'];
// 「公司代码描述」是 SAP 导出里「公司名称」的另一种写法，两张表常常一张写这个、一张写那个。
const ENTITY_COLUMN_LABEL_RE = /^(核算)?主体(名称)?$|^账套$|^所属(公司|单位|主体)$|^法人(主体)?$|^报送主体$|^编制单位$|^公司(名称|简称|代码描述|代码名称)$|^单位名称$|^核算单位$|^记[账帐]单位$|^被审计单位$/;
const CURRENCY_COLUMN_LABEL_RE = /币种|币别|货币|原币|currency/i;
const CURRENCY_LABELS = {
  CNY: '人民币', USD: '美元', EUR: '欧元', HKD: '港币', JPY: '日元',
  GBP: '英镑', AUD: '澳元', CAD: '加元', SGD: '新加坡元', CHF: '瑞士法郎'
};
const CURRENCY_SYMBOLS = {
  CNY: '¥', USD: '$', EUR: '€', HKD: 'HK$', JPY: 'JP¥', GBP: '£',
  AUD: 'A$', CAD: 'C$', SGD: 'S$', CHF: 'CHF '
};
const CURRENCY_ALIASES = {
  CNY: ['人民币', '人民币元', '元', 'rmb', 'cny', '¥', '￥'],
  USD: ['美元', '美金', 'usd', '$', 'us$'],
  EUR: ['欧元', 'eur', '€'],
  HKD: ['港币', '港元', 'hkd', 'hk$', 'hkd$'],
  JPY: ['日元', '日圆', 'jpy', 'jp¥', 'jpy¥'],
  GBP: ['英镑', 'gbp', '£'],
  AUD: ['澳元', 'aud', 'a$'],
  CAD: ['加元', 'cad', 'c$'],
  SGD: ['新加坡元', 'sgd', 's$'],
  CHF: ['瑞士法郎', 'chf']
};

function normalizeCurrencyKey(value) {
  const text = toHalfWidth(cleanCell(value)).replace(/\s+/g, '').replace(/[（）()【】\[\]]/g, '');
  if (!text || isPlaceholderCell(text)) return '';
  const upper = text.toUpperCase();
  const found = Object.keys(CURRENCY_ALIASES).find((key) =>
    CURRENCY_ALIASES[key].some((alias) => alias.toUpperCase() === upper));
  if (found) return found;
  if (/^人民币/.test(upper)) return 'CNY';
  if (/^(美元|美金)/.test(upper)) return 'USD';
  if (/^欧元/.test(upper)) return 'EUR';
  if (/^港[币元]/.test(upper)) return 'HKD';
  if (/^日[元圆]/.test(upper)) return 'JPY';
  if (/^英镑/.test(upper)) return 'GBP';
  if (/^[A-Z]{3}$/.test(upper)) return upper;
  return '';
}

function currencyKeyOf(value) {
  const raw = displayRawName(value);
  if (!raw || isPlaceholderCell(raw)) return '';
  return normalizeCurrencyKey(raw) || `X:${raw.slice(0, 12)}`;
}

function currencyLabelForKey(key, fallback) {
  if (!key) return '';
  if (key.startsWith('X:')) return key.slice(2);
  return CURRENCY_LABELS[key] || fallback || key;
}

function currencySymbolOf(key) {
  return CURRENCY_SYMBOLS[key] || '';
}

function fmtMoneyIn(cents, currencyKey) {
  const amount = moneyFormatter.format(Math.abs(cents || 0) / 100);
  const symbol = currencySymbolOf(currencyKey);
  if (symbol) return `${symbol}${amount}`;
  const label = currencyLabelForKey(currencyKey, '');
  return label ? `${label} ${amount}` : `¥${amount}`;
}

function dimensionColumnKeys(field) {
  return field === 'entity' ? 'entityColumn' : 'currencyColumn';
}

function dimensionTakenColumns(source, field) {
  const taken = new Set(ROLE_FIELDS.map((role) => source.mapping[role]).filter((index) => index >= 0));
  const age = sourceAgeColumn(source);
  if (age) taken.add(age.index);
  const otherField = field === 'entity' ? 'currency' : 'entity';
  const other = source[dimensionColumnKeys(otherField)];
  if (other && other.index >= 0) taken.add(other.index);
  return taken;
}

function currencyColumnProfile(source, index) {
  const bounds = sampleRowBounds(source);
  let filled = 0;
  let hits = 0;
  for (let r = bounds.from; r <= bounds.to; r += 1) {
    if (isHiddenRow(source, r)) continue;
    const text = cleanCell((source.rows[r] || [])[index]);
    if (!text || isPlaceholderCell(text)) continue;
    filled += 1;
    if (normalizeCurrencyKey(text)) hits += 1;
  }
  return { filled, hits, ratio: filled ? hits / filled : 0 };
}

function detectDimensionColumn(source, field) {
  const labels = getHeaderLabels(source);
  const bounds = getMapColumnBounds(source);
  const taken = dimensionTakenColumns(source, field);

  for (let i = bounds.from; i <= bounds.to; i += 1) {
    if (taken.has(i)) continue;
    const label = cleanCell(labels[i]).replace(/\s+/g, '');
    if (!label) continue;

    if (field === 'entity') {
      const bareUnit = label === '单位';
      if (!bareUnit && !ENTITY_COLUMN_LABEL_RE.test(label)) continue;
      if (/金额|余额|编号|号$/.test(label)) continue;
      // 「公司代码／法人代码」这类编码列留给看得懂的名称列；但「公司代码描述」本身是名称列。
      if (/代码/.test(label) && !/描述|名称$/.test(label)) continue;
      const stats = columnRatio(source, i, (cell) => parseAmount(cell) === null);
      if (stats.filled < 1 || stats.ratio < 0.6) continue;
      if (bareUnit) {
        // 裸「单位」既可能是「金额单位：元」，也可能是核算主体；只有整列写着公司名才认。
        const entity = columnRatio(source, i, (cell) => ENTITY_HINT_RE.test(cell));
        if (entity.filled < 1 || entity.ratio < 0.5) continue;
      }
      return { index: i, label, manual: false };
    }

    if (!CURRENCY_COLUMN_LABEL_RE.test(label)) continue;
    if (/金额|余额|汇率|折算/.test(label)) continue;
    const profile = currencyColumnProfile(source, i);
    if (profile.filled < 1 || profile.ratio < 0.6) continue;
    return { index: i, label, manual: false };
  }
  return null;
}

function sourceDimensionColumn(source, field) {
  if (!source || !source.rows || !source.rows.length) return null;
  const key = dimensionColumnKeys(field);
  const held = source[key];
  const stamp = ageColumnStamp(source);

  if (held && held.index >= 0) {
    const taken = dimensionTakenColumns(source, field);
    if (held.manual) {
      if (!taken.has(held.index)) return held;
    } else if (held.stamp === stamp && !taken.has(held.index)) {
      return held;
    }
  } else if (held && (held.manual || held.stamp === stamp)) {
    return null;
  }

  const found = detectDimensionColumn(source, field);
  source[key] = found
    ? Object.assign(found, { stamp })
    : { index: -1, label: '', manual: false, stamp };
  return found;
}

function setSourceDimensionColumn(source, field, index) {
  if (!source) return null;
  const key = dimensionColumnKeys(field);
  const picked = Number(index);
  if (!Number.isFinite(picked) || picked < 0) {
    source[key] = { index: -1, label: '', manual: true, stamp: ageColumnStamp(source) };
    return null;
  }
  const label = cleanCell(getHeaderLabels(source)[picked]).replace(/\s+/g, '');
  source[key] = { index: picked, label, manual: true, stamp: ageColumnStamp(source) };
  return source[key];
}

function refreshDimensionColumns(source) {
  if (!source || !source.rows || !source.rows.length) return;
  const stamp = ageColumnStamp(source);
  DIMENSION_FIELDS.forEach((field) => {
    const key = dimensionColumnKeys(field);
    const held = source[key];
    if (held && held.manual) {
      held.stamp = stamp;
      return;
    }
    source[key] = null;
    const found = sourceDimensionColumn(source, field);
    if (found) found.stamp = stamp;
  });
}

const DIMENSION_FIELD_LABELS = { entity: '主体', currency: '币种' };

// 只有部分表认出了主体／币种时，同一家企业会被拆成「有主体」和「（未注明）」两组，
// 两边永远配不上，而这个错在结果里看不出来。所以一次对账里要么全用、要么全不用。
// 人工指定的那张表尊重用户，只把机器自己认出来的收回来。
function harmonizeAutoDimensionColumns(sources) {
  const notes = [];
  DIMENSION_FIELDS.forEach((field) => {
    const found = [];
    let missing = 0;
    sources.forEach((source) => {
      const column = sourceDimensionColumn(source, field);
      if (column && column.index >= 0) found.push({ source, column });
      else missing += 1;
    });
    if (!found.length || !missing) return;
    const auto = found.filter((item) => !item.column.manual);
    if (!auto.length) return;
    const key = dimensionColumnKeys(field);
    auto.forEach((item) => {
      item.source[key] = { index: -1, label: '', manual: false, stamp: ageColumnStamp(item.source) };
    });
    const label = DIMENSION_FIELD_LABELS[field];
    const names = auto.map((item) => `「${item.source.shortLabel || item.source.sheetName || '数据源'}」`);
    notes.push({
      field,
      text: `有 ${auto.length} 张表认出了${label}列（${names.slice(0, 2).join('、')}${names.length > 2 ? ' 等' : ''}），但另外 ${missing} 张表没有这一列。这次先不按${label}分开，否则同一家企业会被拆成两组、两边对不上。确实要按${label}分开，就在每张表上都选上同一列，或者在那几张没有这一列的表上把${label}设成同一个值。`
    });
  });
  return notes;
}

function dimensionGroupKey(baseKey, entityKey, currencyKey) {
  const parts = [];
  if (entityKey) parts.push(`e:${entityKey}`);
  if (currencyKey) parts.push(`c:${currencyKey}`);
  return parts.length ? `${parts.join('\u0001')}\u0002${baseKey}` : baseKey;
}

function ageBaseDateValue() {
  return state.ageBaseDate || todayIsoDate();
}

function anyAgeColumn() {
  return state.sources.some((source) => source.included && sourceAgeColumn(source) !== null);
}

function populateMappingSelects(source) {
  const headers = getHeaderLabels(source);
  const columnCount = getColumnCount(source);

  const buildOptions = (emptyLabel) => {
    let html = `<option value="-1">${escapeHtml(emptyLabel)}</option>`;
    for (let i = 0; i < columnCount; i += 1) {
      const header = cleanCell(headers[i]);
      const label = `${XLSX.utils.encode_col(i)} 列${header ? ` · ${truncate(header, 28)}` : ' · （空表头）'}`;
      html += `<option value="${i}">${escapeHtml(label)}</option>`;
    }
    return html;
  };

  const fields = [
    ['company', els.companyCol, '请选择列'],
    ['amount', els.amountCol, '请选择列'],
    ['direction', els.directionCol, '不使用（按表名/整表识别）'],
    ['memo', els.memoCol, '不使用']
  ];

  fields.forEach(([key, select, emptyLabel]) => {
    select.innerHTML = buildOptions(emptyLabel);
    const value = String(source.mapping[key]);
    const hasOption = Array.from(select.options).some((option) => option.value === value);
    select.value = hasOption ? value : '-1';
  });

  if (els.ageCol) {
    els.ageCol.innerHTML = buildOptions('不用账龄');
    const age = sourceAgeColumn(source);
    const value = String(age ? age.index : -1);
    const hasOption = Array.from(els.ageCol.options).some((option) => option.value === value);
    els.ageCol.value = hasOption ? value : '-1';
  }

  [['entity', els.entityCol, '不用主体'], ['currency', els.currencyCol, '不用币种']].forEach(([field, select, emptyLabel]) => {
    if (!select) return;
    select.innerHTML = buildOptions(emptyLabel);
    const dimension = sourceDimensionColumn(source, field);
    const value = String(dimension ? dimension.index : -1);
    const hasOption = Array.from(select.options).some((option) => option.value === value);
    select.value = hasOption ? value : '-1';
  });
}

function inferDirectionFromText(value) {
  const text = toHalfWidth(cleanCell(value)).replace(/\s+/g, '');
  if (!text) return '';

  const recv = /应收|收款|回款|预收|客户往来|销售往来/.test(text);
  const pay = /应付|付款|预付|供应商往来|采购往来/.test(text);

  if (recv && !pay) return 'recv';
  if (pay && !recv) return 'pay';
  return '';
}

function inferDirectionForSource(source) {
  const fromSheet = inferDirectionFromText(source.sheetName);
  if (fromSheet) return { direction: fromSheet, source: '工作表名' };

  for (let i = 0; i < source.headerRow; i += 1) {
    const title = (source.rows[i] || []).map(cleanCell).filter(Boolean).join(' ');
    const fromTitle = inferDirectionFromText(title);
    if (fromTitle) return { direction: fromTitle, source: '标题行' };
  }

  const fromFile = inferDirectionFromText(fileBaseName(source.fileName));
  if (fromFile) return { direction: fromFile, source: '文件名' };
  return { direction: '', source: '' };
}

function resolveSourceDirection(source) {
  if (source.directionOverride === 'recv' || source.directionOverride === 'pay') {
    return {
      dir: source.directionOverride,
      label: `整表${dirLabel(source.directionOverride)}`,
      tone: source.directionOverride,
      via: 'override'
    };
  }

  if (source.mapping.direction >= 0) {
    return {
      dir: source.inferredDirection || '',
      label: '方向列',
      tone: 'column',
      via: 'column'
    };
  }

  if (source.inferredDirection) {
    return {
      dir: source.inferredDirection,
      label: `${dirLabel(source.inferredDirection)} · ${source.inferenceSource}`,
      tone: source.inferredDirection,
      via: 'inferred'
    };
  }

  return { dir: '', label: '未识别方向', tone: 'unknown', via: 'none' };
}

function fallbackDirectionForSource(source) {
  if (source.directionOverride === 'recv' || source.directionOverride === 'pay') {
    return source.directionOverride;
  }
  return source.inferredDirection || '';
}

function setAllSourcesIncluded(included) {
  const targets = getVisibleSources();
  if (!targets.length) return;

  targets.forEach((source) => {
    source.included = included;
  });

  renderSourceList();
  populateSheetSelect();
  invalidateResults();

  const scope = state.sourceFilter.trim() ? `筛选出的 ${targets.length} 张` : `全部 ${targets.length} 张`;
  showToast(included ? `已勾选${scope}工作表` : `已取消${scope}工作表，需要哪几张就勾哪几张`);
}

function columnLetter(index) {
  return typeof XLSX !== 'undefined' && XLSX.utils && XLSX.utils.encode_col
    ? XLSX.utils.encode_col(index)
    : `第 ${index + 1} 列`;
}

// ===== 数据源列表、预览与框选 =====

function renderSourceList() {
  const sources = state.sources;
  const needle = state.sourceFilter.trim().toLowerCase();
  const visible = getVisibleSources();
  const included = sources.filter((source) => source.included).length;
  // 「认出了企业名和金额」= 这张表看起来是能对上的，用来告诉人先勾哪几张，不替他勾。
  const suggested = sources.filter((source) => source.usable).length;
  const runCounts = new Map(
    ((state.runInfo && Array.isArray(state.runInfo.sources) ? state.runInfo.sources : [])
      .filter((item) => item && item.id)
      .map((item) => [item.id, Number(item.recordCount)]))
  );

  els.sourceCount.textContent = !sources.length
    ? '—'
    : included
      ? `已选 ${included} / ${sources.length} 张工作表`
      : (suggested
        ? `还没勾选：一共 ${sources.length} 张，其中 ${suggested} 张认出了企业名和金额`
        : `还没勾选：一共 ${sources.length} 张，先把要核对的那几张勾上`);
  els.sourceSelectAll.disabled = !visible.length || visible.every((source) => source.included);
  els.sourceSelectNone.disabled = !visible.length || visible.every((source) => !source.included);
  els.sourceSelectAll.title = needle ? `全选筛选出的 ${visible.length} 张` : '全选所有工作表';
  els.sourceSelectNone.title = needle ? `全不选筛选出的 ${visible.length} 张` : '全不选所有工作表';
  els.sourceFilterNote.textContent = needle
    ? (visible.length ? `筛选出 ${visible.length} / ${sources.length} 张，这时「全选」只作用在筛选出的表上` : '没找到匹配的表，换个词或清空筛选')
    : '';

  if (!sources.length) {
    els.sourceList.innerHTML = '<div class="source-empty">还没有导入工作表。</div>';
    return;
  }

  if (!visible.length) {
    els.sourceList.innerHTML = `<div class="source-empty">没有名字里带「${escapeHtml(needle)}」的工作表。</div>`;
    return;
  }

  // 分批只决定「这里画几行」：全选/全不选、参与对账、图片概览看的都还是完整列表。
  const limit = sourceListLimit(visible);
  els.sourceList.innerHTML = visible.slice(0, limit).map((source) => {
    const direction = resolveSourceDirection(source);
    const active = source.id === state.activeSourceId;
    const rowCount = Math.max(0, source.rows.length - source.headerRow - 1);
    const override = source.directionOverride || 'auto';
    const low = sourceConfidence(source);
    const guessMark = low.length
      ? ` <span class="source-guess" title="${escapeHtml(low.map((item) => item.text).join('；'))}">· ${low.length} 处是猜的</span>`
      : '';
    const doubtReasons = [];
    if (source.amountDoubt) doubtReasons.push('金额列既没写「金额／余额」，格子里也没用金额格式');
    if (source.companyDoubt) doubtReasons.push('企业列看不出是往来的对手方（更像项目、科目这类分析行）');
    const doubtMark = doubtReasons.length
      ? ` <span class="source-guess" title="${escapeHtml(doubtReasons.join('；'))}。这张表要用的话自己勾上，勾之前先点开看一眼那一列对不对。">· 列没把握</span>`
      : '';
    // 刚跑完对账、这张表一笔都没算进去——表在、列在，但那一列其实是空的，最容易看漏。
    const runCount = runCounts.has(source.id) ? runCounts.get(source.id) : null;
    const emptyMark = source.included && runCount === 0
      ? ' <span class="source-empty-run" title="这张表参与了对账，但一笔都没算进去。多半是金额列选到了空白列，或取数范围只剩表头；点开这张表看一眼图片，确实没数据就取消勾选。">· 一笔都没算进去</span>'
      : '';
    // 「企业名和金额各看哪一列」要在列表里直接看得见：一本底稿几十张表，
    // 只有点开的那张能看列状态，人就无法一眼 check 认列认得对不对。
    const labels = getHeaderLabels(source);
    const picked = ['company', 'amount']
      .filter((field) => source.mapping[field] >= 0)
      .map((field) => `${ROLE_LABELS[field]}看 ${columnLetter(source.mapping[field])} 列`
        + `「${escapeHtml(truncate(cleanCell(labels[source.mapping[field]] || '') || '（空表头）', 12))}」`);
    const pickedText = source.usable && picked.length
      ? ` <span class="source-cols">· ${picked.join('，')}</span>`
      : '';

    return `
      <div class="source-row ${active ? 'active' : ''} ${source.included ? '' : 'is-off'}">
        <label class="source-pick" title="参与对账">
          <input type="checkbox" data-act="include" data-id="${source.id}" ${source.included ? 'checked' : ''} aria-label="参与对账：${escapeHtml(source.sheetName)}">
        </label>
        <button type="button" class="source-open" data-act="activate" data-id="${source.id}" title="${escapeHtml(source.label)}">
          <span class="source-name">${highlightMatch(source.sheetName, needle)}</span>
          <span class="source-sub">${escapeHtml(source.fileName)} · 表头第 ${source.rowOffset + source.headerRow + 1} 行 · ${rowCount} 行${source.usable ? `${guessMark}${doubtMark}${emptyMark}${pickedText}` : (source.noAmount ? ' · 这张表里没有金额（整列是横线或空白），不用管它' : ' · 需要手动确认列和方向')}</span>
        </button>
        <span class="source-badge ${direction.tone}" title="${escapeHtml(direction.label)}">${escapeHtml(direction.label)}</span>
        <select class="source-dir" data-act="direction" data-id="${source.id}" aria-label="方向：${escapeHtml(source.sheetName)}">
          <option value="auto" ${override === 'auto' ? 'selected' : ''}>自动识别</option>
          <option value="recv" ${override === 'recv' ? 'selected' : ''}>整表应收</option>
          <option value="pay" ${override === 'pay' ? 'selected' : ''}>整表应付</option>
        </select>
      </div>
    `;
  }).join('') + sourceMoreRow(visible, limit);
}

// 当前点开的那张表必须看得见：它在第 300 行时把上限撑到那一行，
// 而不是让用户点完以后满屏找不到自己刚点了什么。
function sourceListLimit(visible) {
  const base = Number.isFinite(state.sourceLimit) && state.sourceLimit > 0 ? state.sourceLimit : SOURCE_PAGE_SIZE;
  const activeIndex = visible.findIndex((source) => source.id === state.activeSourceId);
  return activeIndex > base ? activeIndex + 1 : base;
}

function sourceMoreRow(visible, limit) {
  const more = visible.length - limit;
  if (more <= 0) return '';
  return `
    <div class="source-more">
      <span>还有 ${more} 张表没列出来（不影响「全选/全不选」，也不影响哪些表参与对账，那边看的始终是这 ${visible.length} 张）</span>
      <button type="button" class="btn btn-sm" data-src-more>再显示 ${Math.min(SOURCE_PAGE_SIZE, more)} 张</button>
      <button type="button" class="btn btn-sm btn-ghost" data-src-all>显示全部</button>
    </div>
  `;
}

function getVisibleSources() {
  const needle = state.sourceFilter.trim().toLowerCase();
  if (!needle) return state.sources.slice();
  return state.sources.filter((source) => sourceMatchesFilter(source, needle));
}

function sourceMatchesFilter(source, needle) {
  const direction = resolveSourceDirection(source);
  const labels = getHeaderLabels(source);
  const haystack = [
    source.sheetName,
    source.fileName,
    direction.dir ? dirLabel(direction.dir) : '',
    labels[source.mapping.company] || '',
    labels[source.mapping.amount] || ''
  ].join(' ').toLowerCase();

  return needle.split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

function highlightMatch(text, needle) {
  const raw = String(text);
  const words = String(needle).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return escapeHtml(raw);

  const lower = raw.toLowerCase();
  const ranges = [];
  words.forEach((word) => {
    for (let from = 0; ;) {
      const at = lower.indexOf(word, from);
      if (at < 0) break;
      ranges.push([at, at + word.length]);
      from = at + word.length;
    }
  });
  if (!ranges.length) return escapeHtml(raw);

  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  ranges.forEach(([start, end]) => {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  });

  let html = '';
  let cursor = 0;
  merged.forEach(([start, end]) => {
    html += escapeHtml(raw.slice(cursor, start))
      + '<mark class="pick-hit">' + escapeHtml(raw.slice(start, end)) + '</mark>';
    cursor = end;
  });
  return html + escapeHtml(raw.slice(cursor));
}

function renderPreview(source) {
  renderSheetMap(source);

  const tableHead = els.previewTable.tHead;
  const tableBody = els.previewTable.tBodies[0];
  const rows = source.rows;
  const header = getHeaderLabels(source);
  const columnCount = Math.min(getColumnCount(source), 40);
  const mappedColumns = new Map();
  const guessedFields = new Set(source.guessedFields || []);
  const picked = pickedColumnSet(source);

  Object.entries(source.mapping).forEach(([field, index]) => {
    if (index >= 0) mappedColumns.set(index, field);
  });

  if (!rows.length) {
    tableHead.innerHTML = '';
    tableBody.innerHTML = '<tr><td class="table-empty">这个工作表没有可预览的数据。</td></tr>';
    return;
  }

  let headHtml = '<tr><th class="rowno">行</th>';
  for (let i = 0; i < columnCount; i += 1) {
    const field = mappedColumns.get(i);
    const classes = [];
    if (field) classes.push('mapped', `is-${field}`);
    if (picked.has(i)) classes.push('picked');
    const tag = field
      ? `<span class="map-tag">${escapeHtml(ROLE_LABELS[field])}${guessedFields.has(field) ? '（按内容认出）' : ''}</span>`
      : '';
    const text = cleanCell(header[i]) || '（空表头）';
    headHtml += `<th class="${classes.join(' ')}" data-col="${i}" title="点一下、或按住拖着框住几列，就能重新指定它是什么">${XLSX.utils.encode_col(i)} 列 · ${escapeHtml(truncate(text, 24))}${tag}</th>`;
  }
  headHtml += '</tr>';
  tableHead.innerHTML = headHtml;

  const previewRows = [];
  let lastCompany = '';

  for (let i = source.headerRow + 1; i < rows.length && previewRows.length < 5; i += 1) {
    const row = rows[i] || [];
    if (row.every((value) => cleanCell(value) === '')) {
      lastCompany = '';
      continue;
    }

    const companyText = source.mapping.company >= 0 ? cleanCell(row[source.mapping.company]) : '';
    if (isSubtotalName(companyText)) lastCompany = '';
    if (companyText) lastCompany = companyText;

    const amountText = source.mapping.amount >= 0 ? cleanCell(row[source.mapping.amount]) : '';
    const inherited = !companyText && Boolean(lastCompany) && Boolean(amountText);
    previewRows.push({
      row,
      rowNumber: source.rowOffset + i + 1,
      inheritedCompany: inherited ? lastCompany : ''
    });
  }

  if (!previewRows.length) {
    tableBody.innerHTML = `<tr><td colspan="${columnCount + 1}" class="table-empty">表头之后没有数据行，请检查表头所在行。</td></tr>`;
    return;
  }

  tableBody.innerHTML = previewRows.map(({ row, rowNumber, inheritedCompany }) => {
    let cells = `<td class="rowno">${rowNumber}</td>`;
    for (let i = 0; i < columnCount; i += 1) {
      const field = mappedColumns.get(i);
      const classes = [];
      if (field) classes.push('mapped', `is-${field}`);
      if (picked.has(i)) classes.push('picked');
      const value = cleanCell(row[i]);
      let content = escapeHtml(value || '—');
      let title = escapeHtml(value);

      if (i === source.mapping.company && inheritedCompany) {
        content = '<span class="inherit-tag">↑ 承上</span>';
        title = `沿用上一行：${escapeHtml(inheritedCompany)}`;
      }

      cells += `<td class="${classes.join(' ')}" data-col="${i}" title="${title}">${content}</td>`;
    }
    return `<tr>${cells}</tr>`;
  }).join('');
}

function pickedColumnSet(source) {
  const picked = new Set();
  if (!source || colPick.sourceId !== source.id || colPick.from < 0) return picked;

  const lo = Math.min(colPick.from, colPick.to);
  const hi = Math.max(colPick.from, colPick.to);
  for (let i = lo; i <= hi; i += 1) picked.add(i);
  return picked;
}

function paintPick() {
  const picked = pickedColumnSet(getActiveSource());
  els.previewTable.querySelectorAll('[data-col]').forEach((cell) => {
    cell.classList.toggle('picked', picked.has(Number(cell.dataset.col)));
  });
}

function bindPreviewPick() {
  els.previewTable.addEventListener('pointerdown', (event) => {
    if (event.button > 0) return;
    const cell = event.target.closest('[data-col]');
    const source = getActiveSource();
    if (!cell || !source) return;

    event.preventDefault();
    colPick.sourceId = source.id;
    colPick.dragging = true;
    colPick.from = Number(cell.dataset.col);
    colPick.to = colPick.from;
    els.previewTable.classList.add('is-selecting');
    paintPick();
  });

  els.previewTable.addEventListener('pointermove', (event) => {
    if (!colPick.dragging) return;
    const under = document.elementFromPoint(event.clientX, event.clientY);
    const cell = under && under.closest ? under.closest('#previewTable [data-col]') : null;
    if (!cell) return;

    const index = Number(cell.dataset.col);
    if (index === colPick.to) return;
    colPick.to = index;
    paintPick();
  });

  window.addEventListener('pointerup', () => {
    if (!colPick.dragging) return;
    colPick.dragging = false;
    els.previewTable.classList.remove('is-selecting');
    showPickBar();
  });

  window.addEventListener('pointercancel', clearPick);
}

function clearPick() {
  colPick.dragging = false;
  colPick.from = -1;
  colPick.to = -1;
  els.pickBar.classList.add('hidden');
  els.previewTable.classList.remove('is-selecting');
  paintPick();
}

function showPickBar() {
  const source = getActiveSource();
  const picked = pickedColumnSet(source);

  if (!source || !picked.size) {
    els.pickBar.classList.add('hidden');
    return;
  }

  const indexes = Array.from(picked).sort((a, b) => a - b);
  const labels = getHeaderLabels(source);
  const nameOf = (index) => truncate(cleanCell(labels[index]) || '（空表头）', 14);
  const first = XLSX.utils.encode_col(indexes[0]);
  const last = XLSX.utils.encode_col(indexes[indexes.length - 1]);

  els.pickText.textContent = indexes.length === 1
    ? `${first} 列「${nameOf(indexes[0])}」`
    : `${first}～${last} 列（共 ${indexes.length} 列，会自动挑最合适的一列）`;
  els.pickBar.classList.remove('hidden');
}

function columnScoreFor(source, field, index) {
  const bounds = sampleRowBounds(source);
  let filled = 0;
  let hit = 0;
  let sum = 0;

  for (let r = bounds.from; r <= bounds.to; r += 1) {
    const cell = cleanCell((source.rows[r] || [])[index]);
    if (isPlaceholderCell(cell)) continue;
    filled += 1;

    if (field === 'amount') {
      const value = parseAmount(cell);
      if (value !== null) { hit += 1; sum += Math.abs(value); }
    } else if (field === 'company') {
      if (ENTITY_HINT_RE.test(cell)) hit += 1;
      else if (parseAmount(cell) === null) hit += 0.5;
    } else if (field === 'direction') {
      if (parseDirection(cell) !== '') hit += 1;
    } else if (parseAmount(cell) === null && cell.length >= 2) {
      hit += 1;
    }
  }

  return { filled, ratio: filled ? hit / filled : 0, sum };
}

function pickBestInRange(source, field, indexes) {
  const taken = new Set(ROLE_FIELDS
    .filter((item) => item !== field)
    .map((item) => source.mapping[item])
    .filter((index) => index >= 0));
  const free = indexes.filter((index) => !taken.has(index));
  const pool = free.length ? free : indexes;

  let best = { index: pool[0], ratio: -1, sum: -1 };

  pool.forEach((index) => {
    const stats = columnScoreFor(source, field, index);
    if (stats.ratio > best.ratio || (stats.ratio === best.ratio && stats.sum > best.sum)) {
      best = { index, ratio: stats.ratio, sum: stats.sum };
    }
  });

  if (field !== 'memo' && best.ratio < 0.2) return -1;
  return best.index;
}

function applyPickedRole(field) {
  const source = getActiveSource();
  const picked = pickedColumnSet(source);

  if (!source || !picked.size || !ROLE_FIELDS.includes(field)) return;

  const indexes = Array.from(picked).sort((a, b) => a - b);
  const index = indexes.length === 1 ? indexes[0] : pickBestInRange(source, field, indexes);

  if (index < 0) {
    showToast(`这几列里找不到${ROLE_LABELS[field]}，${ROLE_PICK_HINTS[field]}试试`, true);
    return;
  }

  const multi = indexes.length > 1 ? `（${indexes.length} 列里挑了最合适的一列）` : '';
  const weak = indexes.length === 1 && field !== 'memo' && columnScoreFor(source, field, index).ratio < 0.2
    ? `，但这列${WEAK_ROLE_HINTS[field]}，对账前先看一下`
    : '';
  const released = setColumnMapping(source, field, index);
  const freed = released.length ? `；原来的${released.join('、')}列已空出来` : '';
  showToast(`已把 ${XLSX.utils.encode_col(index)} 列当作${ROLE_LABELS[field]}${multi}${freed}${weak}`, Boolean(weak));
}

function classifyMapCell(text) {
  if (!text || isPlaceholderCell(text)) return '';
  if (parseDirection(text) !== '') return 'dir';
  if (DATEISH_RE.test(text.replace(/\s+/g, ''))) return 'date';
  if (parseAmount(text) !== null) return 'num';
  return 'name';
}

function sheetMapColumnCount(source) {
  let count = 0;

  for (let r = 0; r < source.rows.length; r += 1) {
    if (isHiddenRow(source, r)) continue;
    const row = source.rows[r] || [];
    for (let c = row.length - 1; c >= count; c -= 1) {
      if (cleanCell(row[c]) !== '') {
        count = c + 1;
        break;
      }
    }
  }

  return Math.min(Math.max(count, 1), MAP_MAX_COLS);
}

function mapAvailableWidth() {
  const measured = els.mapScroll ? els.mapScroll.clientWidth : 0;
  return measured > 80 ? measured : 620;
}

function sheetMapGeom(source, availWidth) {
  const rows = Math.max(1, source.rows.length);
  const cols = Math.max(1, sheetMapColumnCount(source));
  const space = Math.max(240, Math.floor(availWidth || 620));
  const minColW = cols > 42 ? 11 : cols > 24 ? 15 : cols > 12 ? 22 : 30;
  const colW = Math.max(minColW, Math.min(72, Math.floor((space - 50) / cols)));
  const rowH = Math.max(1, Math.min(14, Math.floor(380 / rows)));

  return {
    left: 34,
    top: 19,
    rowH,
    colW,
    rows,
    cols,
    width: 34 + cols * colW,
    height: 19 + rows * rowH
  };
}

function buildSheetMapImage(source, geom) {
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(geom.width * dpr);
  canvas.height = Math.round(geom.height * dpr);

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = MAP_COLORS.card;
  ctx.fillRect(0, 0, geom.width, geom.height);

  const gridWidth = geom.cols * geom.colW;
  const gridHeight = geom.rows * geom.rowH;
  const font = '9px "Microsoft YaHei", "PingFang SC", sans-serif';

  if (geom.rowH >= 4) {
    ctx.strokeStyle = MAP_COLORS.grid;
    ctx.lineWidth = 1;
    for (let r = 0; r <= geom.rows; r += 1) {
      const y = Math.round(geom.top + r * geom.rowH) + 0.5;
      ctx.beginPath();
      ctx.moveTo(geom.left, y);
      ctx.lineTo(geom.left + gridWidth, y);
      ctx.stroke();
    }
  }

  for (let c = 0; c <= geom.cols; c += 1) {
    const x = Math.round(geom.left + c * geom.colW) + 0.5;
    ctx.strokeStyle = c % 2 ? MAP_COLORS.grid : '#dcd6c6';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, geom.top);
    ctx.lineTo(x, geom.top + gridHeight);
    ctx.stroke();
  }

  [source.groupHeaderRow, source.headerRow].forEach((headerLike) => {
    if (headerLike < 0 || headerLike >= geom.rows) return;
    ctx.fillStyle = MAP_COLORS.header;
    ctx.fillRect(geom.left, geom.top + headerLike * geom.rowH, gridWidth, geom.rowH);
  });

  for (let r = 0; r < geom.rows; r += 1) {
    const row = source.rows[r] || [];
    const isHeader = r === source.headerRow || r === source.groupHeaderRow;
    const y = geom.top + r * geom.rowH;
    const barH = Math.max(1, geom.rowH - 1);

    if (isHiddenRow(source, r)) {
      ctx.fillStyle = 'rgba(195, 188, 171, 0.35)';
      ctx.fillRect(geom.left, y, gridWidth, geom.rowH);
      continue;
    }

    for (let c = 0; c < geom.cols; c += 1) {
      const text = cleanCell(row[c]);
      if (!text) continue;
      const x = geom.left + c * geom.colW;
      const kind = isHeader ? 'head' : classifyMapCell(text);
      const units = geom.colW >= 60 ? 5 : geom.colW >= 20 ? 2.4 : 1.4;
      const barW = Math.max(2, Math.min(geom.colW - 3, text.length * units));

      if (kind === 'head') ctx.fillStyle = MAP_COLORS.headerText;
      else if (kind === 'num') ctx.fillStyle = MAP_COLORS.num;
      else if (kind === 'dir') ctx.fillStyle = MAP_COLORS.dir;
      else if (kind === 'date') ctx.fillStyle = MAP_COLORS.faint;
      else ctx.fillStyle = MAP_COLORS.name;

      ctx.globalAlpha = kind === 'head' ? 0.85 : Math.min(0.95, 0.4 + text.length * 0.07);
      ctx.fillRect(x + 1.5, y + (geom.rowH - barH) / 2, barW, barH);
    }
  }
  ctx.globalAlpha = 1;

  (source.sheet && Array.isArray(source.sheet['!merges']) ? source.sheet['!merges'] : []).forEach((merge) => {
    if (!merge || !merge.s || !merge.e) return;
    if (merge.s.r >= geom.rows || merge.s.c >= geom.cols) return;
    const x = geom.left + merge.s.c * geom.colW;
    const y = geom.top + merge.s.r * geom.rowH;
    const w = (Math.min(merge.e.c + 1, geom.cols) - merge.s.c) * geom.colW;
    const h = (Math.min(merge.e.r + 1, geom.rows) - merge.s.r) * geom.rowH;
    if (w <= geom.colW && h <= geom.rowH) return;
    ctx.strokeStyle = (merge.s.r === source.headerRow || merge.s.r === source.groupHeaderRow)
      ? 'rgba(246, 242, 230, 0.5)'
      : '#cfc7b2';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  });

  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  for (let c = 0; c < geom.cols; c += 1) {
    if (geom.colW < 15 && c % 2) continue;
    ctx.fillStyle = c === source.mapping.company || c === source.mapping.amount
      ? MAP_COLORS.name
      : '#9a9586';
    ctx.fillText(XLSX.utils.encode_col(c), geom.left + c * geom.colW + geom.colW / 2, geom.top / 2);
  }

  ctx.textAlign = 'right';
  const step = Math.max(1, Math.ceil(14 / geom.rowH));
  for (let r = 0; r < geom.rows; r += 1) {
    if (r % step && r !== source.headerRow) continue;
    ctx.fillStyle = r === source.headerRow ? MAP_COLORS.header : '#9a9586';
    ctx.fillText(String(source.rowOffset + r + 1), geom.left - 5, geom.top + r * geom.rowH + geom.rowH / 2);
  }

  return { canvas, geom, sourceId: source.id, dpr };
}

function normalizedMapPick(source) {
  if (!source || mapPick.sourceId !== source.id || mapPick.r1 < 0 || mapPick.c1 < 0) return null;
  return {
    r1: Math.min(mapPick.r1, mapPick.r2),
    r2: Math.max(mapPick.r1, mapPick.r2),
    c1: Math.min(mapPick.c1, mapPick.c2),
    c2: Math.max(mapPick.c1, mapPick.c2)
  };
}

function paintSheetMap(explicit) {
  const source = explicit || getActiveSource();
  if (!source || !els.sheetMap) return;

  const avail = mapAvailableWidth();
  if (!mapImage || mapImage.sourceId !== source.id || Math.abs((mapImage.avail || 0) - avail) > 24) {
    mapImage = buildSheetMapImage(source, sheetMapGeom(source, avail));
    mapImage.avail = avail;
  }
  const geom = mapImage.geom;
  const canvas = els.sheetMap;

  canvas.width = Math.round(geom.width * mapImage.dpr);
  canvas.height = Math.round(geom.height * mapImage.dpr);
  canvas.style.width = `${geom.width}px`;
  canvas.style.height = `${geom.height}px`;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(mapImage.dpr, 0, 0, mapImage.dpr, 0, 0);
  ctx.clearRect(0, 0, geom.width, geom.height);
  ctx.drawImage(mapImage.canvas, 0, 0, geom.width, geom.height);

  const gridWidth = geom.cols * geom.colW;
  const gridTop = geom.top;
  const gridHeight = geom.rows * geom.rowH;

  ROLE_FIELDS.forEach((field) => {
    const index = source.mapping[field];
    if (index < 0 || index >= geom.cols) return;
    ctx.fillStyle = MAP_ROLE_FILL[field];
    ctx.fillRect(geom.left + index * geom.colW, gridTop, geom.colW, gridHeight);
  });

  const range = source.dataRange;
  if (range) {
    const before = range.fromRow - (source.headerRow + 1);
    const after = geom.rows - 1 - range.toRow;
    if (before > 0 || after > 0) {
      ctx.fillStyle = 'rgba(244, 241, 232, 0.74)';
      if (before > 0) ctx.fillRect(geom.left, gridTop, gridWidth, before * geom.rowH);
      if (after > 0) ctx.fillRect(geom.left, gridTop + (range.toRow + 1) * geom.rowH, gridWidth, after * geom.rowH);

      ctx.strokeStyle = MAP_COLORS.range;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(
        geom.left + 0.5,
        gridTop + range.fromRow * geom.rowH + 0.5,
        gridWidth - 1,
        Math.max(1, range.toRow - range.fromRow + 1) * geom.rowH - 1
      );
      ctx.setLineDash([]);
    }
  }

  const box = normalizedMapPick(source);
  if (box) {
    const x = geom.left + box.c1 * geom.colW;
    const w = (box.c2 - box.c1 + 1) * geom.colW;
    const y = gridTop + box.r1 * geom.rowH;
    const h = (box.r2 - box.r1 + 1) * geom.rowH;
    ctx.fillStyle = 'rgba(20, 90, 74, 0.18)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = MAP_COLORS.box;
    ctx.lineWidth = 1.6;
    ctx.strokeRect(x + 0.8, y + 0.8, w - 1.6, h - 1.6);
  }
}

function renderSheetMap(source) {
  if (!els.sheetMap) return;
  const target = source || getActiveSource();
  if (!target || target.kind !== 'excel') {
    mapImage = null;
    clearMapPick();
    els.sheetMapMeta.textContent = '—';
    return;
  }

  mapImage = null;
  if (mapPick.sourceId && mapPick.sourceId !== target.id) resetMapPick();
  paintSheetMap(target);

  const geom = mapImage.geom;
  const range = target.dataRange;
  const parts = [`共 ${geom.rows} 行 · ${geom.cols} 列`];
  if (range) parts.push(`取${dataRangeLabel(target)}`);
  if (target.columnWindow) {
    parts.push(`只在 ${XLSX.utils.encode_col(target.columnWindow.from)}～${XLSX.utils.encode_col(target.columnWindow.to)} 列里认`);
  }
  if (geom.cols >= MAP_MAX_COLS) parts.push('列太多，图片只显示前 60 列');
  els.sheetMapMeta.textContent = parts.join(' · ');
}

function mapIndexAt(event, geom) {
  const rect = els.sheetMap.getBoundingClientRect();
  const c = Math.floor((event.clientX - rect.left - geom.left) / geom.colW);
  const r = Math.floor((event.clientY - rect.top - geom.top) / geom.rowH);
  if (c < 0 || c >= geom.cols || r < 0 || r >= geom.rows) return null;
  return { r, c };
}

function resetMapPick() {
  mapPick.dragging = false;
  mapPick.sourceId = '';
  mapPick.r1 = -1;
  mapPick.c1 = -1;
  mapPick.r2 = -1;
  mapPick.c2 = -1;
  if (els.mapBar) els.mapBar.classList.add('hidden');
  if (els.mapScroll) els.mapScroll.classList.remove('is-selecting');
}

function clearMapPick() {
  resetMapPick();
  paintSheetMap();
}

function showMapBar() {
  const source = getActiveSource();
  const box = normalizedMapPick(source);

  if (!source || !box || !els.mapBar) {
    if (els.mapBar) els.mapBar.classList.add('hidden');
    return;
  }

  const fromRow = source.rowOffset + box.r1 + 1;
  const toRow = source.rowOffset + box.r2 + 1;
  const first = XLSX.utils.encode_col(box.c1);
  const last = XLSX.utils.encode_col(box.c2);
  const rowCount = box.r2 - box.r1 + 1;
  const colCount = box.c2 - box.c1 + 1;

  els.mapText.textContent = `框住的是第 ${fromRow}～${toRow} 行（${rowCount} 行）· ${first}${colCount > 1 ? `～${last}` : ''} 列（${colCount} 列）`;
  els.mapBar.classList.remove('hidden');
}

function bindSheetMap() {
  if (!els.sheetMap) return;

  els.sheetMap.addEventListener('pointerdown', (event) => {
    if (event.button > 0) return;
    const source = getActiveSource();
    if (!source || !mapImage) return;

    const at = mapIndexAt(event, mapImage.geom);
    if (!at) return;

    event.preventDefault();
    els.sheetMap.setPointerCapture(event.pointerId);
    mapPick.sourceId = source.id;
    mapPick.r1 = at.r;
    mapPick.c1 = at.c;
    mapPick.r2 = at.r;
    mapPick.c2 = at.c;
    mapPick.dragging = true;
    els.mapScroll.classList.add('is-selecting');
    paintSheetMap();
  });

  els.sheetMap.addEventListener('pointermove', (event) => {
    if (!mapPick.dragging || !mapImage) return;
    const at = mapIndexAt(event, mapImage.geom);
    if (!at || (at.r === mapPick.r2 && at.c === mapPick.c2)) return;
    mapPick.r2 = at.r;
    mapPick.c2 = at.c;
    paintSheetMap();
  });

  const finish = () => {
    if (!mapPick.dragging) return;
    mapPick.dragging = false;
    els.mapScroll.classList.remove('is-selecting');
    showMapBar();
    paintSheetMap();
  };

  els.sheetMap.addEventListener('pointerup', finish);
  els.sheetMap.addEventListener('pointercancel', () => {
    mapPick.dragging = false;
    els.mapScroll.classList.remove('is-selecting');
    paintSheetMap();
  });

  els.mapBar.addEventListener('click', (event) => {
    const button = event.target.closest('[data-map]');
    if (!button) return;
    applyMapPick(button.dataset.map);
  });
}

function setManualDataRange(source, fromRow, toRow) {
  const low = Math.max(source.headerRow + 1, Math.min(fromRow, toRow));
  const high = Math.max(low, Math.max(fromRow, toRow));

  let outside = 0;
  for (let r = source.headerRow + 1; r < source.rows.length; r += 1) {
    if (r >= low && r <= high) continue;
    if (!isBlankRow(source.rows[r])) outside += 1;
  }

  source.dataRange = { fromRow: low, toRow: high, manual: true, note: '', outside };
}

function redrawAfterMap(source) {
  mapImage = null;
  resetMapPick();
  refreshSourceInference(source);
  refreshSourceSelection(source);
  populateSheetSelect();
  populateHeaderRowSelect(source);
  populateMappingSelects(source);
  renderSourceList();
  renderPreview(source);
  renderColumnStatus(source);
  updateFileMeta(source);
  invalidateResults();
}

function applyMapPick(mode) {
  const source = getActiveSource();
  if (!source) return;

  if (mode === 'clear') {
    clearMapPick();
    return;
  }

  if (mode === 'whole') {
    source.columnWindow = null;
    source.dataRange = null;
    syncHeaderLabels(source);
    autoMapColumns(source);
    source.dataRange = detectDataRegion(source);
    redrawAfterMap(source);
    showToast('改回整张表都算');
    return;
  }

  const box = normalizedMapPick(source);
  if (!box) {
    showToast('先在上面的图片里框住一块区域', true);
    return;
  }

  if (mode === 'both') {
    const first = (source.rows[box.r1] || []).map(cleanCell);
    if (looksLikeHeaderRow(first)) {
      const second = (source.rows[box.r1 + 1] || []).map(cleanCell);
      // 框到分组表头那一行时，下面写满列名的那一行才是真表头
      const secondWider = box.r1 + 1 <= box.r2
        && looksLikeHeaderRow(second)
        && second.filter(Boolean).length > first.filter(Boolean).length;
      source.headerRow = secondWider ? box.r1 + 1 : box.r1;
    }

    source.columnWindow = { from: box.c1, to: box.c2 };
    source.dataRange = null;
    syncHeaderLabels(source);
    autoMapColumns(source);
    setManualDataRange(source, box.r1, box.r2);
    redrawAfterMap(source);

    const range = source.dataRange;
    showToast(`已只用这一块：${dataRangeLabel(source)}，并在 ${XLSX.utils.encode_col(box.c1)}～${XLSX.utils.encode_col(box.c2)} 列里重新认了企业名和金额${range.outside ? `；另外 ${range.outside} 行不参与` : ''}`);
    return;
  }

  if (box.r2 <= source.headerRow) {
    showToast('框住的行都在表头上面，请框住下面的数据行', true);
    return;
  }

  setManualDataRange(source, box.r1, box.r2);
  redrawAfterMap(source);
  showToast(`只取${dataRangeLabel(source)}，列还是原来那些${source.dataRange.outside ? `；另外 ${source.dataRange.outside} 行不参与` : ''}`);
}

function setColumnMapping(source, field, index) {
  const released = [];
  source.mapping[field] = index;

  if (index >= 0) {
    ROLE_FIELDS.forEach((other) => {
      if (other === field || source.mapping[other] !== index) return;
      source.mapping[other] = -1;
      if (other === 'direction') source.directionColumnManual = false;
      released.push(ROLE_LABELS[other]);
    });
  }

  source.guessedFields = (source.guessedFields || []).filter((item) => source.mapping[item] >= 0);

  if (field === 'direction') {
    source.directionColumnManual = index >= 0;
    if (index >= 0) source.directionOverride = 'auto';
  }

  source.dataRange = detectDataRegion(source);
  refreshSourceSelection(source);
  populateMappingSelects(source);
  populateSheetSelect();
  renderSourceList();
  renderPreview(source);
  renderColumnStatus(source);
  updateFileMeta(source);
  invalidateResults();
  clearPick();
  return released;
}

function remapActiveSource() {
  const source = getActiveSource();
  if (!source) return;

  autoMapColumns(source);
  source.dataRange = detectDataRegion(source);
  refreshSourceInference(source);
  refreshSourceSelection(source);
  populateMappingSelects(source);
  renderSourceList();
  renderPreview(source);
  renderColumnStatus(source);
  updateFileMeta(source);
  invalidateResults();
  showToast('已重新按表头和内容认了一遍列');
}

function renderColumnStatus(source) {
  if (!source) {
    els.columnStatus.innerHTML = '';
    return;
  }

  const labels = getHeaderLabels(source);
  const guessedFields = new Set(source.guessedFields || []);
  const chips = ROLE_FIELDS.map((field) => {
    const index = source.mapping[field];
    const optional = field === 'direction' || field === 'memo';
    const isGuess = guessedFields.has(field);

    if (index < 0) {
      return `<span class="col-chip is-missing${optional ? ' is-optional' : ''}">${ROLE_LABELS[field]}：${optional ? '这张没有，也能算' : '还没指定，在下面框住那一列'}</span>`;
    }

    const text = truncate(cleanCell(labels[index]) || '（空表头）', 14);
    return `<span class="col-chip is-${field}${isGuess ? ' is-guess' : ''}">${ROLE_LABELS[field]} ${XLSX.utils.encode_col(index)} 列<b>${escapeHtml(text)}</b>${isGuess ? '<i>按内容认出</i>' : ''}</span>`;
  }).join('');

  const lead = ROLE_FIELDS.some((field) => source.mapping[field] >= 0) ? '这张已认出的列' : '这张还没认出列';
  const range = source.dataRange;
  let rangeChip = '';

  if (range) {
    const tail = range.outside ? `，另有 ${range.outside} 行不参与` : '';
    const why = range.manual ? `你框的这一块${tail}` : `${range.note || '范围外的行没纳入'}${tail}`;
    rangeChip = `<span class="col-chip is-range">只算${dataRangeLabel(source)}<b>${escapeHtml(why)}</b></span>`
      + (range.manual ? '<button type="button" class="btn btn-sm btn-ghost" id="rangeWholeBtn">整张都用</button>' : '');
  }

  const low = sourceConfidence(source);
  const guessChip = low.length
    ? `<span class="col-chip is-guess" title="${escapeHtml(low.map((item) => item.text).join('；'))}">有 ${low.length} 处是猜的，先看一眼上面的图片</span>`
    : '';

  const age = sourceAgeColumn(source);
  let ageChip = '';
  if (age) {
    ageChip = `<span class="col-chip is-age">账龄 ${XLSX.utils.encode_col(age.index)} 列<b>${escapeHtml(truncate(age.label || '（空表头）', 14))}</b><i>${escapeHtml(ageKindText(age))}</i></span>`;
  }

  const dimensionChips = [['entity', '主体'], ['currency', '币种']].map(([field, label]) => {
    const dimension = sourceDimensionColumn(source, field);
    if (!dimension) return '';
    return `<span class="col-chip is-dimension">${label} ${XLSX.utils.encode_col(dimension.index)} 列<b>${escapeHtml(truncate(dimension.label || '（空表头）', 14))}</b><i>分开算</i></span>`;
  }).join('');

  els.columnStatus.innerHTML = `<span class="col-status-lead">${lead}</span>${chips}${rangeChip}${ageChip}${dimensionChips}${guessChip}`
    + '<button type="button" class="btn btn-sm btn-ghost" id="autoRemapBtn">重新认一次</button>';
}

function updateFileMeta(source) {
  if (!source) return;

  const extension = (source.fileName.split('.').pop() || 'file').toUpperCase().slice(0, 5);
  const direction = resolveSourceDirection(source);
  const range = source.dataRange;
  const rowCount = range
    ? Math.max(0, range.toRow - range.fromRow + 1)
    : Math.max(0, source.rows.length - source.headerRow - 1);
  const parts = [
    `工作表「${source.sheetName}」`,
    `表头第 ${source.rowOffset + source.headerRow + 1} 行`,
    range ? `${dataRangeLabel(source)} · ${rowCount} 行参与` : `${rowCount} 行`,
    formatBytes(source.fileSize)
  ];

  if (direction.via === 'override') {
    parts.push(`方向：${dirLabel(direction.dir)}（手动指定）`);
  } else if (direction.via === 'column') {
    parts.push(direction.dir ? `方向：按方向列（备用 ${dirLabel(direction.dir)}）` : '方向：按方向列');
  } else if (direction.via === 'inferred') {
    parts.push(`方向：${dirLabel(direction.dir)}（${source.inferenceSource}）`);
  } else {
    parts.push('方向：未识别，请在数据源里指定');
  }

  els.fileExt.textContent = extension;
  els.cfgFileName.textContent = source.fileName;
  els.cfgFileMeta.textContent = parts.join(' · ');
}

// ===== 导入模式与工作区重置 =====

function switchImportMode(mode) {
  if (mode !== 'excel' && mode !== 'manual') return;
  state.importMode = mode;

  document.querySelectorAll('.mode-tab').forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });

  els.excelPanel.classList.toggle('hidden', mode !== 'excel');
  els.manualPanel.classList.toggle('hidden', mode !== 'manual');
  hideFileError();

  if (mode === 'manual') {
    els.manualError.classList.add('hidden');
    updateManualCounts();
  }
}

function countNonEmptyLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => cleanCell(line) !== '').length;
}

function updateManualCounts() {
  const recvCount = countNonEmptyLines(els.manualRecv.value);
  const payCount = countNonEmptyLines(els.manualPay.value);
  els.manualRecvCount.textContent = `${recvCount} 行`;
  els.manualPayCount.textContent = `${payCount} 行`;

  if (state.groups.length && state.runInfo && state.runInfo.mode === 'manual') {
    invalidateResults();
  }
}

function resetWorkbench() {
  state.sources = [];
  state.activeSourceId = '';
  mapImage = null;
  resetMapPick();
  state.records = [];
  state.groups = [];
  state.skipped = [];
  state.reclassRows = [];
  state.redRows = [];
  state.unknownDirections = [];
  state.stats = null;
  state.runInfo = null;
  state.inheritedRows = 0;
  state.directionFallbackRows = 0;
  state.outOfRangeRows = 0;
  state.guessWarnings = [];
  state.dimensionWarnings = [];
  state.unitConfirmSignature = '';
  state.signConfirmSignature = '';
  state.signConfirmed = false;
  state.controls = [];
  state.groupNotes.clear();
  state.merges.clear();
  state.mergeLog = [];
  state.dismissedSimilar.clear();
  resetUndoHistory();
  state.dismissedPairs.clear();
  state.similarSuggestions = [];
  state.signoff = { index: '', preparedBy: '', reviewedBy: '', date: todayIsoDate(), conclusion: '', note: '' };
  state.ageBaseDate = todayIsoDate();
  applyAgeBandPreset('year');
  if (els.ageBandPreset) els.ageBandPreset.value = 'year';
  state.filter = 'all';
  state.search = '';
  state.sourceFilter = '';
  state.sourceLimit = SOURCE_PAGE_SIZE;
  state.sort = 'netAbsDesc';
  resetFacets();
  state.renderLimit = RENDER_PAGE_SIZE;
  state.expanded.clear();
  state.dataCheckOpen = false;

  els.fileInput.value = '';
  els.manualRecv.value = '';
  els.manualPay.value = '';
  els.manualUnit.value = '1';
  els.unitSelect.value = '1';
  updateManualCounts();

  els.sheetSelect.innerHTML = '';
  els.headerRowSelect.innerHTML = '';
  [els.companyCol, els.amountCol, els.directionCol, els.memoCol, els.ageCol, els.entityCol, els.currencyCol]
    .forEach((select) => {
      if (select) select.innerHTML = '';
    });
  updateAgeBaseField();
  els.previewTable.tHead.innerHTML = '';
  els.previewTable.tBodies[0].innerHTML = '';
  els.sourceList.innerHTML = '';
  els.sourceCount.textContent = '—';
  els.sourceSearch.value = '';
  els.sourceFilterNote.textContent = '';
  els.columnStatus.innerHTML = '';
  els.searchInput.value = '';
  els.exportFiltered.checked = false;
  els.fileExt.textContent = 'XLSX';
  els.cfgFileName.textContent = '—';
  els.cfgFileMeta.textContent = '—';
  [els.signoffIndex, els.signoffPrepared, els.signoffReviewed, els.signoffConclusion, els.printNote].forEach((input) => {
    if (input) input.value = '';
  });
  if (els.signoffDate) els.signoffDate.value = state.signoff.date;
  if (els.configNote) els.configNote.textContent = '';
  if (els.similarBox) {
    els.similarBox.innerHTML = '';
    els.similarBox.classList.add('hidden');
  }
  if (els.fingerprintLine) els.fingerprintLine.innerHTML = '';
  clearTimeout(snapshotRefreshTimer);
  snapshotRefreshTimer = null;
  snapshotBaseline = null;
  snapshotComparison = null;
  if (els.snapshotDiff) {
    els.snapshotDiff.innerHTML = '';
    els.snapshotDiff.classList.add('hidden');
  }
  if (els.snapshotInput) els.snapshotInput.value = '';
  if (els.exportVerifyOut) {
    els.exportVerifyOut.innerHTML = '';
    els.exportVerifyOut.className = 'export-verify-out hidden';
  }
  if (els.exportExpectInput) els.exportExpectInput.value = '';

  hideFileError();
  hideRunError();
  els.manualError.classList.add('hidden');
  els.configSection.classList.add('hidden');
  els.resultSection.classList.add('hidden');
  els.landingSection.classList.remove('hidden');
  switchImportMode(state.importMode);

  requestAnimationFrame(() => {
    els.landingSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// ===== 读表与取数范围识别 =====

function readWorkbook(file, buffer) {
  if (/\.(csv|txt)$/i.test(file.name)) {
    const text = decodeTextFile(buffer).replace(/^\uFEFF/, '');
    return XLSX.read(text, { type: 'string' });
  }
  return XLSX.read(buffer, { type: 'array', cellStyles: true, cellNF: true, bookFiles: true });
}

// SheetJS 社区版读不到字体颜色，但 bookFiles 能拿到原始 styles.xml / sheetN.xml，
// 自己扫一遍「金额单元格用了红色字体」→ 按负数处理的依据（红字冲销是底稿常见写法）。
function isRedFontColor(tag) {
  const rgb = tag.match(/\brgb="([0-9a-fA-F]{6,8})"/);
  if (rgb) {
    const hex = rgb[1].slice(-6);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return false;
    return r >= 0x80 && g <= 0x60 && b <= 0x60 && r >= 2 * Math.max(g, b);
  }
  const indexed = tag.match(/\bindexed="(2|10)"/);
  return Boolean(indexed);
}

function redStyleIndexes(stylesXml) {
  const red = new Set();
  const fontsBlock = stylesXml.match(/<fonts\b[^>]*>([\s\S]*?)<\/fonts>/);
  if (!fontsBlock) return red;

  const redFonts = new Set();
  const fontRe = /<font\b[^>]*(?:\/>|>([\s\S]*?)<\/font>)/g;
  let fontMatch = fontRe.exec(fontsBlock[1]);
  let fontIndex = 0;
  while (fontMatch) {
    const body = fontMatch[1] || '';
    const color = body.match(/<color\b[^>]*\/?>/);
    if (color && isRedFontColor(color[0])) redFonts.add(fontIndex);
    fontIndex += 1;
    fontMatch = fontRe.exec(fontsBlock[1]);
  }
  if (!redFonts.size) return red;

  const xfsBlock = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!xfsBlock) return red;
  const xfTags = xfsBlock[1].match(/<xf\b[^>]*>/g) || [];
  xfTags.forEach((tag, index) => {
    const fontAttr = tag.match(/\bfontId="(\d+)"/);
    const fontId = fontAttr ? Number(fontAttr[1]) : 0;
    if (redFonts.has(fontId)) red.add(index);
  });
  return red;
}

function collectRedCells(workbook, sheetName, rowOffset) {
  try {
    const files = workbook && workbook.files;
    if (!files) return null;
    const stylesEntry = files['xl/styles.xml'];
    const relsEntry = files['xl/_rels/workbook.xml.rels'];
    if (!stylesEntry || !relsEntry) return null;

    const decoder = new TextDecoder('utf-8');
    const redStyles = redStyleIndexes(decoder.decode(stylesEntry.content));
    if (!redStyles.size) return null;

    const sheetsMeta = (workbook.Workbook && workbook.Workbook.Sheets) || [];
    const meta = sheetsMeta.find((item) => item.name === sheetName);
    if (!meta || !meta.id) return null;

    const relsXml = decoder.decode(relsEntry.content);
    const relRe = /<Relationship\b[^>]*\/?>/g;
    let target = '';
    let relMatch = relRe.exec(relsXml);
    while (relMatch) {
      const tag = relMatch[0];
      const id = (tag.match(/\bId="([^"]+)"/) || [])[1];
      if (id === meta.id) {
        target = (tag.match(/\bTarget="([^"]+)"/) || [])[1] || '';
        break;
      }
      relMatch = relRe.exec(relsXml);
    }
    if (!target) return null;

    const sheetPath = target.charAt(0) === '/' ? target.slice(1) : `xl/${target}`;
    const sheetEntry = files[sheetPath];
    if (!sheetEntry) return null;

    const sheetXml = decoder.decode(sheetEntry.content);
    const cellRe = /<c\b([^>]*)\/?>/g;
    const byColumn = new Map();
    let cellMatch = cellRe.exec(sheetXml);
    while (cellMatch) {
      const attrs = cellMatch[1];
      const styleAttr = attrs.match(/\bs="(\d+)"/);
      if (styleAttr && redStyles.has(Number(styleAttr[1]))) {
        const ref = attrs.match(/\br="([A-Z]{1,3})(\d+)"/);
        if (ref) {
          const column = XLSX.utils.decode_col(ref[1]);
          const rowIndex = Number(ref[2]) - 1 - rowOffset;
          if (rowIndex >= 0) {
            if (!byColumn.has(column)) byColumn.set(column, new Set());
            byColumn.get(column).add(rowIndex);
          }
        }
      }
      cellMatch = cellRe.exec(sheetXml);
    }
    return byColumn.size ? byColumn : null;
  } catch (error) {
    console.error(error);
    return null;
  }
}

function isRedAmountCell(source, columnIndex, rowIndex) {
  const byColumn = source.redCells;
  if (!byColumn) return false;
  const rows = byColumn.get(columnIndex);
  return Boolean(rows && rows.has(rowIndex));
}

function decodeTextFile(buffer) {
  const bytes = new Uint8Array(buffer);

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buffer);
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer);
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error) {
    try {
      return new TextDecoder('gbk').decode(buffer);
    } catch (fallbackError) {
      return new TextDecoder('utf-8').decode(buffer);
    }
  }
}

function friendlyError(error) {
  const message = String((error && error.message) || error || '未知错误');
  if (/password|encrypt/i.test(message)) {
    return '文件可能设置了打开密码，请先取消密码后再导入。';
  }
  if (/unsupported|corrupt|invalid|bad/i.test(message)) {
    return '无法解析这个文件，请确认它是正常的 Excel 或 CSV 文件。';
  }
  return message.length > 120 ? `${message.slice(0, 120)}…` : message;
}

function setDropzoneBusy(busy) {
  els.dropzone.classList.toggle('busy', busy);
  els.dropzone.setAttribute('aria-busy', String(busy));
}

function detectHeaderLayout(rows) {
  const limit = Math.min(rows.length, 15);
  const info = [];

  for (let i = 0; i < limit; i += 1) {
    const cells = (rows[i] || []).map(cleanCell);
    info.push({ cells, header: looksLikeHeaderRow(cells), score: headerRowScore(cells) });
  }

  let best = { headerRow: 0, groupRow: -1, score: -1 };

  for (let i = 0; i < info.length; i += 1) {
    if (info[i].header && info[i].score > best.score) {
      best = { headerRow: i, groupRow: -1, score: info[i].score };
    }

    const next = info[i + 1];
    if (!info[i].header || !next || !next.header) continue;

    const fill = headerFillCount(info[i].cells, next.cells);
    if (fill < 1) continue;

    const pairScore = info[i].score * 0.6 + next.score + fill * 1.5;
    if (pairScore > best.score) {
      best = { headerRow: i + 1, groupRow: i, score: pairScore };
    }
  }

  return { headerRow: best.headerRow, groupRow: best.groupRow };
}

const TITLE_ROW_RE = /被审计单位|受检单位|编制单位|复核单位|编制日期|复核人|索引号|账套|截止日期|金额单位|记账单位|币种|单位[:：]|期间[:：]|所属期|明细表|汇总表|余额表|清单|底稿|工作簿|对账单/;

function looksLikeHeaderRow(cells) {
  const filled = cells.filter((cell) => cell && !isPlaceholderCell(cell));
  if (filled.length < 2) return false;

  const titleMarks = filled.filter((cell) => TITLE_ROW_RE.test(cell)).length;
  if (titleMarks >= 2) return false;

  const numeric = filled.filter((cell) => parseAmount(cell) !== null).length;
  if (numeric > 2) return false;

  return numeric / filled.length < 0.25;
}

function headerRowScore(cells) {
  const filled = cells.filter(Boolean);
  let score = 0;

  if (filled.some((cell) => /企业|公司|单位|客户|供应商|对方|名称|项目/.test(cell))) score += 4;
  if (filled.some((cell) => /金额|余额|发生额|价税|价款|数目|审定/.test(cell))) score += 4;
  if (filled.some((cell) => /方向|类型|性质|收付|借贷|借款|货款|类别|账龄/.test(cell))) score += 3;
  if (filled.length >= 3) score += 1;

  return score;
}

function headerFillCount(groupCells, leafCells) {
  let fill = 0;

  for (let i = 0; i < groupCells.length; i += 1) {
    if (groupCells[i] && !leafCells[i]) fill += 1;
  }

  return fill;
}

function syncHeaderLabels(source) {
  const leaf = (source.rows[source.headerRow] || []).map(cleanCell);
  const groupCells = source.headerRow > 0
    ? (source.rows[source.headerRow - 1] || []).map(cleanCell)
    : [];
  const useGroup = groupCells.length > 0
    && looksLikeHeaderRow(groupCells)
    && headerFillCount(groupCells, leaf) >= 1;

  const labels = leaf.slice();
  source.groupHeaderRow = useGroup ? source.headerRow - 1 : -1;

  if (useGroup) {
    for (let i = 0; i < labels.length; i += 1) {
      const above = groupCells[i];
      if (!above) continue;
      if (!labels[i]) labels[i] = above;
      else if (!labels[i].includes(above)) labels[i] = `${above} ${labels[i]}`;
    }
  }

  source.headerLabels = labels;
  return labels;
}

function getHeaderLabels(source) {
  if (Array.isArray(source.headerLabels) && source.headerLabels.length) return source.headerLabels;
  return syncHeaderLabels(source);
}

function isPlaceholderCell(value) {
  const text = cleanCell(value);
  if (!text) return true;
  if (/^[-—–―_~／/\\]+$/.test(text)) return true;
  return /^\(?[-—–]+\)?$/.test(text);
}

function sampleRowBounds(source) {
  const manual = source.dataRange && source.dataRange.manual ? source.dataRange : null;
  const from = manual ? manual.fromRow : source.headerRow + 1;
  const to = manual
    ? manual.toRow
    : Math.min(source.rows.length - 1, source.headerRow + 40);
  return { from, to: Math.max(from, to) };
}

function columnRatio(source, index, classify) {
  const bounds = sampleRowBounds(source);
  let filled = 0;
  let hit = 0;

  for (let i = bounds.from; i <= bounds.to; i += 1) {
    const cell = cleanCell((source.rows[i] || [])[index]);
    if (isPlaceholderCell(cell)) continue;
    filled += 1;
    if (classify(cell)) hit += 1;
  }

  return { filled, ratio: filled ? hit / filled : 0 };
}

function isBlankRow(row) {
  if (!row || !row.length) return true;
  return row.every((value) => cleanCell(value) === '');
}

function isHiddenRow(source, index) {
  return Boolean(source.hiddenRows && source.hiddenRows.has(index));
}

function rowCountsAsBlank(source, index) {
  return isBlankRow(source.rows[index]) || isHiddenRow(source, index);
}

function filledCellsOf(row) {
  return (row || []).map(cleanCell).filter((cell) => cell !== '');
}

function isFooterRow(row) {
  const cells = filledCellsOf(row);
  if (!cells.length) return false;
  return FOOTER_ROW_RE.test(cells[0].replace(/\s+/g, ''));
}

function isBlockTitleRow(row) {
  const cells = filledCellsOf(row);
  if (cells.length !== 1) return false;
  return BLOCK_TITLE_RE.test(cells[0].replace(/\s+/g, ''));
}

function looksLikeDataRow(source, row) {
  const companyIndex = source.mapping.company;
  const amountIndex = source.mapping.amount;
  if (companyIndex < 0 || amountIndex < 0) return false;
  const company = cleanCell(row[companyIndex]);
  if (!company || isSubtotalName(company)) return false;
  return parseAmount(row[amountIndex]) !== null;
}

function detectDataRegion(source) {
  const rows = source.rows;
  const start = source.headerRow + 1;
  const previous = source.dataRange;
  if (previous && previous.manual) return previous;

  const tail = Math.max(start, rows.length - 1);
  const whole = { fromRow: start, toRow: tail, manual: false, note: '', outside: 0 };
  if (start >= rows.length) return { ...whole, toRow: rows.length - 1 };

  const headers = getHeaderLabels(source);
  let toRow = rows.length - 1;
  let note = '';
  let blankRun = 0;
  let valid = 0;

  for (let r = start; r < rows.length; r += 1) {
    const row = rows[r] || [];
    if (rowCountsAsBlank(source, r)) {
      blankRun += 1;
      if (blankRun >= MAX_BLANK_GAP) {
        toRow = r - blankRun;
        note = '往下连续空白，没纳入';
        break;
      }
      continue;
    }
    blankRun = 0;

    if (r > start) {
      if (isBlockTitleRow(row)) {
        toRow = r - 1;
        note = '下面还有另一段，只取这一段';
        break;
      }
      if (isFooterRow(row)) {
        toRow = r - 1;
        note = '下面的说明和签字行没纳入';
        break;
      }
      if (looksLikeRepeatedHeader(row, headers, source.mapping.company, source.mapping.amount)) {
        toRow = r - 1;
        note = '下面又出现表头，只取这一段';
        break;
      }
    }

    if (looksLikeDataRow(source, row)) valid += 1;
  }

  if (!valid) return whole;

  let outside = 0;
  for (let r = toRow + 1; r < rows.length; r += 1) {
    if (!isBlankRow(rows[r])) outside += 1;
  }
  if (toRow >= rows.length - 1 && outside === 0) return { ...whole, note: '' };

  return { fromRow: start, toRow, manual: false, note, outside };
}

function dataRangeLabel(source) {
  const range = source.dataRange;
  if (!range) return '';
  const from = source.rowOffset + range.fromRow + 1;
  const to = source.rowOffset + range.toRow + 1;
  return range.fromRow >= range.toRow ? `第 ${from} 行` : `第 ${from}～${to} 行`;
}

function isMoneyFormat(text) {
  if (!text) return false;
  if (/yy|mm\/|\/mm|h:mm|s\.0|"年"|"月"|一般/i.test(text)) return false;
  if (/%/.test(text)) return false;
  return /0\.00|0\.0[;_) ]|#,|#,##|¥|￥|\$/.test(text);
}

function columnMoneyFormatRatio(source, index) {
  const sheet = source.sheet;
  if (!sheet) return { numeric: 0, ratio: 0 };

  const bounds = sampleRowBounds(source);
  let numeric = 0;
  let money = 0;

  for (let r = bounds.from; r <= bounds.to && numeric < 20; r += 1) {
    if (isHiddenRow(source, r)) continue;
    const cell = sheet[XLSX.utils.encode_cell({ r: source.rowOffset + r, c: index })];
    if (!cell || cell.t !== 'n') continue;
    numeric += 1;
    if (isMoneyFormat(cleanCell(cell.z || ''))) money += 1;
  }

  return { numeric, ratio: numeric ? money / numeric : 0 };
}

function companyColumnProfile(source, index) {
  const bounds = sampleRowBounds(source);
  let filled = 0;
  let entity = 0;
  let text = 0;
  let dateish = 0;
  let seq = 0;
  let lengthSum = 0;
  const seen = new Set();

  for (let r = bounds.from; r <= bounds.to; r += 1) {
    const cell = cleanCell((source.rows[r] || [])[index]);
    if (isPlaceholderCell(cell)) continue;
    // 「合计」「核对差异」这类行是底稿自己的说明行，不能当名字算进「这一列像不像对手方」的证据里，
    // 否则一张空模板披露表也会被当成企业列。
    if (isSubtotalName(cell)) continue;
    filled += 1;
    lengthSum += cell.length;
    seen.add(cell);
    if (ENTITY_HINT_RE.test(cell)) entity += 1;
    if (parseAmount(cell) === null) text += 1;
    if (DATEISH_RE.test(cell)) dateish += 1;
    else if (/^\d{1,4}$/.test(cell)) seq += 1;
  }

  return {
    filled,
    entityRatio: filled ? entity / filled : 0,
    textRatio: filled ? text / filled : 0,
    dateRatio: filled ? dateish / filled : 0,
    seqRatio: filled ? seq / filled : 0,
    avgLen: filled ? lengthSum / filled : 0,
    distinctRatio: filled ? seen.size / filled : 0
  };
}

// ===== 对账前检查与金额取数 =====

function validateIncludedSources(sources) {
  if (!sources.length) {
    return '还没勾选要核对的表。请在「数据源与方向」的列表里，把应收、应付那几张表各自打勾（每一行都写了这张表认出的企业名称列和金额列）；表多的话可以先点「全选」，再把封面、目录这些不要的取消掉。';
  }

  for (const source of sources) {
    const label = source.sheetName;
    if (source.mapping.company < 0 || source.mapping.amount < 0) {
      return `「${label}」还没有指定企业名称列或金额列。`;
    }

    const selected = [source.mapping.company, source.mapping.amount];
    if (source.mapping.direction >= 0) selected.push(source.mapping.direction);
    if (source.mapping.memo >= 0) selected.push(source.mapping.memo);
    if (new Set(selected).size !== selected.length) {
      return `「${label}」有多个字段指向同一列，请检查列对应关系。`;
    }

    if (source.mapping.direction < 0 && !fallbackDirectionForSource(source)) {
      return `「${label}」没有方向列，也没能从工作表名、标题或文件名识别方向。请在“数据源与方向”里选择“整表应收”或“整表应付”。`;
    }

    if (source.headerRow >= source.rows.length - 1) {
      return `「${label}」表头之后没有数据行，请检查表头所在行。`;
    }
  }

  return '';
}

function hasWorkInProgress() {
  if (state.sources.length || state.records.length) return true;
  const recv = els.manualRecv ? els.manualRecv.value.trim() : '';
  const pay = els.manualPay ? els.manualPay.value.trim() : '';
  return Boolean(recv || pay);
}

function confirmScaledUnits(entries) {
  const scaled = entries.filter((entry) => entry.unit && entry.unit !== 1);
  if (!scaled.length) {
    state.unitConfirmSignature = '';
    return true;
  }

  const signature = scaled.map((entry) => `${entry.id}:${entry.unit}`).join('|');
  if (state.unitConfirmSignature === signature) return true;

  const unitLabels = { 1000: '千元', 10000: '万元' };
  const lines = scaled.map(
    (entry) => `「${entry.sheetName}」的金额按${unitLabels[entry.unit] || '元'}算`
  );
  const ok = window.confirm(
    `${lines.join('\n')}\n\n金额会先乘上这个单位再对账。如果这些表其实是以“元”写的，请先在“金额单位”里改成“元”，否则结果会差很多倍。\n\n按上面的单位继续吗？`
  );
  if (!ok) return false;
  state.unitConfirmSignature = signature;
  return true;
}

// 总账系统（SAP／金蝶／用友）导出的余额表按「借方为正、贷方为负」写：
// 应付科目的正常余额本身就是负数。这类表要是照搬「负数=对方多付、挪到应收」，
// 整张应付表会被翻到对面去，两边永远配不上。所以要问一句，由用户确认这张表的写法。
const CREDIT_NEGATIVE_MIN_ROWS = 3;
const CREDIT_NEGATIVE_RATIO = 0.6;

function amountSignSplit(source) {
  const amountIndex = source.mapping.amount;
  if (amountIndex < 0) return null;
  const range = source.dataRange
    || { fromRow: source.headerRow + 1, toRow: source.rows.length - 1 };
  let filled = 0;
  let negative = 0;
  for (let r = range.fromRow; r <= range.toRow && r < source.rows.length; r += 1) {
    if (isHiddenRow(source, r)) continue;
    const cell = (source.rows[r] || [])[amountIndex];
    const text = cleanCell(cell);
    if (!text || isPlaceholderCell(text)) continue;
    const parsed = parseAmount(cell);
    if (parsed === null || parsed === 0) continue;
    filled += 1;
    if (parsed < 0) negative += 1;
  }
  if (filled < CREDIT_NEGATIVE_MIN_ROWS) return null;
  if (negative / filled < CREDIT_NEGATIVE_RATIO) return null;
  return { filled, negative };
}

function creditNegativeCandidates(sources) {
  return sources.filter((source) => {
    if (source.mapping.direction >= 0) return false;
    if (resolveSourceDirection(source).dir !== 'pay') return false;
    const split = amountSignSplit(source);
    if (!split) return false;
    source.signSplit = split;
    return true;
  });
}

function confirmSignConvention(sources) {
  sources.forEach((source) => {
    source.creditNegative = false;
  });

  const candidates = creditNegativeCandidates(sources);
  if (!candidates.length) return [];

  // 每次点「开始对账」都问：这一下决定的是整张表的正负怎么读，答错了后面看不出名堂，
  // 所以不做「记住上次答案」——记下来反而会让用户没有改回去的机会。
  const confirmed = window.confirm(
    `${candidates.map((source) => `「${source.shortLabel || source.sheetName}」是应付，${source.signSplit.filled} 行有余额的金额里有 ${source.signSplit.negative} 行写的是负数`).join('\n')}\n\n` +
    '从财务系统直接导出的余额表，常常把贷方写成负数：这种负数就是欠对方的钱，不是对方多付了。\n\n' +
    '这些表的负数按“欠对方的钱”算吗？\n' +
    '· 点「确定」：负数留在应付；写成正数的那几行（应付科目的借方余额）挪到应收\n' +
    '· 点「取消」：按原来的写法，负数挪到应收\n\n' +
    '拿不准就点取消，对完后看“数据检查”里的重分类行数，再点对账一次会重新问。'
  );
  if (!confirmed) return [];

  candidates.forEach((source) => {
    source.creditNegative = true;
  });
  return candidates.map((source) => ({
    sheet: source.shortLabel || source.sheetName,
    filled: source.signSplit.filled,
    negative: source.signSplit.negative
  }));
}

function bothSidesGroupCount(groups) {
  return (groups || []).filter((group) => group.hasRecv && group.hasPay).length;
}

function withoutEntityKey(records) {
  return records.map((record) => Object.assign({}, record, { entityKey: '', entityRaw: '' }));
}

// 每张表都认出了主体列时，「按主体分开」意味着各家的账各算各的。
// 但集团内部往来恰好是 A 的账上挂着 B、B 的账上又挂着 A：分开以后两边永远碰不到一起，
// 而对账要做的正是把能对上的人找出来。所以先各算一遍，只有「不分开能多对上几家」时才问，
// 平时不打扰。币种不在这里问——不同币种本来就不能相加。
function confirmEntityGrouping(records, sources) {
  if (sources.length < 2 || records.length < 2) return null;
  const allHaveEntity = sources.every((source) => {
    const column = sourceDimensionColumn(source, 'entity');
    return Boolean(column && column.index >= 0);
  });
  if (!allHaveEntity) return null;
  if (!records.some((record) => record.entityKey)) return null;

  const splitBoth = bothSidesGroupCount(buildGroups(records));
  const mergedBoth = bothSidesGroupCount(buildGroups(withoutEntityKey(records)));
  if (mergedBoth <= splitBoth) return null;

  const keepSplit = window.confirm(
    '这几张表都写了「主体」（也就是这笔账是谁家做的）。\n\n' +
    `· 按主体分开算：两边都有记录的只有 ${splitBoth} 家\n` +
    `· 不按主体分开算：两边都有记录的有 ${mergedBoth} 家\n\n` +
    '集团内部往来常常是 A 的账上挂着 B、B 的账上又挂着 A，按主体分开就碰不到一起。\n\n' +
    '要按主体分开吗？\n' +
    '· 点「确定」：按主体分开（各家的账各算各的）\n' +
    '· 点「取消」：不按主体分开，先把两边能对上的企业找出来'
  );
  if (keepSplit) return null;

  records.forEach((record) => {
    record.entityKey = '';
    record.entityRaw = '';
  });
  return {
    field: 'entity',
    text: `这几张表都认出了主体列，按主体分开只有 ${splitBoth} 家企业两边都有记录，不分开有 ${mergedBoth} 家，所以这次没有按主体分开算（上面每张表里选中的主体列还在，逐笔的明细不受影响）。要改回按主体分开，重新点「开始对账」，在弹窗里选「确定」就行。`
  };
}

function runReconciliation() {
  hideRunError();
  const sources = state.sources.filter((source) => source.included);
  const validation = validateIncludedSources(sources);
  if (validation) {
    showRunError(validation);
    return;
  }
  if (!confirmScaledUnits(sources.map((source) => ({
    id: source.id,
    unit: source.unit,
    sheetName: source.sheetName
  })))) {
    showRunError('已暂停对账：请先确认“金额单位”选对了，再点“开始对账”。');
    return;
  }

  const guessWarnings = [];
  const signNotes = confirmSignConvention(sources);
  sources.forEach((source) => {
    const low = sourceConfidence(source);
    if (low.length) {
      guessWarnings.push({ sheet: source.sheetName, items: low.map((item) => item.text) });
    }
  });
  state.guessWarnings = guessWarnings;
  const dimensionNotes = harmonizeAutoDimensionColumns(sources);

  const combined = {
    records: [],
    skipped: [],
    reclassRows: [],
    redRows: [],
    controls: [],
    unknownDirections: new Map(),
    inheritedRows: 0,
    directionFallbackRows: 0,
    outOfRangeRows: 0
  };

  sources.forEach((source) => {
    const parsed = parseExcelSource(source);
    combined.records.push(...parsed.records);
    combined.skipped.push(...parsed.skipped);
    combined.reclassRows.push(...parsed.reclassRows);
    combined.redRows.push(...parsed.redRows);
    const control = buildSourceControl(source, parsed);
    if (control) {
      combined.controls.push({
        sourceId: source.id,
        sheetName: source.sheetName,
        kind: 'excel',
        ...control
      });
    }
    combined.inheritedRows += parsed.inheritedRows;
    combined.directionFallbackRows += parsed.directionFallbackRows;
    combined.outOfRangeRows += parsed.outOfRangeRows;
    parsed.unknownDirections.forEach((count, value) => {
      combined.unknownDirections.set(value, (combined.unknownDirections.get(value) || 0) + count);
    });
  });

  if (!combined.records.length) {
    const reasonSummary = summarizeSkipReasons(combined.skipped);
    showRunError(
      `没有读到可用记录。${reasonSummary ? `已跳过 ${combined.skipped.length} 行（${reasonSummary}）。` : ''}请检查表头行、列对应关系和方向设置。`
    );
    return;
  }

  const entityNote = confirmEntityGrouping(combined.records, sources);
  if (entityNote) dimensionNotes.push(entityNote);

  const runInfo = {
    mode: 'excel',
    sources: sources.map((source) => {
      const direction = resolveSourceDirection(source);
      return {
        id: source.id,
        kind: 'excel',
        label: source.label,
        shortLabel: source.shortLabel,
        fileName: source.fileName,
        sheetName: source.sheetName,
        unit: source.unit,
        direction: direction.dir,
        directionLabel: direction.label,
        creditNegative: Boolean(source.creditNegative),
        dataRange: source.dataRange
          ? `${dataRangeLabel(source)}${source.dataRange.manual ? '（手工框选）' : ''}`
          : '',
        outsideRows: source.dataRange ? source.dataRange.outside : 0,
        recordCount: combined.records.filter((record) => record.sourceId === source.id).length
      };
    }),
    dimensionNotes,
    signNotes,
    generatedAt: new Date()
  };

  finalizeReconciliation({
    records: combined.records,
    skipped: combined.skipped,
    reclassRows: combined.reclassRows,
    redRows: combined.redRows,
    controls: combined.controls,
    unknownDirections: Array.from(combined.unknownDirections.entries()).sort((a, b) => b[1] - a[1]),
    inheritedRows: combined.inheritedRows,
    directionFallbackRows: combined.directionFallbackRows,
    outOfRangeRows: combined.outOfRangeRows,
    runInfo
  });
}

function parseExcelSource(source) {
  const records = [];
  const skipped = [];
  const reclassRows = [];
  const redRows = [];
  const unknownDirections = new Map();
  const rows = source.rows;
  const headers = getHeaderLabels(source);
  const companyIndex = source.mapping.company;
  const amountIndex = source.mapping.amount;
  const directionIndex = source.mapping.direction;
  const memoIndex = source.mapping.memo;
  const ageColumn = sourceAgeColumn(source);
  const ageIndex = ageColumn ? ageColumn.index : -1;
  const ageUnitHint = ageColumn ? ageColumn.unit : '';
  const entityColumn = sourceDimensionColumn(source, 'entity');
  const entityIndex = entityColumn ? entityColumn.index : -1;
  const currencyColumn = sourceDimensionColumn(source, 'currency');
  const currencyIndex = currencyColumn ? currencyColumn.index : -1;
  const fallbackDirection = fallbackDirectionForSource(source);
  let lastEntityRaw = '';
  let lastCurrencyRaw = '';
  const range = source.dataRange
    || { fromRow: source.headerRow + 1, toRow: rows.length - 1 };
  let inheritedRows = 0;
  let directionFallbackRows = 0;
  let outOfRangeRows = 0;
  let lastCompany = '';

  for (let r = source.headerRow + 1; r < rows.length; r += 1) {
    if (r < range.fromRow || r > range.toRow) {
      if (!isBlankRow(rows[r]) && !isHiddenRow(source, r)) outOfRangeRows += 1;
      continue;
    }

    const row = rows[r] || [];
    if (isHiddenRow(source, r)) {
      if (!isBlankRow(row)) outOfRangeRows += 1;
      continue;
    }
    const rowNumber = source.rowOffset + r + 1;
    const companyCell = cleanCell(row[companyIndex]);
    const amountCell = cleanCell(row[amountIndex]);
    const amountBlank = isPlaceholderCell(row[amountIndex]);
    const directionCell = directionIndex >= 0 ? cleanCell(row[directionIndex]) : '';
    const memoText = memoIndex >= 0 ? cleanCell(row[memoIndex]) : '';

    if (!companyCell && amountBlank && !directionCell) {
      lastCompany = '';
      continue;
    }

    if (looksLikeRepeatedHeader(row, headers, companyIndex, amountIndex)) {
      lastCompany = '';
      skipped.push({ rowNo: rowNumber, reason: '重复表头行', raw: companyCell, source: source.shortLabel });
      continue;
    }

    if (isSubtotalName(companyCell)) {
      lastCompany = '';
      skipped.push({ rowNo: rowNumber, reason: '合计/小计行', raw: companyCell, source: source.shortLabel });
      continue;
    }

    let companyRaw = companyCell;
    let inherited = false;

    if (!companyRaw) {
      if (amountBlank) {
        lastCompany = '';
        skipped.push({
          rowNo: rowNumber,
          reason: '缺少企业名称',
          raw: directionCell || memoText,
          source: source.shortLabel
        });
        continue;
      }
      if (!lastCompany) {
        skipped.push({
          rowNo: rowNumber,
          reason: '缺少企业名称（上方没有可承上的名称）',
          raw: amountCell,
          source: source.shortLabel
        });
        continue;
      }
      companyRaw = lastCompany;
      inherited = true;
    }

    if (amountBlank) {
      lastCompany = '';
      skipped.push({
        rowNo: rowNumber,
        reason: amountCell ? '金额为 -（原表无余额）' : '金额为空',
        raw: companyRaw,
        source: source.shortLabel
      });
      continue;
    }

    lastCompany = companyRaw;

    let dir = '';
    if (directionIndex >= 0 && directionCell) {
      dir = parseDirection(directionCell);
      if (!dir) {
        skipped.push({
          rowNo: rowNumber,
          reason: '方向无法识别',
          raw: directionCell,
          source: source.shortLabel
        });
        unknownDirections.set(directionCell, (unknownDirections.get(directionCell) || 0) + 1);
        continue;
      }
    } else if (fallbackDirection) {
      dir = fallbackDirection;
      if (directionIndex >= 0) directionFallbackRows += 1;
    } else {
      skipped.push({
        rowNo: rowNumber,
        reason: directionIndex >= 0 ? '方向为空' : '未识别整表方向',
        raw: companyRaw,
        source: source.shortLabel
      });
      continue;
    }

    const parsedAmount = parseAmount(row[amountIndex]);
    if (parsedAmount === null) {
      skipped.push({ rowNo: rowNumber, reason: '金额无法识别', raw: amountCell, source: source.shortLabel });
      continue;
    }
    const redFlipped = parsedAmount > 0 && isRedAmountCell(source, amountIndex, r);
    const cellAmount = redFlipped ? -parsedAmount : parsedAmount;
    // 已确认「贷方写负数」的应付表：整列的读法要反过来 —— 写负数才是欠对方的钱，
    // 写正数反而是应付科目的借方余额（多付／预付），下面按原来的负数重分类挪到应收。
    const amount = source.creditNegative ? -cellAmount : cellAmount;

    const key = normalizeName(companyRaw);
    if (!key) {
      skipped.push({ rowNo: rowNumber, reason: '企业名称为空', raw: companyRaw, source: source.shortLabel });
      continue;
    }

    const rawCents = Math.round(amount * source.unit * 100);
    const cents = Math.abs(rawCents);
    if (!Number.isFinite(cents)) {
      skipped.push({ rowNo: rowNumber, reason: '金额无法识别', raw: amountCell, source: source.shortLabel });
      continue;
    }

    const reclassified = amount < 0;
    const finalDir = reclassified ? (dir === 'recv' ? 'pay' : 'recv') : dir;
    if (reclassified) {
      reclassRows.push({
        rowNo: rowNumber,
        company: displayRawName(companyRaw),
        source: source.shortLabel,
        from: dir,
        to: finalDir,
        red: redFlipped
      });
      if (redFlipped) {
        redRows.push({
          rowNo: rowNumber,
          company: displayRawName(companyRaw),
          source: source.shortLabel,
          from: dir,
          to: finalDir
        });
      }
    }
    if (inherited) inheritedRows += 1;

    const ageParsed = ageIndex >= 0 ? parseAgeCell(row[ageIndex], ageUnitHint) : null;
    const memoDate = extractMemoDate(memoText);
    const recordDateISO = ageParsed && ageParsed.date ? ageParsed.date : memoDate;
    const docNo = extractDocNo(memoText);

    let entityRaw = '';
    let entityKey = '';
    if (entityIndex >= 0) {
      const cell = displayRawName(row[entityIndex]);
      if (cell && !isPlaceholderCell(cell)) {
        lastEntityRaw = cell;
        entityRaw = cell;
      } else {
        entityRaw = lastEntityRaw || '（未注明）';
      }
      entityKey = normalizeName(entityRaw) || entityRaw;
    }

    let currencyRaw = '';
    let currencyKey = '';
    if (currencyIndex >= 0) {
      const cell = displayRawName(row[currencyIndex]);
      if (cell && !isPlaceholderCell(cell)) {
        lastCurrencyRaw = cell;
        currencyRaw = cell;
      } else {
        currencyRaw = lastCurrencyRaw || '（未写币种）';
      }
      currencyKey = currencyKeyOf(currencyRaw) || currencyRaw;
    }

    records.push({
      rowNo: rowNumber,
      companyRaw: displayRawName(companyRaw),
      entityRaw,
      entityKey,
      currencyRaw,
      currencyKey,
      key,
      dir: finalDir,
      cents,
      rawCents,
      cellCents: Math.round(parsedAmount * source.unit * 100),
      memo: memoText,
      docNo,
      docKey: docKeyOf(docNo),
      memoKeys: extractMemoKeys(memoText),
      ageBand: ageParsed && ageParsed.band >= 0 ? ageParsed.band : -1,
      ageMonths: ageParsed && Number.isFinite(ageParsed.months) ? ageParsed.months : null,
      ageDateISO: ageParsed ? ageParsed.date : '',
      ageRaw: ageIndex >= 0 ? cleanCell(row[ageIndex]) : '',
      hasAgeColumn: ageIndex >= 0,
      dateISO: recordDateISO,
      dateSource: ageParsed && ageParsed.date ? 'age' : (memoDate ? 'memo' : ''),
      rawAmount: amountCell,
      reclassified,
      redFlipped,
      zero: cents === 0,
      inherited,
      sourceId: source.id,
      sourceLabel: source.label,
      sourceShortLabel: source.shortLabel,
      sourceKind: 'excel'
    });
  }

  return {
    records,
    skipped,
    reclassRows,
    redRows,
    unknownDirections,
    inheritedRows,
    directionFallbackRows,
    outOfRangeRows
  };
}

function buildSourceControl(source, parsed) {
  const amountIndex = source.mapping.amount;
  if (!source.rows || amountIndex < 0) return null;

  const range = source.dataRange
    || { fromRow: source.headerRow + 1, toRow: source.rows.length - 1 };
  const samples = [];

  for (let r = source.headerRow + 1; r < source.rows.length; r += 1) {
    const row = source.rows[r] || [];
    if (isPlaceholderCell(row[amountIndex])) continue;
    const value = parseAmount(row[amountIndex]);
    if (value === null || !Number.isFinite(value)) continue;
    samples.push({
      rowNo: source.rowOffset + r + 1,
      cents: Math.round(value * source.unit * 100),
      outside: r < range.fromRow || r > range.toRow || isHiddenRow(source, r)
    });
  }

  return summarizeControl(samples, parsed.records, parsed.skipped);
}

function buildManualControl(text, parsed, source) {
  const samples = [];

  String(text || '').split(/\r?\n/).forEach((line, index) => {
    const rawLine = String(line === null || line === undefined ? '' : line).replace(/\u00a0/g, ' ');
    if (!cleanCell(rawLine) || isManualHeaderLine(rawLine)) return;
    const parts = splitManualLine(rawLine);
    if (!parts) return;
    const value = parseAmount(parts.amountRaw);
    if (value === null || !Number.isFinite(value)) return;
    samples.push({ rowNo: index + 1, cents: Math.round(value * source.unit * 100), outside: false });
  });

  return summarizeControl(samples, parsed.records, parsed.skipped);
}

// 独立重算金额列：原表金额 = 纳入 + 跳过 + 范围外 + 未归类。
// 「未归类」是解析流程里没被任何一条记录或跳过项认领的金额格，必须为 0。
function summarizeControl(samples, records, skipped) {
  const recordMap = new Map();
  records.forEach((record) => recordMap.set(record.rowNo, record));
  const skipSet = new Set(skipped.map((item) => item.rowNo));
  const sampleRows = new Set(samples.map((sample) => sample.rowNo));
  const currencyKeys = Array.from(new Set(records.map((record) => record.currencyKey).filter(Boolean)))
    .sort(compareStableText);
  const control = {
    rawCents: 0,
    includedCents: 0,
    skippedCents: 0,
    outsideCents: 0,
    unmatchedCents: 0,
    rawCells: 0,
    includedCells: 0,
    skippedCells: 0,
    outsideCells: 0,
    unmatchedCells: 0,
    unmatchedRows: [],
    missingRecordRows: [],
    currencyKeys,
    currencyMixed: currencyKeys.length > 1
  };

  samples.forEach((sample) => {
    control.rawCents += sample.cents;
    control.rawCells += 1;

    if (sample.outside) {
      control.outsideCents += sample.cents;
      control.outsideCells += 1;
      return;
    }

    const record = recordMap.get(sample.rowNo);
    if (record) {
      const cellCents = record.cellCents === undefined ? record.rawCents : record.cellCents;
      control.includedCents += cellCents;
      control.includedCells += 1;
      return;
    }
    if (skipSet.has(sample.rowNo)) {
      control.skippedCents += sample.cents;
      control.skippedCells += 1;
      return;
    }

    control.unmatchedCents += sample.cents;
    control.unmatchedCells += 1;
    control.unmatchedRows.push(sample.rowNo);
  });

  records.forEach((record) => {
    if (!sampleRows.has(record.rowNo)) control.missingRecordRows.push(record.rowNo);
  });

  control.diffCents = control.rawCents - control.includedCents - control.skippedCents
    - control.outsideCents - control.unmatchedCents;
  control.diffCells = control.rawCells - control.includedCells - control.skippedCells
    - control.outsideCells - control.unmatchedCells;
  control.ok = control.diffCents === 0
    && control.diffCells === 0
    && control.unmatchedCells === 0
    && control.missingRecordRows.length === 0;
  return control;
}

function controlForSource(sourceId) {
  return (state.controls || []).find((control) => control.sourceId === sourceId) || null;
}

function fmtControlAmount(control, cents) {
  return control && control.currencyMixed ? fmtMoneyPlain(cents) : fmtMoney(cents);
}

function combineControls(controls) {
  const total = {
    rawCents: 0,
    includedCents: 0,
    skippedCents: 0,
    outsideCents: 0,
    unmatchedCents: 0,
    rawCells: 0,
    includedCells: 0,
    skippedCells: 0,
    outsideCells: 0,
    unmatchedCells: 0,
    diffCents: 0,
    diffCells: 0,
    unmatchedRows: [],
    missingRecordRows: [],
    currencyKeys: [],
    currencyMixed: false,
    ok: true
  };

  const currencyKeys = new Set();
  (controls || []).forEach((control) => {
    if (!control) return;
    (control.currencyKeys || []).forEach((key) => currencyKeys.add(key));
    total.rawCents += control.rawCents;
    total.includedCents += control.includedCents;
    total.skippedCents += control.skippedCents;
    total.outsideCents += control.outsideCents;
    total.unmatchedCents += control.unmatchedCents;
    total.rawCells += control.rawCells;
    total.includedCells += control.includedCells;
    total.skippedCells += control.skippedCells;
    total.outsideCells += control.outsideCells;
    total.unmatchedCells += control.unmatchedCells;
    total.unmatchedRows.push(...control.unmatchedRows);
    total.missingRecordRows.push(...control.missingRecordRows);
    total.ok = total.ok && control.ok;
  });

  total.diffCents = total.rawCents - total.includedCents - total.skippedCents
    - total.outsideCents - total.unmatchedCents;
  total.diffCells = total.rawCells - total.includedCells - total.skippedCells
    - total.outsideCells - total.unmatchedCells;
  total.currencyKeys = Array.from(currencyKeys).sort(compareStableText);
  total.currencyMixed = total.currencyKeys.length > 1;
  return total;
}

// ===== 手动粘贴取数 =====

function splitManualLine(line) {
  const raw = String(line === null || line === undefined ? '' : line)
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '');
  if (!raw.trim()) return null;

  let parts = [];
  if (raw.includes('\t')) {
    parts = raw.split('\t').map(cleanCell);
  } else if (/\s{2,}/.test(raw)) {
    parts = raw.split(/\s{2,}/).map(cleanCell);
  } else {
    const match = raw.match(/^(.*?)[\s,，;；|]+([¥￥]?[\d,，.\-()（）]+元?)$/);
    if (!match) return null;
    parts = [match[1], match[2]];
  }

  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  if (parts.length < 2) return null;

  const nonEmptyCount = parts.filter(Boolean).length;
  if (parts[0] === '' && nonEmptyCount >= 2) {
    while (parts.length && parts[0] === '') parts.shift();
  }

  if (parts.length >= 3 && /^\d{1,4}[.、)]?$/.test(parts[0])) {
    parts.shift();
  }

  const company = parts[0] || '';
  let amountRaw = parts[1] || '';

  if (parseAmount(amountRaw) === null) {
    for (let i = parts.length - 1; i >= 2; i -= 1) {
      if (parseAmount(parts[i]) !== null) {
        amountRaw = parts[i];
        break;
      }
    }
  }

  const usedIndex = parts.indexOf(amountRaw);
  const memo = (usedIndex >= 0 ? parts.filter((part, i) => i !== 0 && i !== usedIndex && part) : parts.slice(2).filter(Boolean)).join(' ');

  return { company, amountRaw, memo };
}

function isManualHeaderLine(raw) {
  const compact = cleanCell(raw).replace(/\s+/g, '');
  if (isSubtotalName(compact)) return true;
  if (/名称/.test(compact) && /金额|余额|发生额|价款/.test(compact)) return true;
  return /^(企业|公司|单位|客户|供应商|对方)[^0-9]{0,6}(金额|余额|发生额|价款)/.test(compact);
}

function parseManualSide(text, direction, source) {
  const records = [];
  const skipped = [];
  const reclassRows = [];
  let inheritedRows = 0;
  let lastCompany = '';

  String(text || '').split(/\r?\n/).forEach((line, index) => {
    const rowNo = index + 1;
    const rawLine = String(line === null || line === undefined ? '' : line)
      .replace(/\u00a0/g, ' ')
      .replace(/\r/g, '');
    const raw = cleanCell(rawLine);
    if (!raw) {
      lastCompany = '';
      return;
    }

    if (isManualHeaderLine(raw)) {
      lastCompany = '';
      return;
    }

    const parsed = splitManualLine(rawLine);
    if (!parsed) {
      lastCompany = '';
      skipped.push({ rowNo, reason: '无法识别（需要企业名称+金额）', raw, source: source.shortLabel });
      return;
    }

    let company = cleanCell(parsed.company);
    const amountText = cleanCell(parsed.amountRaw);
    let inherited = false;

    if (!amountText) {
      lastCompany = '';
      skipped.push({ rowNo, reason: '金额为空', raw, source: source.shortLabel });
      return;
    }

    if (!company) {
      if (!lastCompany) {
        skipped.push({ rowNo, reason: '缺少企业名称（上方没有可承上的名称）', raw, source: source.shortLabel });
        return;
      }
      company = lastCompany;
      inherited = true;
    } else {
      lastCompany = company;
    }

    const amount = parseAmount(parsed.amountRaw);
    if (amount === null) {
      skipped.push({ rowNo, reason: '金额无法识别', raw: amountText, source: source.shortLabel });
      return;
    }

    const key = normalizeName(company);
    if (!key) {
      skipped.push({ rowNo, reason: '企业名称为空', raw: company, source: source.shortLabel });
      return;
    }

    const rawCents = Math.round(amount * source.unit * 100);
    const cents = Math.abs(rawCents);
    if (!Number.isFinite(cents)) {
      skipped.push({ rowNo, reason: '金额无法识别', raw: amountText, source: source.shortLabel });
      return;
    }

    const reclassified = amount < 0;
    const finalDir = reclassified ? (direction === 'recv' ? 'pay' : 'recv') : direction;
    if (reclassified) {
      reclassRows.push({
        rowNo,
        company: displayRawName(company),
        source: source.shortLabel,
        from: direction,
        to: finalDir
      });
    }
    if (inherited) inheritedRows += 1;

    const memoText = parsed.memo || '';
    const memoDate = extractMemoDate(memoText);
    const docNo = extractDocNo(memoText);

    records.push({
      rowNo,
      companyRaw: displayRawName(company),
      entityRaw: '',
      entityKey: '',
      currencyRaw: '',
      currencyKey: '',
      key,
      dir: finalDir,
      cents,
      rawCents,
      memo: memoText,
      docNo,
      docKey: docKeyOf(docNo),
      memoKeys: extractMemoKeys(memoText),
      dateISO: memoDate,
      dateSource: memoDate ? 'memo' : '',
      rawAmount: amountText,
      reclassified,
      zero: cents === 0,
      inherited,
      sourceId: source.id,
      sourceLabel: source.label,
      sourceShortLabel: source.shortLabel,
      sourceKind: 'manual'
    });
  });

  return { records, skipped, reclassRows, inheritedRows };
}

function runManualReconciliation() {
  els.manualError.classList.add('hidden');
  state.guessWarnings = [];

  const recvText = els.manualRecv.value;
  const payText = els.manualPay.value;
  if (!countNonEmptyLines(recvText) && !countNonEmptyLines(payText)) {
    showManualError('请先在左侧或右侧粘贴企业名称和金额。');
    return;
  }

  const unit = Number(els.manualUnit.value) || 1;
  if (!confirmScaledUnits([{ id: 'manual', unit, sheetName: '左右两边的粘贴内容' }])) {
    showManualError('已暂停对账：请先确认左右两边的“金额单位”选对了，再点“开始对账”。');
    return;
  }
  const recvSource = {
    id: 'manual-recv',
    kind: 'manual',
    shortLabel: '左侧粘贴',
    label: '左侧粘贴（应收）',
    unit
  };
  const paySource = {
    id: 'manual-pay',
    kind: 'manual',
    shortLabel: '右侧粘贴',
    label: '右侧粘贴（应付）',
    unit
  };

  const recvParsed = parseManualSide(recvText, 'recv', recvSource);
  const payParsed = parseManualSide(payText, 'pay', paySource);
  const records = [...recvParsed.records, ...payParsed.records];
  const skipped = [...recvParsed.skipped, ...payParsed.skipped];
  const reclassRows = [...recvParsed.reclassRows, ...payParsed.reclassRows];
  const inheritedRows = recvParsed.inheritedRows + payParsed.inheritedRows;
  const controls = [];
  const recvControl = buildManualControl(recvText, recvParsed, recvSource);
  const payControl = buildManualControl(payText, payParsed, paySource);
  if (recvControl) controls.push({ sourceId: 'manual-recv', sheetName: '左侧粘贴', kind: 'manual', ...recvControl });
  if (payControl) controls.push({ sourceId: 'manual-pay', sheetName: '右侧粘贴', kind: 'manual', ...payControl });

  if (!records.length) {
    const reasonSummary = summarizeSkipReasons(skipped);
    showManualError(
      `没有读到可用记录。${reasonSummary ? `已跳过 ${skipped.length} 行（${reasonSummary}）。` : ''}请确认每行是“企业名称 + 金额”。`
    );
    return;
  }

  recvSource.recordCount = recvParsed.records.length;
  paySource.recordCount = payParsed.records.length;

  finalizeReconciliation({
    records,
    skipped,
    reclassRows,
    controls,
    unknownDirections: [],
    inheritedRows,
    directionFallbackRows: 0,
    outOfRangeRows: 0,
    runInfo: {
      mode: 'manual',
      sources: [recvSource, paySource],
      generatedAt: new Date()
    }
  });
}

function showManualError(message) {
  els.manualError.textContent = message;
  els.manualError.classList.remove('hidden');
  els.manualError.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ===== 对账结果归并 =====

function buildDimensionCoverageWarnings(records) {
  const byCompany = new Map();
  (records || []).forEach((record) => {
    if (!record || !record.key) return;
    let entry = byCompany.get(record.key);
    if (!entry) {
      entry = {
        name: record.companyRaw || '',
        entityFilled: 0,
        entityEmpty: 0,
        currencyFilled: 0,
        currencyEmpty: 0,
        sources: new Map()
      };
      byCompany.set(record.key, entry);
    }
    if (record.entityKey) entry.entityFilled += 1;
    else entry.entityEmpty += 1;
    if (record.currencyKey) entry.currencyFilled += 1;
    else entry.currencyEmpty += 1;
    if (record.sourceId && !entry.sources.has(record.sourceId)) {
      entry.sources.set(record.sourceId, record.sourceShortLabel || record.sourceLabel || '');
    }
  });

  const warnings = [];
  byCompany.forEach((entry) => {
    const kinds = [];
    if (entry.entityFilled && entry.entityEmpty) kinds.push('主体');
    if (entry.currencyFilled && entry.currencyEmpty) kinds.push('币种');
    if (!kinds.length) return;
    warnings.push({
      name: entry.name,
      kinds,
      sources: Array.from(entry.sources.values()).filter(Boolean)
    });
  });
  warnings.sort((a, b) => compareStableText(a.name, b.name));
  return warnings;
}

// 勾了却一笔都没算进去，是最难发现的空跑：表在、列在，但金额列是空的、或取数范围只剩表头。
function emptyIncludedSourceNames() {
  const sources = state.runInfo && Array.isArray(state.runInfo.sources) ? state.runInfo.sources : [];
  return sources
    .filter((item) => Number(item.recordCount) === 0)
    .map((item) => item.shortLabel || item.sheetName || item.label || '数据源');
}

function finalizeReconciliation(payload) {
  applyAgeBandPreset('year');
  if (els.ageBandPreset) els.ageBandPreset.value = 'year';
  payload.records.forEach((record) => {
    if (!record.hasAgeColumn) return;
    if (Number.isFinite(record.ageMonths)) record.ageBand = ageBandIndex(record.ageMonths);
    record.ageShown = recordAgeBand(record, ageBaseDateValue());
  });
  const groups = buildGroups(payload.records);

  state.records = payload.records;
  state.groups = groups;
  state.skipped = payload.skipped;
  state.reclassRows = payload.reclassRows;
  state.redRows = payload.redRows || [];
  state.dimensionWarnings = buildDimensionCoverageWarnings(payload.records);
  state.controls = payload.controls || [];
  state.unknownDirections = payload.unknownDirections || [];
  state.inheritedRows = payload.inheritedRows || 0;
  state.directionFallbackRows = payload.directionFallbackRows || 0;
  state.outOfRangeRows = payload.outOfRangeRows || 0;
  resetUndoHistory();
  els.pairTolerance.value = (state.pairToleranceCents / 100).toFixed(2);
  if (els.pairPercent) els.pairPercent.value = formatPercentInput(state.pairPercent);
  state.pairResult = runPairing(groups, state.pairToleranceCents);
  state.stats = computeStats(groups);
  state.similarSuggestions = buildSimilarSuggestions(groups);
  state.runInfo = payload.runInfo;
  state.filter = 'all';
  state.search = '';
  state.sort = 'netAbsDesc';
  resetFacets();
  state.renderLimit = RENDER_PAGE_SIZE;
  state.expanded.clear();
  state.dataCheckOpen = false;
  if (!state.signoff.date) {
    state.signoff.date = todayIsoDate();
    if (els.signoffDate) els.signoffDate.value = state.signoff.date;
  }

  els.searchInput.value = '';
  els.sortSelect.value = 'netAbsDesc';
  els.exportFiltered.checked = false;

  if (payload.runInfo.mode === 'manual') {
    els.landingSection.classList.remove('hidden');
    els.configSection.classList.add('hidden');
    els.manualError.classList.add('hidden');
  } else {
    els.landingSection.classList.add('hidden');
    els.configSection.classList.remove('hidden');
    hideRunError();
  }

  els.resultSection.classList.remove('hidden');
  updateResultMeta();
  renderSummary();
  renderDataCheck();
  renderSimilarBox();
  renderChips();
  renderFacets();
  renderTable();

  requestAnimationFrame(() => {
    els.resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  showToast(`对账完成：${groups.length} 家企业，${payload.records.length} 笔有效记录`);
  if (state.guessWarnings.length) {
    const first = state.guessWarnings[0];
    showToast(
      `有 ${state.guessWarnings.length} 张表的部分列是猜的（${first.sheet}：${first.items.join('、')}${state.guessWarnings.length > 1 ? '，还有别的' : ''}），先回“核对数据源”看一眼图片再对账`,
      true
    );
  }
  if (state.redRows.length) {
    const first = state.redRows[0];
    showToast(
      `有 ${state.redRows.length} 笔金额是红字，已按负数处理（${first.source ? `「${first.source}」` : ''}第 ${first.rowNo} 行等）。如果红字只是标注、金额其实是正数，请把金额列字体改成普通颜色再导入`,
      true
    );
  }
  if (state.dimensionWarnings.length) {
    const first = state.dimensionWarnings[0];
    const kindText = first.kinds.join('、');
    showToast(
      `有 ${state.dimensionWarnings.length} 家企业的${kindText}没对齐：同一家有的记录写了${kindText}、有的没写（如「${first.name}」${first.sources.length ? `，涉及「${first.sources.join('」「')}」` : ''}），会被拆成两组、两边对不上。请回去给每张表都选上${kindText}列，或者都设成不用`,
      true
    );
  }
  const emptySources = emptyIncludedSourceNames();
  if (emptySources.length) {
    showToast(
      `有 ${emptySources.length} 张勾选的表一笔都没算进去（${emptySources.slice(0, 2).join('」「')}${emptySources.length > 2 ? '」等' : '」'}）。多半是金额列选到了空白列，或取数范围只剩表头；点开那张表看一眼图片就能看出来，确实没数据就取消勾选。`,
      true
    );
  }
  const dimensionNotes = payload.runInfo && Array.isArray(payload.runInfo.dimensionNotes)
    ? payload.runInfo.dimensionNotes
    : [];
  dimensionNotes.forEach((note) => showToast(note.text, true));
  const signNotes = payload.runInfo && Array.isArray(payload.runInfo.signNotes)
    ? payload.runInfo.signNotes
    : [];
  if (signNotes.length) {
    const first = signNotes[0];
    showToast(
      `「${first.sheet}」的负数按“欠对方的钱”算，留在应付（${first.negative} 行）；写成正数的 ${first.filled - first.negative} 行已挪到应收${signNotes.length > 1 ? `，另有 ${signNotes.length - 1} 张表同样处理` : ''}。要是这张表本来就是“负数=对方多付”，重新点对账、在弹窗里选「取消」即可`,
      true
    );
  }
}

function looksLikeRepeatedHeader(row, headers, companyIndex, amountIndex) {
  const company = cleanCell(row[companyIndex]);
  const amount = cleanCell(row[amountIndex]);
  const headerCompany = cleanCell(headers[companyIndex]);
  const headerAmount = cleanCell(headers[amountIndex]);
  return Boolean(company && amount && company === headerCompany && amount === headerAmount);
}

function isSubtotalName(value) {
  const compact = cleanCell(value).replace(/\s+/g, '');
  if (!compact) return false;
  if (/^(本页|以上)?(合计|小计|总计|累计|总额|汇总)/.test(compact)) return true;
  // 底稿模板自带的核对行与披露行：左边写的是一句说明，不是往来对手方
  if (/^(核对差异|核对情况|审定数|账龄分析表中|账龄超过|一年以上重要|期后调整|差异分析)/.test(compact)) return true;
  if (/^(其中|减|加|扣除|不含)[：:]/.test(compact)) return true;
  if (/^[一二三四五六七八九十]+[、.．]/.test(compact)) return true;
  return /^(合并范围内|合并范围外|关联方|非关联方|内部单位|内部往来|外部单位|系统内|系统外|集团内部|集团外部|账内|账外)/.test(compact)
    && compact.length <= 16;
}

function resolveMergeKey(key) {
  let current = key;
  let guard = 0;
  while (state.merges.has(current) && guard < 10) {
    current = state.merges.get(current);
    guard += 1;
  }
  return current;
}

function emptyAgeCell() {
  return { cents: 0, count: 0 };
}

function buildAgeStats(group, baseIso) {
  const recv = AGE_BANDS.map(emptyAgeCell);
  const pay = AGE_BANDS.map(emptyAgeCell);
  const recvUnknown = emptyAgeCell();
  const payUnknown = emptyAgeCell();
  let marked = 0;
  let applicable = 0;
  let maxBand = -1;

  group.rows.forEach((record) => {
    if (!record.hasAgeColumn) {
      record.ageShown = null;
      return;
    }
    applicable += 1;
    const band = recordAgeBand(record, baseIso);
    record.ageShown = band;
    if (band < 0) {
      const cell = record.dir === 'recv' ? recvUnknown : payUnknown;
      cell.cents += record.cents;
      cell.count += 1;
      return;
    }
    marked += 1;
    if (band > maxBand) maxBand = band;
    const cell = (record.dir === 'recv' ? recv : pay)[band];
    cell.cents += record.cents;
    cell.count += 1;
  });

  return {
    recv,
    pay,
    recvUnknown,
    payUnknown,
    marked,
    applicable,
    total: group.rows.length,
    maxBand
  };
}

function buildGroups(records) {
  const groupMap = new Map();

  records.forEach((record) => {
    const baseKey = resolveMergeKey(record.key);
    record.mergedFromKey = baseKey === record.key ? '' : record.key;
    const key = dimensionGroupKey(baseKey, record.entityKey, record.currencyKey);
    let group = groupMap.get(key);
    if (!group) {
      group = {
        key,
        baseKey,
        entityKey: record.entityKey || '',
        entityLabel: record.entityRaw || '',
        currencyKey: record.currencyKey || '',
        currencyLabel: record.currencyKey
          ? currencyLabelForKey(record.currencyKey, record.currencyRaw)
          : '',
        rows: [],
        recvCents: 0,
        payCents: 0,
        hasRecv: false,
        hasPay: false,
        variantMap: new Map(),
        sourceMap: new Map(),
        originKeySet: new Set()
      };
      groupMap.set(key, group);
    }

    group.originKeySet.add(record.key);
    group.rows.push(record);
    if (record.dir === 'recv') {
      group.recvCents += record.cents;
      group.hasRecv = true;
    } else {
      group.payCents += record.cents;
      group.hasPay = true;
    }
    const variant = group.variantMap.get(record.companyRaw);
    if (variant) {
      variant.count += 1;
    } else {
      group.variantMap.set(record.companyRaw, { count: 1, firstRow: record.rowNo });
    }

    if (!group.sourceMap.has(record.sourceId)) {
      group.sourceMap.set(record.sourceId, {
        id: record.sourceId,
        shortLabel: record.sourceShortLabel || record.sourceLabel || '数据源',
        label: record.sourceLabel || record.sourceShortLabel || '数据源',
        kind: record.sourceKind || 'excel'
      });
    }
  });

  const groups = [];

  groupMap.forEach((group) => {
    const variants = Array.from(group.variantMap.entries())
      .map(([name, info]) => ({ name, count: info.count, firstRow: info.firstRow }))
      .sort((a, b) => b.count - a.count || a.firstRow - b.firstRow);

    group.variantList = variants.map((variant) => [variant.name, variant.count]);
    group.sources = Array.from(group.sourceMap.values());
    group.displayName = variants[0].name;
    group.netCents = group.recvCents - group.payCents;

    const dirAmounts = { recv: new Map(), pay: new Map() };
    group.rows.forEach((record) => {
      const amountMap = dirAmounts[record.dir];
      amountMap.set(record.cents, (amountMap.get(record.cents) || 0) + 1);
    });

    group.equalCentsList = Array.from(dirAmounts.recv.keys())
      .filter((cents) => dirAmounts.pay.has(cents))
      .sort((a, b) => b - a);
    group.equalPair = group.equalCentsList.length > 0;

    const duplicateItems = [];
    ['recv', 'pay'].forEach((dir) => {
      dirAmounts[dir].forEach((count, cents) => {
        if (count > 1) duplicateItems.push({ dir, cents, count });
      });
    });
    duplicateItems.sort((a, b) => b.cents - a.cents);
    group.sameDirDupItems = duplicateItems;
    group.sameDirDup = duplicateItems.length > 0;
    group.docHints = group.hasRecv && group.hasPay ? buildDocHints(group) : [];
    group.hasDocHint = group.docHints.length > 0;
    group.memoKeyHints = group.hasRecv && group.hasPay ? buildMemoKeyHints(group) : [];
    group.hasMemoKey = group.memoKeyHints.length > 0;
    group.ageStats = buildAgeStats(group, ageBaseDateValue());
    group.hasAge = group.ageStats.applicable > 0;
    group.ageLong = group.ageStats.maxBand === AGE_BANDS.length - 1;

    group.rows.forEach((record) => {
      const flags = [];
      const sameDirCount = dirAmounts[record.dir].get(record.cents) || 0;
      const oppositeDir = record.dir === 'recv' ? 'pay' : 'recv';

      if (sameDirCount > 1) flags.push('sameDup');
      if (dirAmounts[oppositeDir].has(record.cents)) flags.push('equal');
      if (record.reclassified) flags.push('reclass');
      if (record.zero) flags.push('zero');
      record.flags = flags;
    });

    group.flags = [];
    group.hasReclass = group.rows.some((record) => record.reclassified);
    group.mergedKeys = Array.from(group.originKeySet).filter((key) => key !== group.baseKey);
    group.manualMerge = group.mergedKeys.length > 0;
    if (group.sameDirDup) group.flags.push('sameDup');
    if (group.variantList.length > 1) group.flags.push('variant');
    if (group.manualMerge) group.flags.push('merge');
    if (group.equalPair) group.flags.push('equal');
    if (!(group.hasRecv && group.hasPay)) group.flags.push('single');
    if (group.rows.length > 1) group.flags.push('dup');
    if (group.hasReclass) group.flags.push('reclass');
    if (group.ageLong) group.flags.push('ageLong');

    group.keyReview = group.sameDirDup || group.variantList.length > 1 || group.hasReclass;
    groups.push(group);
  });

  groups.forEach((group, index) => {
    group.idx = index;
  });

  return groups;
}

// ===== 自动核销配对与日期提示 =====

function runPairing(groups, toleranceCents, percent = state.pairPercent) {
  const startedAt = Date.now();
  let pairCount = 0;
  let pairedRecvCents = 0;
  let pairedPayCents = 0;
  let pairGroups = 0;
  let limitedGroups = 0;
  let skippedGroups = 0;
  let nearMissGroups = 0;
  let nearMissCount = 0;

  groups.forEach((group) => {
    if (!group.hasRecv || !group.hasPay) {
      group.pairings = [];
      group.canPair = false;
      group.pairLimited = false;
      group.pairedRecvCents = 0;
      group.pairedPayCents = 0;
      group.nearMiss = [];
      group.hasNearMiss = false;
      group.flags = group.flags.filter((flag) => flag !== 'pair');
      return;
    }
    if (Date.now() - startedAt > PAIR_TIME_BUDGET_MS) {
      group.pairings = [];
      group.canPair = false;
      group.pairLimited = true;
      group.pairedRecvCents = 0;
      group.pairedPayCents = 0;
      group.nearMiss = [];
      group.hasNearMiss = false;
      group.flags = group.flags.filter((flag) => flag !== 'pair');
      skippedGroups += 1;
      return;
    }

    const previousDecisions = new Map();
    (group.pairings || []).forEach((pairing) => {
      if (pairing.decision && pairing.decision !== 'pending') {
        previousDecisions.set(pairingSignature(pairing), pairing.decision);
      }
    });

    const outcome = pairGroup(group, toleranceCents, percent);
    outcome.pairings.forEach((pairing) => {
      const carried = previousDecisions.get(pairingSignature(pairing));
      if (carried) pairing.decision = carried;
    });
    group.pairings = outcome.pairings;
    group.pairedRecvCents = outcome.pairedRecvCents;
    group.pairedPayCents = outcome.pairedPayCents;
    group.pairLimited = outcome.limited;
    group.canPair = outcome.pairings.length > 0;
    group.nearMiss = buildNearMiss(outcome.leftoverRecv, outcome.leftoverPay, toleranceCents, percent);
    group.hasNearMiss = group.nearMiss.length > 0;
    group.flags = group.flags.filter((flag) => flag !== 'pair');
    if (group.canPair) group.flags.push('pair');

    pairCount += outcome.pairings.length;
    pairedRecvCents += outcome.pairedRecvCents;
    pairedPayCents += outcome.pairedPayCents;
    if (group.canPair) pairGroups += 1;
    if (outcome.limited) limitedGroups += 1;
    if (group.hasNearMiss) {
      nearMissGroups += 1;
      nearMissCount += group.nearMiss.length;
    }
  });

  return {
    pairCount,
    pairGroups,
    pairedRecvCents,
    pairedPayCents,
    limitedGroups,
    skippedGroups,
    nearMissGroups,
    nearMissCount,
    elapsedMs: Date.now() - startedAt
  };
}

// 配对剩下的记录里，找出「只差一点」的一对：差额不到当前容差的两倍，或不到较大一方的 5%（取宽松的那个）。
// 每条给出「把核销容差改成多少就能配上」，纯提示，不写进 group.pairings。
function buildNearMiss(leftoverRecv, leftoverPay, toleranceCents, percent) {
  if (!leftoverRecv.length || !leftoverPay.length) return [];
  const recv = leftoverRecv.slice(0, PAIR_NEAR_MISS_POOL);
  const pay = leftoverPay.slice(0, PAIR_NEAR_MISS_POOL);
  const candidates = [];
  recv.forEach((recvItem) => {
    pay.forEach((payItem) => {
      const diff = Math.abs(recvItem.row.cents - payItem.row.cents);
      if (diff === 0) return;
      const bigger = Math.max(recvItem.row.cents, payItem.row.cents);
      // 「差一点」= 差额不超过当前容差的两倍，或不超过较大一方的 5%，两个门槛取宽松的那个。
      const limit = Math.max(
        pairToleranceFor(bigger, toleranceCents, percent) * 2,
        Math.round(bigger * PAIR_NEAR_MISS_RATIO)
      );
      if (diff > limit) return;
      candidates.push({ recv: recvItem, pay: payItem, diffCents: diff });
    });
  });
  if (!candidates.length) return [];
  candidates.sort((a, b) => a.diffCents - b.diffCents
    || b.recv.row.cents - a.recv.row.cents
    || a.recv.row.rowNo - b.recv.row.rowNo
    || a.pay.row.rowNo - b.pay.row.rowNo);

  const usedRecv = new Set();
  const usedPay = new Set();
  const nearMiss = [];
  candidates.forEach((candidate) => {
    if (usedRecv.has(candidate.recv.index) || usedPay.has(candidate.pay.index)) return;
    usedRecv.add(candidate.recv.index);
    usedPay.add(candidate.pay.index);
    nearMiss.push({
      recvRow: candidate.recv.row,
      payRow: candidate.pay.row,
      recvCents: candidate.recv.row.cents,
      payCents: candidate.pay.row.cents,
      diffCents: candidate.diffCents
    });
  });
  return nearMiss;
}

function pairGroup(group, toleranceCents, percent = 0) {
  const recvPool = toPairPool(group.rows.filter((row) => row.dir === 'recv'));
  const payPool = toPairPool(group.rows.filter((row) => row.dir === 'pay'));
  const usedRecv = new Set();
  const usedPay = new Set();
  const pairings = [];
  let limited = false;

  const recvBuckets = bucketByCents(recvPool);
  const payBuckets = bucketByCents(payPool);
  recvBuckets.forEach((recvItems, cents) => {
    const payItems = payBuckets.get(cents);
    if (!payItems) return;
    pairExactBucket(recvItems, payItems, usedRecv, usedPay, pairings);
  });

  if (toleranceCents > 0 || percent > 0) {
    const freeRecv = recvPool.filter((item) => !usedRecv.has(item.index));
    const freePay = payPool.filter((item) => !usedPay.has(item.index));
    collectTolerancePairs(freeRecv, freePay, toleranceCents, percent).forEach((candidate) => {
      if (usedRecv.has(candidate.recv.index) || usedPay.has(candidate.pay.index)) return;
      usedRecv.add(candidate.recv.index);
      usedPay.add(candidate.pay.index);
      pairings.push(makePairing('one', [candidate.recv], [candidate.pay]));
    });
  }

  const subsetRounds = [
    { targets: payPool, usedTargets: usedPay, sourcePool: recvPool, usedSources: usedRecv, kind: 'payMany' },
    { targets: recvPool, usedTargets: usedRecv, sourcePool: payPool, usedSources: usedPay, kind: 'recvMany' }
  ];

  subsetRounds.forEach((round) => {
    if (round.sourcePool.length > PAIR_MAX_SUBSET_POOL) limited = true;
    round.targets.forEach((target) => {
      if (round.usedTargets.has(target.index)) return;
      const targetTolerance = pairToleranceFor(target.row.cents, toleranceCents, percent);
      // 凑出来的合计可能比目标大；按「较大一方」算比例时要放宽到 target × p / (100 − p)
      const searchTolerance = percent > 0 && percent < 100
        ? Math.max(targetTolerance, Math.ceil(target.row.cents * percent / (100 - percent)))
        : targetTolerance;
      const available = round.sourcePool.filter((item) =>
        !round.usedSources.has(item.index) && item.row.cents <= target.row.cents + searchTolerance
      );
      if (available.length < 2) return;
      const picks = findSubset(available, target.row.cents, searchTolerance);
      if (!picks) return;
      picks.forEach((item) => round.usedSources.add(item.index));
      round.usedTargets.add(target.index);
      pairings.push(round.kind === 'payMany'
        ? makePairing('payMany', picks, [target])
        : makePairing('recvMany', [target], picks));
    });
  });

  pairings.sort((a, b) => b.recvCents + b.payCents - (a.recvCents + a.payCents) || a.kind.localeCompare(b.kind));

  return {
    pairings,
    pairedRecvCents: pairings.reduce((sum, pairing) => sum + pairing.recvCents, 0),
    pairedPayCents: pairings.reduce((sum, pairing) => sum + pairing.payCents, 0),
    limited,
    leftoverRecv: recvPool.filter((item) => !usedRecv.has(item.index)),
    leftoverPay: payPool.filter((item) => !usedPay.has(item.index))
  };
}

function toPairPool(rows) {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => b.row.cents - a.row.cents || a.row.rowNo - b.row.rowNo || a.index - b.index);
}

function bucketByCents(pool) {
  const buckets = new Map();
  pool.forEach((item) => {
    const list = buckets.get(item.row.cents);
    if (list) list.push(item);
    else buckets.set(item.row.cents, [item]);
  });
  return buckets;
}

function isoDayNumber(isoDate) {
  const parts = parseAgeDateParts(isoDate);
  if (!parts) return null;
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86400000);
}

function rowDateISO(row) {
  return row && row.dateISO ? row.dateISO : '';
}

function dateGapDays(isoA, isoB) {
  const a = isoDayNumber(isoA);
  const b = isoDayNumber(isoB);
  if (a === null || b === null) return null;
  return Math.abs(a - b);
}

function pairingDateSpan(rows) {
  let from = '';
  let to = '';
  (rows || []).forEach((row) => {
    const iso = rowDateISO(row);
    if (!iso) return;
    if (!from || iso < from) from = iso;
    if (!to || iso > to) to = iso;
  });
  return { from, to };
}

// 两侧日期取最接近的一对，只用来排序和提示，不参与金额判断。
function pairingDateInfo(recvRows, payRows) {
  const recv = pairingDateSpan(recvRows);
  const pay = pairingDateSpan(payRows);
  let gap = null;
  if (recv.from && pay.from) {
    recvRows.forEach((recvRow) => {
      const a = isoDayNumber(rowDateISO(recvRow));
      if (a === null) return;
      payRows.forEach((payRow) => {
        const b = isoDayNumber(rowDateISO(payRow));
        if (b === null) return;
        const diff = Math.abs(a - b);
        if (gap === null || diff < gap) gap = diff;
      });
    });
  }
  return {
    recvDateFrom: recv.from,
    recvDateTo: recv.to,
    payDateFrom: pay.from,
    payDateTo: pay.to,
    dateGapDays: gap
  };
}

// 同额记录里优先把日期最接近的配在一起；没有日期或组合太多时按原顺序配。
function pairExactBucket(recvItems, payItems, usedRecv, usedPay, pairings) {
  const take = Math.min(recvItems.length, payItems.length);
  if (!take) return;

  const pushPair = (recvItem, payItem) => {
    usedRecv.add(recvItem.index);
    usedPay.add(payItem.index);
    pairings.push(makePairing('one', [recvItem], [payItem]));
  };

  if (recvItems.length * payItems.length > PAIR_DATE_MATCH_LIMIT) {
    for (let i = 0; i < take; i += 1) pushPair(recvItems[i], payItems[i]);
    return;
  }

  const candidates = [];
  let hasDate = false;
  recvItems.forEach((recvItem, i) => {
    const recvIso = rowDateISO(recvItem.row);
    payItems.forEach((payItem, j) => {
      const gap = dateGapDays(recvIso, rowDateISO(payItem.row));
      if (gap !== null) hasDate = true;
      candidates.push({ i, j, gap });
    });
  });

  if (!hasDate) {
    for (let i = 0; i < take; i += 1) pushPair(recvItems[i], payItems[i]);
    return;
  }

  candidates.sort((a, b) => {
    const gapA = a.gap === null ? Infinity : a.gap;
    const gapB = b.gap === null ? Infinity : b.gap;
    if (gapA !== gapB) return gapA - gapB;
    return a.i - b.i || a.j - b.j;
  });

  const takenRecv = new Set();
  const takenPay = new Set();
  let made = 0;
  for (let k = 0; k < candidates.length && made < take; k += 1) {
    const candidate = candidates[k];
    if (takenRecv.has(candidate.i) || takenPay.has(candidate.j)) continue;
    takenRecv.add(candidate.i);
    takenPay.add(candidate.j);
    pushPair(recvItems[candidate.i], payItems[candidate.j]);
    made += 1;
  }
}

function pairToleranceFor(targetCents, toleranceCents, percent) {
  const base = Math.max(0, Number(toleranceCents) || 0);
  const ratio = Math.max(0, Number(percent) || 0);
  if (!ratio) return base;
  return Math.max(base, Math.round(Math.abs(targetCents) * ratio / 100));
}

function collectTolerancePairs(recvItems, payItems, toleranceCents, percent = 0) {
  const buckets = bucketByCents(payItems);
  const centsList = Array.from(buckets.keys()).sort((a, b) => a - b);
  const candidates = [];

  recvItems.forEach((recvItem) => {
    const cents = recvItem.row.cents;
    // 比例容差下，允许的差额随较大一方变化；这里放宽扫描窗口，逐条再用 pairToleranceFor 判定。
    const ratioWindow = percent > 0 && percent < 100
      ? Math.ceil(cents * percent / (100 - percent))
      : (percent >= 100 ? Number.MAX_SAFE_INTEGER : 0);
    const scan = Math.max(toleranceCents, ratioWindow, Math.round(cents * percent / 100)) + 1;
    const low = cents - scan;
    const high = cents + scan;
    let matched = 0;
    for (let i = lowerBound(centsList, low); i < centsList.length; i += 1) {
      const other = centsList[i];
      if (other > high) break;
      const diff = Math.abs(cents - other);
      if (diff > pairToleranceFor(Math.max(cents, other), toleranceCents, percent)) continue;
      const bucket = buckets.get(other);
      for (let j = 0; j < bucket.length && matched < PAIR_MAX_CANDIDATES_PER_ROW; j += 1) {
        matched += 1;
        candidates.push({
          recv: recvItem,
          pay: bucket[j],
          diff,
          cents: Math.max(cents, other),
          gap: dateGapDays(rowDateISO(recvItem.row), rowDateISO(bucket[j].row))
        });
      }
      if (matched >= PAIR_MAX_CANDIDATES_PER_ROW) break;
    }
  });

  const gapOf = (candidate) => (candidate.gap === null ? Infinity : candidate.gap);
  candidates.sort((a, b) => {
    if (a.diff !== b.diff) return a.diff - b.diff;
    const gapA = gapOf(a);
    const gapB = gapOf(b);
    if (gapA !== gapB) return gapA - gapB;
    return b.cents - a.cents
      || a.recv.row.rowNo - b.recv.row.rowNo
      || a.pay.row.rowNo - b.pay.row.rowNo;
  });
  return candidates;
}

function lowerBound(sortedValues, value) {
  let low = 0;
  let high = sortedValues.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sortedValues[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

function findSubset(items, targetCents, toleranceCents) {
  const pool = items.slice(0, PAIR_MAX_SUBSET_POOL);
  const suffix = new Array(pool.length + 1).fill(0);
  for (let i = pool.length - 1; i >= 0; i -= 1) suffix[i] = suffix[i + 1] + pool[i].row.cents;

  const upper = targetCents + toleranceCents;
  const lower = targetCents - toleranceCents;
  const picks = [];
  let best = null;
  let nodes = 0;

  function visit(start, sum) {
    for (let i = start; i < pool.length; i += 1) {
      if (nodes > PAIR_MAX_NODES) return;
      if (sum + suffix[i] < lower) return;
      nodes += 1;
      const next = sum + pool[i].row.cents;
      if (next > upper) continue;
      picks.push(pool[i]);
      if (picks.length >= 2 && next >= lower) {
        const diff = Math.abs(next - targetCents);
        if (!best || diff < best.diff || (diff === best.diff && picks.length < best.picks.length)) {
          best = { diff, picks: picks.slice() };
        }
      }
      if (picks.length < PAIR_MAX_SUBSET_SIZE && next + suffix[i + 1] >= lower) {
        visit(i + 1, next);
      }
      picks.pop();
      if (best && best.diff === 0 && best.picks.length === 2) return;
    }
  }

  visit(0, 0);
  return best ? best.picks : null;
}

function makePairing(kind, recvItems, payItems) {
  const sumCents = (items) => items.reduce((sum, item) => sum + item.row.cents, 0);
  const toRows = (items) => items.map((item) => item.row).sort((a, b) => a.rowNo - b.rowNo);
  const recvRows = toRows(recvItems);
  const payRows = toRows(payItems);
  const dates = pairingDateInfo(recvRows, payRows);
  return {
    kind,
    recvRows,
    payRows,
    recvCents: sumCents(recvItems),
    payCents: sumCents(payItems),
    diffCents: Math.abs(sumCents(recvItems) - sumCents(payItems)),
    recvDateFrom: dates.recvDateFrom,
    recvDateTo: dates.recvDateTo,
    payDateFrom: dates.payDateFrom,
    payDateTo: dates.payDateTo,
    dateGapDays: dates.dateGapDays,
    dateFar: dates.dateGapDays !== null && dates.dateGapDays > PAIR_DATE_WARN_DAYS,
    decision: 'pending'
  };
}

// 同一组配对（两侧行号完全一样）在重算后保留人工采纳/不采纳标记。
function pairingSignature(pairing) {
  const ids = (rows) => rows.map((row) => `${row.sourceId}#${row.rowNo}`).join(',');
  return `${pairing.kind}|${ids(pairing.recvRows)}|${ids(pairing.payRows)}`;
}

function pairDecisionLabel(decision) {
  if (decision === 'accepted') return '采纳';
  if (decision === 'rejected') return '不采纳';
  return '待确认';
}

function pairDecisionCounts() {
  const counts = { accepted: 0, rejected: 0, pending: 0 };
  state.groups.forEach((group) => {
    (group.pairings || []).forEach((pairing) => {
      const key = pairing.decision === 'accepted' || pairing.decision === 'rejected'
        ? pairing.decision
        : 'pending';
      counts[key] += 1;
    });
  });
  return counts;
}

function pairKindLabel(pairing) {
  if (pairing.kind === 'one') return '1 对 1';
  if (pairing.kind === 'payMany') return `${pairing.recvRows.length} 对 1`;
  return `1 对 ${pairing.payRows.length}`;
}

function dateSpanText(from, to) {
  if (!from) return '';
  if (!to || from === to) return from;
  return `${from}～${to}`;
}

// 日期只说明「两边日期离得近不近」，不判断是不是同一笔业务。
function pairDateText(pairing) {
  if (pairing.dateGapDays === null || pairing.dateGapDays === undefined) return '';
  const recvText = dateSpanText(pairing.recvDateFrom, pairing.recvDateTo);
  const payText = dateSpanText(pairing.payDateFrom, pairing.payDateTo);
  if (!recvText || !payText) return '';
  const gapText = pairing.dateGapDays === 0
    ? '同一天'
    : `相差 ${pairing.dateGapDays} 天${pairing.dateGapDays > PAIR_DATE_WARN_DAYS ? '，请留意' : ''}`;
  return `应收 ${recvText} · 应付 ${payText} · ${gapText}`;
}

function pairRowLabel(group, side) {
  if (group.sources.length <= 1) {
    return `第 ${side.map((row) => row.rowNo).join('、')} 行`;
  }
  const bySource = new Map();
  side.forEach((row) => {
    const label = row.sourceShortLabel || row.sourceLabel || '数据源';
    const list = bySource.get(label);
    if (list) list.push(row.rowNo);
    else bySource.set(label, [row.rowNo]);
  });
  return Array.from(bySource.entries())
    .map(([label, rows]) => `${label} 第 ${rows.join('、')} 行`)
    .join('；');
}

function toleranceInputToCents(raw) {
  const text = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!text) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 1000) return null;
  return Math.round(value * 100);
}

function percentInputToValue(raw) {
  const text = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!text) return 0;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > PAIR_MAX_PERCENT) return null;
  return Math.round(value * 100) / 100;
}

function formatPercentInput(value) {
  const number = Math.max(0, Number(value) || 0);
  return String(Math.round(number * 100) / 100);
}

function refreshPairing() {
  if (!state.groups.length) return;
  const before = pairDecisionCounts();
  const hadMarks = before.accepted + before.rejected;
  state.pairResult = runPairing(state.groups, state.pairToleranceCents);
  state.stats = computeStats(state.groups);
  renderSummary();
  renderChips();
  renderTable();
  const after = pairDecisionCounts();
  if (hadMarks > after.accepted + after.rejected) {
    showToast(`容差改了，配对重新算过：${hadMarks - after.accepted - after.rejected} 组原来的采纳/不采纳标记已清空`, true);
  }
}

// ===== 统计与撤销 =====

function computeStats(groups) {
  let netRecvCents = 0;
  let netPayCents = 0;
  let grossRecvCents = 0;
  let grossPayCents = 0;

  groups.forEach((group) => {
    grossRecvCents += group.recvCents;
    grossPayCents += group.payCents;
    if (group.netCents > 0) netRecvCents += group.netCents;
    if (group.netCents < 0) netPayCents += Math.abs(group.netCents);
  });

  const stats = {
    netRecvCents,
    netPayCents,
    grossRecvCents,
    grossPayCents,
    recvGroups: groups.filter((group) => group.netCents > 0).length,
    payGroups: groups.filter((group) => group.netCents < 0).length,
    evenGroups: groups.filter((group) => group.netCents === 0).length,
    keyGroups: groups.filter((group) => group.keyReview).length,
    sameDupGroups: groups.filter((group) => group.sameDirDup).length,
    variantGroups: groups.filter((group) => group.variantList.length > 1).length,
    pairGroups: groups.filter((group) => group.canPair).length,
    pairCount: groups.reduce((sum, group) => sum + (group.pairings ? group.pairings.length : 0), 0),
    pairedRecvCents: groups.reduce((sum, group) => sum + (group.pairedRecvCents || 0), 0),
    pairedPayCents: groups.reduce((sum, group) => sum + (group.pairedPayCents || 0), 0),
    pairLimitedGroups: groups.filter((group) => group.pairLimited).length,
    nearMissGroups: groups.filter((group) => group.hasNearMiss).length,
    nearMissCount: groups.reduce((sum, group) => sum + (group.nearMiss ? group.nearMiss.length : 0), 0),
    docHintGroups: groups.filter((group) => group.hasDocHint).length,
    memoKeyGroups: groups.filter((group) => group.hasMemoKey).length,
    mergeGroups: groups.filter((group) => group.manualMerge).length
  };

  // 币种不同不能相加，也不做汇率换算：按币种、按主体各自汇总一遍。
  const currencyMap = new Map();
  const entityMap = new Map();
  groups.forEach((group) => {
    const currencyKey = group.currencyKey || '';
    if (currencyKey) {
      if (!currencyMap.has(currencyKey)) {
        currencyMap.set(currencyKey, {
          key: currencyKey,
          label: group.currencyLabel || currencyLabelForKey(currencyKey, ''),
          groups: 0,
          records: 0,
          grossRecvCents: 0,
          grossPayCents: 0,
          netRecvCents: 0,
          netPayCents: 0,
          recvGroups: 0,
          payGroups: 0,
          evenGroups: 0
        });
      }
      const bucket = currencyMap.get(currencyKey);
      bucket.groups += 1;
      bucket.records += group.rows.length;
      bucket.grossRecvCents += group.recvCents;
      bucket.grossPayCents += group.payCents;
      if (group.netCents > 0) { bucket.netRecvCents += group.netCents; bucket.recvGroups += 1; }
      if (group.netCents < 0) { bucket.netPayCents += Math.abs(group.netCents); bucket.payGroups += 1; }
      if (group.netCents === 0) bucket.evenGroups += 1;
    }

    const entityKey = group.entityKey || '';
    if (entityKey) {
      const combined = `${entityKey}\u0001${currencyKey}`;
      if (!entityMap.has(combined)) {
        entityMap.set(combined, {
          key: combined,
          label: group.entityLabel || entityKey,
          entityKey,
          currencyKey,
          currencyLabel: currencyKey ? (group.currencyLabel || currencyLabelForKey(currencyKey, '')) : '',
          groups: 0,
          records: 0,
          grossRecvCents: 0,
          grossPayCents: 0,
          netRecvCents: 0,
          netPayCents: 0,
          recvGroups: 0,
          payGroups: 0,
          evenGroups: 0
        });
      }
      const bucket = entityMap.get(combined);
      bucket.groups += 1;
      bucket.records += group.rows.length;
      bucket.grossRecvCents += group.recvCents;
      bucket.grossPayCents += group.payCents;
      if (group.netCents > 0) { bucket.netRecvCents += group.netCents; bucket.recvGroups += 1; }
      if (group.netCents < 0) { bucket.netPayCents += Math.abs(group.netCents); bucket.payGroups += 1; }
      if (group.netCents === 0) bucket.evenGroups += 1;
    }
  });

  stats.currencyTotals = Array.from(currencyMap.values())
    .sort((a, b) => compareStableText(a.key, b.key));
  stats.mixedCurrency = stats.currencyTotals.length > 1;
  stats.hasCurrency = stats.currencyTotals.length > 0;
  stats.entityTotals = Array.from(entityMap.values())
    .sort((a, b) => compareStableText(a.label, b.label)
      || compareStableText(a.currencyKey, b.currencyKey));
  stats.hasEntity = stats.entityTotals.length > 0;

  const allPairings = [];
  groups.forEach((group) => {
    (group.pairings || []).forEach((pairing) => allPairings.push(pairing));
  });
  const datedPairings = allPairings.filter((pairing) => Number.isFinite(pairing.dateGapDays));
  stats.pairDateCount = datedPairings.length;
  stats.pairDateFarCount = datedPairings.filter((pairing) => pairing.dateGapDays > PAIR_DATE_WARN_DAYS).length;
  stats.pairDateFarGroups = groups.filter((group) => (group.pairings || []).some(
    (pairing) => Number.isFinite(pairing.dateGapDays) && pairing.dateGapDays > PAIR_DATE_WARN_DAYS
  )).length;

  const ageGroups = groups.filter((group) => group.hasAge);
  if (ageGroups.length) {
    stats.ageGroups = ageGroups.length;
    stats.ageMarkedRecords = ageGroups.reduce((sum, group) => sum + group.ageStats.marked, 0);
    stats.ageUnknownRecords = ageGroups.reduce(
      (sum, group) => sum + group.ageStats.recvUnknown.count + group.ageStats.payUnknown.count,
      0
    );
    stats.ageRecvBands = AGE_BANDS.map((bandLabel, index) => (
      ageGroups.reduce((sum, group) => sum + group.ageStats.recv[index].cents, 0)
    ));
    stats.agePayBands = AGE_BANDS.map((bandLabel, index) => (
      ageGroups.reduce((sum, group) => sum + group.ageStats.pay[index].cents, 0)
    ));
    const lastBand = AGE_BANDS.length - 1;
    stats.ageLongCents = stats.ageRecvBands[lastBand] + stats.agePayBands[lastBand];
  }

  return stats;
}

function updateResultMeta() {
  if (!state.runInfo) {
    els.resultMeta.textContent = '—';
    return;
  }

  const unitLabels = { 1: '元', 1000: '千元', 10000: '万元' };
  const sources = state.runInfo.sources;
  const units = Array.from(new Set(sources.map((source) => unitLabels[source.unit] || '元')));
  const parts = [];

  if (state.runInfo.mode === 'manual') {
    const recv = sources.find((source) => source.id === 'manual-recv');
    const pay = sources.find((source) => source.id === 'manual-pay');
    parts.push(`手动粘贴（左侧 ${recv ? recv.recordCount : 0} 笔 · 右侧 ${pay ? pay.recordCount : 0} 笔）`);
  } else {
    const fileNames = Array.from(new Set(sources.map((source) => source.fileName)));
    const sheetNames = sources.map((source) => source.shortLabel);
    if (fileNames.length === 1) {
      parts.push(`${fileNames[0]}（${sheetNames.join('、')}）`);
    } else {
      parts.push(`${fileNames.length} 个文件 · ${sheetNames.join('、')}`);
    }
  }

  parts.push(`有效 ${state.records.length} 笔`);
  if (state.skipped.length) parts.push(`跳过 ${state.skipped.length} 行`);
  parts.push(`金额单位：${units.join(' / ')}`);
  if (state.inheritedRows) {
    parts.push(state.runInfo.mode === 'manual'
      ? `名称留空续行 ${state.inheritedRows} 行`
      : `合并单元格续行 ${state.inheritedRows} 行`);
  }
  els.resultMeta.textContent = parts.join(' · ');
}

const UNDO_MAX = 50;

function resetUndoHistory() {
  undoStack.length = 0;
  renderUndoButton();
}

function pushUndo(label, restore) {
  if (undoApplying) return;
  undoStack.push({ label, restore });
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  renderUndoButton();
}

function renderUndoButton() {
  if (!els.undoBtn) return;
  const last = undoStack[undoStack.length - 1];
  els.undoBtn.disabled = !last;
  els.undoBtn.textContent = last ? `撤销：${last.label}` : '撤销上一步';
  els.undoBtn.title = last ? `撤销「${last.label}」` : '还没有可以撤销的操作';
}

function undoLastAction() {
  const entry = undoStack.pop();
  if (!entry) {
    showToast('没有可以撤销的操作');
    return;
  }
  undoApplying = true;
  try {
    entry.restore();
  } finally {
    undoApplying = false;
  }
  renderUndoButton();
  showToast(`已撤销：${entry.label}`);
}

function findGroupByKey(key) {
  return state.groups.find((group) => group.key === key) || null;
}

function findPairing(group, signature) {
  if (!group || !group.pairings) return null;
  return group.pairings.find((pairing) => pairingSignature(pairing) === signature) || null;
}

// ===== 结果汇总与企业并归交互 =====

function dimensionSummaryMarkup(stats) {
  if (!stats) return '';
  const blocks = [];
  if (stats.currencyTotals.length > 1) {
    const rows = stats.currencyTotals.map((bucket) => `
      <tr>
        <td><span class="dim-badge">${escapeHtml(bucket.label)}</span></td>
        <td class="num">${bucket.groups}</td>
        <td class="num">${fmtMoneyIn(bucket.grossRecvCents, bucket.key)}</td>
        <td class="num">${fmtMoneyIn(bucket.grossPayCents, bucket.key)}</td>
        <td class="num recv">${fmtMoneyIn(bucket.netRecvCents, bucket.key)}</td>
        <td class="num pay">${fmtMoneyIn(bucket.netPayCents, bucket.key)}</td>
      </tr>`).join('');
    blocks.push(`
      <div class="dim-block">
        <div class="dim-block-head">
          <b>按币种分开看</b>
          <span>不同币种之间不能直接相加，这里也不做汇率换算，金额都是原币；上面的合计因此显示为「—」。</span>
        </div>
        <div class="dim-table-wrap">
          <table class="dim-table">
            <thead><tr>
              <th>币种</th><th class="num">企业</th><th class="num">应收发生额</th>
              <th class="num">应付发生额</th><th class="num">净应收</th><th class="num">净应付</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`);
  }
  if (stats.hasEntity) {
    const rows = stats.entityTotals.map((bucket) => `
      <tr>
        <td>${escapeHtml(bucket.label)}</td>
        <td>${escapeHtml(bucket.currencyLabel || '未写币种')}</td>
        <td class="num">${bucket.groups}</td>
        <td class="num">${fmtMoneyIn(bucket.grossRecvCents, bucket.currencyKey)}</td>
        <td class="num">${fmtMoneyIn(bucket.grossPayCents, bucket.currencyKey)}</td>
        <td class="num recv">${fmtMoneyIn(bucket.netRecvCents, bucket.currencyKey)}</td>
        <td class="num pay">${fmtMoneyIn(bucket.netPayCents, bucket.currencyKey)}</td>
      </tr>`).join('');
    blocks.push(`
      <div class="dim-block">
        <div class="dim-block-head">
          <b>按主体分开看</b>
          <span>同一家企业、同一币种才算到一起；不同主体各算各的，不合并、不改金额。</span>
        </div>
        <div class="dim-table-wrap">
          <table class="dim-table">
            <thead><tr>
              <th>主体</th><th>币种</th><th class="num">企业</th><th class="num">应收发生额</th>
              <th class="num">应付发生额</th><th class="num">净应收</th><th class="num">净应付</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`);
  }
  return blocks.join('');
}

function pairedTotalsByCurrency(groups) {
  const map = new Map();
  (groups || []).forEach((group) => {
    const recv = group.pairedRecvCents || 0;
    const pay = group.pairedPayCents || 0;
    if (!recv && !pay) return;
    const key = group.currencyKey || 'CNY';
    if (!map.has(key)) map.set(key, { key, label: currencyLabelForKey(key, ''), recv: 0, pay: 0 });
    const bucket = map.get(key);
    bucket.recv += recv;
    bucket.pay += pay;
  });
  return Array.from(map.values()).sort((a, b) => compareStableText(a.key, b.key));
}

function ageLongByCurrencyText(groups) {
  const map = new Map();
  (groups || []).forEach((group) => {
    if (!group.hasAge || !group.ageStats) return;
    const lastBand = AGE_BANDS.length - 1;
    const cents = (group.ageStats.recv[lastBand] ? group.ageStats.recv[lastBand].cents : 0)
      + (group.ageStats.pay[lastBand] ? group.ageStats.pay[lastBand].cents : 0);
    if (!cents) return;
    const key = group.currencyKey || 'CNY';
    map.set(key, (map.get(key) || 0) + cents);
  });
  return Array.from(map.entries())
    .sort((a, b) => compareStableText(a[0], b[0]))
    .map(([key, cents]) => `${currencyLabelForKey(key, '')} ${fmtMoneyIn(cents, key)}`)
    .join(' · ');
}

function renderSummary() {
  const stats = state.stats;
  if (!stats) {
    if (els.fingerprintLine) els.fingerprintLine.innerHTML = '';
    if (els.dimSummary) {
      els.dimSummary.innerHTML = '';
      els.dimSummary.classList.add('hidden');
    }
    return;
  }
  updateAgeBaseField();

  const mixed = Boolean(stats.mixedCurrency);
  const currencyMeta = (isRecv) => stats.currencyTotals
    .filter((bucket) => (isRecv ? bucket.netRecvCents > 0 : bucket.netPayCents > 0))
    .slice(0, 4)
    .map((bucket) => `${bucket.label} ${fmtMoneyIn(isRecv ? bucket.netRecvCents : bucket.netPayCents, bucket.key)}`)
    .join(' · ');

  els.summaryGrid.innerHTML = `
    <div class="summary-card">
      <span class="summary-label">纳入对账企业</span>
      <span class="summary-value">${state.groups.length}<small>家</small></span>
      <span class="summary-meta">有效记录 ${state.records.length} 笔 · 已平 ${stats.evenGroups} 家</span>
    </div>
    <div class="summary-card recv">
      <span class="summary-label">净应收合计${mixed ? '（分币种）' : ''}</span>
      <span class="summary-value${mixed ? ' is-mixed' : ''}">${mixed ? '—' : fmtMoney(stats.netRecvCents)}</span>
      <span class="summary-meta">${mixed ? (currencyMeta(true) || '没有净应收') : `${stats.recvGroups} 家企业净应收`}</span>
    </div>
    <div class="summary-card pay">
      <span class="summary-label">净应付合计${mixed ? '（分币种）' : ''}</span>
      <span class="summary-value${mixed ? ' is-mixed' : ''}">${mixed ? '—' : fmtMoney(stats.netPayCents)}</span>
      <span class="summary-meta">${mixed ? (currencyMeta(false) || '没有净应付') : `${stats.payGroups} 家企业净应付`}</span>
    </div>
    <div class="summary-card">
      <span class="summary-label">重点复核</span>
      <span class="summary-value">${stats.keyGroups}<small>家</small></span>
      <span class="summary-meta">同向重复 ${stats.sameDupGroups} 家 · 名称不一 ${stats.variantGroups} 家</span>
    </div>
  `;

  if (els.dimSummary) {
    const dimHtml = dimensionSummaryMarkup(stats);
    els.dimSummary.innerHTML = dimHtml;
    els.dimSummary.classList.toggle('hidden', !dimHtml);
  }

  const totalDifference = stats.grossRecvCents - stats.grossPayCents;
  const differenceClass = totalDifference > 0 ? 'recv' : totalDifference < 0 ? 'pay' : '';
  const recvGrossText = mixed
    ? stats.currencyTotals.map((bucket) => `${bucket.label} ${fmtMoneyIn(bucket.grossRecvCents, bucket.key)}`).join(' · ')
    : fmtMoney(stats.grossRecvCents);
  const payGrossText = mixed
    ? stats.currencyTotals.map((bucket) => `${bucket.label} ${fmtMoneyIn(bucket.grossPayCents, bucket.key)}`).join(' · ')
    : fmtMoney(stats.grossPayCents);
  const differenceText = mixed
    ? stats.currencyTotals.map((bucket) => {
      const diff = bucket.grossRecvCents - bucket.grossPayCents;
      const cls = diff > 0 ? 'recv' : diff < 0 ? 'pay' : '';
      const sign = diff > 0 ? '+' : diff < 0 ? '−' : '';
      return `<strong class="${cls}">${bucket.label} ${sign}${fmtMoneyIn(diff, bucket.key)}</strong>`;
    }).join(' · ')
    : `<strong class="${differenceClass}">${fmtSignedMoney(totalDifference)}</strong>`;
  const pairedBuckets = mixed ? pairedTotalsByCurrency(state.groups) : [];
  const pairedText = pairedBuckets.length
    ? pairedBuckets.map((bucket) => `${bucket.label} 收 ${fmtMoneyIn(bucket.recv, bucket.key)} / 付 ${fmtMoneyIn(bucket.pay, bucket.key)}`).join(' · ')
    : '';
  const pairSpan = stats.pairCount
    ? (mixed
      ? `<span>自动核销 <strong>${stats.pairCount} 组</strong> · ${pairedText}</span>`
      : `<span>自动核销 <strong>${stats.pairCount} 组</strong> · 覆盖应收 <strong>${fmtMoney(stats.pairedRecvCents)}</strong> / 应付 <strong>${fmtMoney(stats.pairedPayCents)}</strong></span>`)
    : '<span>自动核销 <strong>0 组</strong> · 没有金额可对冲的记录对</span>';
  const decisions = pairDecisionCounts();
  const decisionSpan = stats.pairCount
    ? `<span>配对确认 <strong>${decisions.accepted}</strong> 采纳 · <strong>${decisions.rejected}</strong> 不采纳 · <strong>${decisions.pending}</strong> 待确认</span>`
    : '';
  const pairDateNote = stats.pairDateCount
    ? `<span class="totals-note" title="${escapeHtml(`日期取自账龄列里写的日期，或摘要里写的年月日。同样金额的几笔里，会把日期更近的配在一起；两侧日期相差超过 ${PAIR_DATE_WARN_DAYS} 天的只做提醒，不改配对结果、不改金额。`)}">日期能对照 <strong>${stats.pairDateCount}</strong> 组${stats.pairDateFarCount ? ` · <strong>${stats.pairDateFarCount}</strong> 组相差超 ${PAIR_DATE_WARN_DAYS} 天` : ''}</span>`
    : '';
  const pairNote = stats.pairLimitedGroups
    ? `<span class="totals-note" title="有 ${stats.pairLimitedGroups} 家企业记录笔数较多，组合配对只在金额最大的 ${PAIR_MAX_SUBSET_POOL} 笔里尝试">个别企业笔数较多，组合配对未穷尽</span>`
    : '';
  const nearNote = stats.nearMissGroups
    ? `<span class="totals-note" title="${escapeHtml(`有 ${stats.nearMissGroups} 家企业里，配对剩下的应收与应付有只差一点的一对（差额不到当前容差的两倍，或者不到较大一方的 ${Math.round(PAIR_NEAR_MISS_RATIO * 100)}%）。展开那几家会在配对区写清「把核销容差改成多少就能配上」，共 ${stats.nearMissCount} 对；不改任何金额。`)}">差一点就能配上 <strong>${stats.nearMissGroups}</strong> 家 · ${stats.nearMissCount} 对</span>`
    : '';

  const guessWarnings = state.guessWarnings || [];
  const guessNote = guessWarnings.length
    ? `<span class="totals-note" title="${escapeHtml(guessWarnings.map((warning) => `${warning.sheet}：${warning.items.join('；')}`).join('　'))}">有 ${guessWarnings.length} 张表的部分列是猜的，先回“核对数据源”看一眼图片</span>`
    : '';
  const ageUnlisted = state.records.length - (stats.ageMarkedRecords || 0) - (stats.ageUnknownRecords || 0);
  const ageLongText = mixed ? (ageLongByCurrencyText(state.groups) || '各币种均为 0') : fmtMoney(stats.ageLongCents);
  const ageNote = stats.ageGroups
    ? `<span class="totals-note" title="${escapeHtml(`账龄分 ${AGE_BANDS.length} 档（${ageBandPreset().label}）：${AGE_BANDS.join('、')}；${stats.ageUnknownRecords} 笔原表没写账龄，单列在「账龄分析」${ageUnlisted > 0 ? `；另有 ${ageUnlisted} 笔来自没有账龄列的表，不参与账龄统计` : ''}`)}">账龄「${escapeHtml(AGE_BANDS[AGE_BANDS.length - 1])}」 <strong>${ageLongText}</strong> · ${stats.ageMarkedRecords} 笔已分档${stats.ageUnknownRecords ? ` · ${stats.ageUnknownRecords} 笔没写` : ''}</span>`
    : '';

  els.totalsStrip.innerHTML = `
    <span>应收发生额 <strong>${recvGrossText}</strong></span>
    <span>应付发生额 <strong>${payGrossText}</strong></span>
    <span>总轧差 ${differenceText}</span>
    <span>已轧平 <strong>${stats.evenGroups} 家</strong></span>
    ${pairSpan}
    ${decisionSpan}
    ${pairDateNote}
    ${ageNote}
    ${guessNote}
    ${pairNote}
    ${nearNote}
  `;
  const fingerprint = renderFingerprint();
  renderSnapshotComparison(fingerprint);
  renderExportReceipt();
}

function renderDataCheck() {
  const { skipped, reclassRows, redRows, unknownDirections } = state;
  const dimensionWarnings = state.dimensionWarnings || [];
  const controls = state.controls || [];
  const controlTotal = combineControls(controls);
  const controlBroken = controls.length > 0 && !controlTotal.ok;
  const controlMixed = controls.length > 0 && controlTotal.currencyMixed === true;
  const controlMoney = (cents) => (controlMixed ? fmtMoneyPlain(cents) : fmtMoney(cents));
  const problemSkipped = skipped.filter((item) => !BENIGN_SKIP_REASONS.has(item.reason));
  const benignSkipped = skipped.filter((item) => BENIGN_SKIP_REASONS.has(item.reason));
  const emptySources = emptyIncludedSourceNames();
  const hasIssues = problemSkipped.length > 0 || reclassRows.length > 0 || controlBroken
    || dimensionWarnings.length > 0 || emptySources.length > 0;
  const reasonSummary = summarizeSkipReasons(problemSkipped);
  const headlineParts = [];

  if (problemSkipped.length) {
    headlineParts.push(`有 ${problemSkipped.length} 行未纳入计算${reasonSummary ? `（${reasonSummary}）` : ''}`);
  }
  if (reclassRows.length) {
    headlineParts.push(`${reclassRows.length} 行负数金额已重分类到对立方向`);
  }
  if (redRows.length) {
    headlineParts.push(`其中 ${redRows.length} 笔是红字金额（数字为正、字体标红），已按负数处理`);
  }
  if (dimensionWarnings.length) {
    const kindSet = new Set();
    dimensionWarnings.forEach((item) => item.kinds.forEach((kind) => kindSet.add(kind)));
    headlineParts.push(`有 ${dimensionWarnings.length} 家企业的${Array.from(kindSet).join('、')}没对齐，同一家会被拆成两组`);
  }
  if (controlBroken) {
    headlineParts.push(`取数核对差 ${controlMoney(controlTotal.diffCents)}，可能有金额格没算进来`);
  }
  if (emptySources.length) {
    headlineParts.push(`有 ${emptySources.length} 张勾选的表一笔都没算进去`);
  }

  const infoParts = [];
  if (benignSkipped.length) {
    infoParts.push(`已跳过 ${benignSkipped.length} 行合计、表头或无余额行`);
  }
  if (state.inheritedRows) {
    infoParts.push(state.runInfo && state.runInfo.mode === 'manual'
      ? `${state.inheritedRows} 行企业名称留空，已承上一行`
      : `${state.inheritedRows} 行企业名称承上合并单元格`);
  }
  if (state.directionFallbackRows) {
    infoParts.push(`${state.directionFallbackRows} 行方向列为空，已按表名/整表方向补齐`);
  }
  if (state.outOfRangeRows) {
    infoParts.push(`另外 ${state.outOfRangeRows} 行是页脚说明、同表另一段或原表隐藏的行，没有算进来`);
  }
  if (state.stats && state.stats.ageGroups) {
    const missing = state.stats.ageUnknownRecords || 0;
    const unlisted = state.records.length - state.stats.ageMarkedRecords - missing;
    infoParts.push(
      `${state.stats.ageMarkedRecords} 笔按「${AGE_BANDS.join('、')}」分开了（${AGE_BANDS[AGE_BANDS.length - 1]} ${state.stats.mixedCurrency ? (ageLongByCurrencyText(state.groups) || '各币种均为 0') : fmtMoney(state.stats.ageLongCents)}）` +
      `${missing ? `，${missing} 笔原表没写账龄，单列在「账龄分析」` : ''}` +
      `${unlisted > 0 ? `，${unlisted} 笔来自没有账龄列的表、不参与账龄统计` : ''}`
    );
  }

  const headline = hasIssues
    ? `${headlineParts.join('；')}。${infoParts.length ? `${infoParts.join('；')}。` : ''}`
    : `数据检查通过：${state.records.length} 笔记录全部纳入计算。${infoParts.length ? `${infoParts.join('；')}。` : ''}`;

  let details = '';
  if (hasIssues && state.dataCheckOpen) {
    const items = [];
    problemSkipped.slice(0, 80).forEach((item) => {
      const raw = item.raw ? `：${truncate(item.raw, 36)}` : '';
      const source = item.source ? `「${item.source}」` : '';
      items.push(`${source}第 ${item.rowNo} 行 · ${item.reason}${raw}`);
    });
    if (problemSkipped.length > 80) items.push(`其余 ${problemSkipped.length - 80} 行从略`);
    if (reclassRows.length) {
      const rowText = reclassRows.slice(0, 20)
        .map((item) => `${item.source ? `「${item.source}」` : ''}第 ${item.rowNo} 行（${item.company}）${dirLabel(item.from)}→${dirLabel(item.to)}`)
        .join('、');
      items.push(`负数重分类行：${rowText}${reclassRows.length > 20 ? ` 等 ${reclassRows.length} 行` : ''}`);
    }
    if (redRows.length) {
      const redText = redRows.slice(0, 20)
        .map((item) => `${item.source ? `「${item.source}」` : ''}第 ${item.rowNo} 行（${item.company}）`)
        .join('、');
      items.push(`红字金额行：${redText}${redRows.length > 20 ? ` 等 ${redRows.length} 行` : ''}。原表红字按负数理解；如果这几行只是用红色做标注、金额其实是正数，请把金额列字体改成普通颜色后重新导入。`);
    }
    if (dimensionWarnings.length) {
      const text = dimensionWarnings.slice(0, 20)
        .map((item) => `「${item.name}」的${item.kinds.join('、')}有的记录写了、有的没写${item.sources.length ? `（涉及「${item.sources.join('」「')}」）` : ''}`)
        .join('；');
      items.push(`主体／币种没对齐：${text}${dimensionWarnings.length > 20 ? ` 等 ${dimensionWarnings.length} 家` : ''}。同一家企业会被拆成两组、两边对不上，请回上面给每张表都选上同一列，或者都设成不用。`);
    }
    if (controlBroken) {
      const rowList = controlTotal.unmatchedRows.slice(0, 40).join('、');
      if (rowList) items.push(`取数核对未归类的金额行：第 ${rowList} 行${controlTotal.unmatchedRows.length > 40 ? ' 等' : ''}。这些行有金额但没被算进来，请检查表头和取数范围。`);
      if (controlTotal.missingRecordRows.length) {
        items.push(`有 ${controlTotal.missingRecordRows.length} 条记录在金额列里找不到对应金额格：第 ${controlTotal.missingRecordRows.slice(0, 20).join('、')} 行。`);
      }
      if (controlTotal.diffCents !== 0) {
        items.push(`原表金额、纳入、跳过、范围外、未归类加起来差 ${controlMoney(controlTotal.diffCents)}（${controlTotal.diffCells} 格），请把这张表发给协助的人核对。`);
      }
    }
    if (emptySources.length) {
      items.push(`一笔都没算进去的表：${emptySources.map((name) => `「${name}」`).join('、')}。这类表通常是金额列选到了空白列、取数范围只剩表头，或者整张表其实是说明页。请回「核对数据源」点开这几张表看图片：确认那一列是金额就重新选一次，确实没有数据就取消勾选，别让它在清单里装着参与了。`);
    }
    if (unknownDirections.length) {
      items.push(`未识别方向值：${unknownDirections.map(([value, count]) => `${value}（${count} 次）`).join('、')}`);
    }
    if (benignSkipped.length) {
      items.push(`另跳过 ${benignSkipped.length} 行合计、表头或无余额行，不影响对账金额。`);
    }

    details = `
      <div class="dc-body">
        <ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
        <div class="dc-note">跳过的行不计入金额；负数金额已取绝对值并改记到对立方向（应收↔应付），请结合原始凭证复核。金额单元格是红字、数字本身为正的，按负数处理，并在明细里标「红字转负」；如果红字只是标注，改回普通颜色再导入。合并单元格承上的行已按上方企业名称归并。</div>
      </div>
    `;
  }

  const controlBlock = controls.length
    ? `
      <div class="dc-control ${controlBroken ? 'bad' : 'ok'}">
        <div class="dc-control-head">
          <b>取数核对</b>
          <span>${controls.length === 1 ? `「${escapeHtml(controls[0].sheetName)}」` : '全部数据源'}原表金额${controlMixed ? '（不同币种只做原数相加）' : ''} ${controlMoney(controlTotal.rawCents)}（${controlTotal.rawCells} 格）= 纳入 ${controlMoney(controlTotal.includedCents)} + 跳过 ${controlMoney(controlTotal.skippedCents)} + 范围外 ${controlMoney(controlTotal.outsideCents)} + 未归类 ${controlMoney(controlTotal.unmatchedCents)}</span>
          <span class="dc-diff ${controlBroken ? 'bad' : 'ok'}">差额 ${controlMoney(controlTotal.diffCents)}（${controlTotal.diffCells} 格）</span>
        </div>
        ${controls.length > 1
          ? `<div class="dc-control-src">${controls.map((control) => `<span title="${escapeHtml(`原表 ${fmtControlAmount(control, control.rawCents)} / ${control.rawCells} 格 · 纳入 ${fmtControlAmount(control, control.includedCents)} · 跳过 ${fmtControlAmount(control, control.skippedCents)} · 范围外 ${fmtControlAmount(control, control.outsideCents)} · 未归类 ${fmtControlAmount(control, control.unmatchedCents)}`)}">${escapeHtml(control.sheetName)}${control.ok ? '' : ' · 有差额'}</span>`).join('')}</div>`
          : ''}
        <div class="dc-note">金额列每一格都要落在“纳入 / 跳过 / 范围外”里，未归类必须是 0；手动粘贴按每行金额核对。${controlMixed ? '这张表里有多种币种，上面的金额只是原数直接相加，不做汇率换算。' : ''}</div>
      </div>
    `
    : '';

  els.dataCheck.innerHTML = `
    <div class="data-check ${hasIssues ? 'warn' : 'ok'}">
      <div class="dc-head">
        <span class="dc-icon" aria-hidden="true">${hasIssues ? '!' : '✓'}</span>
        <span>${escapeHtml(headline)}</span>
        ${hasIssues ? `<button type="button" class="dc-btn" id="dataCheckBtn" aria-expanded="${state.dataCheckOpen}">${state.dataCheckOpen ? '收起' : '查看明细'}</button>` : ''}
      </div>
      ${controlBlock}
      ${details}
    </div>
  `;
}

function renderSimilarBox() {
  if (!els.similarBox) return;
  const pending = (state.similarSuggestions || []).filter((item) =>
    !state.dismissedPairs.has(item.id) && !state.dismissedSimilar.has(item.id));
  const ignored = state.dismissedPairs.size;
  const ignoredNote = ignored
    ? `<button type="button" class="btn btn-sm similar-restore" data-act="restore-dismissed">已标成不是同一家 ${ignored} 对，恢复</button>`
    : '';

  if (!pending.length) {
    const lines = [];
    if (state.mergeLog.length) {
      lines.push(`已经人工并归 ${state.mergeLog.length} 组，金额按并归后的企业合计。`);
    }
    if (ignored) {
      lines.push(`另有 ${ignored} 对名称相近的企业，你已确认不是同一家，不会再提示。`);
    }
    els.similarBox.innerHTML = lines.length
      ? `<div class="similar-card done">
           <div class="similar-head"><b>名称并归</b><span>${lines.join('')}</span>
           <button type="button" class="btn btn-sm similar-undo" data-act="undo-merge" ${state.mergeLog.length ? '' : 'disabled'}>撤销最后一次并归</button>
           ${ignored ? `<button type="button" class="btn btn-sm similar-restore" data-act="restore-dismissed">恢复“不是同一家”的 ${ignored} 对</button>` : ''}</div>
         </div>`
      : '';
    els.similarBox.classList.toggle('hidden', !lines.length);
    return;
  }

  els.similarBox.classList.remove('hidden');
  els.similarBox.innerHTML = `
    <div class="similar-card">
      <div class="similar-head">
        <b>名称相近，可能是同一家（${pending.length} 组）</b>
        <span>只是提示，没有点「是同一家」之前各算各的；点下去会把两家的记录并到一起，净额按合并后重新算。</span>
      </div>
      <div class="similar-actions">
        <button type="button" class="btn btn-sm similar-undo" data-act="undo-merge" ${state.mergeLog.length ? '' : 'disabled'}>撤销最后一次并归</button>
        <button type="button" class="btn btn-sm similar-all-dismiss" data-act="dismiss-all">都不是同一家</button>
        ${ignoredNote}
      </div>
      <ul class="similar-list">
        ${pending.map((item) => `
          <li class="similar-item tier-${item.tier}">
            <div class="similar-names">
              <span class="similar-name">${escapeHtml(item.nameA)}</span>
              <em>${item.rowsA} 笔 · 净${item.netA >= 0 ? '应收' : '应付'} ${fmtMoney(Math.abs(item.netA))}</em>
              <span class="similar-vs">和</span>
              <span class="similar-name">${escapeHtml(item.nameB)}</span>
              <em>${item.rowsB} 笔 · 净${item.netB >= 0 ? '应收' : '应付'} ${fmtMoney(Math.abs(item.netB))}</em>
            </div>
            <div class="similar-reason">
              <span class="similar-tier">${escapeHtml(mergePairLabel(item))}</span>
              ${escapeHtml(item.reason)}
            </div>
            <div class="similar-btns">
              <button type="button" class="btn btn-sm" data-act="merge" data-id="${escapeHtml(item.id)}" data-keep="a">是同一家（用第一家名字）</button>
              <button type="button" class="btn btn-sm" data-act="merge" data-id="${escapeHtml(item.id)}" data-keep="b">是同一家（用第二家名字）</button>
              <button type="button" class="btn btn-sm btn-ghost" data-act="dismiss" data-id="${escapeHtml(item.id)}">不是同一家</button>
            </div>
          </li>`).join('')}
      </ul>
    </div>
  `;
}

function snapshotMergeState() {
  return {
    merges: new Map(state.merges),
    mergeLog: state.mergeLog.slice(),
    dismissedSimilar: new Set(state.dismissedSimilar),
    groupNotes: new Map(state.groupNotes)
  };
}

function restoreMergeState(snapshot) {
  state.merges = snapshot.merges;
  state.mergeLog = snapshot.mergeLog;
  state.dismissedSimilar = snapshot.dismissedSimilar;
  state.groupNotes = snapshot.groupNotes;
  rebuildGroupsFromRecords();
}

function mergeSimilarPair(id, keep) {
  const item = (state.similarSuggestions || []).find((pair) => pair.id === id);
  if (!item) return;

  const childKey = keep === 'b' ? item.keyA : item.keyB;
  const parentKey = keep === 'b' ? item.keyB : item.keyA;
  if (childKey === parentKey) return;

  const snapshot = snapshotMergeState();
  pushUndo('并归企业', () => restoreMergeState(snapshot));
  state.merges.set(resolveMergeKey(childKey), resolveMergeKey(parentKey));
  state.mergeLog.push({ child: childKey, parent: parentKey, nameA: item.nameA, nameB: item.nameB });
  state.dismissedSimilar.add(similarPairKey(childKey, parentKey));

  const childNote = state.groupNotes.get(childKey);
  if (childNote) {
    const parentNote = state.groupNotes.get(parentKey) || '';
    state.groupNotes.set(parentKey, parentNote ? `${parentNote}；${childNote}` : childNote);
    state.groupNotes.delete(childKey);
  }

  rebuildGroupsFromRecords();
  showToast(`已把「${keep === 'b' ? item.nameA : item.nameB}」并到「${keep === 'b' ? item.nameB : item.nameA}」，需要退回点「撤销最后一次并归」`);
}

function undoLastMerge() {
  const last = state.mergeLog.pop();
  if (!last) {
    showToast('没有可撤销的并归', true);
    return;
  }

  const remaining = new Map();
  state.merges.forEach((parent, child) => {
    if (child !== last.child) remaining.set(child, parent);
  });
  state.merges = remaining;
  state.dismissedSimilar.delete(similarPairKey(last.child, last.parent));

  rebuildGroupsFromRecords();
  showToast('已撤销这一次并归，两家重新分开算');
}

function dismissAllSimilar() {
  const pending = (state.similarSuggestions || []).filter((item) =>
    !state.dismissedPairs.has(item.id) && !state.dismissedSimilar.has(item.id));
  if (!pending.length) return;
  const previous = new Set(state.dismissedPairs);
  pushUndo('标成不是同一家', () => {
    state.dismissedPairs = previous;
    renderSimilarBox();
  });
  pending.forEach((item) => state.dismissedPairs.add(item.id));
  renderSimilarBox();
  showToast(`已把这 ${pending.length} 组都标成不是同一家，重新对账也不会再提示；想改回来点「恢复」`);
}

function restoreDismissedPairs() {
  const count = state.dismissedPairs.size;
  if (!count) return;
  const previous = new Set(state.dismissedPairs);
  pushUndo('恢复名称相近提示', () => {
    state.dismissedPairs = previous;
    renderSimilarBox();
  });
  state.dismissedPairs.clear();
  renderSimilarBox();
  showToast(`已恢复 ${count} 对名称相近的提示，重新点对账后会再列出来`);
}

function rebuildGroupsFromRecords() {
  const openKeys = new Set(
    state.groups.filter((group) => state.expanded.has(group.idx)).map((group) => group.key)
  );

  state.groups = buildGroups(state.records);
  state.pairResult = runPairing(state.groups, state.pairToleranceCents);
  state.stats = computeStats(state.groups);
  state.similarSuggestions = buildSimilarSuggestions(state.groups);
  state.expanded = new Set(
    state.groups.filter((group) => openKeys.has(group.key)).map((group) => group.idx)
  );

  updateResultMeta();
  renderSummary();
  renderDataCheck();
  renderSimilarBox();
  renderChips();
  updateChipStates();
  renderFacets();
  renderTable();
}

// ===== 筛选、排序与结果明细 =====

function summarizeSkipReasons(skipped) {
  if (!skipped.length) return '';
  const counts = new Map();
  skipped.forEach((item) => {
    counts.set(item.reason, (counts.get(item.reason) || 0) + 1);
  });
  return Array.from(counts.entries())
    .map(([reason, count]) => `${reason} ${count} 行`)
    .join('、');
}

function renderChips() {
  const counts = {};
  CHIP_DEFS.forEach((definition) => {
    counts[definition.id] = state.groups.filter(definition.match).length;
  });

  els.filterChips.innerHTML = CHIP_DEFS.map((definition) => {
    const active = state.filter === definition.id;
    return `
      <button type="button" class="chip ${active ? 'active' : ''}" data-filter="${definition.id}" aria-pressed="${active}">
        ${definition.label}<span class="count">${counts[definition.id]}</span>
      </button>
    `;
  }).join('');
}

function updateChipStates() {
  els.filterChips.querySelectorAll('button[data-filter]').forEach((button) => {
    const active = button.dataset.filter === state.filter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function groupMatchesNetFacet(group, facetId) {
  const definition = NET_FACETS.find((item) => item.id === facetId) || NET_FACETS[0];
  return definition.test(Math.abs(group.netCents));
}

function groupMatchesDirFacet(group, facetId) {
  const definition = DIR_FACETS.find((item) => item.id === facetId) || DIR_FACETS[0];
  return definition.test(group);
}

function groupMatchesSourceFacet(group, facetLabel) {
  if (facetLabel === 'all') return true;
  return group.sources.some((source) => sourceLabelOf(source) === facetLabel);
}

// skip 传 'net' / 'dir' / 'source' 时放过那一档，用来数「点这一档会剩几家」。
function groupMatchesFacets(group, skip) {
  if (skip !== 'net' && !groupMatchesNetFacet(group, state.facetNet)) return false;
  if (skip !== 'dir' && !groupMatchesDirFacet(group, state.facetDir)) return false;
  if (skip !== 'source' && !groupMatchesSourceFacet(group, state.facetSource)) return false;
  return true;
}

function facetsActive() {
  return state.facetNet !== 'all' || state.facetDir !== 'all' || state.facetSource !== 'all';
}

function resetFacets() {
  state.facetNet = 'all';
  state.facetDir = 'all';
  state.facetSource = 'all';
}

function sourceLabelOf(source) {
  return source.shortLabel || source.label || '数据源';
}

// 上面那排企业标记 chips 和搜索框先筛一遍，分档筛选在这批里再筛。
function groupsMatchingChipAndSearch() {
  const definition = CHIP_DEFS.find((item) => item.id === state.filter) || CHIP_DEFS[0];
  const query = normalizeForSearch(state.search);

  return state.groups.filter((group) => {
    if (!definition.match(group)) return false;
    if (!query) return true;
    const haystack = [group.key, ...group.variantList.map((variant) => normalizeForSearch(variant[0]))].join(' ');
    return haystack.includes(query);
  });
}

function facetChipMarkup(facet, item, count, active) {
  return `
    <button type="button" class="chip chip-sm ${active ? 'active' : ''}" data-facet="${facet}" data-value="${escapeHtml(item.id)}"
      aria-pressed="${active}" title="${escapeHtml(item.title)}">${item.label}<span class="count">${count}</span></button>
  `;
}

function sourceFacetOptions(groups) {
  const counts = new Map();
  groups.forEach((group) => {
    const seen = new Set();
    group.sources.forEach((source) => {
      const label = sourceLabelOf(source);
      if (seen.has(label)) return;
      seen.add(label);
      counts.set(label, (counts.get(label) || 0) + 1);
    });
  });
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || compareStableText(a.label, b.label));
}

function renderFacets() {
  if (!els.facetBar) return;
  if (!state.groups.length) {
    els.facetBar.innerHTML = '';
    els.facetBar.classList.add('hidden');
    return;
  }
  els.facetBar.classList.remove('hidden');

  const base = groupsMatchingChipAndSearch();
  const netPool = base.filter((group) => groupMatchesFacets(group, 'net'));
  const dirPool = base.filter((group) => groupMatchesFacets(group, 'dir'));
  const sourcePool = base.filter((group) => groupMatchesFacets(group, 'source'));

  const netChips = NET_FACETS.map((item) => {
    const count = item.id === 'all'
      ? netPool.length
      : netPool.filter((group) => groupMatchesNetFacet(group, item.id)).length;
    return facetChipMarkup('net', item, count, state.facetNet === item.id);
  }).join('');

  const dirChips = DIR_FACETS.map((item) => {
    const count = item.id === 'all'
      ? dirPool.length
      : dirPool.filter((group) => groupMatchesDirFacet(group, item.id)).length;
    return facetChipMarkup('dir', item, count, state.facetDir === item.id);
  }).join('');

  const options = sourceFacetOptions(sourcePool);
  if (state.facetSource !== 'all' && !options.some((option) => option.label === state.facetSource)) {
    options.unshift({ label: state.facetSource, count: 0 });
  }
  const sourceOptions = [`<option value="all">不限（${sourcePool.length} 家）</option>`]
    .concat(options.map((option) => `<option value="${escapeHtml(option.label)}" ${state.facetSource === option.label ? 'selected' : ''}>${escapeHtml(option.label)}（${option.count} 家）</option>`))
    .join('');

  const currencyKeys = new Set(state.groups.map((group) => group.currencyKey || ''));
  const mixedCurrency = currencyKeys.size > 1;
  const note = `这三档只是把屏幕上的企业挑出来看，不改变任何金额；${mixedCurrency ? '净额大小按原币金额分档，不做汇率折算；' : ''}勾了「仅导出筛选结果」时，导出的也是筛出来的这几家。`;

  els.facetBar.innerHTML = `
    <div class="facet-row">
      <span class="facet-name">按净额大小</span>
      <div class="facet-chips">${netChips}</div>
    </div>
    <div class="facet-row">
      <span class="facet-name">按净方向</span>
      <div class="facet-chips">${dirChips}</div>
    </div>
    <div class="facet-row">
      <span class="facet-name">按数据源</span>
      <select class="facet-select" id="sourceFacetSelect" aria-label="按数据源筛选" title="只看某一张表里来的企业">${sourceOptions}</select>
    </div>
    <div class="facet-row facet-tools">
      <button type="button" class="btn btn-sm btn-ghost" data-facet-clear ${facetsActive() ? '' : 'disabled'}>清空这三档</button>
      <button type="button" class="btn btn-sm" data-copy-filtered>复制这几家的汇总</button>
      <span class="facet-note">${escapeHtml(note)}</span>
    </div>
  `;
}

function filteredSummaryTsv(groups) {
  const header = ['企业名称', '主体', '币种', '数据源', '记录笔数', '应收合计', '应付合计', '净额', '净方向', '差异说明'];
  const rows = groups.map((group) => [
    copySafe(group.displayName),
    copySafe(group.entityLabel || ''),
    copySafe(group.currencyLabel || ''),
    copySafe(group.sources.map(sourceLabelOf).join('、')),
    group.rows.length,
    (group.recvCents / 100).toFixed(2),
    (group.payCents / 100).toFixed(2),
    (group.netCents / 100).toFixed(2),
    group.netCents > 0 ? '净应收' : group.netCents < 0 ? '净应付' : '已平',
    copySafe(state.groupNotes.get(group.key) || '')
  ].join('\t'));
  return [header.join('\t'), ...rows].join('\n');
}

async function copyFilteredSummary() {
  const groups = getVisibleGroups();
  if (!groups.length) {
    showToast('当前筛选下没有企业，先把上面那档改成不限', true);
    return;
  }
  let copied = false;
  try {
    copied = await copyPlainText(filteredSummaryTsv(groups));
  } catch (error) {
    copied = false;
  }
  showToast(copied
    ? `已复制 ${groups.length} 家企业的汇总，可以直接粘到 Excel`
    : '浏览器拦住了复制，可以在下面的表格里手动选中再按 Ctrl+C', !copied);
}

function getVisibleGroups() {
  const filtered = groupsMatchingChipAndSearch().filter((group) => groupMatchesFacets(group, null));
  return sortGroups(filtered, state.sort);
}

function sortGroups(groups, mode) {
  const result = groups.slice();

  switch (mode) {
    case 'netDesc':
      result.sort((a, b) => b.netCents - a.netCents || a.displayName.localeCompare(b.displayName, 'zh-CN'));
      break;
    case 'countDesc':
      result.sort((a, b) => b.rows.length - a.rows.length || Math.abs(b.netCents) - Math.abs(a.netCents));
      break;
    case 'name':
      result.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'));
      break;
    default:
      result.sort((a, b) => Math.abs(b.netCents) - Math.abs(a.netCents) || a.displayName.localeCompare(b.displayName, 'zh-CN'));
  }

  return result;
}

function renderTable() {
  const visible = getVisibleGroups();
  const total = visible.length;
  const limit = state.printing ? total : Math.min(total, state.renderLimit || RENDER_PAGE_SIZE);
  const shown = visible.slice(0, limit);
  els.visibleCount.textContent = `显示 ${limit} / ${state.groups.length} 家企业`;

  if (!total) {
    els.resultBody.innerHTML = `
      <tr>
        <td colspan="8">
          <div class="table-empty">当前筛选下没有企业。试试清空搜索或切换筛选条件。</div>
        </td>
      </tr>
    `;
    return;
  }

  const more = total - limit;
  const moreRow = more > 0
    ? `<tr class="render-more-row"><td colspan="8">
        <div class="render-more">
          <span>还有 ${more} 家企业没列出来（不影响导出和打印，那边始终是全部）</span>
          <button type="button" class="btn btn-sm" data-render-more>再显示 ${Math.min(RENDER_PAGE_SIZE, more)} 家</button>
          <button type="button" class="btn btn-sm btn-ghost" data-render-all>显示全部</button>
        </div>
      </td></tr>`
    : '';

  els.resultBody.innerHTML = shown.map((group) => groupMarkup(group)).join('') + moreRow;
}

function groupRowSummary(group) {
  const bySource = new Map();

  group.rows.forEach((record) => {
    const label = record.sourceShortLabel || record.sourceLabel || '数据源';
    if (!bySource.has(label)) bySource.set(label, { rows: [], kind: record.sourceKind || 'excel' });
    bySource.get(label).rows.push(record.rowNo);
  });

  const parts = [];
  let shown = 0;

  bySource.forEach((info, label) => {
    if (shown >= 4) return;
    const uniqueRows = Array.from(new Set(info.rows)).sort((a, b) => a - b);
    const take = uniqueRows.slice(0, 4 - shown);
    shown += take.length;
    if (bySource.size === 1) {
      parts.push(`${info.kind === 'manual' ? '粘贴行' : '原表行'} ${take.join('、')}`);
    } else {
      parts.push(`${label} 第 ${take.join('、')} 行`);
    }
  });

  let summary = parts.join(' · ');
  if (group.rows.length > shown) summary += ` 等 ${group.rows.length} 行`;
  return summary;
}

function groupMarkup(group) {
  const isOpen = state.expanded.has(group.idx);
  const rowSummary = groupRowSummary(group);
  const variantSummary = group.variantList.length > 1 ? ` · ${group.variantList.length} 种写法` : '';
  const note = state.groupNotes.get(group.key) || '';
  const noteMark = note.trim() ? '<span class="note-mark" title="已写差异说明">有说明</span>' : '';
  const netClass = group.netCents > 0 ? 'recv' : group.netCents < 0 ? 'pay' : 'even';
  const netLabel = group.netCents > 0 ? '净应收' : group.netCents < 0 ? '净应付' : '已平';
  const flagHtml = group.flags.length
    ? group.flags.map(flagMarkup).join('')
    : '<span class="no-flag">—</span>';
  const sourceHtml = group.sources
    .map((source) => `<span class="source-chip" title="${escapeHtml(source.label)}">${escapeHtml(source.shortLabel)}</span>`)
    .join('');
  const dimBadges = (group.entityLabel || group.currencyLabel)
    ? `<span class="dim-badges">${group.entityLabel ? `<span class="dim-badge" title="主体：${escapeHtml(group.entityLabel)}">主体 ${escapeHtml(group.entityLabel)}</span>` : ''}${group.currencyLabel ? `<span class="dim-badge dim-currency" title="币种：${escapeHtml(group.currencyLabel)}">${escapeHtml(group.currencyLabel)}</span>` : ''}</span>`
    : '';

  return `
    <tr class="group-row ${isOpen ? 'is-open' : ''}">
      <td>
        <div class="company-name" title="${escapeHtml(group.displayName)}">${escapeHtml(group.displayName)}</div>
        <div class="company-sub">${dimBadges}${escapeHtml(rowSummary)}${escapeHtml(variantSummary)}${noteMark}</div>
      </td>
      <td><div class="source-cell">${sourceHtml}</div></td>
      <td class="num">${group.rows.length} 笔</td>
      <td class="num ${group.hasRecv ? 'cell-amount recv' : 'cell-none'}">${group.hasRecv ? fmtMoneyIn(group.recvCents, group.currencyKey) : '—'}</td>
      <td class="num ${group.hasPay ? 'cell-amount pay' : 'cell-none'}">${group.hasPay ? fmtMoneyIn(group.payCents, group.currencyKey) : '—'}</td>
      <td class="num">
        <div class="net-cell">
          <span class="net-amount ${netClass}">${fmtMoneyIn(Math.abs(group.netCents), group.currencyKey)}</span>
          <span class="net-tag ${netClass}">${netLabel}</span>
        </div>
      </td>
      <td class="flags-cell">${flagHtml}</td>
      <td>
        <button type="button" class="detail-btn" data-idx="${group.idx}" aria-expanded="${isOpen}">
          明细<span class="chevron" aria-hidden="true"></span>
        </button>
      </td>
    </tr>
    ${isOpen ? detailRowMarkup(group) : ''}
  `;
}

function refreshAgeBands() {
  if (!state.groups.length) return;
  const base = ageBaseDateValue();
  state.records.forEach((record) => {
    if (!record.hasAgeColumn) return;
    if (Number.isFinite(record.ageMonths)) record.ageBand = ageBandIndex(record.ageMonths);
    record.ageShown = recordAgeBand(record, base);
  });
  state.groups.forEach((group) => {
    group.ageStats = buildAgeStats(group, base);
    group.hasAge = group.ageStats.applicable > 0;
    group.ageLong = group.ageStats.maxBand === AGE_BANDS.length - 1;
    group.flags = group.flags.filter((flag) => flag !== 'ageLong');
    if (group.ageLong) group.flags.push('ageLong');
  });
  state.stats = computeStats(state.groups);
  renderSummary();
  renderDataCheck();
  renderChips();
  renderTable();
}

function updateAgeBaseField() {
  if (!els.ageBaseField || !els.ageBaseDate) return;
  const needsDate = state.records.some((record) => Boolean(record.ageDateISO));
  els.ageBaseField.classList.toggle('hidden', !needsDate);
  els.ageBaseDate.value = ageBaseDateValue();
  const hasAge = state.records.some((record) => record.hasAgeColumn);
  if (els.ageBandField) els.ageBandField.classList.toggle('hidden', !hasAge);
  if (els.ageBandPreset) els.ageBandPreset.value = state.ageBandPreset;
}

function ageLineMarkup(group) {
  if (!group.hasAge) return '';
  const stats = group.ageStats;

  const parts = AGE_BANDS.map((bandLabel, index) => {
    const recv = stats.recv[index];
    const pay = stats.pay[index];
    if (!recv.count && !pay.count) return '';
    const bits = [];
    if (recv.count) bits.push(`应收 ${fmtMoney(recv.cents)} · ${recv.count} 笔`);
    if (pay.count) bits.push(`应付 ${fmtMoney(pay.cents)} · ${pay.count} 笔`);
    return `<b>${escapeHtml(bandLabel)}</b>：${bits.join('；')}`;
  }).filter(Boolean);

  const unknownCount = stats.recvUnknown.count + stats.payUnknown.count;
  const unknownBit = unknownCount
    ? `<span class="age-none">${unknownCount} 笔原表没写账龄</span>`
    : '';

  return `<div class="variant-line age-line"><b>账龄分布</b>：${parts.join('　/　')}${unknownBit}</div>`;
}

function detailRowMarkup(group) {
  const sourceOrder = new Map(group.sources.map((source, index) => [source.id, index]));
  const rows = group.rows.slice().sort((a, b) => {
    const orderA = sourceOrder.get(a.sourceId) ?? 0;
    const orderB = sourceOrder.get(b.sourceId) ?? 0;
    return orderA - orderB || a.rowNo - b.rowNo;
  });
  const netDirection = group.netCents > 0 ? '净应收' : group.netCents < 0 ? '净应付' : '已平';
  const netAmount = fmtMoneyIn(Math.abs(group.netCents), group.currencyKey);
  const amountHeader = group.currencyLabel ? `金额（${group.currencyLabel}）` : '金额（元）';

  const detailRows = rows.map((row) => {
    const flagItems = row.flags.map(flagMarkup).join('');
    const redTag = row.redFlipped
      ? '<span class="red-tag" title="原表金额是红字、数字本身为正，已按负数处理">红字转负</span>'
      : '';
    const ageTag = group.hasAge && row.ageShown >= 0
      ? `<span class="age-tag${row.ageShown === AGE_BANDS.length - 1 ? ' is-long' : ''}" title="${escapeHtml(row.ageRaw ? `原表写的是：${row.ageRaw}` : '按账龄列推算')}">账龄 ${escapeHtml(ageBandLabel(row.ageShown))}</span>`
      : '';
    const flags = redTag + ageTag + (flagItems || '<span class="no-flag">—</span>');
    const memo = row.memo
      ? `<span title="${escapeHtml(row.memo)}">${escapeHtml(truncate(row.memo, 80))}</span>`
      : '—';
    const rawAmountTitle = row.rawAmount
      ? `${row.sourceKind === 'manual' ? '粘贴金额' : '原表金额'}：${row.rawAmount}`
      : '';
    const inheritTag = row.inherited
      ? '<span class="inherit-tag" title="该行企业名称沿用上方合并单元格">承上</span>'
      : '';
    const sourceLabel = row.sourceKind === 'manual' ? row.sourceLabel : (row.sourceLabel || row.sourceShortLabel);
    return `
      <tr>
        <td class="rowno">${row.rowNo}</td>
        <td class="source-cell">${escapeHtml(sourceLabel)}</td>
        <td class="company-raw">${escapeHtml(row.companyRaw)}${inheritTag}</td>
        <td><span class="cell-amount ${row.dir}">${dirLabel(row.dir)}</span></td>
        <td class="num" title="${escapeHtml(rawAmountTitle)}">${fmtMoneyIn(row.cents, group.currencyKey)}</td>
        <td class="memo-cell">${memo}</td>
        <td>${flags}</td>
      </tr>
    `;
  }).join('');

  const variantLine = group.variantList.length > 1
    ? `<div class="variant-line"><b>名称写法（${group.variantList.length} 种）</b>：${group.variantList
        .map(([name, count]) => `${escapeHtml(name)}（${count} 笔）`)
        .join('；')}</div>`
    : '';
  const equalLine = group.equalPair
    ? `<div class="variant-line"><b>同额项</b>：${group.equalCentsList.map((cents) => fmtMoneyIn(cents, group.currencyKey)).join('、')}（应收与应付金额相同）</div>`
    : '';
  const duplicateLine = group.sameDirDup
    ? `<div class="variant-line"><b>同向重复</b>：${group.sameDirDupItems
        .map((item) => `${dirLabel(item.dir)} ${fmtMoneyIn(item.cents, group.currencyKey)} × ${item.count} 笔`)
        .join('；')}</div>`
    : '';
  const mergedNames = group.manualMerge
    ? group.variantList.map(([name]) => name).filter((name) => name !== group.displayName)
    : [];
  const mergeLine = mergedNames.length
    ? `<div class="variant-line merge-line"><b>人工并归</b>：${escapeHtml(group.displayName)} 与${mergedNames.map((name) => `「${escapeHtml(name)}」`).join('、')}已按你的确认当成同一家一起算，点上方「撤销最后一次并归」可以退回。</div>`
    : '';

  const copyZone = copyZoneMarkup(group, rows);
  const note = state.groupNotes.get(group.key) || '';

  return `
    <tr class="detail-row">
      <td colspan="8">
        <div class="detail-wrap" id="detail-${group.idx}">
          <div class="detail-head">
            <div class="detail-title">明细 · ${group.rows.length} 笔</div>
            <div class="detail-sum">应收 ${fmtMoneyIn(group.recvCents, group.currencyKey)} · 应付 ${fmtMoneyIn(group.payCents, group.currencyKey)} · ${netDirection} ${group.netCents === 0 ? fmtMoneyIn(0, group.currencyKey) : netAmount}</div>
          </div>
          <div class="group-note">
            <label for="note-${group.idx}">差异说明 / 复核结论</label>
            <textarea id="note-${group.idx}" class="group-note-input" data-note-key="${escapeHtml(group.key)}" rows="2" placeholder="差异原因、后续程序、与客户确认的结果；会写进导出和打印">${escapeHtml(note)}</textarea>
            <div class="group-note-print">${note.trim() ? escapeHtml(note) : '—'}</div>
          </div>
          ${variantLine}
          ${equalLine}
          ${duplicateLine}
          ${ageLineMarkup(group)}
          ${mergeLine}
          ${pairZoneMarkup(group)}
          ${copyZone}
          <div class="scroll-hint">左右滑动可查看全部列</div>
          <table class="detail-table">
            <thead>
              <tr>
                <th>原表行</th>
                <th>数据源</th>
                <th>原始企业名称</th>
                <th>方向</th>
                <th class="num">${escapeHtml(amountHeader)}</th>
                <th>摘要 / 备注</th>
                <th>记录标记</th>
              </tr>
            </thead>
            <tbody>${detailRows}</tbody>
          </table>
        </div>
      </td>
    </tr>
  `;
}

function pairZoneMarkup(group) {
  if (!group.hasRecv || !group.hasPay) return '';

  const pairings = group.pairings || [];
  // 同一组内币种一致，这里统一按组币种显示金额。
  const fmtMoney = (cents) => fmtMoneyIn(cents, group.currencyKey);
  const tolerance = (state.pairToleranceCents / 100).toFixed(2);
  const percentHint = state.pairPercent
    ? `，或差额不到较大一方 ${formatPercentInput(state.pairPercent)}%`
    : '';
  const hint = `<span>同一企业内按金额配对（容差 ${tolerance} 元${percentHint}），只是提示，不改变净额。</span>`;
  const docHints = group.docHints || [];
  const docBlock = docHints.length
    ? `<div class="pair-docs"><b>同单据号</b>${docHints.slice(0, 8).map((item) => `
        <span class="pair-doc">
          <code title="${escapeHtml(item.docVariants && item.docVariants.length > 1 ? `原表写法：${item.docVariants.join(' / ')}（按同一编号对上）` : '')}">${escapeHtml(item.docNo)}</code>
          <span class="pair-side recv"><i>应收</i><b>${fmtMoney(item.recvCents)}</b><em>${escapeHtml(pairRowLabel(group, item.recvRows))}</em></span>
          <span class="pair-arrow" aria-hidden="true">↔</span>
          <span class="pair-side pay"><i>应付</i><b>${fmtMoney(item.payCents)}</b><em>${escapeHtml(pairRowLabel(group, item.payRows))}</em></span>
          <span class="pair-diff ${item.diffCents === 0 ? '' : 'near'}">${item.diffCents === 0 ? '金额一致' : `还差 ${fmtMoney(Math.abs(item.diffCents))}`}</span>
        </span>`).join('')}${docHints.length > 8 ? `<span class="pair-doc">另有 ${docHints.length - 8} 个单据号相同，导出 Excel 的「同单据号」表里有全部。</span>` : ''}<em>按摘要里的单据号找到的一一对应，只是提示，不改变净额。</em></div>`
    : '';

  const memoHints = group.memoKeyHints || [];
  const keyBlock = memoHints.length
    ? `<div class="pair-docs pair-keys"><b>摘要里的相同线索</b>${memoHints.slice(0, 8).map((item) => `
        <span class="pair-doc">
          <code title="${escapeHtml(item.variants && item.variants.length > 1 ? `原表写法：${item.variants.join(' / ')}（按同一线索对上）` : '')}">${escapeHtml(item.label)} ${escapeHtml(item.value)}</code>
          <span class="pair-side recv"><i>应收</i><b>${fmtMoney(item.recvCents)}</b><em>${escapeHtml(pairRowLabel(group, item.recvRows))}</em></span>
          <span class="pair-arrow" aria-hidden="true">↔</span>
          <span class="pair-side pay"><i>应付</i><b>${fmtMoney(item.payCents)}</b><em>${escapeHtml(pairRowLabel(group, item.payRows))}</em></span>
          <span class="pair-diff ${item.diffCents === 0 ? '' : 'near'}">${item.diffCents === 0 ? '金额一致' : `还差 ${fmtMoney(Math.abs(item.diffCents))}`}</span>
        </span>`).join('')}${memoHints.length > 8 ? `<span class="pair-doc">另有 ${memoHints.length - 8} 条相同线索，导出 Excel 的「摘要线索」表里有全部。</span>` : ''}<em>摘要里写了同一个合同、项目、部门或订单的记录，放一起方便对照；对不上的那些没列出来，只是提示，不改变净额。</em></div>`
    : '';

  const nearMissAll = group.nearMiss || [];
  const nearBlock = nearMissAll.length
    ? `<div class="pair-docs pair-near"><b>差一点就能配上</b>${nearMissAll.slice(0, PAIR_NEAR_MISS_MAX).map((item) => `
        <span class="pair-doc">
          <span class="pair-side recv"><i>应收</i><b>${fmtMoney(item.recvCents)}</b><em>${escapeHtml(pairRowLabel(group, [item.recvRow]))}</em></span>
          <span class="pair-arrow" aria-hidden="true">↔</span>
          <span class="pair-side pay"><i>应付</i><b>${fmtMoney(item.payCents)}</b><em>${escapeHtml(pairRowLabel(group, [item.payRow]))}</em></span>
          <span class="pair-diff near">差 ${fmtMoney(item.diffCents)}</span>
          <span class="pair-need">把「核销容差」改成 ${(item.diffCents / 100).toFixed(2)} 元就能配上</span>
        </span>`).join('')}${nearMissAll.length > PAIR_NEAR_MISS_MAX ? `<span class="pair-doc">另有 ${nearMissAll.length - PAIR_NEAR_MISS_MAX} 对只差一点，导出 Excel 的「差一点」表里有全部。</span>` : ''}<em>自动配对没吃掉的记录里，两边差额最小的几对。只是给个参照，不改任何金额。</em></div>`
    : '';

  if (!pairings.length) {
    const limitNote = group.rows.length > PAIR_MAX_SUBSET_SIZE
      ? `（每侧最多凑 ${PAIR_MAX_SUBSET_SIZE} 笔）`
      : '';
    return `
      <div class="pair-zone empty">
        <div class="pair-head"><b>自动核销</b>${hint}</div>
        <div class="pair-empty">应收与应付之间没有金额相符的组合${limitNote}，全部 ${group.rows.length} 笔都留在净额里。</div>
        ${nearBlock}
        ${docBlock}
        ${keyBlock}
      </div>
    `;
  }

  const shown = pairings.slice(0, PAIR_MAX_SHOWN);
  const items = shown.map((pairing, index) => {
    const decision = pairing.decision || 'pending';
    const decisionText = pairDecisionLabel(decision);
    const dateText = pairDateText(pairing);
    return `
    <div class="pair-item ${pairing.diffCents === 0 ? 'exact' : 'near'}">
      ${dateText ? `<span class="pair-date ${pairing.dateFar ? 'is-far' : ''}">日期 ${escapeHtml(dateText)}</span>` : ''}
      <span class="pair-kind">${pairKindLabel(pairing)}</span>
      <span class="pair-side recv"><i>应收</i><b>${fmtMoney(pairing.recvCents)}</b><em>${escapeHtml(pairRowLabel(group, pairing.recvRows))}</em></span>
      <span class="pair-arrow" aria-hidden="true">↔</span>
      <span class="pair-side pay"><i>应付</i><b>${fmtMoney(pairing.payCents)}</b><em>${escapeHtml(pairRowLabel(group, pairing.payRows))}</em></span>
      <span class="pair-diff">${pairing.diffCents === 0 ? '金额一致' : `差 ${fmtMoney(pairing.diffCents)}`}</span>
      <span class="pair-actions" role="group" aria-label="这组配对是否采纳">
        <button type="button" class="pair-decide ${decision === 'accepted' ? 'is-on accept' : ''}" data-pair-decision="accepted" data-idx="${group.idx}" data-pi="${index}" aria-pressed="${decision === 'accepted'}">采纳</button>
        <button type="button" class="pair-decide ${decision === 'rejected' ? 'is-on reject' : ''}" data-pair-decision="rejected" data-idx="${group.idx}" data-pi="${index}" aria-pressed="${decision === 'rejected'}">不采纳</button>
        <em class="pair-state ${decision}">${decisionText}</em>
      </span>
    </div>
  `;
  }).join('');
  const moreNote = pairings.length > shown.length
    ? `<div class="pair-more">另有 ${pairings.length - shown.length} 组未显示，导出 Excel 的「核销配对」表里有全部。</div>`
    : '';

  const unpairedRecvCents = group.recvCents - group.pairedRecvCents;
  const unpairedPayCents = group.payCents - group.pairedPayCents;
  const foot = group.netCents === 0
    ? `已抵掉应收 ${fmtMoney(group.pairedRecvCents)} · 应付 ${fmtMoney(group.pairedPayCents)}，两边全部配对完成，净额 0。`
    : `已抵掉应收 ${fmtMoney(group.pairedRecvCents)} · 应付 ${fmtMoney(group.pairedPayCents)}；剩下 应收 ${fmtMoney(unpairedRecvCents)} / 应付 ${fmtMoney(unpairedPayCents)}，即${group.netCents > 0 ? '净应收' : '净应付'} ${fmtMoney(Math.abs(group.netCents))}。`;
  const limitNote = group.pairLimited
    ? `<div class="pair-note">该企业记录笔数较多，组合配对只在金额最大的 ${PAIR_MAX_SUBSET_POOL} 笔里尝试，可能还有未找到的组合。</div>`
    : '';

  return `
    <div class="pair-zone">
      <div class="pair-head"><b>自动核销 · ${pairings.length} 组</b>${hint}</div>
      <div class="pair-list">${items}</div>
      ${nearBlock}
      ${docBlock}
      ${keyBlock}
      ${moreNote}
      <div class="pair-foot">${foot}</div>
      ${limitNote}
    </div>
  `;
}

// ===== 复制与剪贴板 =====

function copySafe(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[\t\n\r]+/g, ' ');
}

function copyLineFor(row) {
  return [
    copySafe(row.companyRaw),
    (row.cents / 100).toFixed(2),
    copySafe(row.memo),
    copySafe(row.sourceShortLabel),
    row.rowNo
  ].join('\t');
}

function copySideMarkup(group, direction, sideRows) {
  const label = dirLabel(direction);
  const fmtMoney = (cents) => fmtMoneyIn(cents, group.currencyKey);
  const totalCents = sideRows.reduce((sum, row) => sum + row.cents, 0);
  const targetId = `copy-${group.idx}-${direction}`;

  if (!sideRows.length) {
    return `
      <div class="copy-side ${direction}">
        <div class="copy-side-head"><span>${label} · 0 笔</span></div>
        <div class="copy-empty">该企业没有${label}记录</div>
      </div>
    `;
  }

  const text = sideRows.map(copyLineFor).join('\n');
  const rows = Math.min(8, Math.max(2, sideRows.length));

  return `
    <div class="copy-side ${direction}">
      <div class="copy-side-head">
        <span>${label} · ${sideRows.length} 笔 · ${fmtMoney(totalCents)}</span>
        <button type="button" class="copy-btn" data-copy-target="${targetId}">复制</button>
      </div>
      <textarea class="copy-area" id="${targetId}" rows="${rows}" readonly spellcheck="false" aria-label="${label}复制区，可直接粘贴到 Excel">${escapeHtml(text)}</textarea>
    </div>
  `;
}

function copyZoneMarkup(group, orderedRows) {
  const recvRows = orderedRows.filter((row) => row.dir === 'recv');
  const payRows = orderedRows.filter((row) => row.dir === 'pay');

  return `
    <div class="copy-zone">
      <div class="copy-zone-head">
        <b>复制到 Excel</b>
        <span>点“复制”或框内 Ctrl+A 全选后 Ctrl+C，粘贴到 Excel 会自动分成 5 列：企业名称 / 金额（元）/ 摘要 / 数据源 / 原表行</span>
      </div>
      <div class="copy-grid">
        ${copySideMarkup(group, 'recv', recvRows)}
        ${copySideMarkup(group, 'pay', payRows)}
      </div>
    </div>
  `;
}

async function writeClipboard(text) {
  if (!navigator.clipboard || !navigator.clipboard.writeText) return false;
  const written = navigator.clipboard.writeText(text).then(() => true).catch(() => false);
  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 1200));
  const result = await Promise.race([written, timeout]);
  return result === true;
}

async function copyPlainText(text) {
  if (!text) return false;
  try {
    if (await writeClipboard(text)) return true;
  } catch (error) {
    // 非安全上下文（file://）没有剪贴板接口，下面退回选中复制。
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.left = '-9999px';
  area.style.top = '0';
  document.body.appendChild(area);
  let copied = false;
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    copied = document.execCommand('copy');
  } catch (error) {
    copied = false;
  }
  document.body.removeChild(area);
  return copied;
}

async function copyTextArea(button) {
  const area = document.getElementById(button.dataset.copyTarget);
  if (!area) return;

  const text = area.value;
  let copied = false;

  try {
    copied = await writeClipboard(text);
  } catch (error) {
    copied = false;
  }

  if (!copied) {
    const wasReadOnly = area.hasAttribute('readonly');
    try {
      if (wasReadOnly) area.removeAttribute('readonly');
      area.focus();
      area.select();
      area.setSelectionRange(0, text.length);
      copied = document.execCommand('copy');
    } catch (error) {
      copied = false;
    } finally {
      if (wasReadOnly) area.setAttribute('readonly', '');
    }
  }

  button.textContent = copied ? '已复制' : '复制失败';
  button.classList.toggle('is-copied', copied);
  clearTimeout(button.copyTimer);
  button.copyTimer = setTimeout(() => {
    button.textContent = '复制';
    button.classList.remove('is-copied');
  }, 1600);

  if (copied) {
    showToast('已复制，可直接粘贴到 Excel');
  } else {
    showToast('浏览器拦住了复制，请在框内 Ctrl+A 全选后按 Ctrl+C', true);
  }
}

function flagMarkup(flag) {
  const definition = FLAG_DEFS[flag];
  if (!definition) return '';
  return `<span class="flag flag-${definition.tone}" title="${escapeHtml(definition.title)}">${escapeHtml(definition.label)}</span>`;
}

// 导出范围里要把「分档筛选」也写清楚，否则纸面上看不出这份是从筛过的结果里出的。
// ===== 导出、文件校验与打印 =====

function facetReasonList() {
  const parts = [];
  if (state.facetNet !== 'all') {
    const item = NET_FACETS.find((facet) => facet.id === state.facetNet);
    if (item) parts.push(`净额${item.label}`);
  }
  if (state.facetDir !== 'all') {
    const item = DIR_FACETS.find((facet) => facet.id === state.facetDir);
    if (item) parts.push(item.label);
  }
  if (state.facetSource !== 'all') parts.push(`只看「${state.facetSource}」这张表`);
  return parts;
}

function facetScopeText() {
  const parts = facetReasonList();
  return parts.length ? `，${parts.join('，')}` : '';
}

// 打印件和屏幕不一样：上面那排筛选、搜索框、这三档在纸上都是藏起来的。
// 少了企业又不说，纸上看着就像一份完整底稿，所以必须在时间戳里写明这次只打了筛出来的那几家。
function printScopeNote() {
  const total = state.groups.length;
  const shown = getVisibleGroups().length;
  if (!total || shown >= total) return '';
  const reasons = [];
  if (state.filter && state.filter !== 'all') {
    const definition = CHIP_DEFS.find((item) => item.id === state.filter) || CHIP_DEFS[0];
    reasons.push(`标记筛选「${definition.label}」`);
  }
  if (state.search) reasons.push(`搜索「${state.search}」`);
  reasons.push(...facetReasonList());
  return ` · 本页只列筛出来的 ${shown} 家（这台电脑上一共 ${total} 家，${reasons.join('，') || '已筛选'}）；`
    + '要全部打出来，就清掉搜索框、把标记筛选调回「全部」、点上面「清空这三档」。';
}

function resolveExportScope() {
  const onlyFiltered = els.exportFiltered.checked;
  const groups = onlyFiltered ? getVisibleGroups() : state.groups.slice();
  const filterLabel = (CHIP_DEFS.find((item) => item.id === state.filter) || CHIP_DEFS[0]).label;
  const scopeLabel = onlyFiltered
    ? `当前筛选（${filterLabel}${state.search ? `，搜索“${state.search}”` : ''}${facetScopeText()}，${groups.length} 家）`
    : `全部结果（${groups.length} 家）`;
  return { groups, onlyFiltered, scopeLabel };
}

function exportResults() {
  if (!state.groups.length) {
    showToast('还没有可导出的对账结果', true);
    return;
  }

  const scope = resolveExportScope();
  if (!scope.groups.length) {
    showToast('当前筛选下没有可导出的企业', true);
    return;
  }

  const groups = scope.onlyFiltered ? scope.groups : sortGroups(scope.groups, state.sort);

  try {
    const workbook = buildExportWorkbook(groups, scope.scopeLabel);
    const fileName = buildExportFileName();
    XLSX.writeFile(workbook, fileName);
    const receipt = recordExportReceipt('standard', fileName, workbook);
    showToast(receipt ? `已导出：${fileName}（校验码 ${receipt.sha256.slice(0, 12)}…）` : `已导出：${fileName}`);
  } catch (error) {
    console.error(error);
    showToast('导出失败，请重试或换用 Edge / Chrome 打开本页', true);
  }
}

function exportGroupSheets() {
  if (!state.groups.length) {
    showToast('还没有可导出的对账结果', true);
    return;
  }

  const scope = resolveExportScope();
  if (!scope.groups.length) {
    showToast('当前筛选下没有可导出的企业', true);
    return;
  }

  const groups = scope.groups.slice().sort((a, b) => (
    Math.abs(b.netCents) - Math.abs(a.netCents) || a.displayName.localeCompare(b.displayName, 'zh-CN')
  ));

  try {
    const workbook = buildGroupSheetsWorkbook(groups, scope.scopeLabel);
    const fileName = buildGroupSheetsFileName();
    XLSX.writeFile(workbook, fileName);
    const receipt = recordExportReceipt('blocks', fileName, workbook);
    showToast(receipt
      ? `已导出分企业明细：${fileName}（${groups.length} 家，校验码 ${receipt.sha256.slice(0, 12)}…）`
      : `已导出分企业明细：${fileName}（${groups.length} 家）`);
  } catch (error) {
    console.error(error);
    showToast('导出失败，请重试或换用 Edge / Chrome 打开本页', true);
  }
}

function exportReceiptKindLabel(kind) {
  if (kind === 'blocks') return '分企业导出';
  if (kind === 'snapshot') return '底稿比对导出';
  return '标准导出';
}

function normalizeExportCode(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^sha-?256\s*[:：]\s*/, '')
    .replace(/\s+/g, '');
}

function hashWorkbookBytes(workbook) {
  if (typeof XLSX === 'undefined' || !workbook) return null;
  const raw = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  const bytes = ArrayBuffer.isView(raw)
    ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
    : new Uint8Array(raw);
  return { bytes, sha256: sha256BytesHex(bytes) };
}

function recordExportReceipt(kind, fileName, workbook) {
  let hashed = null;
  try {
    hashed = hashWorkbookBytes(workbook);
  } catch (error) {
    console.error(error);
  }
  if (!hashed) return null;
  lastExportReceipt = {
    kind,
    kindLabel: exportReceiptKindLabel(kind),
    fileName,
    sizeBytes: hashed.bytes.byteLength,
    sha256: hashed.sha256,
    bytes: hashed.bytes,
    fingerprint: state.groups.length ? buildResultFingerprint(state.groups) : '',
    companies: state.groups.length,
    records: state.records.length,
    at: Date.now()
  };
  renderExportReceipt();
  return lastExportReceipt;
}

function renderExportReceipt() {
  if (!els.exportReceiptBody) return;
  if (!lastExportReceipt) {
    els.exportReceiptBody.innerHTML = '<p class="er-empty">还没有导出过文件。点上面的「导出 Excel」后，这里会出现那个文件的校验码。</p>';
    return;
  }

  const receipt = lastExportReceipt;
  const currentFingerprint = state.groups.length ? buildResultFingerprint(state.groups) : '';
  const stale = currentFingerprint && receipt.fingerprint && currentFingerprint !== receipt.fingerprint;
  const fingerprintLine = receipt.fingerprint
    ? `<div class="er-line">
        <span class="er-label">结果指纹</span>
        <code class="er-code" title="${receipt.fingerprint}">${receipt.fingerprint.slice(0, 16)}…</code>
        <span class="er-meta">导出时屏幕上的对账结果，文件里也写了这一串</span>
      </div>`
    : '';

  els.exportReceiptBody.innerHTML = `
    <div class="er-receipt">
      <div class="er-line">
        <span class="er-label">上次导出</span>
        <b class="er-file">${escapeHtml(receipt.fileName)}</b>
        <span class="er-meta">${escapeHtml(receipt.kindLabel)} · ${formatBytes(receipt.sizeBytes)} · ${escapeHtml(formatDateTime(new Date(receipt.at)))}</span>
      </div>
      <div class="er-line">
        <span class="er-label">文件校验码</span>
        <code class="er-code" title="${receipt.sha256}">${receipt.sha256.slice(0, 24)}…</code>
        <button type="button" class="fp-copy" data-er-copy="${receipt.sha256}" data-er-label="复制完整校验码">复制完整校验码</button>
      </div>
      ${fingerprintLine}
      ${stale ? '<p class="er-stale">导出之后结果又改过：这串校验码对应的是当时导出的那份文件，不是现在屏幕上的结果。</p>' : ''}
      <p class="er-tip">把校验码跟文件一起归档。文件被另存、编辑或重新导出，校验码就会变；它只证明文件本身没被改，内容对不对要看结果指纹。</p>
      <div class="er-archive">
        <button type="button" class="btn btn-secondary" data-er-archive>把文件和校验码打成一个归档包</button>
        <span class="er-meta">解压后是同一个 xlsx 加一份「校验码.txt」，一起存档不会把两者弄散</span>
      </div>
    </div>
  `;
}

function renderExportVerifyResult(result) {
  if (!els.exportVerifyOut) return;

  let tone = 'info';
  let headline = '这个文件的校验码：';
  let detail = '<p class="er-tip">页面关掉后不会记住上次的校验码，请拿这串和底稿上记的逐位对照。</p>';

  if (result.status === 'match') {
    tone = 'ok';
    headline = '一致：这个文件就是当时导出的那一份。';
    detail = `<div class="er-line"><span class="er-label">对照的校验码</span><span class="er-meta">${escapeHtml(result.expectedSource)}</span></div>`;
  } else if (result.status === 'mismatch') {
    tone = 'bad';
    headline = '对不上：这个文件和记下的那份不是同一份。';
    detail = `
      <div class="er-line"><span class="er-label">记下的校验码</span><code class="er-code">${escapeHtml(result.expected)}</code><span class="er-meta">${escapeHtml(result.expectedSource)}</span></div>
      <p class="er-tip">文件被另存、编辑过，或者其实是另一次导出的文件，都会对不上。请换回原始文件；如果内容确实改过，请按改后的文件重新留档。</p>
    `;
  }

  els.exportVerifyOut.className = `export-verify-out ${tone}`;
  els.exportVerifyOut.innerHTML = `
    <b class="er-verify-head">${headline}</b>
    <div class="er-line">
      <span class="er-label">文件</span>
      <b class="er-file">${escapeHtml(result.fileName)}</b>
      <span class="er-meta">${formatBytes(result.sizeBytes)}</span>
    </div>
    <div class="er-line">
      <span class="er-label">文件校验码</span>
      <code class="er-code" title="${result.sha256}">${result.sha256}</code>
      <button type="button" class="fp-copy" data-er-copy="${result.sha256}" data-er-label="复制">复制</button>
    </div>
    ${detail}
  `;
}

async function verifyExportFile(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;

  if (!/\.xlsx$/i.test(file.name)) {
    showToast('请选工具导出的 .xlsx 文件；CSV 和旧版 .xls 没有可对照的校验码', true);
    return;
  }
  if (file.size > EXPORT_VERIFY_MAX_BYTES) {
    showToast('这个文件太大了，正常的导出文件只有几十到几百 KB，请确认没选错', true);
    return;
  }

  const expected = normalizeExportCode(els.exportExpectInput ? els.exportExpectInput.value : '');
  if (expected && !/^[0-9a-f]{64}$/.test(expected)) {
    showToast('校验码是 64 位数字和小写字母，请检查是不是复制少了', true);
    return;
  }

  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    showToast('这个文件读不出来，请换一份再试', true);
    return;
  }

  const sha256 = sha256BytesHex(bytes);
  const result = { fileName: file.name, sizeBytes: bytes.byteLength, sha256 };

  if (expected) {
    result.status = expected === sha256 ? 'match' : 'mismatch';
    result.expected = expected;
    result.expectedSource = '底稿上记下的校验码';
  } else if (lastExportReceipt) {
    result.status = lastExportReceipt.sha256 === sha256 ? 'match' : 'mismatch';
    result.expected = lastExportReceipt.sha256;
    result.expectedSource = `本次会话导出的「${lastExportReceipt.fileName}」`;
  } else {
    result.status = 'info';
  }

  renderExportVerifyResult(result);
  showToast(
    result.status === 'match' ? '校验码一致' : result.status === 'mismatch' ? '校验码对不上' : '这个文件的校验码已算出',
    result.status === 'mismatch'
  );
}

function buildGroupSheetsWorkbook(groups, scopeLabel) {
  const workbook = XLSX.utils.book_new();
  const usedNames = new Set(['目录']);
  const hasDims = groups.some((group) => group.entityKey || group.currencyKey);
  const sheetNames = groups.map((group) => safeSheetName(
    hasDims ? [group.displayName, group.entityLabel, group.currencyLabel].filter(Boolean).join('·') : group.displayName,
    usedNames
  ));
  const netLabel = (cents) => (cents > 0 ? '净应收' : cents < 0 ? '净应付' : '已平');
  const totalRecords = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const totalRecv = groups.reduce((sum, group) => sum + group.recvCents, 0);
  const totalPay = groups.reduce((sum, group) => sum + group.payCents, 0);
  const fingerprint = buildResultFingerprint(state.groups.length ? state.groups : groups);
  const hasEntityData = groups.some((group) => group.entityKey);
  const hasCurrencyData = groups.some((group) => group.currencyKey);
  const dimHeaders = [...(hasEntityData ? ['主体'] : []), ...(hasCurrencyData ? ['币种'] : [])];
  const dimValues = (group) => [...(hasEntityData ? [group.entityLabel || ''] : []), ...(hasCurrencyData ? [group.currencyLabel || ''] : [])];
  const moneyUnit = hasCurrencyData ? '原币' : '元';
  const coverCurrencyKeys = new Set(groups.map((group) => group.currencyKey).filter(Boolean));
  const coverMixedCurrency = coverCurrencyKeys.size > 1;
  const coverTail = hasEntityData || hasCurrencyData
    ? '；不同币种分开列示、不做汇率换算'
    : '';

  const coverRows = [
    ['分企业往来明细'],
    ['导出时间', formatDateTime(new Date())],
    ['导出范围', scopeLabel],
    ['企业数', groups.length],
    ['记录笔数', totalRecords],
    ['结果指纹', fingerprint],
    ['说明', `每个企业单独一张工作表，按净额影响从大到小排列；金额单位：${moneyUnit}${coverTail}。净额只是对账口径，不代表会计上可以抵销；表里的自动核销也只是提示，不改变任何金额。`],
    [],
    ['序号', '企业名称', `应收合计（${moneyUnit}）`, `应付合计（${moneyUnit}）`, `净额（${moneyUnit}）`, '净方向', '记录笔数', '工作表', ...dimHeaders]
  ];

  groups.forEach((group, index) => {
    coverRows.push([
      index + 1,
      group.displayName,
      group.recvCents / 100,
      group.payCents / 100,
      Math.abs(group.netCents) / 100,
      netLabel(group.netCents),
      group.rows.length,
      sheetNames[index],
      ...dimValues(group)
    ]);
  });

  coverRows.push([
    '合计', '',
    coverMixedCurrency ? '—' : totalRecv / 100,
    coverMixedCurrency ? '—' : totalPay / 100,
    '—', '', totalRecords, '',
    ...dimHeaders.map(() => '')
  ]);

  const coverSheet = XLSX.utils.aoa_to_sheet(coverRows);
  coverSheet['!cols'] = [
    { wch: 6 }, { wch: 36 }, { wch: 17 }, { wch: 17 },
    { wch: 17 }, { wch: 10 }, { wch: 10 }, { wch: 30 },
    ...dimHeaders.map(() => ({ wch: 18 }))
  ];
  coverSheet['!autofilter'] = {
    ref: `A9:${XLSX.utils.encode_col(7 + dimHeaders.length)}${8 + groups.length}`
  };
  applyMoneyFormat(coverSheet, [2, 3, 4]);
  XLSX.utils.book_append_sheet(workbook, coverSheet, '目录');

  groups.forEach((group, index) => {
    XLSX.utils.book_append_sheet(workbook, buildGroupSheet(group, netLabel), sheetNames[index]);
  });

  workbook.Props = {
    Title: '分企业往来明细',
    Subject: scopeLabel,
    Author: '双边对账核销工具',
    CreatedDate: new Date()
  };

  return workbook;
}

function buildGroupSheet(group, netLabel) {
  const rows = [];
  const moneyCells = [];
  const note = state.groupNotes.get(group.key) || '';
  const showAge = group.rows.some((row) => row.hasAgeColumn);
  const sourceOrder = new Map(group.sources.map((source, index) => [source.id, index]));
  const ordered = group.rows.slice().sort((a, b) => {
    const orderA = sourceOrder.get(a.sourceId) ?? 0;
    const orderB = sourceOrder.get(b.sourceId) ?? 0;
    return orderA - orderB || a.rowNo - b.rowNo;
  });
  const flags = group.flags.length ? group.flags.map((flag) => FLAG_DEFS[flag].label).join('、') : '—';
  const unitLabel = group.currencyLabel || '元';

  const moneyRow = (label, cents, extra) => {
    rows.push(extra === undefined ? [label, cents / 100] : [label, cents / 100, extra]);
    moneyCells.push(`B${rows.length}`);
  };

  rows.push(['企业名称', group.displayName]);
  if (group.entityLabel) rows.push(['主体', group.entityLabel]);
  if (group.currencyLabel) rows.push(['币种', group.currencyLabel]);
  rows.push(['数据源', group.sources.map((source) => source.shortLabel).join('、')]);
  moneyRow(`应收合计（${unitLabel}）`, group.recvCents);
  moneyRow(`应付合计（${unitLabel}）`, group.payCents);
  moneyRow(`净额（${unitLabel}）`, Math.abs(group.netCents), netLabel(group.netCents));
  rows.push(['记录笔数', group.rows.length]);
  rows.push(['标记', flags]);
  rows.push(['差异说明', note || '—']);

  const header = [
    '原表行号', '数据源', '原始企业名称', `金额（${unitLabel}）`,
    ...(showAge ? ['账龄'] : []),
    '摘要 / 备注', '记录标记', '名称来源'
  ];

  [['recv', '应收明细'], ['pay', '应付明细']].forEach(([dir, title]) => {
    const list = ordered.filter((row) => row.dir === dir);
    rows.push([]);
    rows.push([`${title}（${list.length} 笔）`]);
    if (!list.length) {
      rows.push([`该企业没有${dir === 'recv' ? '应收' : '应付'}记录`]);
      return;
    }
    rows.push(header);
    list.forEach((row) => {
      rows.push([
        row.rowNo,
        row.sourceKind === 'manual' ? row.sourceLabel : (row.sourceLabel || row.sourceShortLabel),
        row.companyRaw,
        row.cents / 100,
        ...(showAge ? [row.hasAgeColumn ? (row.ageShown >= 0 ? AGE_BANDS[row.ageShown] : '原表没写') : '这张表没有账龄列'] : []),
        row.memo || '',
        row.flags.length || row.redFlipped
          ? [...(row.redFlipped ? ['红字转负'] : []), ...row.flags.map((flag) => FLAG_DEFS[flag].label)].join('、')
          : '—',
        row.inherited
          ? (row.sourceKind === 'manual' ? '承上（名称留空）' : '承上（合并单元格）')
          : '原表填写'
      ]);
    });
    rows.push(['小计', '', '', (dir === 'recv' ? group.recvCents : group.payCents) / 100]);
  });

  rows.push([]);
  moneyRow(group.currencyLabel ? `净额（应收合计 − 应付合计，${unitLabel}）` : '净额（应收合计 − 应付合计）', Math.abs(group.netCents), netLabel(group.netCents));
  rows.push(['口径', '净额只是对账口径，不代表这两笔可以抵销；明细里的自动核销也只是提示，不改变任何金额。']);

  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = showAge
    ? [{ wch: 22 }, { wch: 30 }, { wch: 36 }, { wch: 17 }, { wch: 12 }, { wch: 40 }, { wch: 28 }, { wch: 20 }]
    : [{ wch: 22 }, { wch: 30 }, { wch: 36 }, { wch: 17 }, { wch: 40 }, { wch: 28 }, { wch: 20 }];
  moneyCells.forEach((address) => {
    const cell = sheet[address];
    if (cell && cell.t === 'n') cell.z = '#,##0.00';
  });
  applyMoneyFormat(sheet, [3]);

  return sheet;
}

function safeSheetName(name, used) {
  let base = String(name || '')
    .replace(/[\[\]:*?\/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^'+|'+$/g, '');
  if (!base) base = '企业';
  if (base.length > 28) base = base.slice(0, 28).trim();
  let candidate = base;
  let index = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = `(${index})`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    index += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function printReport() {
  if (!state.groups.length) {
    showToast('先跑完对账，再打印或存成 PDF', true);
    return;
  }
  if (state.printing) return;

  const snapshot = {
    expanded: new Set(state.expanded),
    dataCheckOpen: state.dataCheckOpen,
    filter: state.filter,
    search: state.search,
    sort: state.sort,
    facetNet: state.facetNet,
    facetDir: state.facetDir,
    facetSource: state.facetSource,
    title: document.title
  };

  const restore = () => {
    if (!state.printing) return;
    state.printing = false;
    clearTimeout(printRestoreTimer);
    state.expanded = snapshot.expanded;
    state.dataCheckOpen = snapshot.dataCheckOpen;
    state.filter = snapshot.filter;
    state.search = snapshot.search;
    state.sort = snapshot.sort;
    state.facetNet = snapshot.facetNet;
    state.facetDir = snapshot.facetDir;
    state.facetSource = snapshot.facetSource;
    if (els.searchInput) els.searchInput.value = snapshot.search;
    if (els.sortSelect) els.sortSelect.value = snapshot.sort;
    renderChips();
    updateChipStates();
    renderFacets();
    renderDataCheck();
    renderTable();
    if (els.printStamp) els.printStamp.textContent = '';
    document.title = snapshot.title;
  };

  state.printing = true;
  state.expanded = new Set(state.groups.map((group) => group.idx));
  state.dataCheckOpen = true;
  document.title = `双边对账底稿${state.signoff.index ? ` ${state.signoff.index}` : ''} ${formatFileStamp(new Date())}`;
  renderDataCheck();
  renderTable();
  if (els.printStamp) {
    const ageStamp = state.stats && state.stats.ageGroups ? ` · 账龄算到 ${ageBaseDateValue()}` : '';
    const fingerprint = buildResultFingerprint(state.groups);
    els.printStamp.textContent = `打印时间 ${formatDateTime(new Date())} · 工具版本 ${els.appVersion && els.appVersion.textContent ? els.appVersion.textContent : APP_VERSION_FALLBACK}${ageStamp} · 结果指纹 ${fingerprint.slice(0, 16)}${printScopeNote()}`;
  }

  printRestoreTimer = setTimeout(restore, 8000);
  window.addEventListener('afterprint', restore, { once: true });
  try {
    window.print();
  } catch (error) {
    restore();
    console.error(error);
    showToast('这台电脑的浏览器打不开打印页，可以用 Ctrl+P', true);
  }
}

function exportRowNumbers(group) {
  return formatRowNumbers(group.rows);
}

function formatRowNumbers(records) {
  const bySource = new Map();

  records.forEach((record) => {
    const label = record.sourceShortLabel || record.sourceLabel || '数据源';
    if (!bySource.has(label)) bySource.set(label, []);
    bySource.get(label).push(record.rowNo);
  });

  if (bySource.size === 1) {
    return Array.from(bySource.values())[0].sort((a, b) => a - b).join('、');
  }

  return Array.from(bySource.entries())
    .map(([label, rows]) => `${label}：${Array.from(new Set(rows)).sort((a, b) => a - b).join('、')}`)
    .join('；');
}

// ===== 标准导出：工作簿入口与各工作表 =====

function buildExportWorkbook(groups, scopeLabel) {
  const workbook = XLSX.utils.book_new();
  const columns = exportColumnsFor(groups);
  appendExportSummarySheet(workbook, groups, columns);
  appendExportDetailSheet(workbook, groups, columns);
  const counts = {
    pair: appendExportPairingSheet(workbook, groups, columns),
    doc: appendExportDocHintsSheet(workbook, groups, columns),
    memo: appendExportMemoHintsSheet(workbook, groups, columns),
    near: appendExportNearMissSheet(workbook, groups, columns)
  };
  appendExportAgeSheet(workbook, groups, columns);
  appendExportInfoSheet(workbook, groups, scopeLabel, columns, counts);

  workbook.Props = {
    Title: '双边对账核销结果',
    Subject: scopeLabel,
    Author: '双边对账核销工具',
    CreatedDate: new Date()
  };

  return workbook;
}


function exportColumnsFor(groups) {
  const hasEntityData = groups.some((group) => group.entityKey);
  const hasCurrencyData = groups.some((group) => group.currencyKey);
  const dimHeaders = [...(hasEntityData ? ['主体'] : []), ...(hasCurrencyData ? ['币种'] : [])];
  const dimValues = (group) => [
    ...(hasEntityData ? [group.entityLabel || ''] : []),
    ...(hasCurrencyData ? [group.currencyLabel || ''] : [])
  ];
  const moneyUnit = hasCurrencyData ? '原币' : '元';
  const hasAgeData = groups.some((group) => group.hasAge);
  return { hasEntityData, hasCurrencyData, dimHeaders, dimValues, moneyUnit, hasAgeData };
}

function appendExportSummarySheet(workbook, groups, columns) {
  const { dimHeaders, dimValues, moneyUnit } = columns;
  const summaryRows = [
    ['企业名称', ...dimHeaders, '数据源', '记录笔数', `应收合计（${moneyUnit}）`, `应付合计（${moneyUnit}）`, `净额（${moneyUnit}）`, '净方向', '标记', '原始名称写法', '原表行号', '差异说明']
  ];

  groups.forEach((group) => {
    summaryRows.push([
      group.displayName,
      ...dimValues(group),
      group.sources.map((source) => source.shortLabel).join('、'),
      group.rows.length,
      group.recvCents / 100,
      group.payCents / 100,
      Math.abs(group.netCents) / 100,
      group.netCents > 0 ? '净应收' : group.netCents < 0 ? '净应付' : '已平',
      group.flags.length ? group.flags.map((flag) => FLAG_DEFS[flag].label).join('、') : '—',
      group.variantList.map(([name]) => name).join('；'),
      exportRowNumbers(group),
      state.groupNotes.get(group.key) || ''
    ]);
  });

  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  summarySheet['!cols'] = [
    { wch: 36 },
    ...dimHeaders.map(() => ({ wch: 18 })),
    { wch: 24 }, { wch: 10 }, { wch: 17 }, { wch: 17 },
    { wch: 17 }, { wch: 10 }, { wch: 34 }, { wch: 40 }, { wch: 32 }, { wch: 44 }
  ];
  if (summaryRows.length > 1) {
    summarySheet['!autofilter'] = {
      ref: `A1:${XLSX.utils.encode_col(summaryRows[0].length - 1)}${summaryRows.length}`
    };
  }
  const summaryMoneyStart = 3 + dimHeaders.length;
  applyMoneyFormat(summarySheet, [summaryMoneyStart, summaryMoneyStart + 1, summaryMoneyStart + 2]);
  XLSX.utils.book_append_sheet(workbook, summarySheet, '对账汇总');
}

function appendExportDetailSheet(workbook, groups, columns) {
  const { dimHeaders, dimValues, moneyUnit, hasAgeData } = columns;
  const detailRows = [
    [
      '企业名称', ...dimHeaders, '数据源', '原始企业名称', '原表行号', '方向', `金额（${moneyUnit}）`, '原表金额',
      ...(hasAgeData ? ['账龄'] : []), '摘要 / 备注', '记录标记', '名称来源'
    ]
  ];

  groups.forEach((group) => {
    const sourceOrder = new Map(group.sources.map((source, index) => [source.id, index]));
    group.rows.slice()
      .sort((a, b) => {
        const orderA = sourceOrder.get(a.sourceId) ?? 0;
        const orderB = sourceOrder.get(b.sourceId) ?? 0;
        return orderA - orderB || a.rowNo - b.rowNo;
      })
      .forEach((row) => {
        detailRows.push([
          group.displayName,
          ...dimValues(group),
          row.sourceKind === 'manual' ? row.sourceLabel : (row.sourceLabel || row.sourceShortLabel),
          row.companyRaw,
          row.rowNo,
          dirLabel(row.dir),
          row.cents / 100,
          row.rawAmount || '',
          ...(hasAgeData ? [row.hasAgeColumn ? (row.ageShown >= 0 ? AGE_BANDS[row.ageShown] : '原表没写') : '这张表没有账龄列'] : []),
          row.memo || '',
          row.flags.length || row.redFlipped
            ? [...(row.redFlipped ? ['红字转负'] : []), ...row.flags.map((flag) => FLAG_DEFS[flag].label)].join('、')
            : '—',
          row.inherited
            ? (row.sourceKind === 'manual' ? '承上（名称留空）' : '承上（合并单元格）')
            : '原表填写'
        ]);
      });
  });

  const detailSheet = XLSX.utils.aoa_to_sheet(detailRows);
  detailSheet['!cols'] = [
    { wch: 36 },
    ...dimHeaders.map(() => ({ wch: 18 })),
    { wch: 30 }, { wch: 30 }, { wch: 10 }, { wch: 10 },
    { wch: 17 }, { wch: 16 },
    ...(hasAgeData ? [{ wch: 12 }] : []),
    { wch: 36 }, { wch: 28 }, { wch: 20 }
  ];
  if (detailRows.length > 1) {
    detailSheet['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(detailRows[0].length - 1)}${detailRows.length}` };
  }
  applyMoneyFormat(detailSheet, [5 + dimHeaders.length]);
  XLSX.utils.book_append_sheet(workbook, detailSheet, '原始明细');
}

function appendExportPairingSheet(workbook, groups, columns) {
  const { dimHeaders, dimValues, moneyUnit } = columns;
  const pairRows = [
    ['企业名称', ...dimHeaders, '配对方式', `应收笔数`, `应收金额（${moneyUnit}）`, '应付笔数', `应付金额（${moneyUnit}）`, `差额（${moneyUnit}）`, '应收原表行号', '应付原表行号', '数据源', '采用情况', '日期情况']
  ];

  groups.forEach((group) => {
    (group.pairings || []).forEach((pairing) => {
      const both = pairing.recvRows.concat(pairing.payRows);
      pairRows.push([
        group.displayName,
        ...dimValues(group),
        pairKindLabel(pairing),
        pairing.recvRows.length,
        pairing.recvCents / 100,
        pairing.payRows.length,
        pairing.payCents / 100,
        pairing.diffCents / 100,
        formatRowNumbers(pairing.recvRows),
        formatRowNumbers(pairing.payRows),
        Array.from(new Set(both.map((row) => row.sourceShortLabel || row.sourceLabel || '数据源'))).join('、'),
        pairDecisionLabel(pairing.decision),
        pairDateText(pairing) || '没有可对照的日期'
      ]);
    });
  });

  const pairSheet = XLSX.utils.aoa_to_sheet(pairRows);
  pairSheet['!cols'] = [
    { wch: 36 },
    ...dimHeaders.map(() => ({ wch: 18 })),
    { wch: 12 }, { wch: 10 }, { wch: 17 }, { wch: 10 },
    { wch: 17 }, { wch: 12 }, { wch: 30 }, { wch: 30 }, { wch: 28 }, { wch: 10 }, { wch: 46 }
  ];
  if (pairRows.length > 1) {
    pairSheet['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(pairRows[0].length - 1)}${pairRows.length}` };
  }
  applyMoneyFormat(pairSheet, [3 + dimHeaders.length, 5 + dimHeaders.length, 6 + dimHeaders.length]);
  XLSX.utils.book_append_sheet(workbook, pairSheet, '核销配对');
  return pairRows.length - 1;
}

function appendExportDocHintsSheet(workbook, groups, columns) {
  const { dimHeaders, dimValues, moneyUnit } = columns;
  const docRows = [];
  groups.forEach((group) => {
    (group.docHints || []).forEach((item) => {
      const both = item.recvRows.concat(item.payRows);
      docRows.push([
        group.displayName,
        ...dimValues(group),
        item.docNo,
        item.recvRows.length,
        item.recvCents / 100,
        item.payRows.length,
        item.payCents / 100,
        item.diffCents / 100,
        formatRowNumbers(item.recvRows),
        formatRowNumbers(item.payRows),
        Array.from(new Set(both.map((row) => row.sourceShortLabel || row.sourceLabel || '数据源'))).join('、')
      ]);
    });
  });

  if (docRows.length) {
    const docSheet = XLSX.utils.aoa_to_sheet([
      ['企业名称', ...dimHeaders, '单据号', '应收笔数', `应收金额（${moneyUnit}）`, '应付笔数', `应付金额（${moneyUnit}）`, `差额（${moneyUnit}）`, '应收原表行号', '应付原表行号', '数据源'],
      ...docRows
    ]);
    docSheet['!cols'] = [
      { wch: 36 },
      ...dimHeaders.map(() => ({ wch: 18 })),
      { wch: 20 }, { wch: 10 }, { wch: 17 }, { wch: 10 },
      { wch: 17 }, { wch: 12 }, { wch: 30 }, { wch: 30 }, { wch: 28 }
    ];
    docSheet['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(docRows[0].length - 1)}${docRows.length + 1}` };
    applyMoneyFormat(docSheet, [3 + dimHeaders.length, 5 + dimHeaders.length, 6 + dimHeaders.length]);
    XLSX.utils.book_append_sheet(workbook, docSheet, '同单据号');
  }
  return docRows.length;
}

function appendExportMemoHintsSheet(workbook, groups, columns) {
  const { dimHeaders, dimValues, moneyUnit } = columns;
  const memoKeyRows = [];
  groups.forEach((group) => {
    (group.memoKeyHints || []).forEach((item) => {
      const both = item.recvRows.concat(item.payRows);
      memoKeyRows.push([
        group.displayName,
        ...dimValues(group),
        item.label,
        item.value,
        item.recvRows.length,
        item.recvCents / 100,
        item.payRows.length,
        item.payCents / 100,
        item.diffCents / 100,
        formatRowNumbers(item.recvRows),
        formatRowNumbers(item.payRows),
        Array.from(new Set(both.map((row) => row.sourceShortLabel || row.sourceLabel || '数据源'))).join('、')
      ]);
    });
  });

  if (memoKeyRows.length) {
    const memoSheet = XLSX.utils.aoa_to_sheet([
      ['企业名称', ...dimHeaders, '类型', '摘要里写的', '应收笔数', `应收金额（${moneyUnit}）`, '应付笔数', `应付金额（${moneyUnit}）`, `差额（${moneyUnit}）`, '应收原表行号', '应付原表行号', '数据源'],
      ...memoKeyRows
    ]);
    memoSheet['!cols'] = [
      { wch: 36 },
      ...dimHeaders.map(() => ({ wch: 18 })),
      { wch: 8 }, { wch: 20 }, { wch: 10 }, { wch: 17 }, { wch: 10 },
      { wch: 17 }, { wch: 12 }, { wch: 30 }, { wch: 30 }, { wch: 28 }
    ];
    memoSheet['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(memoKeyRows[0].length - 1)}${memoKeyRows.length + 1}` };
    applyMoneyFormat(memoSheet, [4 + dimHeaders.length, 6 + dimHeaders.length, 7 + dimHeaders.length]);
    XLSX.utils.book_append_sheet(workbook, memoSheet, '摘要线索');
  }
  return memoKeyRows.length;
}

function appendExportNearMissSheet(workbook, groups, columns) {
  const { dimHeaders, dimValues, moneyUnit } = columns;
  const nearMissRows = [];
  groups.forEach((group) => {
    (group.nearMiss || []).forEach((item) => {
      const both = [item.recvRow, item.payRow];
      nearMissRows.push([
        group.displayName,
        ...dimValues(group),
        formatRowNumbers([item.recvRow]),
        item.recvCents / 100,
        formatRowNumbers([item.payRow]),
        item.payCents / 100,
        item.diffCents / 100,
        Array.from(new Set(both.map((row) => row.sourceShortLabel || row.sourceLabel || '数据源'))).join('、')
      ]);
    });
  });

  if (nearMissRows.length) {
    const nearSheet = XLSX.utils.aoa_to_sheet([
      ['企业名称', ...dimHeaders, '应收原表行号', `应收金额（${moneyUnit}）`, '应付原表行号', `应付金额（${moneyUnit}）`, `差额（${moneyUnit}）`, '数据源'],
      ...nearMissRows
    ]);
    const nearOffset = 1 + dimHeaders.length;
    nearSheet['!cols'] = [
      { wch: 36 },
      ...dimHeaders.map(() => ({ wch: 18 })),
      { wch: 14 }, { wch: 17 }, { wch: 14 }, { wch: 17 }, { wch: 12 }, { wch: 28 }
    ];
    nearSheet['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(nearMissRows[0].length - 1)}${nearMissRows.length + 1}` };
    applyMoneyFormat(nearSheet, [nearOffset + 1, nearOffset + 3, nearOffset + 4]);
    XLSX.utils.book_append_sheet(workbook, nearSheet, '差一点');
  }
  return nearMissRows.length;
}

function appendExportAgeSheet(workbook, groups, columns) {
  const { dimHeaders, dimValues, moneyUnit, hasAgeData } = columns;
  const ageRows = [];
  if (hasAgeData) {
    groups.forEach((group) => {
      if (!group.hasAge) return;
      ['recv', 'pay'].forEach((dir) => {
        const bands = dir === 'recv' ? group.ageStats.recv : group.ageStats.pay;
        const unknown = dir === 'recv' ? group.ageStats.recvUnknown : group.ageStats.payUnknown;
        const total = bands.reduce((sum, cell) => sum + cell.cents, 0) + unknown.cents;
        if (!total) return;
        const counts = bands
          .map((cell, index) => (cell.count ? `${AGE_BANDS[index]} ${cell.count} 笔` : ''))
          .filter(Boolean);
        if (unknown.count) counts.push(`原表没写 ${unknown.count} 笔`);
        ageRows.push([
          group.displayName,
          ...dimValues(group),
          dirLabel(dir),
          ...bands.map((cell) => cell.cents / 100),
          unknown.cents / 100,
          total / 100,
          counts.join('；')
        ]);
      });
    });
  }

  if (ageRows.length) {
    const ageMoneyStart = 2 + dimHeaders.length;
    const ageMoneyCount = AGE_BANDS.length + 2;
    const totals = new Array(ageMoneyStart + ageMoneyCount).fill(0);
    ageRows.forEach((row) => {
      for (let i = ageMoneyStart; i < ageMoneyStart + ageMoneyCount; i += 1) {
        totals[i] += row[i] || 0;
      }
    });
    const ageSheet = XLSX.utils.aoa_to_sheet([
      ['企业名称', ...dimHeaders, '方向', ...AGE_BANDS.map((bandLabel) => `${bandLabel}（${moneyUnit}）`), `原表没写账龄（${moneyUnit}）`, `合计（${moneyUnit}）`, '各档笔数'],
      ...ageRows,
      [
        '合计',
        ...dimHeaders.map(() => ''),
        '',
        ...totals.slice(ageMoneyStart, ageMoneyStart + ageMoneyCount),
        ''
      ]
    ]);
    ageSheet['!cols'] = [
      { wch: 36 },
      ...dimHeaders.map(() => ({ wch: 18 })),
      { wch: 8 },
      ...AGE_BANDS.map(() => ({ wch: 15 })),
      { wch: 17 }, { wch: 15 }, { wch: 40 }
    ];
    const ageColumns = Array.from({ length: ageMoneyCount }, (_, index) => ageMoneyStart + index);
    if (ageRows.length > 1) {
      ageSheet['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(ageRows[0].length - 1)}${ageRows.length + 1}` };
    }
    applyMoneyFormat(ageSheet, ageColumns);
    XLSX.utils.book_append_sheet(workbook, ageSheet, '账龄分析');
  }
}

function appendExportInfoSheet(workbook, groups, scopeLabel, columns, counts) {
  const { hasEntityData, hasCurrencyData, hasAgeData } = columns;
  const unitLabels = { 1: '元', 1000: '千元', 10000: '万元' };
  const runInfo = state.runInfo || { mode: 'excel', sources: [] };
  const sourceCounts = new Map();

  state.records.forEach((record) => {
    sourceCounts.set(record.sourceId, (sourceCounts.get(record.sourceId) || 0) + 1);
  });

  const ageColumnNotes = state.sources
    .map((source) => ({ source, age: sourceAgeColumn(source) }))
    .filter((item) => item.age && (sourceCounts.get(item.source.id) || 0) > 0)
    .map((item) => `「${item.source.shortLabel}」用 ${XLSX.utils.encode_col(item.age.index)} 列${item.age.label}（${ageKindText(item.age)}）`);

  const exportedRecords = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const decisionTotals = { accepted: 0, rejected: 0, pending: 0 };
  let datedPairCount = 0;
  let farPairCount = 0;
  groups.forEach((group) => {
    (group.pairings || []).forEach((pairing) => {
      const key = pairing.decision === 'accepted' || pairing.decision === 'rejected'
        ? pairing.decision
        : 'pending';
      decisionTotals[key] += 1;
      if (Number.isFinite(pairing.dateGapDays)) {
        datedPairCount += 1;
        if (pairing.dateGapDays > PAIR_DATE_WARN_DAYS) farPairCount += 1;
      }
    });
  });
  const signoff = state.signoff || {};
  const fingerprint = buildResultFingerprint(state.groups.length ? state.groups : groups);
  const infoRows = [
    ['双边对账核销结果说明'],
    [],
    ['索引号', signoff.index || '未填'],
    ['编制人', signoff.preparedBy || '未填'],
    ['复核人', signoff.reviewedBy || '未填'],
    ['复核日期', signoff.date || '未填'],
    ['复核结论', signoff.conclusion || '未填'],
    [],
    ['导入方式', runInfo.mode === 'manual' ? '手动粘贴（左右两栏）' : 'Excel 导入'],
    ['导出时间', formatDateTime(new Date())],
    ['导出范围', scopeLabel],
    ['对账结果指纹', `${fingerprint}（同一批数据每次算出的指纹相同；改动金额、账龄基准日或配对采用情况会变，改差异说明和签字信息不会变）`],
    ['企业数', groups.length],
    ['有效记录数', exportedRecords],
    ['跳过行数', state.skipped.length],
    [runInfo.mode === 'manual' ? '名称留空续行' : '合并单元格续行', `${state.inheritedRows} 行`],
    ['方向补齐行数', `${state.directionFallbackRows} 行`],
    ['范围外行数', `${state.outOfRangeRows} 行（页脚说明、同表另一段或原表隐藏的行）`],
    ['红字金额', state.redRows.length
      ? `${state.redRows.length} 笔：金额是正数、单元格标红，已按负数处理并重分类到对立方向；若红字只是标注，请改回普通颜色后重新导入`
      : '没有发现红字金额'],
    ['自动核销组数', `${counts.pair} 组`],
    ['配对确认', `采纳 ${decisionTotals.accepted} 组、不采纳 ${decisionTotals.rejected} 组、待确认 ${decisionTotals.pending} 组（在页面上逐组标记）`],
    ['人工并归', state.mergeLog.length
      ? `${state.mergeLog.length} 组由人工确认为同一家：${state.mergeLog.map((item) => `${item.nameA}＝${item.nameB}`).join('；')}（名称写法仍保留在「原始名称写法」列）`
      : '没有人工并归企业'],
    []
  ];

  if (state.controls.length) {
    const controlTotal = combineControls(state.controls);
    state.controls.forEach((control) => {
      infoRows.push([
        '取数核对',
        `${control.sheetName}：原表金额${control.currencyMixed ? '（不同币种只做原数相加）' : ''} ${fmtControlAmount(control, control.rawCents)}（${control.rawCells} 格）= 纳入 ${fmtControlAmount(control, control.includedCents)} + 跳过 ${fmtControlAmount(control, control.skippedCents)} + 范围外 ${fmtControlAmount(control, control.outsideCents)} + 未归类 ${fmtControlAmount(control, control.unmatchedCents)}；差额 ${fmtControlAmount(control, control.diffCents)}${control.ok ? '' : '（有差额，请复核）'}`
      ]);
    });
    if (state.controls.length > 1) {
      infoRows.push([
        '取数核对合计',
        `原表金额${controlTotal.currencyMixed ? '（不同币种只做原数相加）' : ''} ${fmtControlAmount(controlTotal, controlTotal.rawCents)}（${controlTotal.rawCells} 格）= 纳入 ${fmtControlAmount(controlTotal, controlTotal.includedCents)} + 跳过 ${fmtControlAmount(controlTotal, controlTotal.skippedCents)} + 范围外 ${fmtControlAmount(controlTotal, controlTotal.outsideCents)} + 未归类 ${fmtControlAmount(controlTotal, controlTotal.unmatchedCents)}；差额 ${fmtControlAmount(controlTotal, controlTotal.diffCents)}`
      ]);
    }
    infoRows.push(['取数核对口径', '独立重算每张表金额列（表头以下每一格），必须满足：原表金额 = 纳入 + 跳过 + 范围外 + 未归类；未归类应为 0。手动粘贴按每行金额核对。']);
    infoRows.push([]);
  }

  if (signoff.note) {
    infoRows.push(['补充说明', signoff.note], []);
  }

  const emptySourceNames = emptyIncludedSourceNames();
  if (emptySourceNames.length) {
    infoRows.push([
      '没算进记录的表',
      `${emptySourceNames.length} 张勾选的表一笔都没算进去：${emptySourceNames.map((name) => `「${name}」`).join('、')}。可能是金额列选到了空白列，或取数范围只剩表头，请回到「核对数据源」，逐张复核标了「一笔都没算进去」的那几张。`
    ], []);
  }

  runInfo.sources.forEach((source) => {
    if (source.kind === 'manual') {
      infoRows.push([
        '数据源',
        `${source.label}；金额单位：${unitLabels[source.unit] || '元'}；${sourceCounts.get(source.id) || 0} 笔`
      ]);
    } else {
      infoRows.push([
        '数据源',
        `${source.fileName} · ${source.sheetName}；方向：${source.directionLabel || '按方向列'}；金额单位：${unitLabels[source.unit] || '元'}；${sourceCounts.get(source.id) || 0} 笔；算的行：${source.dataRange || '整张表'}`
      ]);
    }
  });

  if (runInfo.mode === 'manual') {
    infoRows.push(['手动粘贴识别', '每行按“企业名称 + 金额”识别，支持制表符、连续空格、逗号等分隔；首行表头和合计行自动跳过；企业名称留空时承上一行。']);
  }

  infoRows.push(
    [],
    ...(hasEntityData || hasCurrencyData ? [[
      '主体与币种',
      `${hasEntityData ? '按「主体」列分开' : ''}${hasEntityData && hasCurrencyData ? '，' : ''}${hasCurrencyData ? '按「币种」列分开' : ''}：同一家企业、同一主体、同一币种才算到一起，不同币种之间不相加、也不做汇率换算，汇总卡片在多种币种并存时显示「—」，具体金额看「按币种分开看」「按主体分开看」两块。`
    ]] : []),
    ...(state.dimensionWarnings.length ? [[
      '主体／币种没对齐',
      `${state.dimensionWarnings.length} 家企业的主体或币种有的记录写了、有的没写：${state.dimensionWarnings.slice(0, 20).map((item) => `「${item.name}」（${item.kinds.join('、')}）`).join('、')}${state.dimensionWarnings.length > 20 ? ` 等 ${state.dimensionWarnings.length} 家` : ''}。这样同一家企业会被拆成两组、两边对不上；请给每张表都选上同一列，或者都设成不用。`
    ]] : []),
    ...((runInfo.dimensionNotes || []).map((note) => [
      `本次没有按${DIMENSION_FIELD_LABELS[note.field] || '主体'}分开`,
      note.text
    ])),
    ['方向识别', '有方向列时逐行读取；没有方向列时，依次从工作表名、表头上方标题、文件名识别。工作表名含“应收/收款/回款/预收”视为应收，含“应付/付款/预付”视为应付，也可在数据源里手动指定整表方向。'],
    ['合并单元格', '企业名称留空时，自动沿用上方最近的一个企业名称，并在明细中标记“承上”；空行、合计行、重复表头会中断承接。'],
    ['算哪些行', `只算表头下面连着的那一块：遇到下一段的标题、重复表头、注／制表人／复核人之类签字行，或原表里被隐藏的行就停下。本次共 ${state.outOfRangeRows} 行按此规则没有算进来，各数据源的取数范围见上；需要全算就在页面上点“整张都用”后重新对账。`],
    ['计算口径', '净额 = 应收合计 − 应付合计；净方向按净额的正负判断。净额仅用于对账归并和函证准备，不代表会计上的抵销，也不作为财务报表列报依据；是否抵销以抵销权和列报要求为准。'],
    ['自动核销', `同一企业内先做金额相等（容差 ${moneyFormatter.format(state.pairToleranceCents / 100)} 元${state.pairPercent ? `，或差额不到较大一方 ${formatPercentInput(state.pairPercent)}%` : '以内'}）的一对一配对，同样金额有几笔时优先把日期更近的配在一起，再用「多笔对一笔」凑数（每侧最多 ${PAIR_MAX_SUBSET_SIZE} 笔，记录很多时只在金额最大的 ${PAIR_MAX_SUBSET_POOL} 笔内尝试）。「核销配对」表列出全部组合和每组的采用情况，配对只是提示，净额仍按企业合计大减小。`],
    ...(datedPairCount ? [[
      '日期线索',
      `日期取自账龄列里写的日期，或摘要里写的年月日；共 ${datedPairCount} 组配对两侧都有日期可以对照${farPairCount ? `，其中 ${farPairCount} 组相差超过 ${PAIR_DATE_WARN_DAYS} 天，已在「核销配对」表的「日期情况」列标出` : ''}。日期只用来给同样金额的几笔排序和提醒，不判断是不是同一笔业务，也不改变配对结果、金额和净额。`
    ]] : []),
    ['金额处理', '源表金额已统一换算为元后导出；负数金额取绝对值，并自动改记到对立方向（应收负数记为应付，应付负数记为应收），明细表“原表金额”列保留原始写法。'],
    ['负数重分类', `${state.reclassRows.length} 行；重分类后仍标“负数重分类”，请结合原始凭证复核。`],
    ...(((runInfo.signNotes || []).length) ? [[
      '贷方写负数',
      `${(runInfo.signNotes || []).map((note) => `「${note.sheet}」有余额的 ${note.filled} 行里 ${note.negative} 行写的是负数`).join('；')}。这次按财务系统「贷方写负数」的写法处理：负数留在应付，写成正数的那几行（应付科目的借方余额）按负数重分类挪到应收。取数核对仍按原表格子里写的数统计，不受这个处理影响。`
    ]] : []),
    ['名称归一', '忽略空格、全半角、括号样式，并去掉公司后缀（有限公司、股份有限公司等）后归并。'],
    ['名称并归', `${state.mergeLog.length
      ? `页面上由人工确认并归的 ${state.mergeLog.length} 组，已合并成一家计算，原始写法保留在「原始名称写法」列；并归只影响归并，不改任何金额。`
      : '本次没有人工并归企业；名称相近的只做提示，不合并。'}${state.dismissedPairs.size
      ? `另有 ${state.dismissedPairs.size} 对名称相近的企业，已由你确认不是同一家，本次按两家分别计算。`
      : ''}`],
    ['同单据号', counts.doc
      ? `从摘要里读到发票号／单据号／凭证号／合同号等编号，同一企业内两侧出现相同编号的共 ${counts.doc} 个（大小写、空格、横线写法不同也按同一个编号对上），单列在「同单据号」表；金额不一致的是“部分核销”，请按凭证补差。同单据号只是提示，不参与净额计算。`
      : '摘要里没有发现相同的单据号（认发票号／单据号／凭证号／合同号等编号，字母数字混排也可以，以及 6 位以上连续数字）。'],
    ['摘要线索', counts.memo
      ? `摘要里写了合同、项目、工程、部门、订单、批次这类字的，把同一个说法在两侧同时出现的 ${counts.memo} 条单列在「摘要线索」表，方便对照。这只是按文字找出来的线索，不代表同一笔业务，也不改变任何金额。`
      : '摘要里没有发现两侧都写到的合同、项目、工程、部门、订单、批次等相同说法。'],
    ['差一点', counts.near
      ? `自动配对没吃掉的记录里，${groups.filter((group) => group.hasNearMiss).length} 家企业还剩 ${counts.near} 对只差一点（差额不到当前容差 ${moneyFormatter.format(state.pairToleranceCents / 100)} 元的两倍，或者不到较大一方的 ${Math.round(PAIR_NEAR_MISS_RATIO * 100)}%），单列在「差一点」表；把「核销容差」改成那一行的差额就能配上。每家最多列差额最小的 ${PAIR_NEAR_MISS_POOL} 对。这只是给个参照，不改任何金额，也不影响净额。`
      : `自动配对没吃掉的记录里，没有只差一点的一对（每对的差额都超过当前容差 ${moneyFormatter.format(state.pairToleranceCents / 100)} 元的两倍，也超过较大一方的 ${Math.round(PAIR_NEAR_MISS_RATIO * 100)}%）。`],
    ...(hasAgeData ? [[
      '账龄',
      `按「${AGE_BANDS.join('、')}」分档统计（${ageBandPreset().label}），单列在「账龄分析」表，「原始明细」里每笔也标了档位。${ageColumnNotes.length ? `${ageColumnNotes.join('；')}。` : ''}原表没写账龄的单独列示、不塞进任何一档；没有账龄列的那些表不进这张表，所以「账龄分析」的合计可能比「对账汇总」小。账龄只是把挂账时间分开看，不改变金额，也不参与净额计算。`
    ]] : []),
    ['复核提示', '“同向重复”只代表同方向同金额出现多次，是否重复入账请结合原始凭证判断。']
  );

  const infoSheet = XLSX.utils.aoa_to_sheet(infoRows);
  infoSheet['!cols'] = [{ wch: 18 }, { wch: 100 }];
  XLSX.utils.book_append_sheet(workbook, infoSheet, '对账说明');
}

function applyMoneyFormat(sheet, columnIndexes) {
  if (!sheet || !sheet['!ref']) return;
  const range = XLSX.utils.decode_range(sheet['!ref']);

  for (let row = range.s.r + 1; row <= range.e.r; row += 1) {
    columnIndexes.forEach((column) => {
      const address = XLSX.utils.encode_cell({ r: row, c: column });
      const cell = sheet[address];
      if (cell && cell.t === 'n') cell.z = '#,##0.00';
    });
  }
}

function buildExportFileName() {
  return `${exportFileBase()}_对账结果_${formatFileStamp(new Date())}.xlsx`;
}

function buildGroupSheetsFileName() {
  return `${exportFileBase()}_分企业明细_${formatFileStamp(new Date())}.xlsx`;
}

function exportFileBase() {
  const sources = state.runInfo ? state.runInfo.sources : [];
  let base = '对账';

  if (state.runInfo && state.runInfo.mode === 'manual') {
    base = '手动粘贴';
  } else {
    const fileNames = Array.from(new Set(sources.map((source) => source.fileName).filter(Boolean)));
    if (fileNames.length === 1) {
      base = sanitizeFileBase(fileBaseName(fileNames[0]));
    } else if (fileNames.length > 1) {
      base = `${sanitizeFileBase(fileBaseName(fileNames[0]))}等${fileNames.length}个文件`;
    }
  }

  return base || '对账';
}

function sanitizeFileBase(value) {
  return String(value || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || '对账';
}

function formatFileStamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function formatDateTime(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function todayIsoDate() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// ===== 示例、自检与诊断 =====

function buildSampleWorkbook() {
  const recvRows = [
    ['应收账款底稿（2026年9月）'],
    ['企业名称', '业务摘要', '金额（元）'],
    ['北京华信科技有限公司', '9月货款', 128000],
    ['', '9月补记', 32000],
    ['', '红字退货冲销', -9600],
    ['上海恒远贸易有限公司', '设备款', 56800],
    ['杭州云帆信息技术有限公司', '技术服务', 15000],
    ['', '追加服务', 5000],
    ['重庆两江商贸有限公司', '货款', 120000],
    ['', '第二笔货款', 120000],
    ['南京博远贸易有限公司', '零星货款', 7800],
    ['合计', '', 475000]
  ];

  const payRows = [
    ['应付账款底稿（2026年9月）'],
    ['企业名称', '业务摘要', '金额（元）'],
    ['北京华信科技有限公司', '材料款', 96000],
    ['上海恒远贸易有限公司', '设备款', 56800],
    ['杭州云帆信息技术有限公司', '服务费', 5000],
    ['重庆两江商贸有限公司', '货款', 120000],
    ['武汉长江器材有限公司', '材料款', 43000],
    ['', '补记材料款', 7000],
    ['合计', '', 327800]
  ];

  const recvSheet = XLSX.utils.aoa_to_sheet(recvRows);
  recvSheet['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } },
    { s: { r: 2, c: 0 }, e: { r: 4, c: 0 } },
    { s: { r: 6, c: 0 }, e: { r: 7, c: 0 } },
    { s: { r: 8, c: 0 }, e: { r: 9, c: 0 } }
  ];
  recvSheet['!cols'] = [{ wch: 38 }, { wch: 20 }, { wch: 16 }];
  applyMoneyFormat(recvSheet, [2]);

  const paySheet = XLSX.utils.aoa_to_sheet(payRows);
  paySheet['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } },
    { s: { r: 6, c: 0 }, e: { r: 7, c: 0 } }
  ];
  paySheet['!cols'] = [{ wch: 38 }, { wch: 20 }, { wch: 16 }];
  applyMoneyFormat(paySheet, [2]);

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, recvSheet, '应收账款底稿');
  XLSX.utils.book_append_sheet(workbook, paySheet, '应付账款底稿');
  return workbook;
}

function browserCapabilityChecks() {
  const items = [];
  const ua = typeof navigator !== 'undefined' && navigator.userAgent ? String(navigator.userAgent) : '';
  const legacyIE = /MSIE |Trident\//.test(ua);
  const browserName = /Edg\//.test(ua) ? 'Edge'
    : /Firefox\//.test(ua) ? 'Firefox'
      : /Chrome\//.test(ua) ? 'Chrome'
        : /Safari\//.test(ua) ? 'Safari'
          : legacyIE ? 'IE' : '';
  items.push({
    ok: !legacyIE,
    text: legacyIE
      ? '浏览器：这是 IE 内核，本工具用不了，请换新版 Edge、Chrome、Firefox 或 Safari'
      : `浏览器：${browserName || '这台电脑上的浏览器'}；建议用新版 Edge、Chrome、Firefox 或 Safari`
  });

  const missing = [];
  [
    ['Map', typeof Map],
    ['Set', typeof Set],
    ['Promise', typeof Promise],
    ['TextEncoder', typeof TextEncoder],
    ['TextDecoder', typeof TextDecoder],
    ['Blob', typeof Blob],
    ['ArrayBuffer', typeof ArrayBuffer],
    ['File', typeof File],
    ['FileReader', typeof FileReader]
  ].forEach(([name, kind]) => {
    if (kind !== 'function') missing.push(name);
  });
  if (typeof Intl === 'undefined' || typeof Intl.NumberFormat !== 'function') missing.push('金额格式');
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') missing.push('下载文件');
  items.push({
    ok: missing.length === 0,
    text: missing.length
      ? `浏览器功能：缺少 ${missing.join('、')}，对账、导出或复制会出问题，请换新版 Edge、Chrome、Firefox 或 Safari`
      : '浏览器功能：对账、导出、复制需要的功能都在'
  });

  let canvasOk = false;
  try {
    const canvas = typeof document !== 'undefined' && document.createElement
      ? document.createElement('canvas')
      : null;
    canvasOk = Boolean(canvas && canvas.getContext && canvas.getContext('2d'));
  } catch (error) {
    canvasOk = false;
  }
  items.push({
    ok: canvasOk,
    text: canvasOk
      ? '工作表图片概览：可用，可以在图片上框选'
      : '工作表图片概览：这台浏览器画不了图，请改用下面的列下拉框选列'
  });

  const pointerOk = typeof window !== 'undefined' && 'PointerEvent' in window;
  items.push({
    ok: true,
    text: pointerOk
      ? '鼠标拖框：可用'
      : '鼠标拖框：这台浏览器不支持，请改用下面的列下拉框选列'
  });

  return items;
}

function runSelfCheck() {
  if (!els.selfCheckOut) return;
  const items = [];
  const protocol = location.protocol;
  const host = location.hostname;

  if (protocol === 'file:') {
    items.push({ ok: true, text: '打开方式：直接打开的本机文件，可用' });
  } else if (host === '127.0.0.1' || host === 'localhost') {
    items.push({ ok: true, text: `打开方式：本机小服务（${host}${location.port ? `:${location.port}` : ''}），可用` });
  } else {
    items.push({ ok: false, text: `打开方式：从 ${host || '未知地址'} 打开，不是本机地址，请确认这是公司内网地址` });
  }

  const libLoaded = typeof XLSX !== 'undefined';
  items.push({
    ok: libLoaded,
    text: libLoaded
      ? `Excel 解析库：已加载${XLSX.version ? `（${XLSX.version}）` : ''}`
      : 'Excel 解析库：没加载，请重新解压整个文件夹，或用 Edge / Chrome 打开'
  });

  const fileApiOk = typeof File !== 'undefined' && typeof FileReader !== 'undefined';
  items.push({
    ok: fileApiOk,
    text: fileApiOk ? '读取本机文件：可用' : '读取本机文件：不可用，请换 Edge 或 Chrome 打开'
  });

  items.push(...browserCapabilityChecks());

  const clipboardOk = Boolean(navigator.clipboard && window.isSecureContext);
  items.push({
    ok: true,
    text: clipboardOk
      ? '复制按钮：可以用浏览器剪贴板'
      : '复制按钮：浏览器限制自动复制，点复制后按 Ctrl+A、Ctrl+C 也能复制'
  });

  const online = typeof navigator.onLine === 'boolean' ? navigator.onLine : null;
  items.push({
    ok: true,
    text: online === false
      ? '网络状态：这台电脑现在没联网，本工具照样能用'
      : '网络状态：浏览器报告已联网；本工具不会主动访问任何网站'
  });

  items.push({
    ok: true,
    text: `版本：${els.appVersion && els.appVersion.textContent ? els.appVersion.textContent : '未标注'}`
  });

  els.selfCheckOut.innerHTML = items
    .map((item) => `<li class="${item.ok ? '' : 'check-bad'}">${escapeHtml(item.text)}</li>`)
    .join('');
  els.selfCheckOut.classList.remove('hidden');
  const problems = items.filter((item) => !item.ok).length;
  showToast(problems ? `有 ${problems} 项需要处理，看检查结果` : '检查通过：这台电脑可以直接用', problems > 0);
}

function maskDiagnosticText(text) {
  let out = String(text == null ? '' : text);
  const pairs = [];
  state.sources.forEach((source, index) => {
    if (source.sheetName) pairs.push([source.sheetName, `表${index + 1}`]);
    if (source.fileName) pairs.push([source.fileName, `文件${index + 1}`]);
  });
  pairs.sort((a, b) => b[0].length - a[0].length);
  pairs.forEach(([raw, alias]) => {
    if (raw) out = out.split(raw).join(alias);
  });
  return out.slice(0, 400);
}

function buildDiagnostics() {
  const version = els.appVersion && els.appVersion.textContent ? els.appVersion.textContent : APP_VERSION_FALLBACK;
  const unitLabels = { 1: '元', 1000: '千元', 10000: '万元' };
  let protocol = '直接双击打开（file://）';
  if (location.protocol !== 'file:') {
    const local = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
    protocol = local ? `本机小服务（${location.host}）` : `其他地址（${location.host || '未知'}）`;
  }


  const sources = state.sources.map((source, index) => {
    const direction = resolveSourceDirection(source);
    const mapped = ROLE_FIELDS
      .filter((field) => source.mapping[field] >= 0)
      .map((field) => `${ROLE_LABELS[field]}=${columnLetter(source.mapping[field])}`);
    const age = sourceAgeColumn(source);
    return {
      编号: `表${index + 1}`,
      行数: source.rows ? source.rows.length : 0,
      列数: getColumnCount(source),
      表头行: source.headerRow >= 0 ? source.rowOffset + source.headerRow + 1 : '未识别',
      取数范围: source.dataRange ? dataRangeLabel(source) : '整张表',
      范围外行数: source.dataRange ? source.dataRange.outside : 0,
      金额单位: unitLabels[source.unit] || String(source.unit),
      方向: direction.dir ? direction.label : '看方向列',
      认出的列: mapped.join('，') || '还没认全',
      账龄列: age ? `${columnLetter(age.index)}（${age.manual ? '人工指定' : '自动认出'}，${age.kind}）` : '没有',
      主体列: (() => {
        const column = sourceDimensionColumn(source, 'entity');
        return column ? `${columnLetter(column.index)}（${column.manual ? '人工指定' : '自动认出'}）` : '没有';
      })(),
      币种列: (() => {
        const column = sourceDimensionColumn(source, 'currency');
        return column ? `${columnLetter(column.index)}（${column.manual ? '人工指定' : '自动认出'}）` : '没有';
      })(),
      是猜的处数: sourceConfidence(source).length,
      套用列设置: source.profileUsed ? '是' : '否',
      取数核对: controlForSource(source.id)
        ? (controlForSource(source.id).ok ? '平' : `差 ${controlForSource(source.id).diffCells} 格`)
        : '未对账',
      能参与对账: source.usable ? '是' : '否',
      已勾选: source.included ? '是' : '否'
    };
  });

  const domErrors = [els.fileError, els.runError, els.manualError]
    .filter((node) => node && !node.classList.contains('hidden') && node.textContent.trim())
    .map((node) => node.textContent.trim());
  const errors = domErrors
    .concat(state.recentErrors)
    .map(maskDiagnosticText)
    .filter((text, index, list) => text && list.indexOf(text) === index)
    .slice(0, 6);

  const stats = state.stats
    ? {
        企业数: state.groups.length,
        记录笔数: state.records.length,
        跳过行数: state.skipped.length,
        名称续行数: state.inheritedRows,
        负数重分类笔数: state.reclassRows.length,
        红字转负笔数: state.redRows.length,
        账龄: state.stats.ageGroups
          ? `${state.stats.ageGroups} 家 / ${state.stats.ageMarkedRecords} 笔（${AGE_BANDS.length} 档：${AGE_BANDS.join('、')}）`
          : '没有认出账龄列',
        账龄算到: state.stats.ageGroups ? ageBaseDateValue() : '不适用',
        分维度: [
          state.stats.hasEntity ? `按主体分开（${state.stats.entityTotals.length} 个主体）` : '不分主体',
          state.stats.hasCurrency ? `按币种分开（${state.stats.currencyTotals.length} 种币种）` : '不分币种'
        ].join('，'),
        自动核销组数: state.pairResult ? state.pairResult.pairCount : 0,
        核销容差元: (state.pairToleranceCents / 100).toFixed(2),
        核销比例容差: state.pairPercent ? `${formatPercentInput(state.pairPercent)}%` : '不用',
        配对确认: (() => {
          const counts = pairDecisionCounts();
          return `采纳 ${counts.accepted}、不采纳 ${counts.rejected}、待确认 ${counts.pending}`;
        })(),
        取数核对: (state.controls || []).length
          ? (combineControls(state.controls).ok ? '各表金额格全部归类' : `有 ${combineControls(state.controls).diffCells} 格对不上`)
          : '未生成',
        差异说明条数: state.groupNotes ? state.groupNotes.size : 0
      }
    : '还没有开始对账';

  return {
    工具: '双边对账核销工具',
    版本: version,
    导出时间: new Date().toLocaleString('zh-CN', { hour12: false }),
    打开方式: protocol,
    浏览器: navigator.userAgent,
    安全上下文: window.isSecureContext ? '是' : '否',
    窗口大小: `${window.innerWidth}×${window.innerHeight}`,
    网络: navigator.onLine === false ? '浏览器报告没联网' : '浏览器报告已联网（本工具不主动联网）',
    数据源: sources.length ? sources : '还没有导入表',
    统计: stats,
    最近错误: errors.length ? errors : '没有记录到错误',
    说明: '这份文件只有运行环境和配置，不含金额、企业名称和原始单元格内容。'
  };
}

function exportDiagnostics() {
  let payload;
  try {
    payload = buildDiagnostics();
  } catch (error) {
    showToast('诊断包生成失败，请把「检查运行环境」的结果截图发给协助的人', true);
    return;
  }

  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

  try {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `对账工具诊断包-${stamp}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast('诊断包已下载：只有环境和配置，不含金额和企业名称');
  } catch (error) {
    showToast('这台电脑不让下载文件，请改用「检查运行环境」并把结果截图发给协助的人', true);
  }
}

function downloadSample() {
  if (typeof XLSX === 'undefined') {
    showToast('Excel 解析库未加载，无法生成示例', true);
    return;
  }

  try {
    XLSX.writeFile(buildSampleWorkbook(), '双边对账示例_应收应付两张表.xlsx');
    showToast('示例已下载：没有方向列、有合并单元格，还有一行红字负数会被改记到应付', false);
  } catch (error) {
    console.error(error);
    showToast('示例生成失败，请确认本页是用 Edge / Chrome 打开的', true);
  }
}

async function runBuiltinSample() {
  if (typeof XLSX === 'undefined') {
    showToast('Excel 解析库未加载，无法跑示例', true);
    return;
  }

  let file;
  try {
    const bytes = XLSX.write(buildSampleWorkbook(), { type: 'array', bookType: 'xlsx' });
    file = new File([bytes], '双边对账示例.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
  } catch (error) {
    console.error(error);
    showToast('示例生成失败，请确认本页是用 Edge / Chrome 打开的', true);
    return;
  }

  if (state.sources.length || state.records.length || els.manualRecv.value || els.manualPay.value) {
    resetWorkbench();
  }
  await handleFiles([file]);
  state.sources.forEach((source) => {
    source.included = source.usable && !source.amountDoubt && !source.companyDoubt;
  });
  if (!state.sources.some((source) => source.included)) {
    showToast('示例没认出可对账的表，请点「重新认一次」或手动框列', true);
    return;
  }
  runReconciliation();
  showToast('示例已跑完：企业名全是编的，看完点「添加文件」换成你自己的表');
}

// ===== 金额、方向与名称规范化 =====

function parseAmount(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  let text = toHalfWidth(String(value)).trim();
  if (!text) return null;

  text = text
    .replace(/[,\s]/g, '')
    .replace(/[¥￥元]/g, '')
    .replace(/人民币|RMB/gi, '')
    .replace(/−/g, '-');

  let negative = false;

  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (/-$/.test(text)) {
    negative = !negative;
    text = text.slice(0, -1);
  }
  if (text.startsWith('+')) text = text.slice(1);

  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;

  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  return negative ? -Math.abs(number) : number;
}

function parseDirection(value) {
  const text = toHalfWidth(value).replace(/\s+/g, '').toUpperCase();
  if (!text) return '';

  const hasPay = /应付|付款|贷方|贷/.test(text);
  const hasRecv = /应收|收款|借方|借/.test(text);

  if (hasPay && hasRecv) return '';
  if (hasPay) return 'pay';
  if (hasRecv) return 'recv';
  if (/付/.test(text)) return 'pay';
  if (/收/.test(text)) return 'recv';
  return '';
}

const DOC_NO_RE = /(?:发票|单据|结算单|凭证|记账|业务|合同|订单|提单|汇票|收据)\s*(?:号|编号|号码)?[\s:：是为-]*([0-9A-Z][0-9A-Z\-/ ]{3,})/;
const DOC_NO_BARE_RE = /(?<![0-9])([0-9]{6,18})(?![0-9])/;

// 底稿上的编号常有大小写、全半角、空格和连接符差异（HT-2026-011 / ht 2026-011 / HT2026011），
// 比较时统一成「字母数字」，显示仍保留原写法。
function normalizeTokenKey(value) {
  return toHalfWidth(cleanCell(value))
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[—–－﹣_/／\\]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function docKeyOf(docNo) {
  const key = normalizeTokenKey(docNo).replace(/[^0-9A-Z]/g, '');
  return key.length >= 4 && /\d/.test(key) ? key : '';
}

function extractDocNo(text) {
  const raw = toHalfWidth(cleanCell(text)).toUpperCase();
  if (!raw) return '';
  const labeled = raw.match(DOC_NO_RE);
  if (labeled && labeled[1]) return labeled[1].replace(/[^\dA-Z\-/]/g, '');
  const digits = raw.match(DOC_NO_BARE_RE);
  return digits ? digits[1] : '';
}

function buildDocHints(group) {
  const byNo = new Map();
  (group.rows || []).forEach((record) => {
    if (!record.docNo) return;
    const key = record.docKey || docKeyOf(record.docNo);
    if (!key) return;
    const bucket = byNo.get(key) || { recv: [], pay: [], variants: [] };
    bucket[record.dir].push(record);
    if (!bucket.variants.includes(record.docNo)) bucket.variants.push(record.docNo);
    byNo.set(key, bucket);
  });

  const hints = [];
  byNo.forEach((bucket) => {
    if (!bucket.recv.length || !bucket.pay.length) return;
    const recvCents = bucket.recv.reduce((sum, record) => sum + record.cents, 0);
    const payCents = bucket.pay.reduce((sum, record) => sum + record.cents, 0);
    hints.push({
      docNo: bucket.variants[0],
      docVariants: bucket.variants,
      recvRows: bucket.recv.slice().sort((a, b) => a.rowNo - b.rowNo),
      payRows: bucket.pay.slice().sort((a, b) => a.rowNo - b.rowNo),
      recvCents,
      payCents,
      diffCents: recvCents - payCents
    });
  });
  hints.sort((a, b) => Math.abs(b.recvCents) - Math.abs(a.recvCents) || a.docNo.localeCompare(b.docNo));
  return hints;
}

const MEMO_KEY_LABELS = ['合同', '协议', '项目', '工程', '部门', '车间', '班组', '门店', '分店', '仓库', '批次', '批号', '订单', '计划', '任务', '课题', '工单'];
const MEMO_KEY_RE = new RegExp(
  '(' + MEMO_KEY_LABELS.join('|') + ')(?:号|编号|号码|名称|单)?[\\s:：是为\\-—／/]*(' +
    '[0-9A-Za-z][0-9A-Za-z\\-_/／ ]{2,22}|' +
    '[0-9A-Za-z\\u4e00-\\u9fa5][0-9A-Za-z\\u4e00-\\u9fa5\\-_/／]{1,19}' +
  ')',
  'g'
);
const MEMO_KEY_GENERIC = new Set([
  '编号', '号码', '名称', '金额', '日期', '时间', '无', '空白', '略', '待定', '见附件', '如上', '如下',
  '扫描件', '复印件', '原件', '照片', '签订', '终止', '解除', '模板', '示例', '未知', '其他', '正常',
  '合计', '小计', '说明', '备注', '借款', '货款', '材料款', '往来', '转账', '付款', '收款', '报销',
  '发票', '待补', '补充', '更正', '调整', '作废', '已付', '未付', '部分', '全部'
]);

function isMemoKeyValue(label, value) {
  if (value.length < 2 || value.length > 20) return false;
  if (MEMO_KEY_GENERIC.has(value)) return false;
  if (MEMO_KEY_LABELS.some((item) => value.startsWith(item))) return false;
  if (/[0-9A-Za-z]/.test(value)) return true;
  return value.length >= 3;
}

const DEPT_RE = /([\u4e00-\u9fa5]{2,8}?(?:部|科|室|组))/;
const DEPT_BLACKLIST = new Set(['全部', '内部', '外部', '干部', '本部', '分部', '支部', '总部', '每个部', '各部门']);
const MEMO_KEY_TAIL_RE = /(?:进度款|工程款|材料款|货款|尾款|欠款|借款|付款|收款|运费|费用|保证金|质保金|押金|款项|结算|款|费|金|额|税)$/;

// 摘要里的日期只认完整的年月日或年月；前后必须是边界，避免把合同号 HT-2026-011 当成 2026 年 1 月。
const MEMO_DATE_RE = /(^|[^\d])(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?![\d])/;
const MEMO_YM_RE = /(^|[^\d])(\d{4})[-/.年](\d{1,2})月?(?![\d])/;

function extractMemoDate(text) {
  const raw = toHalfWidth(cleanCell(text)).replace(/\s+/g, '');
  if (!raw) return '';
  let year = 0;
  let month = 0;
  let day = 1;
  let match = MEMO_DATE_RE.exec(raw);
  if (match) {
    year = Number(match[2]);
    month = Number(match[3]);
    day = Number(match[4]);
  } else {
    match = MEMO_YM_RE.exec(raw);
    if (!match) return '';
    // 只写年月时要求带“年/月”字样，否则 HT-2026-01 这类合同号会被误当成日期
    if (!/[年月]/.test(match[0])) return '';
    year = Number(match[2]);
    month = Number(match[3]);
  }
  if (year < 1900 || year > 2999 || month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// 比较用的写法：去掉空格、大小写和连接符差异；HT-2026-011 与 ht 2026 011 视为同一个编号。
function memoKeyNorm(value) {
  return toHalfWidth(cleanCell(value)).toUpperCase().replace(/[\s\-_/／—–－]+/g, '');
}

// 比较时把「二期扩建进度款」这种尾巴去掉，显示时仍用原写法
function memoKeyCore(value) {
  if (/[0-9A-Za-z]/.test(value)) return value;
  let core = value;
  for (let i = 0; i < 3; i += 1) {
    const next = core.replace(MEMO_KEY_TAIL_RE, '');
    if (next === core || next.length < 2) break;
    core = next;
  }
  return core;
}

function extractMemoKeys(text) {
  const raw = toHalfWidth(cleanCell(text));
  if (!raw) return [];
  const found = [];
  const seen = new Set();
  const push = (label, value) => {
    const core = memoKeyCore(value);
    const norm = memoKeyNorm(core);
    if (!core || seen.has(label + '|' + norm)) return;
    seen.add(label + '|' + norm);
    found.push({ label, value, core, norm });
  };

  MEMO_KEY_RE.lastIndex = 0;
  let match = MEMO_KEY_RE.exec(raw);
  while (match && found.length < 3) {
    const label = match[1];
    const captured = match[2].trim();
    const asciiToken = /^[0-9A-Za-z]/.test(captured);
    const value = (asciiToken ? captured.replace(/\s+/g, '') : captured)
      .replace(/[^\dA-Za-z\u4e00-\u9fa5\-_/／]/g, '')
      .replace(/[\-_/／]+$/, '');
    if (isMemoKeyValue(label, memoKeyCore(value))) push(label, value);
    match = MEMO_KEY_RE.exec(raw);
  }

  if (found.length < 3) {
    const dept = raw.match(DEPT_RE);
    if (dept && !DEPT_BLACKLIST.has(dept[1]) && !found.some((item) => item.core === dept[1])) {
      push('部门', dept[1]);
    }
  }
  return found;
}

function buildMemoKeyHints(group) {
  const rows = group.rows || [];
  const recvTotal = rows.filter((record) => record.dir === 'recv').length;
  const payTotal = rows.filter((record) => record.dir === 'pay').length;
  const byKey = new Map();
  (group.rows || []).forEach((record) => {
    (record.memoKeys || []).forEach((item) => {
      const bucketId = item.label + '|' + item.norm;
      const bucket = byKey.get(bucketId) || { label: item.label, value: item.value, variants: [], recv: [], pay: [] };
      if (!bucket.variants.includes(item.value)) bucket.variants.push(item.value);
      bucket[record.dir].push(record);
      byKey.set(bucketId, bucket);
    });
  });

  const hints = [];
  byKey.forEach((bucket) => {
    if (!bucket.recv.length || !bucket.pay.length) return;
    // 每笔两边都写着同一个说法时说明不了什么，不当线索
    if (bucket.recv.length === recvTotal && bucket.pay.length === payTotal) return;
    const recvCents = bucket.recv.reduce((sum, record) => sum + record.cents, 0);
    const payCents = bucket.pay.reduce((sum, record) => sum + record.cents, 0);
    hints.push({
      label: bucket.label,
      value: bucket.value,
      variants: bucket.variants,
      recvRows: bucket.recv.slice().sort((a, b) => a.rowNo - b.rowNo),
      payRows: bucket.pay.slice().sort((a, b) => a.rowNo - b.rowNo),
      recvCents,
      payCents,
      diffCents: recvCents - payCents
    });
  });
  hints.sort((a, b) =>
    Math.abs(b.recvCents) + Math.abs(b.payCents) - (Math.abs(a.recvCents) + Math.abs(a.payCents)) ||
    a.label.localeCompare(b.label) || a.value.localeCompare(b.value, 'zh-CN')
  );
  return hints;
}

function normalizeName(value) {
  let text = toHalfWidth(cleanCell(value))
    .replace(/\s+/g, '')
    .replace(/[()（）[\]【】{}「」『』]/g, '')
    .replace(/^[,.，。;；:：、\-—_]+|[,.，。;；:：、\-—_]+$/g, '');

  const suffixes = NAME_SUFFIXES;

  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of suffixes) {
      if (text.endsWith(suffix) && text.length > suffix.length) {
        text = text.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
  }

  return text.toUpperCase();
}

function normalizeForSearch(value) {
  return toHalfWidth(value).replace(/\s+/g, '').toUpperCase();
}

const REGION_WORDS = [
  '内蒙古', '黑龙江', '石家庄', '呼和浩特', '乌鲁木齐', '北京', '上海', '天津', '重庆', '河北', '山西',
  '辽宁', '吉林', '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南', '广东', '广西',
  '海南', '四川', '贵州', '云南', '西藏', '陕西', '甘肃', '青海', '宁夏', '新疆', '香港', '澳门', '台湾',
  '太原', '沈阳', '长春', '南京', '杭州', '合肥', '福州', '南昌', '济南', '郑州', '武汉', '长沙',
  '广州', '南宁', '海口', '成都', '贵阳', '昆明', '拉萨', '西安', '兰州', '西宁', '银川', '深圳', '珠海',
  '汕头', '佛山', '东莞', '中山', '苏州', '无锡', '宁波', '温州', '厦门', '青岛', '大连', '唐山', '保定',
  '廊坊', '沧州', '徐州', '常州', '南通', '扬州', '嘉兴', '湖州', '金华', '台州', '九江', '赣州', '淄博',
  '烟台', '潍坊', '临沂', '洛阳', '襄阳', '宜昌', '岳阳', '常德', '株洲', '惠州', '湛江', '肇庆', '江门',
  '茂名', '德阳', '绵阳', '宜宾', '泸州', '遵义', '曲靖', '玉溪', '宝鸡', '咸阳', '桂林', '柳州', '三亚'
];
const INDUSTRY_WORDS = [
  '科技', '贸易', '实业', '建筑', '工程', '制造', '机械', '电子', '信息', '网络', '软件', '数据',
  '医疗', '医药', '生物', '教育', '培训', '文化', '传媒', '广告', '餐饮', '食品', '农业', '林业',
  '能源', '电力', '化工', '材料', '塑料', '橡胶', '纺织', '服装', '家具', '建材', '装饰', '物流',
  '运输', '仓储', '货运', '进出口', '商贸', '商务', '咨询', '金融', '投资', '租赁', '担保', '保险',
  '环保', '矿业', '冶金', '航空', '船舶', '汽车', '通信', '劳务', '人力资源', '物业', '酒店', '旅游',
  '置业', '地产', '电动', '光电', '智能', '技术', '发展', '国际'
];
const ORG_FORM_STRIP_RE = /(有限责任公司|股份有限公司|有限公司|集团公司|集团|公司|工厂|厂|中心|研究院|研究所|设计院|事务所|合伙企业|独资企业|企业)/g;
const BRANCH_TOKEN_RE = /(分公司|分厂|办事处|支行|分行|分部|营业部|经营部|代表处|项目部)/;
const SIMILAR_STRONG = 0.6;

function stripKnownWords(text, words) {
  let out = text;
  let changed = true;
  while (changed && out.length > 2) {
    changed = false;
    for (let i = 0; i < words.length; i += 1) {
      const word = words[i];
      if (!word || out.length <= word.length) continue;
      const at = out.indexOf(word);
      if (at !== -1) {
        out = out.slice(0, at) + out.slice(at + word.length);
        changed = true;
        break;
      }
    }
  }
  return out;
}

function leadingRegionOf(name) {
  const text = toHalfWidth(String(name || '')).replace(/\s+/g, '');
  for (let i = 0; i < REGION_WORDS.length; i += 1) {
    const word = REGION_WORDS[i];
    if (word && text.startsWith(word)) return word;
  }
  const match = text.match(/^(.{2,6}?(省|市|自治区|自治州|地区|盟|县|区|镇|乡))/);
  return match ? match[1] : '';
}

function nameCoreOf(name) {
  let text = toHalfWidth(cleanCell(name)).replace(/\s+/g, '');
  text = text.replace(/[()（）[\]【】{}「」『』]/g, '');
  const region = leadingRegionOf(text);
  if (region && text.length > region.length + 1) text = text.slice(region.length);
  text = text.replace(ORG_FORM_STRIP_RE, '');
  text = stripKnownWords(text, INDUSTRY_WORDS);
  text = text.replace(/[^0-9a-zA-Z\u4E00-\u9FA5]/g, '');
  return text.toUpperCase();
}

function nameBigrams(text) {
  const set = new Set();
  const clean = String(text || '').replace(/\s+/g, '');
  if (clean.length < 2) {
    if (clean) set.add(clean);
    return set;
  }
  for (let i = 0; i < clean.length - 1; i += 1) {
    set.add(clean.slice(i, i + 2));
  }
  return set;
}

function jaccardOfBigrams(left, right) {
  if (!left.size || !right.size) return 0;
  const iterate = left.size <= right.size ? left : right;
  const lookup = left.size <= right.size ? right : left;
  let shared = 0;
  iterate.forEach((gram) => {
    if (lookup.has(gram)) shared += 1;
  });
  const union = left.size + right.size - shared;
  return union ? shared / union : 0;
}

function nameSimilarity(a, b) {
  return jaccardOfBigrams(nameBigrams(a), nameBigrams(b));
}

// 两两比对的每次比较都要用到这四样，而它们只跟企业自己的名字有关：
// 800 家企业若逐对现算，光「剥字号 + 造二元组集合」就要重复三十万次。
function similarNameProfile(group) {
  const text = normalizeName(group.displayName);
  const bigrams = nameBigrams(text);
  return {
    group,
    text,
    bigrams,
    gramCount: bigrams.size,
    branch: BRANCH_TOKEN_RE.test(group.displayName),
    core: nameCoreOf(group.displayName),
    region: leadingRegionOf(group.displayName),
    entityKey: group.entityKey || '',
    currencyKey: group.currencyKey || ''
  };
}

function buildSimilarSuggestions(groups) {
  const items = [];
  const list = (groups || [])
    .filter((group) => group && group.key && group.displayName)
    .map(similarNameProfile);

  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    for (let j = i + 1; j < list.length; j += 1) {
      const b = list[j];
      // 主体或币种不同时本来就分开算，不能提示并归。
      if (a.entityKey !== b.entityKey) continue;
      if (a.currencyKey !== b.currencyKey) continue;
      if (a.text === b.text) continue;
      if (a.branch !== b.branch) continue;

      const sameCore = a.core.length >= 2 && a.core === b.core;
      // Jaccard 不会超过「小集合 / 大集合」，长度差太大时先剪掉，省掉整轮查表。
      if (!sameCore) {
        const smaller = a.gramCount <= b.gramCount ? a.gramCount : b.gramCount;
        const larger = a.gramCount <= b.gramCount ? b.gramCount : a.gramCount;
        if (!larger || smaller / larger < SIMILAR_STRONG) continue;
      }

      const score = jaccardOfBigrams(a.bigrams, b.bigrams);
      if (!sameCore && score < SIMILAR_STRONG) continue;

      const regionDiff = !!a.region && !!b.region && a.region !== b.region;

      let tier = 'similar';
      let reason = `名字只差几个字（${Math.round(score * 100)}% 相同）`;
      if (sameCore && regionDiff) {
        tier = 'region';
        reason = `字号都是「${a.core}」，但一个写${a.region}、一个写${b.region}，很可能是两家`;
      } else if (sameCore) {
        tier = 'core';
        reason = `字号相同（${a.core}），只是地区、行业或写法不一样`;
      }

      items.push({
        tier,
        reason,
        score,
        keyA: a.group.key,
        keyB: b.group.key,
        nameA: a.group.displayName,
        nameB: b.group.displayName,
        netA: a.group.netCents,
        netB: b.group.netCents,
        rowsA: a.group.rows.length,
        rowsB: b.group.rows.length,
        id: similarPairKey(a.group.key, b.group.key)
      });
    }
  }

  const order = { core: 0, region: 1, similar: 2 };
  items.sort((x, y) =>
    (order[x.tier] - order[y.tier])
    || (Math.abs(y.netA) + Math.abs(y.netB)) - (Math.abs(x.netA) + Math.abs(x.netB))
    || y.score - x.score);

  return items.slice(0, 40);
}

function mergePairLabel(pair) {
  return pair.tier === 'region' ? '同字号不同地区' : pair.tier === 'core' ? '同字号' : '写法相近';
}

// 一对企业的忽略标记与两家谁在前无关：合并后、重跑后都认得出是同一对
function similarPairKey(keyA, keyB) {
  return [String(keyA || ''), String(keyB || '')].sort().join('<->');
}

function compareStableText(a, b) {
  const left = String(a === null || a === undefined ? '' : a);
  const right = String(b === null || b === undefined ? '' : b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

// ===== 结果指纹与 SHA-256 =====

function fingerprintRowRefs(rows) {
  return (rows || [])
    .map((row) => `${row.sourceShortLabel || row.sourceLabel || ''}#${row.rowNo}`)
    .sort(compareStableText);
}

// 对账结果指纹：同一批数据、同样的配对采用情况，每次算出来都一样。
// 只覆盖结果本身（金额、分档、取数核对、容差与账龄基准日），不含差异说明和签字信息。
function buildResultFingerprint(groups) {
  const list = Array.isArray(groups) ? groups : (state.groups || []);
  const controls = (state.controls || []).map((control) => [
    control.sheetName || '',
    control.rawCents,
    control.includedCents,
    control.skippedCents,
    control.outsideCents,
    control.unmatchedCents,
    control.rawCells,
    control.includedCells,
    control.skippedCells,
    control.outsideCells,
    control.unmatchedCells
  ]).sort((a, b) => compareStableText(a[0], b[0]) || a[1] - b[1]);

  const settings = [
    1,
    state.pairToleranceCents,
    state.pairPercent,
    ageBaseDateValue(),
    state.records.length,
    state.skipped.length,
    state.reclassRows.length,
    state.redRows.length,
    state.inheritedRows,
    state.directionFallbackRows,
    state.outOfRangeRows,
    controls
  ];
  if (state.ageBandPreset !== 'year') settings.push(state.ageBandPreset);

  const groupRows = list.slice().sort((a, b) => compareStableText(a.key, b.key)).map((group) => {
    const rows = (group.rows || []).slice().sort((a, b) => (
      compareStableText(a.sourceShortLabel, b.sourceShortLabel)
      || a.rowNo - b.rowNo
      || compareStableText(a.dir, b.dir)
      || a.cents - b.cents
    )).map((row) => [
      row.rowNo,
      row.dir,
      row.cents,
      row.rawCents,
      row.companyRaw || '',
      row.memo || '',
      row.sourceShortLabel || '',
      row.sourceLabel || '',
      row.reclassified ? 1 : 0,
      row.redFlipped ? 1 : 0,
      row.hasAgeColumn ? row.ageShown : -2,
      (row.flags || []).slice().sort(compareStableText).join(',')
    ]);

    const pairings = (group.pairings || []).map((pairing) => [
      pairing.kind,
      pairing.recvCents,
      pairing.payCents,
      pairing.diffCents,
      pairing.decision || 'pending',
      fingerprintRowRefs(pairing.recvRows),
      fingerprintRowRefs(pairing.payRows)
    ]);
    const docs = (group.docHints || [])
      .map((hint) => [hint.docNo, hint.recvCents, hint.payCents, hint.diffCents])
      .sort((a, b) => compareStableText(a[0], b[0]) || a[1] - b[1]);
    const memo = (group.memoKeyHints || [])
      .map((hint) => [hint.label, hint.value, hint.recvCents, hint.payCents, hint.diffCents])
      .sort((a, b) => compareStableText(a[0], b[0]) || compareStableText(a[1], b[1]) || a[2] - b[2]);
    const age = group.ageStats
      ? [
        group.ageStats.recv.map((cell) => cell.cents),
        group.ageStats.pay.map((cell) => cell.cents),
        group.ageStats.recvUnknown ? group.ageStats.recvUnknown.cents : 0,
        group.ageStats.payUnknown ? group.ageStats.payUnknown.cents : 0
      ]
      : null;

    const entry = [
      group.key,
      group.displayName,
      group.recvCents,
      group.payCents,
      group.netCents,
      rows,
      pairings,
      docs,
      memo,
      age
    ];
    // 没有主体/币种列时不追加，保证旧底稿的指纹不变。
    if (list.some((item) => item.entityKey || item.currencyKey)) {
      entry.push(group.entityLabel || '', group.currencyLabel || '', group.entityKey || '', group.currencyKey || '');
    }
    return entry;
  });

  return sha256Hex(JSON.stringify([settings, groupRows]));
}

function renderFingerprint() {
  if (!els.fingerprintLine) return '';
  if (!state.groups.length) {
    els.fingerprintLine.innerHTML = '';
    return '';
  }
  const fingerprint = buildResultFingerprint(state.groups);
  const short = `${fingerprint.slice(0, 16)}…`;
  els.fingerprintLine.innerHTML = `
    <span class="fp-label">结果指纹</span>
    <code title="${fingerprint}">${short}</code>
    <button type="button" class="fp-copy" data-fp-copy="${fingerprint}">复制完整指纹</button>
    <span class="fp-note">同一批数据每次算出来都一样；改金额、账龄基准日或配对采用情况会变，改差异说明和签字信息不变。</span>
  `;
  return fingerprint;
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function utf8Bytes(text) {
  const value = String(text);
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value);
  const encoded = unescape(encodeURIComponent(value));
  const bytes = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i += 1) bytes[i] = encoded.charCodeAt(i);
  return bytes;
}

function sha256Hex(text) {
  return sha256BytesHex(utf8Bytes(text));
}

function sha256BytesHex(source) {
  const bytes = ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
  const length = bytes.length;
  const padded = new Uint8Array((((length + 9) + 63) >> 6) << 6);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(padded.length - 4, (length << 3) >>> 0);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);
  const rotr = (value, bits) => (value >>> bits) | (value << (32 - bits));

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(words[i - 15], 7) ^ rotr(words[i - 15], 18) ^ (words[i - 15] >>> 3);
      const s1 = rotr(words[i - 2], 17) ^ rotr(words[i - 2], 19) ^ (words[i - 2] >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[i] + words[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((value) => value.toString(16).padStart(8, '0'))
    .join('');
}

/* ---------- 底稿快照：保存本次结果、下次导入后比对 ---------- */

// ===== 底稿快照与结果比对 =====

function snapshotVersionLabel() {
  const text = els.appVersion ? String(els.appVersion.textContent || '').trim() : '';
  return text && text.indexOf('__APP_VERSION__') === -1 ? text : APP_VERSION_FALLBACK;
}

function snapshotDecisionCountsOf(pairings) {
  const counts = { accepted: 0, rejected: 0, pending: 0 };
  (pairings || []).forEach((pairing) => {
    const key = pairing.decision === 'accepted' || pairing.decision === 'rejected' ? pairing.decision : 'pending';
    counts[key] += 1;
  });
  return counts;
}

function snapshotEntryFromGroup(group) {
  const decisions = snapshotDecisionCountsOf(group.pairings);
  const aliases = Array.from(new Set(
    (group.variantList || []).map((variant) => String(variant[0] || '').trim()).filter(Boolean)
  )).sort(compareStableText);
  const entry = {
    key: String(group.key || ''),
    name: String(group.displayName || ''),
    aliases,
    recvCents: Math.round(group.recvCents || 0),
    payCents: Math.round(group.payCents || 0),
    netCents: Math.round(group.netCents || 0),
    records: (group.rows || []).length,
    flags: (group.flags || []).slice().sort(compareStableText),
    accepted: decisions.accepted,
    rejected: decisions.rejected,
    pending: decisions.pending,
    note: state.groupNotes.has(group.key) ? String(state.groupNotes.get(group.key) || '') : ''
  };
  // 没有主体/币种列时不写这两个字段，旧快照与新快照保持同一种形状。
  if (group.entityLabel || group.entityKey) {
    entry.entity = String(group.entityLabel || '');
    entry.entityKey = String(group.entityKey || '');
  }
  if (group.currencyLabel || group.currencyKey) {
    entry.currency = String(group.currencyLabel || '');
    entry.currencyKey = String(group.currencyKey || '');
  }
  return entry;
}

function buildSnapshotPayload(groups, fingerprintOverride) {
  const list = Array.isArray(groups) ? groups : (state.groups || []);
  const companies = list.map(snapshotEntryFromGroup).sort((a, b) => compareStableText(a.key, b.key));
  const decisions = { accepted: 0, rejected: 0, pending: 0 };
  let grossRecvCents = 0;
  let grossPayCents = 0;
  let netRecvCents = 0;
  let netPayCents = 0;
  let evenGroups = 0;
  let pairCount = 0;
  const currencyMap = new Map();

  list.forEach((group) => {
    grossRecvCents += group.recvCents || 0;
    grossPayCents += group.payCents || 0;
    if (group.netCents > 0) netRecvCents += group.netCents;
    if (group.netCents < 0) netPayCents += Math.abs(group.netCents);
    if (group.netCents === 0) evenGroups += 1;
    pairCount += (group.pairings || []).length;
    if (group.currencyKey) {
      if (!currencyMap.has(group.currencyKey)) {
        currencyMap.set(group.currencyKey, {
          key: group.currencyKey,
          label: group.currencyLabel || currencyLabelForKey(group.currencyKey, group.currencyKey),
          grossRecvCents: 0,
          grossPayCents: 0,
          netRecvCents: 0,
          netPayCents: 0
        });
      }
      const bucket = currencyMap.get(group.currencyKey);
      bucket.grossRecvCents += group.recvCents || 0;
      bucket.grossPayCents += group.payCents || 0;
      if (group.netCents > 0) bucket.netRecvCents += group.netCents;
      if (group.netCents < 0) bucket.netPayCents += Math.abs(group.netCents);
    }
  });
  const currencyTotals = Array.from(currencyMap.values()).sort((a, b) => compareStableText(a.key, b.key));
  companies.forEach((entry) => {
    decisions.accepted += entry.accepted;
    decisions.rejected += entry.rejected;
    decisions.pending += entry.pending;
  });

  return {
    appVersion: snapshotVersionLabel(),
    createdAt: formatDateTime(new Date()),
    fingerprint: fingerprintOverride || buildResultFingerprint(list),
    mode: state.runInfo && state.runInfo.mode ? String(state.runInfo.mode) : 'excel',
    settings: {
      toleranceCents: state.pairToleranceCents,
      pairPercent: state.pairPercent,
      ageBaseDate: ageBaseDateValue(),
      ageBandPreset: state.ageBandPreset
    },
    totals: {
      companies: companies.length,
      records: state.records.length,
      grossRecvCents,
      grossPayCents,
      netRecvCents,
      netPayCents,
      evenGroups,
      pairCount,
      accepted: decisions.accepted,
      rejected: decisions.rejected,
      pending: decisions.pending,
      ...(currencyTotals.length ? { mixedCurrency: currencyTotals.length > 1, currencyTotals } : {})
    },
    companies
  };
}

function buildSnapshotFile(groups) {
  const payload = buildSnapshotPayload(groups);
  return {
    format: SNAPSHOT_FORMAT,
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    savedAt: new Date().toISOString(),
    sha256: sha256Hex(JSON.stringify(payload)),
    payload
  };
}

function sanitizeSnapshotPayload(payload) {
  const settings = payload.settings && typeof payload.settings === 'object' ? payload.settings : {};
  const totals = payload.totals && typeof payload.totals === 'object' ? payload.totals : {};
  const numberOrZero = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number) : 0;
  };
  const currencyTotals = Array.isArray(totals.currencyTotals)
    ? totals.currencyTotals.slice(0, 40).map((bucket) => ({
      key: String((bucket && bucket.key) || ''),
      label: String((bucket && bucket.label) || ''),
      grossRecvCents: numberOrZero(bucket && bucket.grossRecvCents),
      grossPayCents: numberOrZero(bucket && bucket.grossPayCents),
      netRecvCents: numberOrZero(bucket && bucket.netRecvCents),
      netPayCents: numberOrZero(bucket && bucket.netPayCents)
    })).filter((bucket) => bucket.key)
    : [];
  return {
    appVersion: String(payload.appVersion || ''),
    createdAt: String(payload.createdAt || ''),
    fingerprint: /^[0-9a-f]{64}$/i.test(String(payload.fingerprint || '')) ? String(payload.fingerprint).toLowerCase() : '',
    mode: String(payload.mode || ''),
    settings: {
      toleranceCents: numberOrZero(settings.toleranceCents),
      pairPercent: Number(settings.pairPercent) || 0,
      ageBaseDate: String(settings.ageBaseDate || ''),
      ageBandPreset: settings.ageBandPreset === 'half' ? 'half' : 'year'
    },
    totals: {
      companies: numberOrZero(totals.companies),
      records: numberOrZero(totals.records),
      grossRecvCents: numberOrZero(totals.grossRecvCents),
      grossPayCents: numberOrZero(totals.grossPayCents),
      netRecvCents: numberOrZero(totals.netRecvCents),
      netPayCents: numberOrZero(totals.netPayCents),
      evenGroups: numberOrZero(totals.evenGroups),
      pairCount: numberOrZero(totals.pairCount),
      accepted: numberOrZero(totals.accepted),
      rejected: numberOrZero(totals.rejected),
      pending: numberOrZero(totals.pending),
      ...(currencyTotals.length ? { mixedCurrency: Boolean(totals.mixedCurrency) || currencyTotals.length > 1, currencyTotals } : {})
    },
    companies: payload.companies.slice(0, SNAPSHOT_MAX_COMPANIES).map((entry) => ({
      key: String(entry.key || ''),
      name: String(entry.name || ''),
      aliases: Array.isArray(entry.aliases) ? entry.aliases.map((alias) => String(alias || '')).filter(Boolean) : [],
      recvCents: numberOrZero(entry.recvCents),
      payCents: numberOrZero(entry.payCents),
      netCents: numberOrZero(entry.netCents),
      records: numberOrZero(entry.records),
      flags: Array.isArray(entry.flags) ? entry.flags.map((flag) => String(flag || '')).filter(Boolean) : [],
      accepted: numberOrZero(entry.accepted),
      rejected: numberOrZero(entry.rejected),
      pending: numberOrZero(entry.pending),
      entity: String(entry.entity || ''),
      entityKey: String(entry.entityKey || ''),
      currency: String(entry.currency || ''),
      currencyKey: String(entry.currencyKey || ''),
      note: String(entry.note || '')
    }))
  };
}

function validateSnapshotFile(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, message: '这个文件不是底稿快照，请选「保存本次快照」下载的 .json 文件' };
  }
  if (parsed.format !== SNAPSHOT_FORMAT) {
    return { ok: false, message: '这不是本工具保存的底稿快照，请选「保存本次快照」下载的 .json 文件' };
  }
  if (Number(parsed.formatVersion) !== SNAPSHOT_FORMAT_VERSION) {
    return { ok: false, message: '这份快照来自另一个版本的工具；请用保存它的那一版打开比对' };
  }
  const payload = parsed.payload;
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.companies)) {
    return { ok: false, message: '快照内容不完整，请重新保存一份再比对' };
  }
  if (payload.companies.length > SNAPSHOT_MAX_COMPANIES) {
    return { ok: false, message: '这份快照的企业数量异常，暂时不能读入' };
  }
  const broken = payload.companies.some((entry) => (
    !entry || typeof entry !== 'object' || !entry.key || !entry.name
    || !Number.isFinite(Number(entry.recvCents))
    || !Number.isFinite(Number(entry.payCents))
    || !Number.isFinite(Number(entry.netCents))
  ));
  if (broken) {
    return { ok: false, message: '快照里有读不懂的企业记录，请重新保存一份再比对' };
  }
  const expected = sha256Hex(JSON.stringify(payload));
  if (String(parsed.sha256 || '').toLowerCase() !== expected) {
    return { ok: false, message: '快照内容和自带的校验码对不上，文件可能被改过；请换回原始快照文件' };
  }
  return { ok: true, payload: sanitizeSnapshotPayload(payload) };
}

function snapshotShortText(value, length = 40) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) return '（空）';
  return `「${truncate(text, length)}」`;
}

function snapshotFlagLabel(flag) {
  const definition = FLAG_DEFS[flag];
  return definition ? definition.label : flag;
}

function snapshotDecisionText(entry) {
  return `采纳 ${entry.accepted} / 不采纳 ${entry.rejected} / 待确认 ${entry.pending}`;
}

function snapshotCompanyChanges(baseline, current, matchedBy) {
  const details = [];
  let amountChanged = false;
  let decisionChanged = false;
  let noteChanged = false;
  const money = (cents) => fmtMoneyIn(cents, current.currencyKey || baseline.currencyKey);

  if (baseline.recvCents !== current.recvCents) {
    details.push(`应收 ${money(baseline.recvCents)} → ${money(current.recvCents)}`);
    amountChanged = true;
  }
  if (baseline.payCents !== current.payCents) {
    details.push(`应付 ${money(baseline.payCents)} → ${money(current.payCents)}`);
    amountChanged = true;
  }
  if (baseline.netCents !== current.netCents) {
    details.push(`净额 ${money(baseline.netCents)} → ${money(current.netCents)}`);
    amountChanged = true;
  }
  if (baseline.records !== current.records) {
    details.push(`记录 ${baseline.records} 笔 → ${current.records} 笔`);
    amountChanged = true;
  }

  const decisionParts = [];
  if (baseline.accepted !== current.accepted) decisionParts.push(`采纳 ${baseline.accepted} → ${current.accepted}`);
  if (baseline.rejected !== current.rejected) decisionParts.push(`不采纳 ${baseline.rejected} → ${current.rejected}`);
  if (baseline.pending !== current.pending) decisionParts.push(`待确认 ${baseline.pending} → ${current.pending}`);
  if (decisionParts.length) {
    details.push(`配对确认：${decisionParts.join('、')}`);
    decisionChanged = true;
  }

  if ((baseline.note || '') !== (current.note || '')) {
    details.push(`差异说明：${snapshotShortText(baseline.note)} → ${snapshotShortText(current.note)}`);
    noteChanged = true;
  }
  if (baseline.name !== current.name) {
    details.push(`名称写法：「${baseline.name}」→「${current.name}」`);
  }

  const addedFlags = current.flags.filter((flag) => baseline.flags.indexOf(flag) === -1);
  const removedFlags = baseline.flags.filter((flag) => current.flags.indexOf(flag) === -1);
  if (addedFlags.length) details.push(`多了标记：${addedFlags.map(snapshotFlagLabel).join('、')}`);
  if (removedFlags.length) details.push(`少了标记：${removedFlags.map(snapshotFlagLabel).join('、')}`);

  if (!details.length) {
    if (matchedBy === 'alias') details.push('已按原始名称对上：名称写法或人工并归变过');
    else return null;
  }

  let kind = 'other';
  if (amountChanged) kind = 'amount';
  else if (decisionChanged) kind = 'decision';
  else if (noteChanged) kind = 'note';
  return { kind, details };
}

function snapshotToleranceText(cents) {
  return `${(Math.round(Number(cents) || 0) / 100).toFixed(2)} 元`;
}

function snapshotPercentText(value) {
  return Number(value) ? `${formatPercentInput(value)}%` : '不用比例';
}

function snapshotSettingChanges(baselinePayload, currentPayload) {
  const baseline = baselinePayload.settings || {};
  const current = currentPayload.settings || {};
  const changes = [];
  if (Math.round(baseline.toleranceCents || 0) !== Math.round(current.toleranceCents || 0)) {
    changes.push(`核销容差 ${snapshotToleranceText(baseline.toleranceCents)} → ${snapshotToleranceText(current.toleranceCents)}`);
  }
  if (Math.abs((Number(baseline.pairPercent) || 0) - (Number(current.pairPercent) || 0)) > 0.000001) {
    changes.push(`比例容差 ${snapshotPercentText(baseline.pairPercent)} → ${snapshotPercentText(current.pairPercent)}`);
  }
  if ((baseline.ageBaseDate || '') !== (current.ageBaseDate || '')) {
    changes.push(`账龄算到 ${baseline.ageBaseDate || '（没设置）'} → ${current.ageBaseDate || '（没设置）'}`);
  }
  const beforePreset = AGE_BAND_PRESETS[baseline.ageBandPreset] ? baseline.ageBandPreset : 'year';
  const afterPreset = AGE_BAND_PRESETS[current.ageBandPreset] ? current.ageBandPreset : 'year';
  if (beforePreset !== afterPreset) {
    changes.push(`账龄档位 ${AGE_BAND_PRESETS[beforePreset].label} → ${AGE_BAND_PRESETS[afterPreset].label}`);
  }
  return changes;
}

function snapshotTotalChanges(baseline, current) {
  const changes = [];
  const baselineCurrencies = Array.isArray(baseline.currencyTotals) ? baseline.currencyTotals : [];
  const currentCurrencies = Array.isArray(current.currencyTotals) ? current.currencyTotals : [];
  const mixed = baselineCurrencies.length > 1 || currentCurrencies.length > 1;
  const simpleChange = (key, label, unit) => {
    const before = Math.round(Number(baseline[key]) || 0);
    const after = Math.round(Number(current[key]) || 0);
    if (before === after) return;
    changes.push(`${label} ${before}${unit} → ${after}${unit}`);
  };
  const moneyFields = [
    ['grossRecvCents', '应收发生额'],
    ['grossPayCents', '应付发生额'],
    ['netRecvCents', '净应收合计'],
    ['netPayCents', '净应付合计']
  ];

  simpleChange('companies', '企业数', ' 家');
  simpleChange('records', '记录笔数', ' 笔');

  if (mixed) {
    const keys = Array.from(new Set(
      baselineCurrencies.concat(currentCurrencies).map((bucket) => String((bucket && bucket.key) || ''))
    )).sort(compareStableText);
    keys.forEach((key) => {
      const before = baselineCurrencies.find((bucket) => bucket.key === key) || {};
      const after = currentCurrencies.find((bucket) => bucket.key === key) || {};
      const label = before.label || after.label || currencyLabelForKey(key, key);
      moneyFields.forEach(([field, name]) => {
        const beforeCents = Math.round(Number(before[field]) || 0);
        const afterCents = Math.round(Number(after[field]) || 0);
        if (beforeCents === afterCents) return;
        changes.push(`${name}（${label}） ${fmtMoneyIn(beforeCents, key)} → ${fmtMoneyIn(afterCents, key)}`);
      });
    });
  } else {
    const currencyKey = (baselineCurrencies[0] || currentCurrencies[0] || {}).key || '';
    moneyFields.forEach(([field, label]) => {
      const before = Math.round(Number(baseline[field]) || 0);
      const after = Math.round(Number(current[field]) || 0);
      if (before === after) return;
      changes.push(`${label} ${fmtMoneyIn(before, currencyKey)} → ${fmtMoneyIn(after, currencyKey)}`);
    });
  }

  simpleChange('evenGroups', '已轧平', ' 家');
  simpleChange('pairCount', '自动核销', ' 组');
  simpleChange('accepted', '采纳', ' 组');
  simpleChange('rejected', '不采纳', ' 组');
  simpleChange('pending', '待确认', ' 组');
  return changes;
}

function snapshotKindLabel(kind) {
  if (kind === 'amount') return '金额/笔数';
  if (kind === 'added') return '新增企业';
  if (kind === 'removed') return '少了企业';
  if (kind === 'decision') return '配对确认';
  if (kind === 'note') return '差异说明';
  return '名称/标记';
}

function snapshotItemWeight(item) {
  if (item.kind === 'amount' && item.baseline && item.current) {
    return Math.abs(item.current.netCents - item.baseline.netCents) + Math.abs(item.current.recvCents - item.baseline.recvCents);
  }
  const entry = item.current || item.baseline;
  return entry ? Math.abs(entry.netCents) : 0;
}

function snapshotSameDimensions(a, b) {
  return (a.entityKey || '') === (b.entityKey || '') && (a.currencyKey || '') === (b.currencyKey || '');
}

function compareSnapshotPayload(baselinePayload, currentPayload) {
  const baselineEntries = baselinePayload.companies || [];
  const currentEntries = currentPayload.companies || [];
  const currentByKey = new Map();
  currentEntries.forEach((entry) => {
    if (!currentByKey.has(entry.key)) currentByKey.set(entry.key, entry);
  });

  const matches = [];
  const matchedBaseline = new Set();
  const matchedCurrent = new Set();

  baselineEntries.forEach((entry) => {
    const target = currentByKey.get(entry.key);
    if (!target || matchedCurrent.has(target)) return;
    matches.push({ baseline: entry, current: target, matchedBy: 'key' });
    matchedBaseline.add(entry);
    matchedCurrent.add(target);
  });

  const remainingCurrent = currentEntries.filter((entry) => !matchedCurrent.has(entry));
  baselineEntries.forEach((entry) => {
    if (matchedBaseline.has(entry)) return;
    const targetName = normalizeName(entry.name);
    const index = remainingCurrent.findIndex((candidate) => (
      snapshotSameDimensions(entry, candidate) && normalizeName(candidate.name) === targetName
    ));
    if (index === -1) return;
    const target = remainingCurrent.splice(index, 1)[0];
    matches.push({ baseline: entry, current: target, matchedBy: 'name' });
    matchedBaseline.add(entry);
    matchedCurrent.add(target);
  });

  baselineEntries.forEach((entry) => {
    if (matchedBaseline.has(entry)) return;
    const baselineNames = new Set(
      [entry.name].concat(entry.aliases || []).map((name) => normalizeName(name)).filter(Boolean)
    );
    const matchesAlias = (candidate) => (
      snapshotSameDimensions(entry, candidate)
      && [candidate.name].concat(candidate.aliases || [])
        .map((name) => normalizeName(name))
        .some((name) => name && baselineNames.has(name))
    );

    const index = remainingCurrent.findIndex(matchesAlias);
    if (index !== -1) {
      const target = remainingCurrent.splice(index, 1)[0];
      matches.push({ baseline: entry, current: target, matchedBy: 'alias' });
      matchedBaseline.add(entry);
      matchedCurrent.add(target);
      return;
    }

    // 人工并归会把两家并成一家：旧企业名只留在这家的原始写法里，不再单独算作“少了”。
    const existing = matches.find((match) => matchesAlias(match.current));
    if (!existing) return;
    existing.mergedFrom = existing.mergedFrom || [];
    existing.mergedFrom.push(entry.name);
    matchedBaseline.add(entry);
  });

  const items = [];
  matches.forEach(({ baseline, current, matchedBy, mergedFrom }) => {
    const change = snapshotCompanyChanges(baseline, current, matchedBy);
    const mergedNames = mergedFrom || [];
    if (!change && !mergedNames.length) return;
    const details = change ? change.details.slice() : [];
    if (mergedNames.length) details.push(`「${mergedNames.join('」「')}」已经并进这家（人工并归）`);
    items.push({
      kind: change ? change.kind : 'other',
      name: current.name || baseline.name,
      baseline,
      current,
      detail: details.join('；')
    });
  });

  baselineEntries.forEach((entry) => {
    if (matchedBaseline.has(entry)) return;
    items.push({
      kind: 'removed',
      name: entry.name,
      baseline: entry,
      current: null,
      detail: `少了这家：应收 ${fmtMoneyIn(entry.recvCents, entry.currencyKey)} / 应付 ${fmtMoneyIn(entry.payCents, entry.currencyKey)} / 净额 ${fmtMoneyIn(entry.netCents, entry.currencyKey)}（${entry.records} 笔）`
    });
  });

  currentEntries.forEach((entry) => {
    if (matchedCurrent.has(entry)) return;
    items.push({
      kind: 'added',
      name: entry.name,
      baseline: null,
      current: entry,
      detail: `新增这家：应收 ${fmtMoneyIn(entry.recvCents, entry.currencyKey)} / 应付 ${fmtMoneyIn(entry.payCents, entry.currencyKey)} / 净额 ${fmtMoneyIn(entry.netCents, entry.currencyKey)}（${entry.records} 笔）`
    });
  });

  const priority = { amount: 0, added: 1, removed: 2, decision: 3, note: 4, other: 5 };
  items.sort((a, b) => (
    (priority[a.kind] - priority[b.kind])
    || (snapshotItemWeight(b) - snapshotItemWeight(a))
    || compareStableText(a.name, b.name)
  ));

  const counts = { total: items.length, amount: 0, added: 0, removed: 0, decision: 0, note: 0, other: 0 };
  items.forEach((item) => { counts[item.kind] += 1; });

  return {
    items,
    counts,
    settingChanges: snapshotSettingChanges(baselinePayload, currentPayload),
    totalChanges: snapshotTotalChanges(baselinePayload.totals || {}, currentPayload.totals || {}),
    sameFingerprint: Boolean(
      baselinePayload.fingerprint
      && currentPayload.fingerprint
      && baselinePayload.fingerprint === currentPayload.fingerprint
    )
  };
}

function snapshotBaselineLabel() {
  if (!snapshotBaseline) return '';
  const payload = snapshotBaseline.payload;
  const when = payload.createdAt || '没写保存时间';
  if (snapshotBaseline.source === 'imported') {
    return `导入的 ${snapshotBaseline.fileName || '快照文件'}（${when} 保存）`;
  }
  return `本次保存的快照（${when}）`;
}

function snapshotHeadline(comparison) {
  const parts = [];
  if (comparison.counts.amount) parts.push(`金额/笔数 ${comparison.counts.amount} 家`);
  if (comparison.counts.added) parts.push(`新增 ${comparison.counts.added} 家`);
  if (comparison.counts.removed) parts.push(`少了 ${comparison.counts.removed} 家`);
  if (comparison.counts.decision) parts.push(`配对确认 ${comparison.counts.decision} 家`);
  if (comparison.counts.note) parts.push(`差异说明 ${comparison.counts.note} 家`);
  if (comparison.counts.other) parts.push(`名称/标记 ${comparison.counts.other} 家`);
  if (comparison.settingChanges.length) parts.push(`设置 ${comparison.settingChanges.length} 项`);
  return parts.join(' · ');
}

function renderSnapshotComparison(fingerprintOverride) {
  if (!els.snapshotDiff) return;
  if (!state.groups.length || !state.stats || !snapshotBaseline) {
    els.snapshotDiff.innerHTML = '';
    els.snapshotDiff.classList.add('hidden');
    snapshotComparison = null;
    return;
  }

  const current = buildSnapshotPayload(state.groups, fingerprintOverride);
  const comparison = compareSnapshotPayload(snapshotBaseline.payload, current);
  snapshotComparison = {
    baseline: snapshotBaseline.payload,
    current,
    items: comparison.items,
    counts: comparison.counts,
    settingChanges: comparison.settingChanges,
    totalChanges: comparison.totalChanges,
    sameFingerprint: comparison.sameFingerprint
  };

  const hasResultChanges = comparison.counts.amount + comparison.counts.added
    + comparison.counts.removed + comparison.counts.decision > 0;
  const identical = !comparison.items.length
    && !comparison.settingChanges.length
    && !comparison.totalChanges.length;
  const tone = identical ? 'ok' : (hasResultChanges ? 'changed' : 'minor');
  const headline = identical
    ? (comparison.sameFingerprint ? '和快照完全一致：金额、配对确认、差异说明都没变' : '和快照比没有企业级变化')
    : (hasResultChanges
      ? `和快照比有变化：${snapshotHeadline(comparison) || `${comparison.totalChanges.length} 项合计变化`}`
      : `金额和配对结果没变，只有说明或设置变化：${snapshotHeadline(comparison) || `${comparison.settingChanges.length} 项设置变化`}`);

  const settingsHtml = comparison.settingChanges.length
    ? `<div class="snapshot-settings"><b>设置变了</b><span>${escapeHtml(comparison.settingChanges.join('；'))}</span></div>`
    : '';
  const totalsHtml = comparison.totalChanges.length
    ? `<div class="snapshot-settings"><b>合计变了</b><span>${escapeHtml(comparison.totalChanges.join('；'))}</span></div>`
    : '';
  const versionNote = snapshotBaseline.payload.appVersion
    && snapshotBaseline.payload.appVersion !== current.appVersion
    ? `<p class="snapshot-version">这份快照是 ${escapeHtml(snapshotBaseline.payload.appVersion)} 保存的，现在是 ${escapeHtml(current.appVersion)}；两个版本的口径可能不同，请留意。</p>`
    : '';

  const shown = comparison.items.slice(0, SNAPSHOT_MAX_SHOWN);
  const rows = shown.map((item) => {
    const dimEntry = item.current || item.baseline || {};
    const dimLabel = [dimEntry.entity, dimEntry.currency].filter(Boolean).join(' · ');
    return `
    <tr class="snap-row snap-${item.kind}">
      <td>${escapeHtml(item.name)}${dimLabel ? ` <span class="dim-badge">${escapeHtml(dimLabel)}</span>` : ''}</td>
      <td><span class="snapshot-kind kind-${item.kind}">${escapeHtml(snapshotKindLabel(item.kind))}</span></td>
      <td>${escapeHtml(item.detail)}</td>
    </tr>
  `;
  }).join('');

  const tableHtml = shown.length
    ? `<div class="snapshot-table-wrap">
        <table class="snapshot-table">
          <thead><tr><th>企业名称</th><th>变化</th><th>具体</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${comparison.items.length > shown.length
        ? `<p class="snapshot-more">还有 ${comparison.items.length - shown.length} 处没显示，点「导出比对结果」看全部。</p>`
        : ''}`
    : (identical
      ? '<p class="snapshot-empty">不需要处理。</p>'
      : '<p class="snapshot-empty">企业级金额、笔数、配对确认和差异说明都没变。</p>');

  els.snapshotDiff.innerHTML = `
    <div class="snapshot-summary ${tone}">
      <b>${escapeHtml(headline)}</b>
      <span class="snapshot-meta">基准：${escapeHtml(snapshotBaselineLabel())}${baselineShortFingerprint() ? ` · 指纹 ${baselineShortFingerprint()}` : ''}</span>
    </div>
    ${settingsHtml}
    ${totalsHtml}
    ${versionNote}
    ${tableHtml}
    <div class="snapshot-actions">
      <button type="button" class="btn btn-secondary" data-snap-export${comparison.items.length ? '' : ' disabled'}>导出比对结果</button>
      <button type="button" class="btn btn-secondary" data-snap-clear>不用这份快照</button>
    </div>
  `;
  els.snapshotDiff.classList.remove('hidden');
}

function baselineShortFingerprint() {
  if (!snapshotBaseline || !snapshotBaseline.payload.fingerprint) return '';
  return `${snapshotBaseline.payload.fingerprint.slice(0, 16)}…`;
}

function scheduleSnapshotRefresh() {
  if (!snapshotBaseline || !els.snapshotDiff) return;
  clearTimeout(snapshotRefreshTimer);
  snapshotRefreshTimer = setTimeout(() => {
    snapshotRefreshTimer = null;
    renderSnapshotComparison();
  }, 350);
}

function saveSnapshotFile() {
  if (!state.groups.length) {
    showToast('还没有对账结果，先跑完对账再保存快照', true);
    return;
  }
  let file;
  try {
    file = buildSnapshotFile(state.groups);
  } catch (error) {
    console.error(error);
    showToast('快照生成失败，请刷新页面后再试', true);
    return;
  }

  const fileName = `${exportFileBase()}_底稿快照_${formatFileStamp(new Date())}.json`;
  try {
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (error) {
    showToast('这台电脑不让下载文件，请换 Edge 或 Chrome 再试', true);
    return;
  }

  snapshotBaseline = { payload: file.payload, source: 'saved', fileName, importedAt: new Date() };
  renderSnapshotComparison();
  showToast('快照已下载（含企业名称和金额，请按底稿保管）；页面也记住了它，接下来改动会自动和它比');
}

async function importSnapshotFile(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  if (!file) return;
  input.value = '';
  if (file.size > SNAPSHOT_MAX_BYTES) {
    showToast('这个快照文件太大了，正常的底稿快照只有几十 KB', true);
    return;
  }

  let text;
  try {
    text = await file.text();
  } catch (error) {
    showToast('这个文件读不出来，请换一份再试', true);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch (error) {
    showToast('这个文件不是底稿快照，请选「保存本次快照」下载的 .json 文件', true);
    return;
  }

  const result = validateSnapshotFile(parsed);
  if (!result.ok) {
    showToast(result.message, true);
    return;
  }

  snapshotBaseline = {
    payload: result.payload,
    source: 'imported',
    fileName: file.name,
    importedAt: new Date()
  };

  if (!state.groups.length) {
    renderSnapshotComparison();
    showToast('快照已读入；等这次对账跑完就会自动和它比');
    return;
  }

  renderSnapshotComparison();
  const comparison = snapshotComparison;
  if (!comparison) {
    showToast('快照已读入');
    return;
  }
  if (!comparison.items.length && !comparison.settingChanges.length) {
    showToast('快照已读入：和现在的结果一致');
  } else {
    showToast(
      `快照已读入：${comparison.items.length} 处企业变化${comparison.settingChanges.length ? `、${comparison.settingChanges.length} 项设置变化` : ''}`
    );
  }
  if (els.snapshotDiff) els.snapshotDiff.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearSnapshot() {
  clearTimeout(snapshotRefreshTimer);
  snapshotRefreshTimer = null;
  snapshotBaseline = null;
  snapshotComparison = null;
  if (els.snapshotDiff) {
    els.snapshotDiff.innerHTML = '';
    els.snapshotDiff.classList.add('hidden');
  }
  if (els.snapshotInput) els.snapshotInput.value = '';
  showToast('已不再使用这份快照；可以重新保存或换一份');
}

function exportSnapshotComparison() {
  if (!snapshotComparison || !snapshotComparison.items.length) {
    showToast('现在没有可导出的变化', true);
    return;
  }
  if (typeof XLSX === 'undefined') {
    showToast('Excel 解析库未加载，无法导出比对结果', true);
    return;
  }

  const comparison = snapshotComparison;
  const hasDims = comparison.items.some((item) => {
    const entry = item.current || item.baseline;
    return Boolean(entry && (entry.entityKey || entry.currencyKey));
  });
  const dimHeaders = hasDims ? ['主体', '币种'] : [];
  const moneyStart = 2 + dimHeaders.length;
  const rows = [
    ['双边对账底稿比对'],
    ['当前结果时间', comparison.current.createdAt],
    ['基准快照', snapshotBaselineLabel()],
    ['基准保存时间', comparison.baseline.createdAt || ''],
    ['基准快照版本', comparison.baseline.appVersion || ''],
    ['当前结果指纹', comparison.current.fingerprint],
    ['快照结果指纹', comparison.baseline.fingerprint || ''],
    ['指纹是否一致', comparison.sameFingerprint ? '一致' : '不一致'],
    ['设置变化', comparison.settingChanges.join('；') || '没有变化'],
    ['合计变化', comparison.totalChanges.join('；') || '没有变化'],
    ['数据说明', '只比较结果本身；文件含企业名称和金额，请按底稿保管。'],
    [],
    ['企业名称', ...dimHeaders, '变化', '应收（快照）', '应收（现在）', '应付（快照）', '应付（现在）', '净额（快照）', '净额（现在）', '笔数（快照）', '笔数（现在）', '配对确认（快照）', '配对确认（现在）', '差异说明（快照）', '差异说明（现在）', '具体变化']
  ];

  comparison.items.forEach((item) => {
    const before = item.baseline;
    const after = item.current;
    const dimSource = after || before;
    rows.push([
      item.name,
      ...(hasDims ? [dimSource.entity || '', dimSource.currency || ''] : []),
      snapshotKindLabel(item.kind),
      before ? before.recvCents / 100 : '',
      after ? after.recvCents / 100 : '',
      before ? before.payCents / 100 : '',
      after ? after.payCents / 100 : '',
      before ? before.netCents / 100 : '',
      after ? after.netCents / 100 : '',
      before ? before.records : '',
      after ? after.records : '',
      before ? snapshotDecisionText(before) : '',
      after ? snapshotDecisionText(after) : '',
      before ? before.note : '',
      after ? after.note : '',
      item.detail
    ]);
  });

  rows.push([]);
  rows.push(['说明', '配对确认、标记和差异说明只是提示；比对结果不改动任何金额，净额仍按企业合计应收减应付。']);

  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = [
    { wch: 30 }, ...dimHeaders.map(() => ({ wch: 16 })), { wch: 12 }, { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 15 },
    { wch: 15 }, { wch: 15 }, { wch: 9 }, { wch: 9 }, { wch: 22 }, { wch: 22 },
    { wch: 28 }, { wch: 28 }, { wch: 56 }
  ];
  sheet['!autofilter'] = { ref: `A13:${XLSX.utils.encode_col(14 + dimHeaders.length)}${12 + comparison.items.length}` };
  applyMoneyFormat(sheet, Array.from({ length: 6 }, (_, index) => moneyStart + index));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, '底稿比对');
  workbook.Props = {
    Title: '双边对账底稿比对',
    Subject: '两次对账结果比对',
    Author: '双边对账核销工具',
    CreatedDate: new Date()
  };

  try {
    const fileName = `${exportFileBase()}_底稿比对_${formatFileStamp(new Date())}.xlsx`;
    XLSX.writeFile(workbook, fileName);
    const receipt = recordExportReceipt('snapshot', fileName, workbook);
    showToast(receipt ? `比对结果已导出（校验码 ${receipt.sha256.slice(0, 12)}…）` : '比对结果已导出');
  } catch (error) {
    console.error(error);
    showToast('比对结果导出失败，请确认本页是用 Edge / Chrome 打开的', true);
  }
}

function toHalfWidth(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\uFF01-\uFF5E]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/−/g, '-');
}

function cleanCell(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\u00a0/g, ' ').trim();
}

function displayRawName(value) {
  return cleanCell(value).replace(/\s+/g, ' ');
}

function dirLabel(direction) {
  return direction === 'recv' ? '应收' : '应付';
}

function fmtMoney(cents) {
  return `¥${moneyFormatter.format(Math.abs(cents || 0) / 100)}`;
}

function fmtMoneyPlain(cents) {
  return moneyFormatter.format(Math.abs(cents || 0) / 100);
}

function fmtSignedMoney(cents) {
  if (!cents) return '¥0.00';
  return `${cents > 0 ? '+' : '−'}${fmtMoney(cents)}`;
}

function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function truncate(value, length) {
  const text = String(value === null || value === undefined ? '' : value);
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function escapeHtml(value) {
  const characters = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  return String(value === null || value === undefined ? '' : value)
    .replace(/[&<>"']/g, (character) => characters[character]);
}

function invalidateResults() {
  hideRunError();
  if (!state.groups.length && !state.runInfo) return;

  state.records = [];
  state.groups = [];
  state.skipped = [];
  state.reclassRows = [];
  state.redRows = [];
  state.unknownDirections = [];
  state.inheritedRows = 0;
  state.directionFallbackRows = 0;
  state.outOfRangeRows = 0;
  state.stats = null;
  state.runInfo = null;
  state.expanded.clear();
  els.resultSection.classList.add('hidden');
}

function showRunError(message) {
  els.runError.textContent = message;
  els.runError.classList.remove('hidden');
  els.runError.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideRunError() {
  els.runError.classList.add('hidden');
}

function showFileError(message) {
  if (!els.configSection.classList.contains('hidden')) {
    showToast(message, true);
    return;
  }
  els.fileError.textContent = message;
  els.fileError.classList.remove('hidden');
}

function hideFileError() {
  els.fileError.classList.add('hidden');
}

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.toggle('error', Boolean(isError));
  els.toast.classList.add('show');
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
  }, 3400);
}

/* ---------- 导出归档包（zip，仅存储不压缩） ---------- */

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

// ===== 归档包 =====

function crc32Bytes(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function zipDosStamp(date) {
  const value = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, Math.min(2107, value.getFullYear()));
  return {
    time: ((value.getHours() & 0x1F) << 11) | ((value.getMinutes() & 0x3F) << 5) | ((value.getSeconds() >> 1) & 0x1F),
    day: ((year - 1980) << 9) | (((value.getMonth() + 1) & 0x0F) << 5) | (value.getDate() & 0x1F)
  };
}

function buildStoreZip(entries) {
  const prepared = (entries || []).map((entry) => {
    const data = ArrayBuffer.isView(entry.bytes)
      ? new Uint8Array(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength)
      : new Uint8Array(entry.bytes);
    const stamp = zipDosStamp(entry.at);
    return {
      name: utf8Bytes(entry.name),
      data,
      crc: crc32Bytes(data),
      time: stamp.time,
      day: stamp.day,
      offset: 0
    };
  });

  const parts = [];
  let offset = 0;

  prepared.forEach((entry) => {
    const local = new Uint8Array(30 + entry.name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, entry.time, true);
    view.setUint16(12, entry.day, true);
    view.setUint32(14, entry.crc, true);
    view.setUint32(18, entry.data.length, true);
    view.setUint32(22, entry.data.length, true);
    view.setUint16(26, entry.name.length, true);
    view.setUint16(28, 0, true);
    local.set(entry.name, 30);
    entry.offset = offset;
    parts.push(local, entry.data);
    offset += local.length + entry.data.length;
  });

  const centralStart = offset;
  prepared.forEach((entry) => {
    const central = new Uint8Array(46 + entry.name.length);
    const view = new DataView(central.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, entry.time, true);
    view.setUint16(14, entry.day, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.data.length, true);
    view.setUint32(24, entry.data.length, true);
    view.setUint16(28, entry.name.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, entry.offset, true);
    central.set(entry.name, 46);
    parts.push(central);
    offset += central.length;
  });

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, prepared.length, true);
  endView.setUint16(10, prepared.length, true);
  endView.setUint32(12, offset - centralStart, true);
  endView.setUint32(16, centralStart, true);
  endView.setUint16(20, 0, true);
  parts.push(end);

  const out = new Uint8Array(offset + end.length);
  let cursor = 0;
  parts.forEach((part) => {
    out.set(part, cursor);
    cursor += part.length;
  });
  return out;
}

function buildArchiveReadme(receipt, archivedAt) {
  const version = els.appVersion && els.appVersion.textContent
    ? els.appVersion.textContent
    : APP_VERSION_FALLBACK;
  const lines = [
    '双边对账工具 · 归档说明',
    '======================',
    '',
    `导出方式：${receipt.kindLabel}`,
    `导出时间：${formatDateTime(new Date(receipt.at))}`,
    `打包时间：${formatDateTime(archivedAt)}`,
    `工具版本：${version}`,
    `结果文件：${receipt.fileName}`,
    `文件校验码（SHA-256）：${receipt.sha256}`,
    `结果指纹（SHA-256）：${receipt.fingerprint || '（导出时页面上没有对账结果）'}`,
    `企业数：${receipt.companies} 家`,
    `记录笔数：${receipt.records} 笔`,
    '',
    '怎么核对',
    '1. 解压后，把上面的 xlsx 选回工具的「导出文件校验码 → 核对一个导出文件」，应该显示「一致」。',
    '2. 也可以把上面「文件校验码」那一行整串抄进输入框，再选文件，效果一样。',
    '3. 文件校验码只证明这个 xlsx 没被改过；内容对不对，看「结果指纹」和底稿本身。',
    '4. 归档包本身不带自校验码，核对以包内 xlsx 的校验码为准。',
    '',
    '口径',
    '- 净额只是对账归并口径，不代表会计上可以抵销，能否抵销要看合同和报表列报。',
    '- 自动核销、差一点、同单据号、摘要线索都只是提示，不改变任何金额。',
    '- 本包不压缩，只是把文件和校验码放在一起，包内文件与导出时的文件逐字节相同。',
    ''
  ];
  return lines.join('\r\n');
}

function archiveExportReceipt() {
  const receipt = lastExportReceipt;
  if (!receipt || !receipt.bytes || !receipt.bytes.length) {
    showToast('先导出一次文件，再把文件和校验码打包归档', true);
    return null;
  }

  try {
    const base = sanitizeFileBase(receipt.fileName.replace(/\.xlsx$/i, ''));
    const stamp = formatFileStamp(new Date());
    const fileName = `${base}_归档_${stamp}.zip`;
    const readme = utf8Bytes(buildArchiveReadme(receipt, new Date()));
    const readmeWithBom = new Uint8Array(readme.length + 3);
    readmeWithBom.set([0xEF, 0xBB, 0xBF], 0);
    readmeWithBom.set(readme, 3);
    const bytes = buildStoreZip([
      { name: receipt.fileName, bytes: receipt.bytes, at: new Date(receipt.at) },
      { name: '校验码.txt', bytes: readmeWithBom, at: new Date() }
    ]);

    const blob = new Blob([bytes], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast(`归档包已下载：${fileName}（${formatBytes(bytes.byteLength)}）`);
    return { fileName, bytes };
  } catch (error) {
    console.error(error);
    showToast('归档包做不出来，请换 Edge / Chrome 再试，或分别保存文件和校验码', true);
    return null;
  }
}
