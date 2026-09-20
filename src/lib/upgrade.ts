/**
 * 字体版本升级影响评估：
 * 对同一字体条目的旧版 / 新版两个本地字体文件（仅浏览器端 cmap 解析结果，
 * 文件本身不上传、不持久化），按当前参与求解的场景字素簇逐簇比较支持情况。
 *
 * 判定规则与主求解一致：
 * - 簇内全部「必需码位」（按设置剔除透明格式字符后）都被某版本覆盖，
 *   才算该版本支持此簇（ZWJ 序列、组合符簇必须整体可渲染）；
 * - 重复出现的簇按场景与出现位置各自独立计数，不做任何去重合并；
 * - 仅含透明格式字符的簇必需码位为空，两版本均视为支持（与主分析的 free 簇一致）。
 */

import type { FontFileInfo } from '../types';
import type { GraphemeGroup } from './coverage';
import { coversCodepoint } from './coverage';
import { formatCodepoint, isTransparentCodepoint } from './grapheme';
import { countCodepoints, subtractRanges } from './ranges';

/** 簇级变化类别：gained 升级后新增支持 / lost 升级后失去支持 / unchanged 不变 */
export type UpgradeChangeKind = 'gained' | 'lost' | 'unchanged';

/** 单个字素簇（单次出现）的版本对比结果 */
export interface UpgradeClusterChange {
  /** 所属场景 id */
  scenarioId: string;
  /** 簇在所属场景内的局部下标（从 0 开始）；重复簇按出现位置各自成行 */
  localIndex: number;
  /** 簇文本（原样） */
  text: string;
  /** 在原文中的 UTF-16 偏移 */
  start: number;
  /** 簇内全部码位 */
  codepoints: number[];
  /** 需要字体实际覆盖的码位（已按设置剔除透明格式字符） */
  required: number[];
  /** 旧版是否完整覆盖全部必需码位 */
  oldSupported: boolean;
  /** 新版是否完整覆盖全部必需码位 */
  newSupported: boolean;
  change: UpgradeChangeKind;
}

/** 单个场景的升级变化汇总 */
export interface UpgradeScenarioStats {
  scenarioId: string;
  clusterCount: number;
  /** 升级后新增支持的簇数 */
  gained: number;
  /** 升级后失去支持的簇数 */
  lost: number;
  /** 两版本均支持（不变簇） */
  stillSupported: number;
  /** 两版本均不支持（不变簇） */
  stillUnsupported: number;
}

export interface UpgradeAssessment {
  /** 新版有、旧版无的码位区间（new − old） */
  addedRanges: [number, number][];
  addedCount: number;
  /** 旧版有、新版无的码位区间（old − new） */
  removedRanges: [number, number][];
  removedCount: number;
  /** 全部参与场景展平后的逐簇变化（重复簇独立成行，不去重） */
  clusters: UpgradeClusterChange[];
  /** 逐场景汇总（按场景清单顺序，空场景保留且各项为 0） */
  scenarioStats: UpgradeScenarioStats[];
  total: number;
  gainedCount: number;
  lostCount: number;
  /** 不变簇总数 = 仍支持 + 仍不支持 */
  unchangedCount: number;
  stillSupportedCount: number;
  stillUnsupportedCount: number;
}

/**
 * 逐字素簇比较旧版 / 新版字体的支持情况。
 * groups 为当前参与求解的场景簇序列（单场景模式仅活动场景），
 * oldRanges / newRanges 为两版本 cmap 实测覆盖区间（已排序合并）。
 */
export function assessFontUpgrade(
  groups: GraphemeGroup[],
  oldRanges: [number, number][],
  newRanges: [number, number][],
  ignoreFormatCodepoints: boolean,
): UpgradeAssessment {
  const addedRanges = subtractRanges(newRanges, oldRanges);
  const removedRanges = subtractRanges(oldRanges, newRanges);

  const clusters: UpgradeClusterChange[] = [];
  const scenarioStats: UpgradeScenarioStats[] = [];
  let gainedCount = 0;
  let lostCount = 0;
  let stillSupportedCount = 0;
  let stillUnsupportedCount = 0;

  for (const group of groups) {
    const stat: UpgradeScenarioStats = {
      scenarioId: group.scenarioId,
      clusterCount: group.graphemes.length,
      gained: 0,
      lost: 0,
      stillSupported: 0,
      stillUnsupported: 0,
    };
    scenarioStats.push(stat);

    group.graphemes.forEach((g, localIndex) => {
      const required = ignoreFormatCodepoints
        ? g.codepoints.filter((cp) => !isTransparentCodepoint(cp))
        : [...g.codepoints];
      // 空必需集（纯格式字符簇）：两版本均视为支持
      const oldSupported = required.every((cp) => coversCodepoint(oldRanges, cp));
      const newSupported = required.every((cp) => coversCodepoint(newRanges, cp));
      const change: UpgradeChangeKind =
        !oldSupported && newSupported
          ? 'gained'
          : oldSupported && !newSupported
            ? 'lost'
            : 'unchanged';

      if (change === 'gained') {
        stat.gained += 1;
        gainedCount += 1;
      } else if (change === 'lost') {
        stat.lost += 1;
        lostCount += 1;
      } else if (oldSupported) {
        stat.stillSupported += 1;
        stillSupportedCount += 1;
      } else {
        stat.stillUnsupported += 1;
        stillUnsupportedCount += 1;
      }

      clusters.push({
        scenarioId: group.scenarioId,
        localIndex,
        text: g.text,
        start: g.start,
        codepoints: g.codepoints,
        required,
        oldSupported,
        newSupported,
        change,
      });
    });
  }

  return {
    addedRanges,
    addedCount: countCodepoints(addedRanges),
    removedRanges,
    removedCount: countCodepoints(removedRanges),
    clusters,
    scenarioStats,
    total: clusters.length,
    gainedCount,
    lostCount,
    unchangedCount: stillSupportedCount + stillUnsupportedCount,
    stillSupportedCount,
    stillUnsupportedCount,
  };
}

/** 升级评估报告的可选上下文（界面状态快照） */
export interface UpgradeReportContext {
  /** 被评估的字体条目（名称为空串表示未命名；null 表示无条目可选） */
  fontEntry: { preference: number; name: string } | null;
  mode: 'single' | 'set';
  ignoreFormatCodepoints: boolean;
  /** 场景 id -> 显示名 */
  scenarioNames: Record<string, string>;
  oldFile: FontFileInfo;
  newFile: FontFileInfo;
  generatedAt: string;
}

const fmtRanges = (rs: [number, number][]) =>
  rs.map(([s, e]) => [formatCodepoint(s), formatCodepoint(e)]);

/** 上传文件的审计序列化：只输出解析出的元数据与码位区间，文件二进制从未离开浏览器 */
function serializeVersionFile(f: FontFileInfo) {
  return {
    fileName: f.name,
    sizeBytes: f.size,
    sfntVersion: f.sfntVersion,
    cmapFormats: f.cmapFormats,
    parsedAt: f.parsedAt,
    codepointCount: f.codepointCount,
    ranges: fmtRanges(f.ranges),
  };
}

/**
 * 构建「字体版本升级影响评估」JSON 报告：
 * 含文件元数据、新旧覆盖码位差集、逐场景汇总与完整变化明细。
 */
export function buildUpgradeReport(
  assessment: UpgradeAssessment,
  ctx: UpgradeReportContext,
) {
  const scenarioName = (id: string) => ctx.scenarioNames[id] ?? null;

  return {
    tool: 'unicode-font-fallback-audit',
    analysis: 'font-version-upgrade-impact',
    version: 1,
    generatedAt: ctx.generatedAt,
    mode: ctx.mode,
    options: {
      ignoreFormatCodepoints: ctx.ignoreFormatCodepoints,
    },
    /** 本次评估针对的字体条目（仅作上下文标注，比较对象为两个上传文件） */
    fontEntry: ctx.fontEntry
      ? {
          name: ctx.fontEntry.name,
          preference: ctx.fontEntry.preference + 1,
        }
      : null,
    files: {
      old: serializeVersionFile(ctx.oldFile),
      new: serializeVersionFile(ctx.newFile),
    },
    /** 新旧版本 cmap 实测覆盖的码位差集 */
    coverageDiff: {
      /** 新版新增覆盖（new − old） */
      added: {
        count: assessment.addedCount,
        segmentCount: assessment.addedRanges.length,
        ranges: fmtRanges(assessment.addedRanges),
      },
      /** 新版失去覆盖（old − new） */
      removed: {
        count: assessment.removedCount,
        segmentCount: assessment.removedRanges.length,
        ranges: fmtRanges(assessment.removedRanges),
      },
    },
    summary: {
      clusterCount: assessment.total,
      gainedCount: assessment.gainedCount,
      lostCount: assessment.lostCount,
      unchangedCount: assessment.unchangedCount,
      stillSupportedCount: assessment.stillSupportedCount,
      stillUnsupportedCount: assessment.stillUnsupportedCount,
    },
    /** 逐场景汇总（重复簇按场景与出现位置独立计数） */
    scenarios: assessment.scenarioStats.map((s) => ({
      scenarioId: s.scenarioId,
      scenario: scenarioName(s.scenarioId),
      clusterCount: s.clusterCount,
      gainedCount: s.gained,
      lostCount: s.lost,
      stillSupportedCount: s.stillSupported,
      stillUnsupportedCount: s.stillUnsupported,
    })),
    /** 完整变化明细：每个簇的每次出现独立成行 */
    changes: assessment.clusters.map((c) => ({
      scenarioId: c.scenarioId,
      scenario: scenarioName(c.scenarioId),
      scenarioLocalIndex: c.localIndex,
      textStart: c.start,
      text: c.text,
      codepoints: c.codepoints.map(formatCodepoint),
      requiredCodepoints: c.required.map(formatCodepoint),
      oldSupported: c.oldSupported,
      newSupported: c.newSupported,
      change: c.change,
    })),
  };
}
