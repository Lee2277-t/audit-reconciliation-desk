#!/usr/bin/env node
/**
 * 「贷方写负数」与「要不要按主体分开」两问的回归。
 *
 * 真实底稿里两种写法都会把结果整体带偏：
 *   ① SAP／金蝶余额表把应付的负数余额直接写成负数，老口径会把整张应付表翻成应收；
 *   ② 两张表各自认出了主体列，同一家对手方在两边挂着不同主体，按主体分开就对不上。
 * 这一版改成对账前问一次，所以必须定格：什么条件下问、答哪个得到什么结果、金额口径没被动过。
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:/Qoder CN/Qoder CN.exe" tests/credit-negative-check.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'assets', 'app.js');
const XLSX = require(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));

let pass = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    return;
  }
  failures.push(detail ? `${name}（${detail}）` : name);
}

function createSandbox(confirmAnswer) {
  const stub = () => ({
    textContent: '',
    innerHTML: '',
    value: '',
    style: {},
    disabled: false,
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {},
    addEventListener() {},
    scrollIntoView() {},
    focus() {},
    select() {},
    click() {},
    querySelector() { return null; },
    querySelectorAll() { return []; }
  });

  const confirmCalls = [];

  const sandbox = {
    XLSX,
    console,
    Intl,
    Date,
    Math,
    JSON,
    Number,
    String,
    Object,
    Array,
    Map,
    Set,
    RegExp,
    Error,
    TypeError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: () => {},
    encodeURIComponent,
    decodeURIComponent,
    TextDecoder,
    TextEncoder,
    Blob: function () {},
    URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
    navigator: {},
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => stub()
    },
    window: {
      addEventListener() {},
      confirm(message) {
        confirmCalls.push(String(message));
        return typeof confirmAnswer === 'function' ? confirmAnswer(String(message)) : Boolean(confirmAnswer);
      },
      print() {}
    }
  };

  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP, 'utf8'), sandbox);
  vm.runInContext(
    `['toast', 'runError', 'fileError', 'manualError', 'dataCheck',
       'sourceList', 'sourceCount', 'sourceSelectAll', 'sourceSelectNone', 'sourceFilterNote']
       .forEach((id) => { els[id] = __stub(); });
     globalThis.__state = state;
     globalThis.__els = els;`,
    Object.assign(sandbox, { __stub: stub })
  );

  return { sandbox, state: sandbox.__state, confirmCalls };
}

function addSheet(workbook, name, rows) {
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
}

function buildSources(env, sheets) {
  const workbook = XLSX.utils.book_new();
  sheets.forEach((sheet) => addSheet(workbook, sheet.name, sheet.rows));
  const file = { name: '贷方负数测试.xlsx', size: 1, lastModified: 1 };
  const sources = sheets
    .map((sheet, index) => env.sandbox.buildSource(file, workbook, sheet.name, `cn::${index}`))
    .filter(Boolean);
  env.state.sources = sources;
  env.state.activeSourceId = sources[0] ? sources[0].id : '';
  env.state.pairToleranceCents = 1;
  return sources;
}

// 应付余额表：借正贷负写法，负数是「欠对方的钱」；正数是应付科目的借方余额（多付／预付）
function payableCreditNegativeRows() {
  return [
    ['供应商名称', '累计余额-原币'],
    ['甲Company有限公司', -1000],
    ['乙Company有限公司', -2000],
    ['丙Company有限公司', -3000],
    ['丁Company有限公司', 500],
    ['戊Company有限公司', 200],
    ['己Company有限公司', 0],
    ['庚Company有限公司', 0],
    ['辛Company有限公司', 0],
    ['壬Company有限公司', 0],
    ['癸Company有限公司', 0]
  ];
}

function sumByDir(records, dir) {
  return records.filter((record) => record.dir === dir).reduce((total, record) => total + record.cents, 0);
}

function reclassCount(records) {
  return records.filter((record) => record.reclassified).length;
}

function signTests(answer) {
  const env = createSandbox(answer);
  const sources = buildSources(env, [
    { name: '应付账款', rows: payableCreditNegativeRows() },
    { name: '应收账款', rows: [['客户名称', '累计余额-原币'], ['甲公司', 100], ['乙公司', 200]] }
  ]);
  const payable = sources[0];
  const receivable = sources[1];

  const split = env.sandbox.amountSignSplit(payable);
  check('零余额不参与正负统计', split && split.filled === 5 && split.negative === 3,
    split ? `filled=${split.filled} negative=${split.negative}` : 'null');
  check('整表方向认出应付', env.sandbox.resolveSourceDirection(payable).dir === 'pay');
  check('多数为负的应付表进了候选', env.sandbox.creditNegativeCandidates(sources).length === 1);
  check('应收表永远不会进候选', env.sandbox.creditNegativeCandidates(sources)[0] === payable,
    '应收侧同形状的表不得出现在候选里');

  const notes = env.sandbox.confirmSignConvention(sources);
  check('一次问完所有候选表', env.confirmCalls.length === 1, `弹窗次数=${env.confirmCalls.length}`);
  check('弹窗写清了行数', env.confirmCalls[0] && /5 行有余额的金额里有 3 行写的是负数/.test(env.confirmCalls[0]),
    env.confirmCalls[0]);
  check('弹窗给了两个选择各自的结果', env.confirmCalls[0] && /点「确定」：负数留在应付/.test(env.confirmCalls[0])
    && /点「取消」：按原来的写法/.test(env.confirmCalls[0]));
  check('弹窗带「拿不准就点取消」', env.confirmCalls[0] && /拿不准就点取消/.test(env.confirmCalls[0]));
  check('候选表被打上标记', Boolean(payable.creditNegative) === (answer !== false));
  check('应收表不会被顺手打标', receivable.creditNegative === false);

  const parsed = env.sandbox.parseExcelSource(payable);
  const literalCents = parsed.records.reduce((total, record) => total + record.cellCents, 0);

  if (answer !== false) {
    check('负数留在应付', sumByDir(parsed.records, 'pay') === 600000, `应付=${sumByDir(parsed.records, 'pay')}`);
    check('正数（应付科目借方余额）挪到应收', sumByDir(parsed.records, 'recv') === 70000,
      `应收=${sumByDir(parsed.records, 'recv')}`);
    check('只有正数那几行算重分类', reclassCount(parsed.records) === 2, `重分类=${reclassCount(parsed.records)}`);
    // rawCents 是「按贷方负数读出来」的口径，翻转过的行本来就是负的；判原表写法要用 cellCents。
    check('原表写负数的行留在应付、不标重分类',
      parsed.records.filter((record) => record.cellCents < 0).length === 3
      && parsed.records.filter((record) => record.cellCents < 0)
        .every((record) => !record.reclassified && record.dir === 'pay'));
    check('翻到应收的那两行是原表写正数的行',
      parsed.records.filter((record) => record.reclassified).every((record) => record.cellCents > 0));
    check('零余额行留在应付且不翻转',
      parsed.records.filter((record) => record.cents === 0).every((record) => record.dir === 'pay' && !record.reclassified));
  } else {
    check('取消后回到老口径：负数翻到应收', sumByDir(parsed.records, 'recv') === 600000,
      `应收=${sumByDir(parsed.records, 'recv')}`);
    check('取消后重分类的是负数行', reclassCount(parsed.records) === 3, `重分类=${reclassCount(parsed.records)}`);
    check('取消后不返回说明', notes.length === 0);
    check('取消后候选表没打标', payable.creditNegative === false);
  }

  const control = env.sandbox.buildSourceControl(payable, parsed);
  check('取数核对仍然平', control && control.ok === true, control ? `diff=${control.diffCents}/${control.diffCells}` : 'null');
  check('取数核对按原表格子里写的数统计', control && control.rawCents === -530000,
    control ? `rawCents=${control.rawCents}` : 'null');
  check('cellCents 永远是原表格子里写的那个数', literalCents === -530000, `合计=${literalCents}`);

  return { env, sources, payable, parsed, control, notes };
}

function gateShapeTests() {
  const noDirectionColumn = createSandbox(true);
  const sources = buildSources(noDirectionColumn, [
    { name: '应付账款', rows: [['供应商名称', '方向', '累计余额-原币'], ['甲公司', '应付', -100], ['乙公司', '应付', -200], ['丙公司', '应付', -300]] }
  ]);
  check('有方向列的表不问', noDirectionColumn.sandbox.creditNegativeCandidates(sources).length === 0);
  check('有方向列时确认弹窗不出现', noDirectionColumn.sandbox.confirmSignConvention(sources).length === 0);

  const tooFew = createSandbox(true);
  const fewSources = buildSources(tooFew, [
    { name: '应付账款', rows: [['供应商名称', '累计余额-原币'], ['甲公司', -100], ['乙公司', -200]] }
  ]);
  check('只有两行负余额不问', tooFew.sandbox.amountSignSplit(fewSources[0]) === null);

  const notMajority = createSandbox(true);
  const halfSources = buildSources(notMajority, [
    { name: '应付账款', rows: [['供应商名称', '累计余额-原币'], ['甲', -100], ['乙', -200], ['丙', -300], ['丁', 100], ['戊', 200], ['己', 300]] }
  ]);
  check('负数不到六成不问', notMajority.sandbox.amountSignSplit(halfSources[0]) === null);

  const allPositive = createSandbox(true);
  const posSources = buildSources(allPositive, [
    { name: '应付账款', rows: [['供应商名称', '累计余额-原币'], ['甲', 100], ['乙', 200], ['丙', 300]] }
  ]);
  check('全是正数（正常写法）不问', allPositive.sandbox.amountSignSplit(posSources[0]) === null);

  const twoCandidates = createSandbox(true);
  const bothSources = buildSources(twoCandidates, [
    { name: '应付账款', rows: payableCreditNegativeRows() },
    { name: '其他应付款', rows: [['供应商名称', '累计余额-原币'], ['甲', -100], ['乙', -200], ['丙', -300], ['丁', 50]] },
    { name: '应收账款', rows: [['客户名称', '累计余额-原币'], ['甲', 100], ['乙', 200]] }
  ]);
  twoCandidates.state.autoDetectCols = true;
  const notes = twoCandidates.sandbox.confirmSignConvention(bothSources);
  check('两张候选表只问一次', twoCandidates.confirmCalls.length === 1, `弹窗次数=${twoCandidates.confirmCalls.length}`);
  check('两张候选表各留一条说明', notes.length === 2, `notes=${notes.length}`);
  check('说明里带上表名与行数',
    notes.every((note) => note.sheet && note.filled >= 3 && note.negative >= 1), JSON.stringify(notes));
  check('弹窗把两张候选表都列出来',
    bothSources.slice(0, 2).every((source) => twoCandidates.confirmCalls[0].indexOf(source.shortLabel || source.sheetName) >= 0));
  const mixed = twoCandidates.sandbox.parseExcelSource(bothSources[1]);
  check('每张候选表都按同一口径处理', sumByDir(mixed.records, 'pay') === 60000 && sumByDir(mixed.records, 'recv') === 5000,
    `应付=${sumByDir(mixed.records, 'pay')} 应收=${sumByDir(mixed.records, 'recv')}`);

  const repeat = createSandbox(true);
  const repeatSources = buildSources(repeat, [
    { name: '应付账款', rows: payableCreditNegativeRows() }
  ]);
  repeat.sandbox.confirmSignConvention(repeatSources);
  repeat.confirmCalls.length = 0;
  repeat.sandbox.confirmSignConvention(repeatSources);
  check('每次点开始对账都会重新问', repeat.confirmCalls.length === 1, `第二次弹窗次数=${repeat.confirmCalls.length}`);
}

// 集团内部往来：同一家对手方在两张表上挂着不同主体
function intercompanySheets() {
  return [
    { name: '应收账款', rows: [
      ['主体', '客户名称', '金额'],
      ['甲公司', '华信科技', 100],
      ['甲公司', '星旷创新', 500],
      ['乙公司', '恒远贸易', 800]
    ] },
    { name: '应付账款', rows: [
      ['主体', '供应商名称', '金额'],
      ['甲公司', '华信科技', 60],
      ['丙公司', '星旷创新', 400],
      ['乙公司', '恒远贸易', 700]
    ] }
  ];
}

function bothSides(groups) {
  return groups.filter((group) => group.hasRecv && group.hasPay);
}

function entityGateTests(answer) {
  const env = createSandbox(answer);
  const sources = buildSources(env, intercompanySheets());
  sources.forEach((source) => {
    const column = env.sandbox.sourceDimensionColumn(source, 'entity');
    check(`${source.sheetName} 自动认出主体列`, column && column.index === 0, column ? `col=${column.index}` : 'null');
  });

  const parsed = sources.map((source) => env.sandbox.parseExcelSource(source));
  const records = parsed.reduce((all, item) => all.concat(item.records), []);
  check('逐笔记住了自己的主体', records.every((record) => record.entityKey), JSON.stringify(records.map((r) => r.entityRaw)));

  const askedBefore = bothSides(env.sandbox.buildGroups(records.map((record) => Object.assign({}, record)))).length;
  const asked = env.sandbox.confirmEntityGrouping(records, sources);
  check('两边都能对上时不问', env.confirmCalls.length === 1, `弹窗次数=${env.confirmCalls.length}`);
  check('弹窗给出两种算法各几家', /按主体分开算：两边都有记录的只有 2 家/.test(env.confirmCalls[0] || '')
    && /不按主体分开算：两边都有记录的有 3 家/.test(env.confirmCalls[0] || ''), env.confirmCalls[0]);
  check('弹窗说了为什么', /A 的账上挂着 B、B 的账上又挂着 A/.test(env.confirmCalls[0] || ''));

  const groups = env.sandbox.buildGroups(records);
  if (answer === false) {
    check('选「取消」后不再按主体分开', asked && asked.field === 'entity');
    check('说明里写清了不分开的原因', Boolean(asked && /这次没有按主体分开算/.test(asked.text)), asked && asked.text);
    check('说明里给了改回来的办法', Boolean(asked && /重新点「开始对账」/.test(asked.text)));
    check('主体信息只从聚合口径里去掉', records.every((record) => !record.entityKey));
    check('分开时只有 2 家两边都有', askedBefore === 2, `分开=${askedBefore}`);
    check('不分开能多对上 1 家', bothSides(groups).length === 3, `不分开=${bothSides(groups).length}`);
  } else {
    check('选「确定」时保持分开', asked === null);
    check('选「确定」时主体键原样保留', records.every((record) => record.entityKey));
    check('分开后每家各归各的账', groups.every((group) => group.entityKey));
  }
  const cents = records.reduce((total, record) => total + record.cents, 0);
  check('这一问不碰任何金额', cents === 256000, `合计=${cents}`);
  return { env, records, groups };
}

function entityGateSilentTests() {
  const single = createSandbox(true);
  const onlyOne = buildSources(single, intercompanySheets().slice(0, 1));
  const oneRecords = single.sandbox.parseExcelSource(onlyOne[0]).records;
  check('只有一张表时不问', single.sandbox.confirmEntityGrouping(oneRecords, onlyOne) === null);
  check('只有一张表时没有弹窗', single.confirmCalls.length === 0);

  const partial = createSandbox(true);
  const partialSources = buildSources(partial, [
    { name: '应收账款', rows: [['主体', '客户名称', '金额'], ['甲公司', '华信科技', 100], ['甲公司', '星旷创新', 500]] },
    { name: '应付账款', rows: [['供应商名称', '金额'], ['华信科技', 60], ['星旷创新', 400]] }
  ]);
  const partialRecords = partialSources.reduce((all, source) => all.concat(partial.sandbox.parseExcelSource(source).records), []);
  check('不是每张表都有主体列时不问', partial.sandbox.confirmEntityGrouping(partialRecords, partialSources) === null,
    `弹窗=${partial.confirmCalls.length}`);
  check('没问就不动主体口径', partialRecords.some((record) => record.entityKey));

  const already = createSandbox(true);
  const alreadySources = buildSources(already, [
    { name: '应收账款', rows: [['主体', '客户名称', '金额'], ['甲公司', '华信科技', 100], ['甲公司', '星旷创新', 500]] },
    { name: '应付账款', rows: [['主体', '供应商名称', '金额'], ['甲公司', '华信科技', 60], ['甲公司', '星旷创新', 400]] }
  ]);
  const alreadyRecords = alreadySources.reduce((all, source) => all.concat(already.sandbox.parseExcelSource(source).records), []);
  check('分开也能全对上时不打扰', already.sandbox.confirmEntityGrouping(alreadyRecords, alreadySources) === null,
    `弹窗=${already.confirmCalls.length}`);
  check('不打扰时主体键保留', alreadyRecords.every((record) => record.entityKey));

  const noDims = createSandbox(true);
  const plainSources = buildSources(noDims, [
    { name: '应收账款', rows: [['客户名称', '金额'], ['华信科技', 100], ['星旷创新', 500]] },
    { name: '应付账款', rows: [['供应商名称', '金额'], ['华信科技', 60], ['星旷创新', 400]] }
  ]);
  const plainRecords = plainSources.reduce((all, source) => all.concat(noDims.sandbox.parseExcelSource(source).records), []);
  check('没认主体列时不问', noDims.sandbox.confirmEntityGrouping(plainRecords, plainSources) === null);

  const currencyOnly = createSandbox(true);
  const currencySources = buildSources(currencyOnly, [
    { name: '应收账款', rows: [['客户名称', '币种', '金额'], ['华信科技', '美元', 100], ['星旷创新', '美元', 500]] },
    { name: '应付账款', rows: [['供应商名称', '币种', '金额'], ['华信科技', '人民币', 60], ['星旷创新', '人民币', 400]] }
  ]);
  const currencyRecords = currencySources.reduce((all, source) => all.concat(currencyOnly.sandbox.parseExcelSource(source).records), []);
  check('只有币种不同时不问（不同币种本来就不能相加）',
    currencyOnly.sandbox.confirmEntityGrouping(currencyRecords, currencySources) === null,
    `弹窗=${currencyOnly.confirmCalls.length}`);
  check('币种口径不受影响', currencyRecords.every((record) => record.currencyKey));
}

function noAmountSheetTests() {
  const env = createSandbox(true);
  const sources = buildSources(env, [
    // 真实底稿里的「情况表」：整列余额全是横线，一个数字都没有（只有序号列是数字）
    { name: '预收账款', rows: [
      ['序号', '单位', '客商', '款项性质', '审定数', '核对'],
      [1, '江苏某公司', '华信科技', '货款', '-', '-'],
      [2, '江苏某公司', '星旷创新', '货款', '-', '-'],
      [3, '江苏某公司', '恒远贸易', '货款', '-', '-'],
      [4, '江苏某公司', '蓝湖建设', '货款', '-', '-'],
      [5, '江苏某公司', '启明信息', '货款', '-', '-']
    ] },
    // 金额认出来了、对手方认不出来 —— 这种要让人去确认列，不能说「没有金额」
    { name: '两期余额', rows: [
      ['期初余额', '期末余额'],
      [100, 200],
      [300, 400],
      [500, 600]
    ] },
    // 正常有金额的表
    { name: '应收账款', rows: [['客户名称', '金额'], ['华信科技', 100], ['恒远贸易', 200]] },
    // 真实底稿里最阴的一种：前几行全是横线，只有最后一行填了钱。
    // 认列只看表头下 40 行样本，这种表很可能认不出金额列——但绝不能对用户说「这张表没有金额」。
    { name: '存货', rows: [
      ['序号', '项目', '2026/6/30账面余额', '跌价准备'],
      [1, '原材料', '-', '-'],
      [2, '在产品', '-', '-'],
      [3, '库存商品', '-', '-'],
      [4, '周转材料', '-', '-'],
      [5, '委托加工物资', '-', '-'],
      [6, '发出商品', '282,646,200.00', '-']
    ] }
  ]);
  const dashed = sources.find((source) => source.sheetName === '预收账款');
  const counted = sources.find((source) => source.sheetName === '两期余额');
  const money = sources.find((source) => source.sheetName === '应收账款');
  const tailMoney = sources.find((source) => source.sheetName === '存货');

  check('全横线的表认不出金额列', dashed && dashed.mapping.amount < 0,
    dashed ? `col=${dashed.mapping.amount}` : '没找到这张表');
  check('全横线的表标成「没有金额」', dashed && dashed.noAmount === true && dashed.usable === false
    && dashed.included === false);
  check('认到金额列但没认到对手方的表不算「没有金额」', counted && counted.mapping.amount >= 0
    && counted.noAmount === false && counted.usable === false,
    counted ? `amount=${counted.mapping.amount} company=${counted.mapping.company} noAmount=${counted.noAmount}` : '没找到这张表');
  check('正常有金额的表不带这个标记且默认不勾选', money && money.noAmount === false && money.included === false);
  check('钱只在最后一行时不谎称「没有金额」', tailMoney && tailMoney.noAmount === false,
    tailMoney ? `amount=${tailMoney.mapping.amount} noAmount=${tailMoney.noAmount}` : '没找到这张表');

  env.sandbox.renderSourceList();
  const html = env.sandbox.__els.sourceList.innerHTML;
  const silentCount = sources.filter((source) => source.noAmount).length;
  const manualCount = sources.filter((source) => !source.usable && !source.noAmount).length;
  check('列表里「没有金额」只说给全横线的表', silentCount === 1
    && (html.match(/这张表里没有金额/g) || []).length === silentCount,
    `实际=${silentCount} 命中=${(html.match(/这张表里没有金额/g) || []).length}`);
  check('其余不能用的表都说「需要手动确认列和方向」', manualCount >= 1
    && (html.match(/需要手动确认列和方向/g) || []).length === manualCount,
    `实际=${manualCount} 命中=${(html.match(/需要手动确认列和方向/g) || []).length}`);
  check('每张不能用的表恰好得一句提示、能用的那句都不提',
    (html.match(/不用管它|需要手动确认/g) || []).length === sources.filter((source) => !source.usable).length,
    `不可用=${sources.filter((source) => !source.usable).length}`);

  // 用户自己把金额列指上去之后，这句提醒必须马上消失
  dashed.mapping.amount = 4;
  env.sandbox.refreshSourceSelection(dashed);
  check('手动指了金额列后不再说「没有金额」', dashed.noAmount === false, `noAmount=${dashed.noAmount}`);
}

function main() {
  const yes = signTests(true);
  check('答「确定」时返回说明', yes.notes.length === 1, `notes=${yes.notes.length}`);
  const no = signTests(false);
  check('两种答案的取数核对都是平的',
    yes.control.ok === true && no.control.ok === true);
  check('两种答案的原表合计完全相同', yes.control.rawCents === no.control.rawCents,
    `${yes.control.rawCents} vs ${no.control.rawCents}`);
  check('两种答案纳入的格数相同', yes.control.includedCells === no.control.includedCells);
  check('两种答案的格子合计相同', yes.control.includedCents === no.control.includedCents,
    `${yes.control.includedCents} vs ${no.control.includedCents}`);

  gateShapeTests();

  const keep = entityGateTests(true);
  const drop = entityGateTests(false);
  check('两种答案的组数不同', keep.groups.length === 4 && drop.groups.length === 3,
    `分开=${keep.groups.length} 不分开=${drop.groups.length}`);
  check('两种答案的笔数与金额完全相同',
    keep.records.length === drop.records.length
    && keep.records.reduce((t, r) => t + r.cents, 0) === drop.records.reduce((t, r) => t + r.cents, 0));

  entityGateSilentTests();
  noAmountSheetTests();

  if (failures.length) {
    failures.forEach((item) => console.log(`FAIL ${item}`));
    console.log(`CREDIT_NEGATIVE_CHECK FAIL failures=${failures.length} total=${pass + failures.length}`);
    process.exit(1);
  }
  console.log(`CREDIT_NEGATIVE_CHECK PASS failures=0 total=${pass}`);
}

main();
