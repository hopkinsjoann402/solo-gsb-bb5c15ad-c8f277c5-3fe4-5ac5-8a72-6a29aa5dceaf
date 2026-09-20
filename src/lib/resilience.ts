/**
 * 单字体失效韧性分析。
 *
 * 对当前最优回退链中的每种字体，模拟其不可用（从有效字体列表中移除），
 * 在保持原始偏好顺序、当前声明/实测覆盖模式与入链约束（锁定/排除）
 * 的前提下重新求解回退链，并对比失效前后每个字素簇的承接结果：
 *   - 新增缺失：原本被覆盖、失效后无任何字体可承接的簇；
 *   - 改接：原本由某字体承接、失效后改由链中其他字体承接的簇。
 *
 * 场景集模式下所有场景的簇展平后一起参与分析（与基线求解同一空间），
 * 簇条目带 scenarioId/localIndex 以便界面分组展示。
 *
 * 索引约定：所有对外暴露的字体下标均为「原始有效字体列表」中的下标。
 * 过滤失效字体后产生的新下标空间只存在于单次重解内部，结果一律经
 * remaining 映射回原始空间，保证字体名称与原条目不错配。
 */

import type { ParsedFont, ScenarioClusterAudit } from '../types';
import { analyzeGroupedCoverage, type GraphemeGroup } from './coverage';
import { findMissingCodepoints } from './coverage';
import { solveFallbackChain } from './solver';

/** 失效后新增缺失的字素簇 */
export interface NewMissingCluster {
  index: number;
  text: string;
  codepoints: number[];
  /** 剩余字体中仍无任何覆盖的码位 */
  missingCodepoints: number[];
  /** 所属场景 id（单场景模式为空串） */
  scenarioId?: string;
  /** 在所属场景内的局部下标 */
  localIndex?: number;
}

/** 失效后改由其他字体承接的字素簇 */
export interface ReassignedCluster {
  index: number;
  text: string;
  codepoints: number[];
  /** 原承接字体（原始有效字体下标） */
  fromFont: number;
  /** 新承接字体（原始有效字体下标） */
  toFont: number;
  /** 所属场景 id（单场景模式为空串） */
  scenarioId?: string;
  /** 在所属场景内的局部下标 */
  localIndex?: number;
}

/** 单个字体失效场景的重解结果 */
export interface FailureScenario {
  /** 失效字体在原始有效字体列表中的下标 */
  fontIndex: number;
  /** 失效字体的原始偏好位次（0 = 最优先） */
  preference: number;
  /** 失效前由该字体承接的（非 free）簇数 */
  assignedBefore: number;
  /** 失效后是否仍可行（无新增缺失） */
  feasible: boolean;
  /** 重解是否精确最优 */
  exact: boolean;
  /** 替代回退链：原始有效字体下标，按偏好顺序 */
  chain: number[];
  /** 替代链中每种字体承接的簇数（与 chain 一一对应，跨场景合计） */
  chainAssigned: number[];
  /** 链长变化：失效后链长 − 失效前链长 */
  chainLengthDelta: number;
  newMissing: NewMissingCluster[];
  reassigned: ReassignedCluster[];
  /** 失效前后均缺失的簇数（与本次失效无关，仅作对照） */
  stillMissing: number;
}

export interface ResilienceInput {
  /** 各场景的字素簇序列（单场景模式仅一组，scenarioId 传空串） */
  groups: GraphemeGroup[];
  /** 原始有效字体列表（对外暴露的下标空间） */
  validFonts: ParsedFont[];
  /** 每种有效字体的原始偏好位次（与 validFonts 对齐） */
  preference: number[];
  ignoreFormat: boolean;
  lengthPriority: number;
  /** 基线（失效前）已分配的簇审计结果（按全局展平顺序对齐） */
  baselineClusters: ScenarioClusterAudit[];
  /** 基线回退链（原始有效字体下标，按偏好顺序） */
  baselineChain: number[];
  /** 必须入链（锁定）的字体下标（原始有效字体空间）；失效字体外其余保持锁定 */
  locked?: number[];
  /** 禁止入链（排除）的字体下标（原始有效字体空间），重解时保持排除 */
  excluded?: number[];
}

/**
 * 逐一模拟链中字体失效并重解。
 * 返回的风险卡片已按「新增缺失数降序 → 改接簇数降序 → 偏好位次升序」排序。
 */
export function analyzeSingleFontFailure(input: ResilienceInput): FailureScenario[] {
  const {
    groups,
    validFonts,
    preference,
    ignoreFormat,
    lengthPriority,
    baselineClusters,
    baselineChain,
    locked,
    excluded,
  } = input;

  const scenarios: FailureScenario[] = [];

  for (const failed of baselineChain) {
    // 剩余字体：新求解空间下标 i ↔ 原始下标 remaining[i]
    const remaining: number[] = [];
    for (let i = 0; i < validFonts.length; i++) {
      if (i !== failed) remaining.push(i);
    }
    const remainingFonts = remaining.map((i) => validFonts[i]);

    // 入链约束映射到剩余字体空间（失效字体自身除外）
    const toRemaining = (indices: number[] | undefined) =>
      (indices ?? [])
        .filter((f) => f !== failed)
        .map((f) => remaining.indexOf(f))
        .filter((i) => i >= 0);

    // 覆盖模式与求解偏好均与基线一致（effectiveRanges 已随声明/实测开关确定）
    const analysis = analyzeGroupedCoverage(groups, remainingFonts, ignoreFormat);
    const solution = solveFallbackChain({
      fontCount: remainingFonts.length,
      preference: remaining.map((i) => preference[i]),
      patterns: analysis.patterns,
      lengthPriority,
      locked: toRemaining(locked),
      excluded: toRemaining(excluded),
    });

    // 求解结果映射回原始下标空间
    const chain = solution.selected.map((i) => remaining[i]);
    const assignedCount = new Map<number, number>();

    const newMissing: NewMissingCluster[] = [];
    const reassigned: ReassignedCluster[] = [];
    let stillMissing = 0;

    analysis.clusters.forEach((c, ci) => {
      const base = baselineClusters[ci];
      if (c.free) return; // 仅含格式字符，无需字体承接，不参与对比

      const hit = solution.selected.find((f) => c.candidates.includes(f));
      const assigned = hit === undefined ? null : remaining[hit];
      if (assigned !== null) {
        assignedCount.set(assigned, (assignedCount.get(assigned) ?? 0) + 1);
      }

      const scenarioTag = c.scenarioId
        ? { scenarioId: c.scenarioId, localIndex: c.localIndex }
        : {};

      if (base.status === 'missing') {
        // 字体只会变少，原本缺失的簇仍然缺失
        stillMissing++;
        return;
      }
      if (assigned === null) {
        newMissing.push({
          index: c.index,
          text: c.text,
          codepoints: c.codepoints,
          missingCodepoints: findMissingCodepoints(c.required, remainingFonts),
          ...scenarioTag,
        });
      } else if (assigned !== base.assigned) {
        reassigned.push({
          index: c.index,
          text: c.text,
          codepoints: c.codepoints,
          fromFont: base.assigned!,
          toFont: assigned,
          ...scenarioTag,
        });
      }
    });

    scenarios.push({
      fontIndex: failed,
      preference: preference[failed],
      assignedBefore: baselineClusters.filter(
        (c) => c.status !== 'free' && c.assigned === failed,
      ).length,
      feasible: solution.feasible,
      exact: solution.exact,
      chain,
      chainAssigned: chain.map((i) => assignedCount.get(i) ?? 0),
      chainLengthDelta: chain.length - baselineChain.length,
      newMissing,
      reassigned,
      stillMissing,
    });
  }

  // 风险卡片排序：新增缺失数降序 → 改接簇数降序 → 偏好位次升序
  scenarios.sort(
    (a, b) =>
      b.newMissing.length - a.newMissing.length ||
      b.reassigned.length - a.reassigned.length ||
      a.preference - b.preference,
  );
  return scenarios;
}
