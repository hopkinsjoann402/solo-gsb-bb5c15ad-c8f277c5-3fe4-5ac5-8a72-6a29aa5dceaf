import type { ParsedFont, ScenarioClusterAudit } from '../types';
import type { Grapheme } from './grapheme';
import { isTransparentCodepoint } from './grapheme';

/** 二分查找：码位是否落在已排序合并的范围内 */
export function coversCodepoint(ranges: [number, number][], cp: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e] = ranges[mid];
    if (cp < s) hi = mid - 1;
    else if (cp > e) lo = mid + 1;
    else return true;
  }
  return false;
}

export interface ClusterCoverage {
  index: number;
  text: string;
  start: number;
  codepoints: number[];
  required: number[];
  /** 可完整覆盖该簇的字体下标（相对传入的 fonts 数组） */
  candidates: number[];
  /** 仅含透明格式字符 */
  free: boolean;
  /** 去重后的需求模式编号；-1 表示 free 簇不参与求解 */
  patternId: number;
}

/** 分组（场景）输入：每组的字素簇序列；空数组表示空场景，保留但不参与求解 */
export interface GraphemeGroup {
  scenarioId: string;
  graphemes: Grapheme[];
}

/** 带场景归属的覆盖分析簇（index 为跨场景展平后的全局下标） */
export interface ScenarioClusterCoverage extends Omit<ClusterCoverage, 'patternId'> {
  scenarioId: string;
  /** 簇在所属场景内的局部下标（从 0 开始） */
  localIndex: number;
  patternId: number;
}

export interface CoverageAnalysis {
  clusters: ClusterCoverage[];
  /** 唯一需求模式：每个模式是可覆盖该类簇的字体下标列表 */
  patterns: number[][];
  /** 模式 -> 簇下标列表 */
  patternClusters: number[][];
}

export interface GroupedCoverageAnalysis {
  /** 全部场景按场景顺序展平后的簇 */
  clusters: ScenarioClusterCoverage[];
  /**
   * 全局去重的需求模式（候选字体集合相同即同一模式，跨场景共享）。
   * 注意：去重的只是求解约束；重复文本/重复需求在每个场景中仍各自成簇、
   * 分别计数，不会跨场景合并。
   */
  patterns: number[][];
}

function buildCoverageRow(
  fonts: ParsedFont[],
  ignoreFormatCodepoints: boolean,
  g: Grapheme,
): { required: number[]; candidates: number[]; free: boolean } {
  const required = ignoreFormatCodepoints
    ? g.codepoints.filter((cp) => !isTransparentCodepoint(cp))
    : [...g.codepoints];
  if (required.length === 0) {
    return { required, candidates: fonts.map((_, i) => i), free: true };
  }
  const candidates: number[] = [];
  for (let i = 0; i < fonts.length; i++) {
    if (required.every((cp) => coversCodepoint(fonts[i].effectiveRanges, cp))) {
      candidates.push(i);
    }
  }
  return { required, candidates, free: false };
}

/**
 * 多场景合并覆盖分析。
 * 所有场景的字素簇一起参与候选字体判定，需求模式跨场景全局去重，
 * 供一次回退链求解（链中字体及顺序全局唯一）；空场景无簇、不影响求解。
 */
export function analyzeGroupedCoverage(
  groups: GraphemeGroup[],
  fonts: ParsedFont[],
  ignoreFormatCodepoints: boolean,
): GroupedCoverageAnalysis {
  const patternMap = new Map<string, number>();
  const patterns: number[][] = [];
  const clusters: ScenarioClusterCoverage[] = [];

  groups.forEach((group) => {
    group.graphemes.forEach((g, localIndex) => {
      const index = clusters.length;
      const { required, candidates, free } = buildCoverageRow(
        fonts,
        ignoreFormatCodepoints,
        g,
      );
      let patternId = -1;
      if (!free) {
        const key = candidates.join(',');
        const pid = patternMap.get(key);
        if (pid === undefined) {
          patternId = patterns.length;
          patternMap.set(key, patternId);
          patterns.push(candidates);
        } else {
          patternId = pid;
        }
      }
      clusters.push({
        index,
        text: g.text,
        start: g.start,
        codepoints: g.codepoints,
        required,
        candidates,
        free,
        patternId,
        scenarioId: group.scenarioId,
        localIndex,
      });
    });
  });

  return { clusters, patterns };
}

/**
 * 逐字素簇计算每种字体能否承接（单场景便捷封装）。
 * 规则：簇内每个“需覆盖码位”都落在字体范围内，才认为该字体可承接该簇
 * （ZWJ 序列、组合符簇必须整体可渲染，不能只覆盖一半）。
 */
export function analyzeCoverage(
  graphemes: Grapheme[],
  fonts: ParsedFont[],
  ignoreFormatCodepoints: boolean,
): CoverageAnalysis {
  const grouped = analyzeGroupedCoverage(
    [{ scenarioId: '', graphemes }],
    fonts,
    ignoreFormatCodepoints,
  );
  const patternClusters: number[][] = grouped.patterns.map(() => []);
  const clusters: ClusterCoverage[] = grouped.clusters.map((c) => {
    if (!c.free) patternClusters[c.patternId].push(c.index);
    return {
      index: c.index,
      text: c.text,
      start: c.start,
      codepoints: c.codepoints,
      required: c.required,
      candidates: c.candidates,
      free: c.free,
      patternId: c.patternId,
    };
  });
  return { clusters, patterns: grouped.patterns, patternClusters };
}

/** 缺失簇中，具体是哪些码位没有任何字体覆盖 */
export function findMissingCodepoints(required: number[], fonts: ParsedFont[]): number[] {
  return required.filter(
    (cp) => !fonts.some((f) => coversCodepoint(f.effectiveRanges, cp)),
  );
}

/** 将已完成承接分配的场景簇整理为审计输出形态 */
export function toScenarioClusterAudit(
  c: ScenarioClusterCoverage,
  assigned: number | null,
  status: ScenarioClusterAudit['status'],
  missingCodepoints: number[],
  missingKind: ScenarioClusterAudit['missingKind'] = null,
  unblockFonts: number[] = [],
): ScenarioClusterAudit {
  return {
    index: c.index,
    text: c.text,
    start: c.start,
    codepoints: c.codepoints,
    required: c.required,
    candidates: c.candidates,
    free: c.free,
    assigned,
    status,
    missingKind,
    unblockFonts,
    missingCodepoints,
    scenarioId: c.scenarioId,
    localIndex: c.localIndex,
  };
}
