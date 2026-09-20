/**
 * 字体版本升级影响评估。
 *
 * 针对一个字体条目的旧版 / 新版 TTF/OTF（均在浏览器端复用 sfnt.ts 的 cmap 解析，
 * 文件不上传、不持久化），按当前参与求解的场景与「忽略透明格式字符」设置
 * 逐字素簇比较两个版本的覆盖情况：
 *
 * - 只有簇内全部「必需码位」均被该版本覆盖，才算该版本支持该簇
 *   （与回退链求解的承接规则一致，ZWJ/变体选择符等透明码位随设置剔除）；
 * - 按场景与出现位置逐簇独立计数：同一文本重复出现、跨场景出现均分别成条，绝不合并；
 * - 变化分为 gained（旧不支持→新支持）、lost（旧支持→新不支持）、
 *   unchanged（支持状态不变，进一步区分 still-supported / still-unsupported / free）。
 *
 * 另给出新旧覆盖码位的双向差集与逐场景汇总；本模块为纯计算，不触碰文件 IO。
 */

import { subtractRanges } from './ranges';
import { coversCodepoint } from './coverage';
import { formatCodepoint, isTransparentCodepoint, type Grapheme } from './grapheme';
import type { FontFileInfo } from '../types';

/** 参与比较的字体条目（仅展示用元数据；与上传的版本文件无关联） */
export interface UpgradeFontRef {
  id: string;
  name: string;
}

/** 参与比较的场景（App 中即当前参与求解的场景；单场景模式仅活动场景） */
export interface UpgradeScenarioRef {
  id: string;
  name: string;
}

/** 参与比较的一个场景及其按场景内顺序排列的字素簇 */
export interface UpgradeGroup {
  scenarioId: string;
  graphemes: Grapheme[];
}

/** 簇变化类型：新增支持 / 失去支持 / 不变 */
export type UpgradeChangeKind = 'gained' | 'lost' | 'unchanged';

/** 不变簇的细分：仍支持 / 仍不支持 / 仅含透明格式字符（free） */
export type UpgradeUnchangedState = 'supported' | 'unsupported' | 'free';

/** 单个字素簇的一次出现的比较结果（重复簇按场景与位置独立成条） */
export interface UpgradeClusterOccurrence {
  kind: UpgradeChangeKind;
  /** kind === 'unchanged' 时的细分 */
  unchangedState: UpgradeUnchangedState | null;
  /** 所属场景 id */
  scenarioId: string;
  /** 簇在所属场景内的序号（从 0 开始） */
  localIndex: number;
  /** 簇原文 */
  text: string;
  /** 簇在原文中的 UTF-16 偏移 */
  start: number;
  /** 簇内全部码位 */
  codepoints: number[];
  /** 参与覆盖判定的必需码位（已按设置剔除透明格式字符） */
  required: number[];
  /** 旧版是否完整支持 */
  oldSupported: boolean;
  /** 新版是否完整支持 */
  newSupported: boolean;
  /** 该簇不被某版本支持时，该版本缺失的必需码位 */
  oldMissingCodepoints: number[];
  newMissingCodepoints: number[];
}

/** 单场景变化汇总（簇按场景内序号独立计数） */
export interface UpgradeScenarioSummary {
  scenarioId: string;
  scenarioName: string;
  total: number;
  gained: number;
  lost: number;
  unchangedSupported: number;
  unchangedUnsupported: number;
  free: number;
  /** 旧版完整支持的簇数（含 free） */
  oldSupportedCount: number;
  /** 新版完整支持的簇数（含 free） */
  newSupportedCount: number;
}

export interface FontUpgradeComparison {
  gained: UpgradeClusterOccurrence[];
  lost: UpgradeClusterOccurrence[];
  unchanged: UpgradeClusterOccurrence[];
  scenarios: UpgradeScenarioSummary[];
  /** 全部参与比较的簇数（各场景簇数之和，重复簇独立计数） */
  totalClusters: number;
  /** 旧版覆盖、新版不覆盖的码位区间 */
  removedRanges: [number, number][];
  removedCodepointCount: number;
  /** 新版覆盖、旧版不覆盖的码位区间 */
  addedRanges: [number, number][];
  addedCodepointCount: number;
  oldCodepointCount: number;
  newCodepointCount: number;
  oldRangeCount: number;
  newRangeCount: number;
}

export interface CompareFontUpgradeInput {
  font: UpgradeFontRef;
  oldVersion: FontFileInfo;
  newVersion: FontFileInfo;
  groups: UpgradeGroup[];
  scenarios: UpgradeScenarioRef[];
  ignoreFormatCodepoints: boolean;
}

/** 某版本是否完整支持一个簇（全部必需码位均在其 cmap 覆盖中） */
function versionSupports(
  ranges: [number, number][],
  required: number[],
): boolean {
  return required.every((cp) => coversCodepoint(ranges, cp));
}

/**
 * 逐场景逐字素簇比较旧版 / 新版字体覆盖，并计算覆盖码位双向差集。
 * 输入场景应与当前参与求解的场景一致（单场景模式只传活动场景）。
 */
export function compareFontUpgrade(input: CompareFontUpgradeInput): FontUpgradeComparison {
  const { oldVersion, newVersion, groups, scenarios, ignoreFormatCodepoints } = input;

  const removedRanges = subtractRanges(oldVersion.ranges, newVersion.ranges);
  const addedRanges = subtractRanges(newVersion.ranges, oldVersion.ranges);

  const gained: UpgradeClusterOccurrence[] = [];
  const lost: UpgradeClusterOccurrence[] = [];
  const unchanged: UpgradeClusterOccurrence[] = [];

  const totals = new Map<
    string,
    { total: number; gained: number; lost: number; us: number; uu: number; free: number; old: number; next: number }
  >();
  const ensure = (id: string) => {
    let t = totals.get(id);
    if (!t) {
      t = { total: 0, gained: 0, lost: 0, us: 0, uu: 0, free: 0, old: 0, next: 0 };
      totals.set(id, t);
    }
    return t;
  };

  groups.forEach((group) => {
    group.graphemes.forEach((g, localIndex) => {
      const required = ignoreFormatCodepoints
        ? g.codepoints.filter((cp) => !isTransparentCodepoint(cp))
        : [...g.codepoints];
      const isFree = required.length === 0;
      // free 簇（仅含透明格式字符）无需任何字形：两版本均视为支持
      const oldSupported = isFree || versionSupports(oldVersion.ranges, required);
      const newSupported = isFree || versionSupports(newVersion.ranges, required);
      const oldMissing = oldSupported ? [] : required.filter((cp) => !coversCodepoint(oldVersion.ranges, cp));
      const newMissing = newSupported ? [] : required.filter((cp) => !coversCodepoint(newVersion.ranges, cp));

      let kind: UpgradeChangeKind;
      let unchangedState: UpgradeUnchangedState | null;
      if (isFree) {
        kind = 'unchanged';
        unchangedState = 'free';
      } else if (!oldSupported && newSupported) {
        kind = 'gained';
        unchangedState = null;
      } else if (oldSupported && !newSupported) {
        kind = 'lost';
        unchangedState = null;
      } else {
        kind = 'unchanged';
        unchangedState = oldSupported ? 'supported' : 'unsupported';
      }

      const occurrence: UpgradeClusterOccurrence = {
        kind,
        unchangedState,
        scenarioId: group.scenarioId,
        localIndex,
        text: g.text,
        start: g.start,
        codepoints: g.codepoints,
        required,
        oldSupported,
        newSupported,
        oldMissingCodepoints: oldMissing,
        newMissingCodepoints: newMissing,
      };

      const t = ensure(group.scenarioId);
      t.total += 1;
      if (oldSupported) t.old += 1;
      if (newSupported) t.next += 1;
      if (kind === 'gained') {
        gained.push(occurrence);
        t.gained += 1;
      } else if (kind === 'lost') {
        lost.push(occurrence);
        t.lost += 1;
      } else {
        unchanged.push(occurrence);
        if (unchangedState === 'supported') t.us += 1;
        else if (unchangedState === 'unsupported') t.uu += 1;
        else t.free += 1;
      }
    });
  });

  const scenarioSummaries: UpgradeScenarioSummary[] = scenarios.map((s) => {
    const t = totals.get(s.id) ?? {
      total: 0,
      gained: 0,
      lost: 0,
      us: 0,
      uu: 0,
      free: 0,
      old: 0,
      next: 0,
    };
    return {
      scenarioId: s.id,
      scenarioName: s.name,
      total: t.total,
      gained: t.gained,
      lost: t.lost,
      unchangedSupported: t.us,
      unchangedUnsupported: t.uu,
      free: t.free,
      oldSupportedCount: t.old,
      newSupportedCount: t.next,
    };
  });

  const removedCodepointCount = removedRanges.reduce((sum, [s, e]) => sum + (e - s + 1), 0);
  const addedCodepointCount = addedRanges.reduce((sum, [s, e]) => sum + (e - s + 1), 0);

  return {
    gained,
    lost,
    unchanged,
    scenarios: scenarioSummaries,
    totalClusters: gained.length + lost.length + unchanged.length,
    removedRanges,
    removedCodepointCount,
    addedRanges,
    addedCodepointCount,
    oldCodepointCount: oldVersion.codepointCount,
    newCodepointCount: newVersion.codepointCount,
    oldRangeCount: oldVersion.ranges.length,
    newRangeCount: newVersion.ranges.length,
  };
}

/** 单侧边文件的元数据序列化（仅解析得到的元数据，文件二进制从不离开浏览器） */
function serializeVersionSide(v: FontFileInfo) {
  return {
    fileName: v.name,
    sizeBytes: v.size,
    sfntVersion: v.sfntVersion,
    cmapFormats: v.cmapFormats,
    parsedAt: v.parsedAt,
    codepointCount: v.codepointCount,
    rangeCount: v.ranges.length,
    /** 完整 cmap 覆盖区间（紧凑 U+xxxx 形态） */
    ranges: v.ranges.map(([s, e]) => [formatCodepoint(s), formatCodepoint(e)]),
  };
}

function serializeOccurrence(o: UpgradeClusterOccurrence, scenarioName: string | null) {
  return {
    scenarioId: o.scenarioId,
    ...(scenarioName !== null ? { scenario: scenarioName } : {}),
    localIndex: o.localIndex,
    text: o.text,
    start: o.start,
    codepoints: o.codepoints.map(formatCodepoint),
    requiredCodepoints: o.required.map(formatCodepoint),
    oldSupported: o.oldSupported,
    newSupported: o.newSupported,
    oldMissingCodepoints: o.oldMissingCodepoints.map(formatCodepoint),
    newMissingCodepoints: o.newMissingCodepoints.map(formatCodepoint),
    ...(o.kind === 'unchanged' ? { unchangedState: o.unchangedState } : {}),
  };
}

/**
 * 构建「字体版本升级影响评估」JSON 报告：
 * 含两侧文件元数据、新旧覆盖码位双向差集（区间 + 完整码位区间）、
 * 逐场景汇总与新增支持 / 失去支持 / 不变簇完整变化明细（界面截断不影响 JSON）。
 */
export function buildFontUpgradeReport(
  input: CompareFontUpgradeInput,
  comparison: FontUpgradeComparison,
  generatedAt: string,
  mode: 'single' | 'set',
) {
  const nameById = new Map(input.scenarios.map((s) => [s.id, s.name]));
  const scenarioName = (id: string) => nameById.get(id) ?? null;
  const fmtRanges = (rs: [number, number][]) =>
    rs.map(([s, e]) => [formatCodepoint(s), formatCodepoint(e)]);

  const unchangedByState = (state: UpgradeUnchangedState) =>
    comparison.unchanged.filter((o) => o.unchangedState === state);

  return {
    tool: 'unicode-font-fallback-audit',
    analysis: 'font-version-upgrade-impact',
    version: 1,
    generatedAt,
    mode,
    targetFont: {
      name: input.font.name,
      /** 仅用于标识所选字体条目，随名称重命名/删除可能失效 */
      fontEntryId: input.font.id,
    },
    options: {
      ignoreFormatCodepoints: input.ignoreFormatCodepoints,
    },
    versions: {
      old: serializeVersionSide(input.oldVersion),
      new: serializeVersionSide(input.newVersion),
    },
    codepointDiff: {
      /** 新版覆盖、旧版不覆盖 */
      added: {
        count: comparison.addedCodepointCount,
        segmentCount: comparison.addedRanges.length,
        ranges: fmtRanges(comparison.addedRanges),
      },
      /** 旧版覆盖、新版不覆盖 */
      removed: {
        count: comparison.removedCodepointCount,
        segmentCount: comparison.removedRanges.length,
        ranges: fmtRanges(comparison.removedRanges),
      },
    },
    summary: {
      scenarioCount: comparison.scenarios.length,
      totalClusters: comparison.totalClusters,
      gainedCount: comparison.gained.length,
      lostCount: comparison.lost.length,
      unchangedCount: comparison.unchanged.length,
      unchangedSupportedCount: unchangedByState('supported').length,
      unchangedUnsupportedCount: unchangedByState('unsupported').length,
      freeClusterCount: unchangedByState('free').length,
      oldSupportedCount: comparison.scenarios.reduce((a, s) => a + s.oldSupportedCount, 0),
      newSupportedCount: comparison.scenarios.reduce((a, s) => a + s.newSupportedCount, 0),
    },
    scenarios: comparison.scenarios,
    changes: {
      gained: comparison.gained.map((o) => serializeOccurrence(o, scenarioName(o.scenarioId))),
      lost: comparison.lost.map((o) => serializeOccurrence(o, scenarioName(o.scenarioId))),
      unchanged: comparison.unchanged.map((o) =>
        serializeOccurrence(o, scenarioName(o.scenarioId)),
      ),
    },
  };
}
