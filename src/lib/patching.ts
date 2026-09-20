/**
 * 补字预算规划。
 *
 * 仅针对当前**缺失（非自由）**字素簇，规划向现有有效字体补加（字体, 码位）对：
 *   - 簇内全部「需覆盖码位」都由**同一**有效字体的已有覆盖或新增补丁覆盖，
 *     该簇才算恢复（与覆盖分析一致，不允许一个簇拆给多个字体）；
 *   - 被「禁止入链」排除的字体由调用方剔除，不作为补丁承接对象
 *     （补了也不会进入回退链）；
 *   - 同一（字体, 码位）对跨簇复用只计一次费用，不同字体分别计费；
 *   - 每轮枚举「缺失簇 × 有效字体」的最小补丁（缺哪些码位就补哪些），
 *     按「新增恢复簇数 / 新增对数」之比贪心选择；平局依次选：
 *     新增对数较少 → 字体较前（偏好位次）→ 场景较前 → 簇较前；
 *   - 只选择剩余预算内的方案，每轮应用补丁后重新计算各方案的恢复数
 *     （补丁复用会使后续轮次代价下降、恢复数上升）。
 *
 * 规划完全基于当前参与求解的场景与生效的声明/实测覆盖，结果为**预演**：
 * 不修改原求解结果、字体范围与字体文件。
 */

import type { ParsedFont, ScenarioClusterAudit } from '../types';
import { coversCodepoint } from './coverage';
import { formatCodepoint } from './grapheme';

/** 参与规划的场景（按清单顺序） */
export interface PatchScenarioInfo {
  id: string;
  name: string;
}

export interface BudgetPlanInput {
  /** 当前参与求解的全部簇（单场景模式仅活动场景） */
  clusters: ScenarioClusterAudit[];
  /** 可承接补丁的字体（调用方已剔除被「禁止入链」排除的字体） */
  fonts: ParsedFont[];
  /** 每种字体的原始偏好位次（与 fonts 对齐，越靠前越优先） */
  preference: number[];
  scenarios: PatchScenarioInfo[];
  /** 最多可新增的不同（字体, 码位）对数 */
  budget: number;
}

/** 单轮贪心选择的补丁方案 */
export interface PatchPlanStep {
  /** 轮次序号（从 1 开始） */
  round: number;
  /** 承接字体（有效字体下标） */
  fontIndex: number;
  /** 字体名（冗余存储，便于导出） */
  fontName: string;
  /** 本轮向该字体新增的码位（去重升序，均不与已加补丁/已有覆盖重复） */
  addedCodepoints: number[];
  /** 本轮新增的（字体, 码位）对数 */
  addedPairs: number;
  /** 应用本轮补丁后**新**恢复的簇数（跨场景合计，重复出现分别计数） */
  recoveredClusters: number;
  /** 选择时的恢复/代价比（= recoveredClusters / addedPairs） */
  ratio: number;
  /** 本轮后累计已用预算 */
  pairsUsed: number;
  /** 本轮后累计恢复簇数 */
  totalRecovered: number;
}

/** 单簇恢复归属信息 */
export interface PlannedRecoveredCluster {
  /** 簇全局展平下标 */
  index: number;
  text: string;
  codepoints: number[];
  scenarioId: string;
  scenarioName: string;
  localIndex: number;
  /** 恢复它的字体（有效字体下标） */
  fontIndex: number;
  fontName: string;
  /** 恢复它的轮次 */
  round: number;
}

/** 规划后仍缺失的簇 */
export interface PlannedStillMissingCluster {
  index: number;
  text: string;
  codepoints: number[];
  scenarioId: string;
  scenarioName: string;
  localIndex: number;
  /** 规划结束后仍无任何字体（含补丁）可覆盖的码位 */
  uncoveredCodepoints: number[];
}

/** 按字体归组的补码清单 */
export interface FontPatchGroup {
  fontIndex: number;
  fontName: string;
  preference: number;
  /** 向该字体新增的全部码位（去重升序） */
  codepoints: number[];
  /** 新增（字体, 码位）对数 */
  pairCount: number;
  /** 由该字体（含补丁）恢复的簇数 */
  recoveredClusters: number;
  /** 选择该字体的首末轮次 */
  firstRound: number;
  lastRound: number;
}

/** 逐场景规划统计 */
export interface ScenarioPatchStat {
  scenarioId: string;
  scenarioName: string;
  /** 簇总数 */
  totalClusters: number;
  /** 规划前已覆盖（含自由簇） */
  alreadyCovered: number;
  /** 规划前缺失（非自由） */
  initiallyMissing: number;
  /** 本次规划预计恢复 */
  recovered: number;
  /** 规划后仍缺失 */
  stillMissing: number;
}

export interface BudgetPlan {
  /** 预算（对数上限） */
  budget: number;
  /** 规划前缺失簇数（非自由） */
  initiallyMissing: number;
  /** 预计恢复簇数（跨场景合计，重复出现分别计数） */
  recoveredCount: number;
  /** 规划后仍缺失簇数 */
  stillMissingCount: number;
  /** 实际新增的（字体, 码位）对数 */
  pairsUsed: number;
  /** 恢复全部缺失簇所需的最小对数（不受预算限制） */
  minPairsToCoverAll: number | null;
  /** 逐轮方案 */
  steps: PatchPlanStep[];
  /** 按字体归组的补码清单（按偏好位次升序） */
  fontPatches: FontPatchGroup[];
  /** 逐场景统计（按场景清单顺序） */
  scenarioStats: ScenarioPatchStat[];
  recoveredClusters: PlannedRecoveredCluster[];
  stillMissingClusters: PlannedStillMissingCluster[];
  /** 停止原因：预算耗尽 / 全部恢复 / 剩余预算不足以补任何一簇 */
  stopReason: 'all-recovered' | 'budget-exhausted' | 'unaffordable';
}

interface MissingGroup {
  /** 归一化需求码位（去重升序）—— 同组候选方案完全一致 */
  requiredKey: number[];
  /** 该需求模式的全部缺失簇出现（跨场景分别计数，不合并） */
  occurrences: ScenarioClusterAudit[];
  /** 平局代表：场景序、簇序均最靠前的出现 */
  representative: ScenarioClusterAudit;
  /** 每个字体恢复该组所需的最小补丁码位（懒计算缓存；缺失簇必然非空） */
  deficits: (number[] | null)[];
}

function sortedUnique(cps: number[]): number[] {
  return [...new Set(cps)].sort((a, b) => a - b);
}

/** 字体恢复某需求集合尚缺的码位（最小补丁） */
function deficitFor(required: number[], font: ParsedFont): number[] {
  return required.filter((cp) => !coversCodepoint(font.effectiveRanges, cp));
}

interface RawRecovered {
  index: number;
  text: string;
  codepoints: number[];
  scenarioId: string;
  localIndex: number;
  fontIndex: number;
  round: number;
}

interface GreedyResult {
  steps: PatchPlanStep[];
  patches: Set<number>[];
  pairsUsed: number;
  recovered: RawRecovered[];
  /** 停止时是否存在「预算内无法承担」的情况（而非恰好花完预算） */
  noAffordable: boolean;
}

/**
 * 贪心主循环。
 * 每轮对每个仍缺失的需求组 × 每个有效字体计算最小补丁代价
 * （新增码位 = 该组需求中既无字体已有覆盖、也无历史补丁的码位），
 * 与应用后新增恢复簇数（凡在该字体上被补满的待处理组都恢复），
 * 按 恢复数/代价 之比选优并应用，直到全部恢复或无预算内方案。
 */
function runGreedy(
  groups: MissingGroup[],
  fonts: ParsedFont[],
  preference: number[],
  scenarioOrder: Map<string, number>,
  budget: number,
): GreedyResult {
  // 注意：deficits 缓存会在求解中懒填充，调用方若需两次求解必须传入全新分组
  const patches: Set<number>[] = fonts.map(() => new Set<number>());
  let pending = groups;
  const steps: PatchPlanStep[] = [];
  const recovered: RawRecovered[] = [];
  let pairsUsed = 0;
  let round = 0;
  let noAffordable = false;

  while (pending.length > 0) {
    interface Cand {
      group: MissingGroup;
      fontIndex: number;
      add: number[];
      cost: number;
      gain: number;
    }
    let best: Cand | null = null;

    // 比较 a/b：比降序 → 代价升序 → 偏好位次升序 → 场景序 → 簇序 → 字体序
    const better = (a: Cand, b: Cand): boolean => {
      const lhs = a.gain * b.cost;
      const rhs = b.gain * a.cost;
      if (lhs !== rhs) return lhs > rhs;
      if (a.cost !== b.cost) return a.cost < b.cost;
      const pa = preference[a.fontIndex] ?? a.fontIndex;
      const pb = preference[b.fontIndex] ?? b.fontIndex;
      if (pa !== pb) return pa < pb;
      const ra = a.group.representative;
      const rb = b.group.representative;
      const sa = scenarioOrder.get(ra.scenarioId) ?? Number.MAX_SAFE_INTEGER;
      const sb = scenarioOrder.get(rb.scenarioId) ?? Number.MAX_SAFE_INTEGER;
      if (sa !== sb) return sa < sb;
      if (ra.localIndex !== rb.localIndex) return ra.localIndex < rb.localIndex;
      return a.fontIndex < b.fontIndex;
    };

    for (const g of pending) {
      for (let fi = 0; fi < fonts.length; fi++) {
        let deficit = g.deficits[fi];
        if (deficit === null) {
          deficit = deficitFor(g.requiredKey, fonts[fi]);
          g.deficits[fi] = deficit;
        }
        const patched = patches[fi];
        const add = deficit.filter((cp) => !patched.has(cp));
        const cost = add.length;
        // cost === 0 只会出现在已恢复组上，pending 中不可能
        if (cost === 0) continue;
        if (pairsUsed + cost > budget) continue;
        // 应用该候选后，所有「补完这些码位即恢复」的待处理组都会恢复
        let gain = 0;
        for (const og of pending) {
          let od = og.deficits[fi];
          if (od === null) {
            od = deficitFor(og.requiredKey, fonts[fi]);
            og.deficits[fi] = od;
          }
          if (od.every((cp) => patched.has(cp) || add.includes(cp))) {
            gain += og.occurrences.length;
          }
        }
        const cand: Cand = { group: g, fontIndex: fi, add, cost, gain };
        if (!best || better(cand, best)) best = cand;
      }
    }

    if (!best) {
      noAffordable = true;
      break;
    }

    round += 1;
    const { fontIndex, add, cost, gain } = best;
    for (const cp of add) patches[fontIndex].add(cp);
    pairsUsed += cost;

    // 应用后重新计算恢复集合：该字体上凡需求已全部满足的待处理组均恢复
    const stillPending: MissingGroup[] = [];
    for (const g of pending) {
      const deficit = g.deficits[fontIndex]!;
      if (deficit.every((cp) => patches[fontIndex].has(cp))) {
        for (const occ of g.occurrences) {
          recovered.push({
            index: occ.index,
            text: occ.text,
            codepoints: occ.codepoints,
            scenarioId: occ.scenarioId,
            localIndex: occ.localIndex,
            fontIndex,
            round,
          });
        }
      } else {
        stillPending.push(g);
      }
    }
    pending = stillPending;

    steps.push({
      round,
      fontIndex,
      fontName: fonts[fontIndex]?.name ?? '(未命名)',
      addedCodepoints: [...add].sort((a, b) => a - b),
      addedPairs: cost,
      recoveredClusters: gain,
      ratio: gain / cost,
      pairsUsed,
      totalRecovered: recovered.length,
    });
  }

  return { steps, patches, pairsUsed, recovered, noAffordable };
}

/**
 * 执行补字预算规划。无缺失簇或预算为 0 时返回空方案（仍给出逐场景统计）。
 */
export function planGlyphBudget(input: BudgetPlanInput): BudgetPlan {
  const { clusters, fonts, preference, scenarios, budget } = input;
  const safeBudget = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0;

  const scenarioOrder = new Map<string, number>();
  scenarios.forEach((s, i) => scenarioOrder.set(s.id, i));
  const scenarioName = (id: string) => scenarios.find((s) => s.id === id)?.name ?? '';

  // ---- 按「归一化需求码位集合」聚合当前缺失的非自由簇 ----
  // 注意：分组对象带懒填充缓存，两次求解必须使用全新分组
  const buildGroups = (): MissingGroup[] => {
    const map = new Map<string, MissingGroup>();
    const out: MissingGroup[] = [];
    for (const c of clusters) {
      if (c.free || c.status !== 'missing') continue;
      const key = sortedUnique(c.required);
      const mapKey = key.join(',');
      let g = map.get(mapKey);
      if (!g) {
        g = {
          requiredKey: key,
          occurrences: [],
          representative: c,
          deficits: fonts.map(() => null),
        };
        map.set(mapKey, g);
        out.push(g);
      }
      g.occurrences.push(c);
      // 平局代表：场景较前 → 场景内簇较前
      const rep = g.representative;
      if (
        (scenarioOrder.get(c.scenarioId) ?? Number.MAX_SAFE_INTEGER) <
          (scenarioOrder.get(rep.scenarioId) ?? Number.MAX_SAFE_INTEGER) ||
        (c.scenarioId === rep.scenarioId && c.localIndex < rep.localIndex)
      ) {
        g.representative = c;
      }
    }
    return out;
  };

  const initiallyMissing = clusters.filter(
    (c) => !c.free && c.status === 'missing',
  ).length;

  // 先按预算求解：预算足够时这一次即可同时给出方案与「恢复全部」最小对数；
  // 未全部恢复时再跑一次无预算上限求解，仅用于得到 minPairsToCoverAll。
  // 补丁可为任意字体补任意码位，故只要存在有效字体，全部缺失理论上都可恢复。
  const budgeted = runGreedy(buildGroups(), fonts, preference, scenarioOrder, safeBudget);
  const coveredAll = budgeted.recovered.length === initiallyMissing;
  const result = budgeted;
  let minPairsToCoverAll: number | null;
  if (initiallyMissing === 0) {
    minPairsToCoverAll = 0;
  } else if (fonts.length === 0) {
    minPairsToCoverAll = null;
  } else if (coveredAll) {
    minPairsToCoverAll = budgeted.pairsUsed;
  } else {
    const full = runGreedy(
      buildGroups(),
      fonts,
      preference,
      scenarioOrder,
      Number.MAX_SAFE_INTEGER,
    );
    minPairsToCoverAll =
      full.recovered.length === initiallyMissing ? full.pairsUsed : null;
  }

  // ---- 逐簇恢复/仍缺失归属 ----
  const recoveryOf = new Map<number, { fontIndex: number; round: number }>();
  const recoveredClusters: PlannedRecoveredCluster[] = [];
  for (const rec of result.recovered) {
    recoveryOf.set(rec.index, { fontIndex: rec.fontIndex, round: rec.round });
    recoveredClusters.push({
      index: rec.index,
      text: rec.text,
      codepoints: rec.codepoints,
      scenarioId: rec.scenarioId,
      scenarioName: scenarioName(rec.scenarioId),
      localIndex: rec.localIndex,
      fontIndex: rec.fontIndex,
      fontName: fonts[rec.fontIndex]?.name ?? '(未命名)',
      round: rec.round,
    });
  }
  recoveredClusters.sort(
    (a, b) =>
      (scenarioOrder.get(a.scenarioId) ?? 0) - (scenarioOrder.get(b.scenarioId) ?? 0) ||
      a.localIndex - b.localIndex,
  );

  const stillMissingClusters: PlannedStillMissingCluster[] = [];
  for (const c of clusters) {
    if (c.free || c.status !== 'missing' || recoveryOf.has(c.index)) continue;
    const uncovered = c.required.filter(
      (cp) =>
        !fonts.some(
          (f, fi) =>
            coversCodepoint(f.effectiveRanges, cp) || result.patches[fi]?.has(cp),
        ),
    );
    stillMissingClusters.push({
      index: c.index,
      text: c.text,
      codepoints: c.codepoints,
      scenarioId: c.scenarioId,
      scenarioName: scenarioName(c.scenarioId),
      localIndex: c.localIndex,
      uncoveredCodepoints: uncovered,
    });
  }
  stillMissingClusters.sort(
    (a, b) =>
      (scenarioOrder.get(a.scenarioId) ?? 0) - (scenarioOrder.get(b.scenarioId) ?? 0) ||
      a.localIndex - b.localIndex,
  );

  // ---- 按字体归组（按偏好位次升序） ----
  const recoveredByFont = new Map<number, number>();
  for (const r of recoveredClusters) {
    recoveredByFont.set(r.fontIndex, (recoveredByFont.get(r.fontIndex) ?? 0) + 1);
  }
  const fontPatches: FontPatchGroup[] = [];
  for (let fi = 0; fi < fonts.length; fi++) {
    const set = result.patches[fi];
    if (!set || set.size === 0) continue;
    const rounds = result.steps.filter((s) => s.fontIndex === fi).map((s) => s.round);
    fontPatches.push({
      fontIndex: fi,
      fontName: fonts[fi].name || '(未命名)',
      preference: preference[fi] ?? fi,
      codepoints: [...set].sort((a, b) => a - b),
      pairCount: set.size,
      recoveredClusters: recoveredByFont.get(fi) ?? 0,
      firstRound: Math.min(...rounds),
      lastRound: Math.max(...rounds),
    });
  }
  fontPatches.sort((a, b) => a.preference - b.preference);

  // ---- 逐场景统计（按场景清单顺序） ----
  const scenarioStats: ScenarioPatchStat[] = scenarios.map((s) => {
    const sc = clusters.filter((c) => c.scenarioId === s.id);
    const missing = sc.filter((c) => !c.free && c.status === 'missing');
    const recovered = missing.filter((c) => recoveryOf.has(c.index)).length;
    return {
      scenarioId: s.id,
      scenarioName: s.name,
      totalClusters: sc.length,
      alreadyCovered: sc.length - missing.length,
      initiallyMissing: missing.length,
      recovered,
      stillMissing: missing.length - recovered,
    };
  });

  const recoveredCount = recoveredClusters.length;
  let stopReason: BudgetPlan['stopReason'];
  if (initiallyMissing === 0 || recoveredCount === initiallyMissing) {
    stopReason = 'all-recovered';
  } else if (result.noAffordable && result.pairsUsed < safeBudget) {
    stopReason = 'unaffordable';
  } else {
    stopReason = 'budget-exhausted';
  }

  return {
    budget: safeBudget,
    initiallyMissing,
    recoveredCount,
    stillMissingCount: initiallyMissing - recoveredCount,
    pairsUsed: result.pairsUsed,
    minPairsToCoverAll,
    steps: result.steps,
    fontPatches,
    scenarioStats,
    recoveredClusters,
    stillMissingClusters,
    stopReason,
  };
}

/** 补字规划 JSON 报告（供面板下载） */
export interface BudgetPlanReport {
  tool: string;
  analysis: 'glyph-budget-plan';
  version: number;
  generatedAt: string;
  mode: 'single' | 'set';
  options: {
    budgetPairs: number;
    ignoreFormatCodepoints: boolean;
    useMeasuredCoverage: boolean;
  };
  summary: {
    initiallyMissingClusters: number;
    plannedRecoveredClusters: number;
    stillMissingClusters: number;
    pairsUsed: number;
    pairsRemaining: number;
    /** 恢复全部缺失所需的最小对数；存在任何字体都无法补齐的码位时为 null */
    minPairsToCoverAll: number | null;
    stopReason: BudgetPlan['stopReason'];
  };
  scenarioStats: {
    scenario: string;
    totalClusters: number;
    alreadyCovered: number;
    initiallyMissing: number;
    plannedRecovered: number;
    stillMissing: number;
  }[];
  rounds: {
    round: number;
    font: string;
    preference: number;
    addedCodepoints: string[];
    addedPairs: number;
    recoveredClusters: number;
    recoveredPerAddedPair: number;
    pairsUsedAfter: number;
  }[];
  fontPatches: {
    font: string;
    preference: number;
    addedPairs: number;
    addedCodepoints: string[];
    recoveredClusters: number;
  }[];
  recoveredClusters: {
    scenario: string;
    scenarioLocalIndex: number;
    globalIndex: number;
    text: string;
    codepoints: string[];
    recoveredByFont: string;
    round: number;
  }[];
  stillMissing: {
    scenario: string;
    scenarioLocalIndex: number;
    globalIndex: number;
    text: string;
    codepoints: string[];
    uncoveredCodepoints: string[];
  }[];
}

export function buildBudgetPlanReport(
  plan: BudgetPlan,
  opts: {
    generatedAt: string;
    mode: 'single' | 'set';
    ignoreFormatCodepoints: boolean;
    useMeasuredCoverage: boolean;
  },
): BudgetPlanReport {
  const prefOf = (fi: number) =>
    plan.fontPatches.find((g) => g.fontIndex === fi)?.preference ?? fi;
  return {
    tool: 'unicode-font-fallback-audit',
    analysis: 'glyph-budget-plan',
    version: 1,
    generatedAt: opts.generatedAt,
    mode: opts.mode,
    options: {
      budgetPairs: plan.budget,
      ignoreFormatCodepoints: opts.ignoreFormatCodepoints,
      useMeasuredCoverage: opts.useMeasuredCoverage,
    },
    summary: {
      initiallyMissingClusters: plan.initiallyMissing,
      plannedRecoveredClusters: plan.recoveredCount,
      stillMissingClusters: plan.stillMissingCount,
      pairsUsed: plan.pairsUsed,
      pairsRemaining: plan.budget - plan.pairsUsed,
      minPairsToCoverAll: plan.minPairsToCoverAll,
      stopReason: plan.stopReason,
    },
    scenarioStats: plan.scenarioStats.map((s) => ({
      scenario: s.scenarioName,
      totalClusters: s.totalClusters,
      alreadyCovered: s.alreadyCovered,
      initiallyMissing: s.initiallyMissing,
      plannedRecovered: s.recovered,
      stillMissing: s.stillMissing,
    })),
    rounds: plan.steps.map((st) => ({
      round: st.round,
      font: st.fontName,
      preference: prefOf(st.fontIndex) + 1,
      addedCodepoints: st.addedCodepoints.map(formatCodepoint),
      addedPairs: st.addedPairs,
      recoveredClusters: st.recoveredClusters,
      recoveredPerAddedPair: Number(st.ratio.toFixed(4)),
      pairsUsedAfter: st.pairsUsed,
    })),
    fontPatches: plan.fontPatches.map((g) => ({
      font: g.fontName,
      preference: g.preference + 1,
      addedPairs: g.pairCount,
      addedCodepoints: g.codepoints.map(formatCodepoint),
      recoveredClusters: g.recoveredClusters,
    })),
    recoveredClusters: plan.recoveredClusters.map((c) => ({
      scenario: c.scenarioName,
      scenarioLocalIndex: c.localIndex,
      globalIndex: c.index,
      text: c.text,
      codepoints: c.codepoints.map(formatCodepoint),
      recoveredByFont: c.fontName,
      round: c.round,
    })),
    stillMissing: plan.stillMissingClusters.map((c) => ({
      scenario: c.scenarioName,
      globalIndex: c.index,
      scenarioLocalIndex: c.localIndex,
      text: c.text,
      codepoints: c.codepoints.map(formatCodepoint),
      uncoveredCodepoints: c.uncoveredCodepoints.map(formatCodepoint),
    })),
  };
}
