#!/usr/bin/env node
/**
 * 黄金回归：不依赖 Electron、不依赖浏览器，只用 Node 跑解析 / 归并 / 配对 / 导出。
 *
 *   node tests/run-golden.cjs                跑全部夹具，与 tests/golden/*.json 比对
 *   node tests/run-golden.cjs --update       重新生成黄金文件（改口径后先人工核对再提交）
 *   node tests/run-golden.cjs red-font-negative.xlsx   只跑指定夹具
 *
 * 夹具全部是编造的企业名与金额，可以进版本库；tests/ 不进交付 zip。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'assets', 'app.js');
const XLSX = require(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));
const FIXTURES = path.join(__dirname, 'fixtures');
const GOLDEN = path.join(__dirname, 'golden');
const TOLERANCE_CENTS = 1;
// 只有这张夹具额外跑几档比例容差；其余夹具保持原来的绝对容差结果
const PERCENT_CASES = { 'pairing-percent.xlsx': [0, 0.1, 1] };

const argv = process.argv.slice(2);
const update = argv.includes('--update');
const only = argv.filter((arg) => !arg.startsWith('--'));

function createSandbox() {
  const captured = [];
  const stub = () => ({
    textContent: '',
    innerHTML: '',
    value: '',
    style: {},
    disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {},
    addEventListener() {},
    scrollIntoView() {},
    focus() {},
    select() {},
    click() {}
  });

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
    parseInt,
    parseFloat,
    isNaN,
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
    window: { addEventListener() {}, confirm: () => true, print() {} }
  };

  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP, 'utf8'), sandbox);
  vm.runInContext(
    `['toast', 'runError', 'fileError', 'manualError'].forEach((id) => { els[id] = __stub(); });`,
    Object.assign(sandbox, { __stub: stub })
  );

  const originalWriteFile = XLSX.writeFile;
  XLSX.writeFile = (workbook) => {
    captured.push(workbook);
  };

  return { sandbox, captured, restore: () => { XLSX.writeFile = originalWriteFile; } };
}

const PROBE = `
(function () {
  var workbook = __wb;
  var fileName = __fileName;
  var tolerance = __tolerance;
  var percentList = __pairPercents || null;
  state.autoDetectCols = true;
  state.sort = 'netAbsDesc';
  state.pairPercent = 0;
  // 账龄按日期折算时必须有固定基准日，否则黄金文件每天在变（真实页面默认取今天）
  state.ageBaseDate = '2026-10-31';

  var seq = 0;
  var file = { name: fileName, size: 1, lastModified: 1 };
  var sources = workbook.SheetNames
    .map(function (sheetName) { return buildSource(file, workbook, sheetName, fileName + '::' + (++seq)); })
    .filter(Boolean);
  // 导入默认零勾选；回归夹具模拟用户勾上识别明确的数据表。
  sources.forEach(function (source) {
    source.included = source.usable && !source.amountDoubt && !source.companyDoubt;
  });
  var selected = sources.filter(function (source) { return source.included; });

  function skipReasons(list) {
    var map = {};
    list.forEach(function (item) { map[item.reason] = (map[item.reason] || 0) + 1; });
    return map;
  }

  function controlView(control) {
    if (!control) return null;
    return {
      rawCents: control.rawCents,
      includedCents: control.includedCents,
      skippedCents: control.skippedCents,
      outsideCents: control.outsideCents,
      unmatchedCents: control.unmatchedCents,
      diffCents: control.diffCents,
      rawCells: control.rawCells,
      includedCells: control.includedCells,
      skippedCells: control.skippedCells,
      outsideCells: control.outsideCells,
      unmatchedCells: control.unmatchedCells,
      diffCells: control.diffCells,
      ok: !!control.ok,
      unmatchedRows: (control.unmatchedRows || []).slice().sort(function (a, b) { return a - b; }),
      missingRecordRows: (control.missingRecordRows || []).slice().sort(function (a, b) { return a - b; })
    };
  }

  function describe(source) {
    var labels = getHeaderLabels(source);
    var name = function (index) { return index >= 0 ? (labels[index] || ('#' + index)) : '-'; };
    var direction = resolveSourceDirection(source);
    var age = sourceAgeColumn(source);
    return {
      sheet: source.sheetName,
      shortLabel: source.shortLabel,
      headerRow: source.headerRow,
      groupHeaderRow: source.groupHeaderRow,
      columns: {
        company: name(source.mapping.company),
        amount: name(source.mapping.amount),
        direction: name(source.mapping.direction),
        memo: name(source.mapping.memo)
      },
      age: age
        ? {
          column: XLSX.utils.encode_col(age.index),
          label: age.label,
          kind: age.kind,
          unit: age.unit,
          manual: !!age.manual,
          hits: age.hits,
          filled: age.filled
        }
        : null,
      range: source.dataRange
        ? (source.rowOffset + source.dataRange.fromRow + 1) + '-' + (source.rowOffset + source.dataRange.toRow + 1) + (source.dataRange.manual ? '*' : '')
        : '',
      rangeNote: source.dataRange ? source.dataRange.note : '',
      outside: source.dataRange ? source.dataRange.outside : 0,
      unit: source.unit,
      direction: { via: direction.via, dir: direction.dir, label: direction.label },
      guessedFields: (source.guessedFields || []).slice(),
      profileUsed: !!source.profileUsed,
      confidence: sourceConfidence(source).map(function (item) { return item.text; }),
      usable: source.usable,
      included: source.included
    };
  }

  var combined = {
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

  var perSource = sources.map(function (source) {
    if (!source.included) return null;
    var parsed = parseExcelSource(source);
    parsed.records.forEach(function (row) { combined.records.push(row); });
    parsed.skipped.forEach(function (row) { combined.skipped.push(row); });
    parsed.reclassRows.forEach(function (row) { combined.reclassRows.push(row); });
    parsed.redRows.forEach(function (row) { combined.redRows.push(row); });
    var control = buildSourceControl(source, parsed);
    if (control) {
      combined.controls.push(Object.assign({
        sourceId: source.id,
        sheetName: source.sheetName,
        kind: 'excel'
      }, control));
    }
    combined.inheritedRows += parsed.inheritedRows;
    combined.directionFallbackRows += parsed.directionFallbackRows;
    combined.outOfRangeRows += parsed.outOfRangeRows;
    parsed.unknownDirections.forEach(function (count, value) {
      combined.unknownDirections.set(value, (combined.unknownDirections.get(value) || 0) + count);
    });

    var sourceGroups = buildGroups(parsed.records);
    var sourceStats = computeStats(sourceGroups);
    return {
      records: parsed.records.length,
      skipped: parsed.skipped.length,
      skipReasons: skipReasons(parsed.skipped),
      reclass: parsed.reclassRows.length,
      red: parsed.redRows.length,
      inherited: parsed.inheritedRows,
      directionFallback: parsed.directionFallbackRows,
      outOfRange: parsed.outOfRangeRows,
      unknownDirs: parsed.unknownDirections.size,
      groups: sourceGroups.length,
      control: controlView(control),
      grossRecvCents: sourceStats.grossRecvCents,
      grossPayCents: sourceStats.grossPayCents,
      netRecvCents: sourceStats.netRecvCents,
      netPayCents: sourceStats.netPayCents,
      evenGroups: sourceStats.evenGroups
    };
  });

  var groups = buildGroups(combined.records);

  function pairingSnapshot(result) {
    var maxDiff = 0;
    var duplicates = 0;
    var details = [];
    groups.forEach(function (group) {
      var used = {};
      (group.pairings || []).forEach(function (pairing) {
        if (pairing.diffCents > maxDiff) maxDiff = pairing.diffCents;
        pairing.recvRows.concat(pairing.payRows).forEach(function (row) {
          var key = group.displayName + '|' + row.sourceId + '|' + row.rowNo;
          if (used[key]) duplicates += 1;
          used[key] = true;
        });
        details.push([
          group.displayName,
          pairKindLabel(pairing),
          pairing.recvRows.length,
          pairing.recvCents,
          pairing.payRows.length,
          pairing.payCents,
          pairing.diffCents
        ]);
      });
    });
    return {
      pairCount: result.pairCount,
      pairGroups: result.pairGroups,
      pairedRecvCents: result.pairedRecvCents,
      pairedPayCents: result.pairedPayCents,
      limitedGroups: result.limitedGroups,
      skippedGroups: result.skippedGroups,
      maxDiffCents: maxDiff,
      duplicateRows: duplicates,
      details: details
    };
  }

  var pairDefault = runPairing(groups, tolerance);
  var snapDefault = pairingSnapshot(pairDefault);
  var stats = computeStats(groups);
  var pairZero = runPairing(groups, 0);
  var snapZero = pairingSnapshot(pairZero);
  runPairing(groups, tolerance);

  var snapPercent = null;
  if (percentList && percentList.length) {
    snapPercent = percentList.map(function (percent) {
      state.pairPercent = percent;
      var result = runPairing(groups, tolerance);
      var snap = pairingSnapshot(result);
      snap.percent = percent;
      return snap;
    });
    state.pairPercent = 0;
    runPairing(groups, tolerance);
  }

  var suggestions = buildSimilarSuggestions(groups);
  var similarView = suggestions.map(function (item) {
    return [item.tier, item.nameA, item.nameB, Math.round(item.score * 100), item.rowsA + item.rowsB];
  });

  var docHintView = [];
  groups.forEach(function (group) {
    (group.docHints || []).forEach(function (hint) {
      docHintView.push([
        group.displayName,
        hint.docNo,
        hint.recvRows.length,
        hint.recvCents,
        hint.payRows.length,
        hint.payCents,
        hint.diffCents,
        hint.recvRows.map(function (row) { return row.rowNo; }).join(','),
        hint.payRows.map(function (row) { return row.rowNo; }).join(',')
      ]);
    });
  });

  var memoKeyView = [];
  groups.forEach(function (group) {
    (group.memoKeyHints || []).forEach(function (hint) {
      memoKeyView.push([
        group.displayName,
        hint.label,
        hint.value,
        hint.recvRows.length,
        hint.recvCents,
        hint.payRows.length,
        hint.payCents,
        hint.diffCents,
        hint.recvRows.map(function (row) { return row.rowNo; }).join(','),
        hint.payRows.map(function (row) { return row.rowNo; }).join(',')
      ]);
    });
  });

  var ageView = groups.filter(function (group) { return group.hasAge; }).map(function (group) {
    var s = group.ageStats;
    var cents = function (list, unknown) { return list.map(function (cell) { return cell.cents; }).concat([unknown.cents]); };
    var counts = function (list, unknown) { return list.map(function (cell) { return cell.count; }).concat([unknown.count]).join('/'); };
    return [
      group.displayName,
      cents(s.recv, s.recvUnknown),
      cents(s.pay, s.payUnknown),
      counts(s.recv, s.recvUnknown) + '|' + counts(s.pay, s.payUnknown),
      s.maxBand,
      s.marked,
      s.total,
      group.recvCents,
      group.payCents
    ];
  });

  var mergeProbe = (function () {
    if (!suggestions.length) return null;
    var item = suggestions[0];
    state.merges.set(item.keyA, item.keyB);
    state.mergeLog.push({ child: item.keyA, parent: item.keyB, nameA: item.nameA, nameB: item.nameB });
    var mergedGroups = buildGroups(combined.records);
    var view = {
      pair: [item.nameA, item.nameB],
      groupsBefore: groups.length,
      groupsAfter: mergedGroups.length,
      flagged: mergedGroups.filter(function (group) { return group.manualMerge; }).map(function (group) {
        return [group.displayName, group.rows.length, group.netCents, group.mergedKeys.length, group.flags.indexOf('merge') >= 0];
      })
    };
    state.merges.clear();
    state.mergeLog = [];
    var restored = buildGroups(combined.records);
    view.revertedGroups = restored.length;
    return view;
  })();

  var profileProbe = (function () {
    if (!selected.length) return null;
    function signatureOf(source) {
      return [source.sheetName, source.mapping.company, source.mapping.amount,
        source.mapping.direction, source.mapping.memo, source.unit].join('|');
    }
    var auto = selected.map(signatureOf);
    var savedSources = state.sources;
    state.sources = sources.slice();
    var profiles = collectConfigProfiles();

    state.configProfiles = profiles;
    var restored = sources.filter(function (source) { return source.included; }).map(function (source) {
      var fresh = buildSource(file, workbook, source.sheetName, 'profile::' + source.sheetName);
      if (!fresh) return 'null';
      return signatureOf(fresh) + (fresh.profileUsed ? '#yes' : '#no');
    });

    var broken = profiles.slice();
    broken[0] = Object.assign({}, broken[0], {
      mapping: { company: -1, amount: -1, direction: -1, memo: -1 }
    });
    state.configProfiles = broken;
    var override = buildSource(file, workbook, selected[0].sheetName, 'profile::broken');
    var overrideView = override
      ? [override.profileUsed ? 'yes' : 'no', override.mapping.company, override.mapping.amount, override.usable]
      : null;
    state.configProfiles = [];
    state.sources = savedSources;

    return {
      count: profiles.length,
      signatures: profiles.map(function (profile) { return profile.signature; }),
      restoredMatchesAuto: restored.every(function (line, index) {
        return line === auto[index] + '#yes';
      }),
      restored: restored,
      clearedByBrokenProfile: overrideView
    };
  })();

  function exportSnapshot() {
    if (!groups.length) return null;
    state.sources = sources.slice();
    state.records = combined.records;
    state.skipped = combined.skipped;
    state.reclassRows = combined.reclassRows;
    state.redRows = combined.redRows;
    state.inheritedRows = combined.inheritedRows;
    state.directionFallbackRows = combined.directionFallbackRows;
    state.outOfRangeRows = combined.outOfRangeRows;
    state.groups = groups;
    state.stats = stats;
    state.pairToleranceCents = tolerance;
    state.pairResult = pairDefault;
    state.controls = combined.controls;
    state.signoff = {
      index: 'AR-AP-01',
      preparedBy: '张三',
      reviewedBy: '李四',
      date: '2026-10-25',
      conclusion: '已复核',
      note: '差异说明与取数核对回归用的固定文本'
    };
    state.groupNotes = new Map();
    if (groups.length) state.groupNotes.set(groups[0].key, '第一家企业的差异说明');
    var decisionMarks = 0;
    groups.forEach(function (group) {
      (group.pairings || []).forEach(function (pairing) {
        if (decisionMarks === 0) { pairing.decision = 'accepted'; decisionMarks += 1; }
        else if (decisionMarks === 1) { pairing.decision = 'rejected'; decisionMarks += 1; }
      });
    });
    state.runInfo = {
      mode: 'excel',
      sources: selected.map(function (source) {
        var direction = resolveSourceDirection(source);
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
          dataRange: source.dataRange
            ? dataRangeLabel(source) + (source.dataRange.manual ? '（手工框选）' : '')
            : '',
          outsideRows: source.dataRange ? source.dataRange.outside : 0,
          recordCount: combined.records.filter(function (row) { return row.sourceId === source.id; }).length
        };
      }),
      generatedAt: new Date(0)
    };

    var exported = groups.slice();
    var blockGroups = groups.slice().sort(function (a, b) {
      return Math.abs(b.netCents) - Math.abs(a.netCents) || a.displayName.localeCompare(b.displayName, 'zh-CN');
    });
    var frozenTime = formatDateTime;
    formatDateTime = function () { return '<导出时间>'; };
    var workbook;
    var blockWorkbook;
    try {
      workbook = buildExportWorkbook(exported, '全部结果（' + exported.length + ' 家）');
      blockWorkbook = buildGroupSheetsWorkbook(blockGroups, '全部结果（' + blockGroups.length + ' 家）');
    } finally {
      formatDateTime = frozenTime;
    }
    var rows = function (name) {
      return workbook.Sheets[name]
        ? XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: '' })
        : null;
    };
    var blockRows = function (name) {
      return XLSX.utils.sheet_to_json(blockWorkbook.Sheets[name], { header: 1, raw: true, defval: '' });
    };
    var blockCompany = blockWorkbook.SheetNames.slice(1).map(function (name) {
      var grid = blockRows(name);
      var head = {};
      grid.forEach(function (row) {
        if (!row || !row.length) return;
        var label = String(row[0] || '');
        if (label === '企业名称' && head.name === undefined) head.name = row[1];
        else if (label === '数据源' && head.source === undefined) head.source = row[1];
        else if (label.indexOf('应收合计') === 0 && head.recv === undefined) head.recv = row[1];
        else if (label.indexOf('应付合计') === 0 && head.pay === undefined) head.pay = row[1];
        else if (label.indexOf('净额（') === 0 && head.net === undefined) {
          head.net = row[1];
          head.direction = row[2];
        } else if (label === '标记' && head.flags === undefined) head.flags = row[1];
      });
      var subtotals = [];
      var netRow = null;
      grid.forEach(function (row) {
        if (row[0] === '小计') subtotals.push(row[3]);
        if (String(row[0] || '').indexOf('净额（应收合计') === 0) netRow = [row[0], row[1], row[2]];
      });
      return [name, head.name, head.source, head.recv, head.pay, head.net, head.direction, subtotals, netRow, head.flags, grid.length];
    });
    return {
      sheets: workbook.SheetNames.slice(),
      summary: rows('对账汇总'),
      pair: rows('核销配对'),
      detail: rows('原始明细'),
      age: rows('账龄分析'),
      doc: rows('同单据号'),
      memo: rows('摘要线索'),
      notes: rows('对账说明'),
      decisionMarks: decisionMarks,
      blocks: {
        sheets: blockWorkbook.SheetNames.slice(),
        cover: blockRows('目录'),
        company: blockCompany
      }
    };
  }

  return JSON.stringify({
    fixture: fileName,
    sources: sources.map(function (source, index) {
      var item = describe(source);
      item.stats = perSource[index];
      return item;
    }),
    combined: {
      selectedSheets: selected.map(function (source) { return source.sheetName; }),
      records: combined.records.length,
      skipped: combined.skipped.length,
      skipReasons: skipReasons(combined.skipped),
      reclass: combined.reclassRows.length,
      red: combined.redRows.length,
      inherited: combined.inheritedRows,
      directionFallback: combined.directionFallbackRows,
      outOfRange: combined.outOfRangeRows,
      unknownDirections: Array.from(combined.unknownDirections.entries()).sort(function (a, b) { return b[1] - a[1]; }),
      groups: groups.length,
      grossRecvCents: stats.grossRecvCents,
      grossPayCents: stats.grossPayCents,
      netRecvCents: stats.netRecvCents,
      netPayCents: stats.netPayCents,
      evenGroups: stats.evenGroups,
      keyGroups: stats.keyGroups,
      pairGroups: stats.pairGroups,
      pairCount: stats.pairCount,
      pairLimitedGroups: stats.pairLimitedGroups,
      docHintGroups: stats.docHintGroups,
      memoKeyGroups: stats.memoKeyGroups,
      mergeGroups: stats.mergeGroups
    },
    control: {
      perSource: combined.controls.map(function (item) {
        var view = controlView(item);
        view.sheetName = item.sheetName;
        return view;
      }),
      combined: controlView(combineControls(combined.controls))
    },
    similar: {
      count: suggestions.length,
      byTier: suggestions.reduce(function (acc, item) {
        acc[item.tier] = (acc[item.tier] || 0) + 1;
        return acc;
      }, {}),
      items: similarView
    },
    docHints: docHintView,
    memoKeys: memoKeyView,
    age: stats.ageGroups
      ? {
        groups: stats.ageGroups,
        markedRecords: stats.ageMarkedRecords,
        unknownRecords: stats.ageUnknownRecords,
        recvBands: stats.ageRecvBands,
        payBands: stats.agePayBands,
        longCents: stats.ageLongCents,
        baseDate: ageBaseDateValue()
      }
      : null,
    ageByGroup: ageView,
    mergeProbe: mergeProbe,
    profileProbe: profileProbe,
    pairing: {
      toleranceCents: tolerance,
      default: snapDefault,
      zero: snapZero,
      percent: snapPercent
    },
    export: exportSnapshot(),
    fingerprint: buildResultFingerprint(groups)
  });
})()
`;

const MANUAL_PROBE = `
(function () {
  var cases = __cases;
  var results = [];
  function controlViewLite(control) {
    if (!control) return null;
    return {
      rawCents: control.rawCents,
      includedCents: control.includedCents,
      skippedCents: control.skippedCents,
      outsideCents: control.outsideCents,
      unmatchedCents: control.unmatchedCents,
      diffCents: control.diffCents,
      rawCells: control.rawCells,
      includedCells: control.includedCells,
      skippedCells: control.skippedCells,
      outsideCells: control.outsideCells,
      unmatchedCells: control.unmatchedCells,
      diffCells: control.diffCells,
      ok: !!control.ok,
      unmatchedRows: (control.unmatchedRows || []).slice().sort(function (a, b) { return a - b; }),
      missingRecordRows: (control.missingRecordRows || []).slice().sort(function (a, b) { return a - b; })
    };
  }
  cases.forEach(function (item) {
    var unit = item.unit || 1;
    var recvSource = { id: 'manual-recv', kind: 'manual', shortLabel: '左侧粘贴', label: '左侧粘贴（应收）', unit: unit };
    var paySource = { id: 'manual-pay', kind: 'manual', shortLabel: '右侧粘贴', label: '右侧粘贴（应付）', unit: unit };
    var recvParsed = parseManualSide(item.recv, 'recv', recvSource);
    var payParsed = parseManualSide(item.pay, 'pay', paySource);
    var records = recvParsed.records.concat(payParsed.records);
    var skipped = recvParsed.skipped.concat(payParsed.skipped);
    var groups = buildGroups(records);
    var stats = computeStats(groups);
    var recvControl = buildManualControl(item.recv, recvParsed, recvSource);
    var payControl = buildManualControl(item.pay, payParsed, paySource);
    var manualControls = [];
    if (recvControl) manualControls.push(Object.assign({ sourceId: 'manual-recv', sheetName: '左侧粘贴', kind: 'manual' }, recvControl));
    if (payControl) manualControls.push(Object.assign({ sourceId: 'manual-pay', sheetName: '右侧粘贴', kind: 'manual' }, payControl));
    function reasons(list) {
      var map = {};
      list.forEach(function (row) { map[row.reason] = (map[row.reason] || 0) + 1; });
      return map;
    }
    results.push({
      name: item.name,
      unit: unit,
      records: records.length,
      skipped: skipped.length,
      skipReasons: reasons(skipped),
      reclass: recvParsed.reclassRows.length + payParsed.reclassRows.length,
      inherited: recvParsed.inheritedRows + payParsed.inheritedRows,
      groups: groups.length,
      control: manualControls.map(function (ctl) {
        var view = controlViewLite(ctl);
        view.sheetName = ctl.sheetName;
        return view;
      }),
      controlTotal: controlViewLite(combineControls(manualControls)),
      docNos: groups.reduce(function (acc, group) {
        (group.docHints || []).forEach(function (hint) {
          acc.push([group.displayName, hint.docNo, hint.recvCents, hint.payCents, hint.diffCents]);
        });
        return acc;
      }, []),
      memoKeys: groups.reduce(function (acc, group) {
        (group.memoKeyHints || []).forEach(function (hint) {
          acc.push([group.displayName, hint.label, hint.value, hint.recvCents, hint.payCents, hint.diffCents]);
        });
        return acc;
      }, []),
      similar: buildSimilarSuggestions(groups).map(function (pair) {
        return [pair.tier, pair.nameA, pair.nameB, Math.round(pair.score * 100)];
      }),
      grossRecvCents: stats.grossRecvCents,
      grossPayCents: stats.grossPayCents,
      netRecvCents: stats.netRecvCents,
      netPayCents: stats.netPayCents,
      evenGroups: stats.evenGroups,
      flags: groups.map(function (group) { return [group.displayName, group.flags.slice().sort().join(',')]; })
    });
  });
  return JSON.stringify(results);
})()
`;

const MANUAL_CASES = [
  {
    name: '基础两栏',
    recv: '华信有限公司 100\n恒远贸易有限公司 200',
    pay: '华信有限公司 100'
  },
  {
    name: '表头合计承上括号负',
    recv: '客户名称 金额\n华信有限公司 (1,000.00)\n  200\n合计 1,200',
    pay: '华信有限公司 500'
  },
  {
    name: '制表符与千分位',
    recv: '启明科技有限公司\t300,000.00\t货款',
    pay: '启明科技有限公司\t300,000.00'
  },
  {
    name: '千元单位',
    unit: 1000,
    recv: '华信有限公司 2',
    pay: '恒远贸易有限公司 1'
  }
];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).sort().forEach((key) => {
      out[key] = canonical(value[key]);
    });
    return out;
  }
  return value;
}

function stableText(value) {
  return JSON.stringify(canonical(value), null, 2);
}

function firstDiff(actual, expected) {
  const a = actual.split('\n');
  const b = expected.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      return `第 ${i + 1} 行\n  实际：${a[i]}\n  黄金：${b[i]}`;
    }
  }
  return '';
}

function checkInvariants(name, data, toleranceCents) {
  const problems = [];
  const combined = data.combined;
  if (combined.grossRecvCents - combined.grossPayCents !== combined.netRecvCents - combined.netPayCents) {
    problems.push('应收/应付合计与净额对不上（gross 差 ≠ net 差）');
  }
  const pairs = data.pairing.default;
  if (pairs.duplicateRows !== 0) {
    problems.push(`有 ${pairs.duplicateRows} 条记录被两组配对同时使用`);
  }
  if (pairs.maxDiffCents > toleranceCents) {
    problems.push(`默认容差下最大差额 ${pairs.maxDiffCents} 分，超过容差 ${toleranceCents} 分`);
  }
  if (data.pairing.zero.maxDiffCents !== 0) {
    problems.push(`容差 0 时仍有差额 ${data.pairing.zero.maxDiffCents} 分的配对`);
  }
  if (pairs.pairedRecvCents > combined.grossRecvCents || pairs.pairedPayCents > combined.grossPayCents) {
    problems.push('配对覆盖金额超过企业合计');
  }

  (data.pairing.percent || []).forEach((snap) => {
    if (snap.duplicateRows !== 0) {
      problems.push(`比例容差 ${snap.percent}% 下有 ${snap.duplicateRows} 条记录被两组配对同时使用`);
    }
    (snap.details || []).forEach((row) => {
      const maxSide = Math.max(row[3], row[5]);
      const allowed = Math.max(toleranceCents, Math.round(maxSide * snap.percent / 100));
      if (row[6] > allowed) {
        problems.push(`比例容差 ${snap.percent}% 下「${row[0]}」的配对差额 ${row[6]} 分超过允许的 ${allowed} 分`);
      }
    });
  });

  const controls = [
    ...data.control.perSource.map((item) => ({ label: `「${item.sheetName}」`, view: item })),
    { label: '合计', view: data.control.combined }
  ];
  controls.forEach(({ label, view }) => {
    if (!view) return;
    if (view.diffCents !== 0) {
      problems.push(`${label}取数核对不平，原表金额与纳入+跳过+范围外+未归类差 ${view.diffCents} 分`);
    }
    if (view.diffCells !== 0) {
      problems.push(`${label}取数核对金额格数差 ${view.diffCells} 格`);
    }
    if (view.unmatchedCells !== 0) {
      problems.push(`${label}有 ${view.unmatchedCells} 个金额格既没进记录也没进跳过（第 ${view.unmatchedRows.join('、')} 行）`);
    }
    if (view.missingRecordRows.length) {
      problems.push(`${label}有 ${view.missingRecordRows.length} 条记录在金额列里找不到对应格子（第 ${view.missingRecordRows.join('、')} 行）`);
    }
    if (view.ok !== true) {
      problems.push(`${label}取数核对 ok 应为 true`);
    }
  });

  const memoRows = data.memoKeys || [];
  const memoCompanies = new Set(memoRows.map((row) => row[0]));
  if ((data.combined && data.combined.memoKeyGroups) !== memoCompanies.size) {
    problems.push(`摘要线索企业数 ${data.combined && data.combined.memoKeyGroups} 与逐条线索里的企业数 ${memoCompanies.size} 不一致`);
  }
  memoRows.forEach((row) => {
    if (!row[3] || !row[5]) {
      problems.push(`「${row[0]}」的摘要线索 ${row[1]} ${row[2]} 只有一边有记录`);
    }
    if (row[7] !== row[4] - row[6]) {
      problems.push(`「${row[0]}」的摘要线索 ${row[1]} ${row[2]} 差额不等于应收 − 应付`);
    }
  });

  const sum = (list) => list.reduce((acc, value) => acc + value, 0);

  const blocks = data.export && data.export.blocks;
  if (combined.groups && blocks) {
    if (blocks.sheets.length !== combined.groups + 1) {
      problems.push(`分企业明细应有 ${combined.groups + 1} 张工作表（目录 + 每家企业一张），实际 ${blocks.sheets.length}`);
    }
    if (blocks.sheets[0] !== '目录') {
      problems.push('分企业明细的第一张工作表应叫「目录」');
    }
    const seenSheets = new Set();
    blocks.sheets.forEach((sheetName) => {
      if (!sheetName || sheetName.length > 31) {
        problems.push(`分企业明细的工作表名「${sheetName}」为空或超过 31 个字`);
      }
      if (seenSheets.has(sheetName.toLowerCase())) {
        problems.push(`分企业明细有重名工作表「${sheetName}」`);
      }
      seenSheets.add(sheetName.toLowerCase());
    });
    const cover = blocks.cover || [];
    if (!cover[5] || cover[5][0] !== '结果指纹' || !/^[0-9a-f]{64}$/.test(String(cover[5][1] || ''))) {
      problems.push('分企业明细目录的「结果指纹」行缺失或格式不对');
    }
    const coverRows = cover.slice(9, 9 + combined.groups);
    let previousImpact = Infinity;
    coverRows.forEach((row, index) => {
      const impact = Math.abs(row[4] || 0);
      if (impact > previousImpact) {
        problems.push(`分企业明细目录没有按净额影响从大到小排（第 ${index + 1} 行）`);
      }
      previousImpact = impact;
      if (row[7] !== blocks.sheets[index + 1]) {
        problems.push(`分企业明细目录「${row[1]}」写的工作表名与实际工作表对不上`);
      }
    });
    const totalRow = cover[9 + combined.groups] || [];
    if (Math.abs(totalRow[2] - sum(coverRows.map((row) => row[2]))) > 0.001
      || Math.abs(totalRow[3] - sum(coverRows.map((row) => row[3]))) > 0.001) {
      problems.push('分企业明细目录的合计行与逐企业合计对不上');
    }
    (blocks.company || []).forEach((view, index) => {
      const coverRow = coverRows[index] || [];
      const recv = view[3];
      const pay = view[4];
      const net = view[5];
      const direction = view[6];
      if (view[1] !== coverRow[1] || recv !== coverRow[2] || pay !== coverRow[3] || net !== coverRow[4]) {
        problems.push(`「${view[1]}」分表的应收/应付/净额与目录不一致`);
      }
      const signedNet = direction === '净应付' ? -1 : 1;
      if (Math.abs((recv - pay) - net * signedNet) > 0.001) {
        problems.push(`「${view[1]}」分表的净额不等于应收 − 应付`);
      }
      if (Math.abs(sum(view[7] || []) - (recv + pay)) > 0.001) {
        problems.push(`「${view[1]}」分表的小计之和与应收 + 应付对不上`);
      }
      const netRow = view[8] || [];
      if (netRow[1] !== net || netRow[2] !== direction) {
        problems.push(`「${view[1]}」分表底部的净额行与表头不一致`);
      }
    });
  }

  (data.ageByGroup || []).forEach((row) => {
    const name = `「${row[0]}」`;
    const recvBands = sum(row[1].slice(0, 4));
    const payBands = sum(row[2].slice(0, 4));
    if (recvBands + row[1][4] !== row[7]) {
      problems.push(`${name}账龄四档加「原表没写」= ${recvBands + row[1][4]} 分，和应收合计 ${row[7]} 分对不上`);
    }
    if (payBands + row[2][4] !== row[8]) {
      problems.push(`${name}账龄四档加「原表没写」= ${payBands + row[2][4]} 分，和应付合计 ${row[8]} 分对不上`);
    }
    const counts = row[3].split('|').map((side) => side.split('/').map(Number));
    const markedCounts = sum(counts[0].slice(0, 4)) + sum(counts[1].slice(0, 4));
    if (markedCounts !== row[5]) {
      problems.push(`${name}账龄分档笔数 ${markedCounts} 与已标账龄笔数 ${row[5]} 对不上`);
    }
    if (markedCounts + counts[0][4] + counts[1][4] !== row[6]) {
      problems.push(`${name}账龄笔数没覆盖全部 ${row[6]} 笔记录`);
    }
  });
  const ageStats = data.age;
  if (ageStats) {
    const rows = data.ageByGroup || [];
    const bandCents = rows.reduce((acc, row) => acc + sum(row[1].slice(0, 4)) + sum(row[2].slice(0, 4)), 0);
    const statsBandCents = sum(ageStats.recvBands) + sum(ageStats.payBands);
    if (bandCents !== statsBandCents) {
      problems.push(`账龄四档逐企业合计 ${bandCents} 分与汇总 ${statsBandCents} 分对不上`);
    }
    if (ageStats.longCents !== ageStats.recvBands[3] + ageStats.payBands[3]) {
      problems.push('3 年以上金额不等于两侧第四档之和');
    }
    if (ageStats.groups !== rows.length) {
      problems.push(`有账龄的企业数 ${ageStats.groups} 与逐企业明细 ${rows.length} 家不一致`);
    }
    if (ageStats.markedRecords !== rows.reduce((acc, row) => acc + row[5], 0)) {
      problems.push('已标账龄的笔数与逐企业明细之和不一致');
    }
  }

  if (data.export && data.export.decisionMarks > 2) {
    problems.push(`配对确认标记应只有 2 组，实际 ${data.export.decisionMarks}`);
  }
  if (combined.groups && !/^[0-9a-f]{64}$/.test(String(data.fingerprint || ''))) {
    problems.push('对账结果指纹缺失或不是 64 位十六进制');
  }
  if (data.similar && data.similar.count > 40) {
    problems.push(`疑似同一企业的建议有 ${data.similar.count} 条，超过 40 条上限`);
  }
  const prof = data.profileProbe;
  if (prof && prof.count > 0) {
    if (!prof.restoredMatchesAuto) {
      problems.push('列设置模板套回同一张表后识别结果变了');
    }
    const cleared = prof.clearedByBrokenProfile;
    if (cleared && (cleared[0] !== 'yes' || cleared[1] !== -1 || cleared[3] !== false)) {
      problems.push(`故意清空的列设置模板没有盖过自动识别（${JSON.stringify(cleared)}）`);
    }
  }
  if (data.mergeProbe) {
    if (data.mergeProbe.groupsAfter !== data.mergeProbe.groupsBefore - 1) {
      problems.push(`并归后企业数应少 1 家，实际 ${data.mergeProbe.groupsBefore} → ${data.mergeProbe.groupsAfter}`);
    }
    if (data.mergeProbe.revertedGroups !== data.mergeProbe.groupsBefore) {
      problems.push(`撤销并归后企业数没恢复（${data.mergeProbe.revertedGroups}）`);
    }
    data.mergeProbe.flagged.forEach((row) => {
      if (row[4] !== true) problems.push(`并归后的「${row[0]}」缺少「已人工并归」标记`);
    });
  }

  return problems.map((text) => `${name}：${text}`);
}

function main() {
  const { sandbox, captured, restore } = createSandbox();
  const files = fs
    .readdirSync(FIXTURES)
    .filter((name) => /\.(xlsx|csv)$/i.test(name))
    .filter((name) => !only.length || only.includes(name))
    .sort();

  if (!files.length) {
    console.error('没有找到夹具，检查 tests/fixtures 目录');
    process.exit(2);
  }

  const failures = [];
  let passed = 0;

  files.forEach((fileName) => {
    const filePath = path.join(FIXTURES, fileName);
    const buffer = new Uint8Array(fs.readFileSync(filePath));
    let workbook;
    try {
      workbook = sandbox.readWorkbook({ name: fileName }, buffer);
    } catch (error) {
      failures.push(`${fileName}：读文件失败（${error.message}）`);
      return;
    }

    sandbox.__wb = workbook;
    sandbox.__fileName = fileName;
    sandbox.__tolerance = TOLERANCE_CENTS;
    sandbox.__pairPercents = PERCENT_CASES[fileName] || null;
    let actualText;
    try {
      actualText = vm.runInContext(PROBE, sandbox);
    } catch (error) {
      failures.push(`${fileName}：跑对账流程出错（${error.message}）`);
      return;
    }

    const data = JSON.parse(actualText);
    const invariants = checkInvariants(fileName, data, TOLERANCE_CENTS);
    if (invariants.length) {
      invariants.forEach((text) => failures.push(text));
      return;
    }

    const goldenPath = path.join(GOLDEN, `${fileName}.json`);
    if (update) {
      fs.writeFileSync(goldenPath, stableText(data), 'utf8');
      passed += 1;
      console.log(`UPDATED  ${fileName}`);
      return;
    }

    if (!fs.existsSync(goldenPath)) {
      failures.push(`${fileName}：缺少黄金文件 ${path.basename(goldenPath)}，先跑 --update 生成并人工核对`);
      return;
    }

    const expectedText = stableText(JSON.parse(fs.readFileSync(goldenPath, 'utf8')));
    if (expectedText !== stableText(data)) {
      failures.push(`${fileName}：结果与黄金文件不一致\n${firstDiff(stableText(data), expectedText)}`);
      return;
    }

    passed += 1;
    console.log(`PASS     ${fileName}`);
  });

  if (!only.length) {
    sandbox.__cases = MANUAL_CASES;
    let manualData;
    try {
      manualData = JSON.parse(vm.runInContext(MANUAL_PROBE, sandbox));
    } catch (error) {
      failures.push(`手动粘贴：跑流程出错（${error.message}）`);
      manualData = null;
    }

    if (manualData) {
      manualData.forEach((item) => {
        const expectedNet = item.grossRecvCents - item.grossPayCents;
        const actualNet = item.netRecvCents - item.netPayCents;
        if (expectedNet !== actualNet) {
          failures.push(`手动粘贴「${item.name}」：合计与净额对不上`);
        }
        [item.controlTotal, ...(item.control || [])].forEach((ctl) => {
          if (!ctl) return;
          const label = ctl.sheetName || '合计';
          if (ctl.diffCents !== 0 || ctl.diffCells !== 0) {
            failures.push(`手动粘贴「${item.name}」：${label}取数核对不平（差 ${ctl.diffCents} 分 / ${ctl.diffCells} 格）`);
          }
          if (ctl.unmatchedCells !== 0) {
            failures.push(`手动粘贴「${item.name}」：${label}有 ${ctl.unmatchedCells} 行金额没被认领（第 ${ctl.unmatchedRows.join('、')} 行）`);
          }
          if (ctl.missingRecordRows.length) {
            failures.push(`手动粘贴「${item.name}」：${label}有记录找不到金额格（第 ${ctl.missingRecordRows.join('、')} 行）`);
          }
        });
      });
      const manualPath = path.join(GOLDEN, '__manual__.json');
      if (update) {
        fs.writeFileSync(manualPath, stableText(manualData), 'utf8');
        passed += 1;
        console.log('UPDATED  __manual__');
      } else if (!fs.existsSync(manualPath)) {
        failures.push('手动粘贴：缺少黄金文件 __manual__.json，先跑 --update');
      } else {
        const expectedManual = stableText(JSON.parse(fs.readFileSync(manualPath, 'utf8')));
        if (expectedManual !== stableText(manualData)) {
          failures.push(`手动粘贴：结果与黄金文件不一致\n${firstDiff(stableText(manualData), expectedManual)}`);
        } else {
          passed += 1;
          console.log('PASS     __manual__');
        }
      }
    }

    sandbox.downloadSample();
    if (!captured.length) {
      failures.push('内置示例：没能生成示例工作簿');
    } else {
      sandbox.__wb = captured[captured.length - 1];
      sandbox.__fileName = '内置示例.xlsx';
      sandbox.__tolerance = TOLERANCE_CENTS;
      sandbox.__pairPercents = null;
      let sampleData;
      try {
        sampleData = JSON.parse(vm.runInContext(PROBE, sandbox));
      } catch (error) {
        failures.push(`内置示例：跑流程出错（${error.message}）`);
      }

      if (sampleData) {
        const sampleProblems = checkInvariants('内置示例', sampleData, TOLERANCE_CENTS);
        sampleProblems.forEach((text) => failures.push(text));
        const expectedSample = {
          records: 15,
          inherited: 5,
          reclass: 1,
          netRecvCents: 19720000,
          netPayCents: 5000000,
          evenGroups: 1
        };
        Object.keys(expectedSample).forEach((key) => {
          if (sampleData.combined[key] !== expectedSample[key]) {
            failures.push(`内置示例：${key} 应为 ${expectedSample[key]}，实际 ${sampleData.combined[key]}`);
          }
        });

        const samplePath = path.join(GOLDEN, '__sample__.json');
        if (update) {
          fs.writeFileSync(samplePath, stableText(sampleData), 'utf8');
          passed += 1;
          console.log('UPDATED  __sample__');
        } else if (!fs.existsSync(samplePath)) {
          failures.push('内置示例：缺少黄金文件 __sample__.json，先跑 --update');
        } else {
          const expectedRecord = stableText(JSON.parse(fs.readFileSync(samplePath, 'utf8')));
          if (expectedRecord !== stableText(sampleData)) {
            failures.push(`内置示例：结果与黄金文件不一致\n${firstDiff(stableText(sampleData), expectedRecord)}`);
          } else {
            passed += 1;
            console.log('PASS     __sample__');
          }
        }
      }
    }
  }

  restore();

  if (failures.length) {
    console.error('\n失败：');
    failures.forEach((text) => console.error(`- ${text}`));
    console.error(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
    process.exit(1);
  }

  console.log(`\n全部通过：${passed} 项（${files.length} 个夹具${only.length ? '' : ' + 手动粘贴 + 内置示例'}）`);
}

main();
