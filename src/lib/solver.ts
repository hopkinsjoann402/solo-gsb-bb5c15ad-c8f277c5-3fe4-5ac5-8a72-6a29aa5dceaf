/**
 * 回退链求解器。
 *
 * 模型：每个“需求模式”（一组字素簇共享的可覆盖字体集合）要求链中至少
 * 包含其中一种字体 —— 即 hitting set / set cover 对偶问题。
 *
 * 目标：在“链长度最短”与“保持用户字体顺序偏好”之间按权重折中：
 *   cost(f) = λ·(1/N) + (1-λ)·(pref(f)+1)/maxPref + ε·对偶项
 *   λ = lengthPriority（1 = 完全链长优先，0 = 完全顺序优先）
 * 总成本为所选字体成本之和，越小越好。
 *
 * 算法：
 *   0. 应用入链约束：被排除（禁止入链）的字体从所有需求模式中剔除，
 *      候选被剔空的模式记为「约束导致不可满足」；锁定（必须入链）的字体
 *      无条件入选，即使它不覆盖任何模式；
 *   1. 无可覆盖字体的模式直接记为不可满足（自然缺失）；
 *   2. 唯一候选字体强制入选；
 *   3. 支配约简（覆盖集真超集且成本不更高的字体淘汰被支配者）；
 *   4. 贪心 + 删除/交换局部搜索得到优质 incumbent；
 *   5. 分支定界求精确最优（节点预算内）；超预算或规模过大时退回启发式结果。
 */

export interface SolveInput {
  /** 有效字体数量 */
  fontCount: number;
  /** 每种字体的偏好位次（0 = 最优先），通常即用户录入顺序 */
  preference: number[];
  /** 需求模式：每个模式是可覆盖它的字体下标列表 */
  patterns: number[][];
  /** 0 = 顺序优先，1 = 链长优先 */
  lengthPriority: number;
  /** 分支定界节点预算 */
  nodeBudget?: number;
  /** 必须入链（锁定）的字体下标；与 excluded 冲突时以排除为准 */
  locked?: number[];
  /** 禁止入链（排除）的字体下标，求解前从全部候选中剔除 */
  excluded?: number[];
}

export interface SolveOutput {
  /** 入选字体下标，按偏好顺序排列 */
  selected: number[];
  /** 是否所有模式均可满足（含约束导致不可满足时为 false） */
  feasible: boolean;
  /** 无任何字体可覆盖的模式下标（自然缺失） */
  unsatisfiable: number[];
  /** 原本有候选、但候选全部被排除约束剔除的模式下标（约束导致缺失） */
  constraintUnsatisfiable: number[];
  /** 是否精确最优（false 表示预算内未完成证明，返回启发式结果） */
  exact: boolean;
  objective: number;
  nodesExplored: number;
  /** 被唯一候选强制的字体 */
  forced: number[];
  /** 实际入链的锁定字体（已剔除越界与和排除冲突者），按偏好顺序 */
  locked: number[];
}

const EPS = 1e-9;
const EXACT_FONT_LIMIT = 40;

function popcount(x: bigint): number {
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}

export function solveFallbackChain(input: SolveInput): SolveOutput {
  const { fontCount, preference, patterns } = input;
  const nodeBudget = input.nodeBudget ?? 120_000;
  const lp = Math.min(1, Math.max(0, input.lengthPriority));

  const maxCount = Math.max(1, fontCount);
  const maxPref = Math.max(1, (fontCount * (fontCount + 1)) / 2);
  const cost: number[] = [];
  for (let f = 0; f < fontCount; f++) {
    const primary = lp / maxCount + (1 - lp) * ((preference[f] + 1) / maxPref);
    const tieBreak = (1 - lp) / maxCount + (lp * (preference[f] + 1)) / maxPref;
    cost.push(primary + tieBreak * 1e-6);
  }

  // ---- 入链约束：先剔除禁用候选，再把锁定字体纳入目标链 ----
  const excludedSet = new Set(
    (input.excluded ?? []).filter((f) => f >= 0 && f < fontCount),
  );
  const lockedSet = new Set(
    (input.locked ?? []).filter((f) => f >= 0 && f < fontCount && !excludedSet.has(f)),
  );
  // 各需求模式剔除被排除字体后的候选列表（无排除时复用原数组，只读）
  const allowed = patterns.map((fonts) =>
    excludedSet.size === 0 ? fonts : fonts.filter((f) => !excludedSet.has(f)),
  );

  const unsatisfiable: number[] = [];
  const constraintUnsatisfiable: number[] = [];
  const workable: number[] = [];
  patterns.forEach((fonts, p) => {
    if (fonts.length === 0) unsatisfiable.push(p);
    else if (allowed[p].length === 0) constraintUnsatisfiable.push(p);
    else workable.push(p);
  });

  // 字体 -> 可覆盖的模式
  const fontPatterns: number[][] = Array.from({ length: fontCount }, () => []);
  for (const p of workable) {
    for (const f of allowed[p]) fontPatterns[f].push(p);
  }

  // 锁定字体强制入选（即使不覆盖任何模式）
  const covered = new Set<number>();
  for (const f of lockedSet) {
    for (const q of fontPatterns[f]) covered.add(q);
  }

  // 唯一候选强制入选
  const forcedSet = new Set<number>();
  for (const p of workable) {
    if (allowed[p].length === 1) {
      const f = allowed[p][0];
      if (!lockedSet.has(f) && !forcedSet.has(f)) {
        forcedSet.add(f);
        for (const q of fontPatterns[f]) covered.add(q);
      }
    }
  }

  const remaining = workable.filter((p) => !covered.has(p));
  const localIndex = new Map<number, number>();
  remaining.forEach((p, i) => localIndex.set(p, i));
  const P = remaining.length;

  // 已预选（锁定/唯一候选强制）的字体不再参与优化
  const preselected = (f: number) => lockedSet.has(f) || forcedSet.has(f);
  const candidateSet = new Set<number>();
  for (const p of remaining) {
    for (const f of allowed[p]) {
      if (!preselected(f)) candidateSet.add(f);
    }
  }
  let candidates = [...candidateSet];

  const fullMask = P === 0 ? 0n : (1n << BigInt(P)) - 1n;
  const mask = new Map<number, bigint>();
  for (const f of candidates) {
    let m = 0n;
    for (const p of fontPatterns[f]) {
      const li = localIndex.get(p);
      if (li !== undefined) m |= 1n << BigInt(li);
    }
    mask.set(f, m);
  }

  // 支配约简：A 覆盖 ⊇ B 且成本 ≤ B，则 B 永不需要
  const dominated = new Set<number>();
  for (const a of candidates) {
    if (dominated.has(a)) continue;
    const ma = mask.get(a)!;
    for (const b of candidates) {
      if (a === b || dominated.has(b)) continue;
      const mb = mask.get(b)!;
      const coversAll = (mb & ~ma) === 0n;
      const strictlyBetter = cost[a] < cost[b] - EPS || (ma & ~mb) !== 0n || a < b;
      if (coversAll && cost[a] <= cost[b] + EPS && strictlyBetter) {
        dominated.add(b);
      }
    }
  }
  candidates = candidates.filter((f) => !dominated.has(f));

  const finish = (sel: number[], exact: boolean, nodes: number): SolveOutput => {
    const selected = [...lockedSet, ...forcedSet, ...sel].sort(
      (a, b) => preference[a] - preference[b],
    );
    const objective = selected.reduce((s, f) => s + cost[f], 0);
    return {
      selected,
      feasible: unsatisfiable.length === 0 && constraintUnsatisfiable.length === 0,
      unsatisfiable,
      constraintUnsatisfiable,
      exact,
      objective,
      nodesExplored: nodes,
      forced: [...forcedSet],
      locked: [...lockedSet].sort((a, b) => preference[a] - preference[b]),
    };
  };

  if (P === 0 || candidates.length === 0) {
    return finish([], true, 0);
  }

  // ---- 启发式 incumbent：贪心 + 局部搜索 ----
  const greedy = (): number[] => {
    let uncovered = fullMask;
    const sol: number[] = [];
    const inSol = new Set<number>();
    while (uncovered !== 0n) {
      let best = -1;
      let bestScore = Infinity;
      for (const f of candidates) {
        if (inSol.has(f)) continue;
        const gain = popcount(mask.get(f)! & uncovered);
        if (gain === 0) continue;
        const score = cost[f] / gain;
        if (score < bestScore - EPS) {
          bestScore = score;
          best = f;
        }
      }
      if (best < 0) break;
      sol.push(best);
      inSol.add(best);
      uncovered &= ~mask.get(best)!;
    }
    return sol;
  };

  const coversAll = (sol: number[]): boolean => {
    let m = 0n;
    for (const f of sol) m |= mask.get(f)!;
    return m === fullMask;
  };

  const totalCost = (sol: number[]): number => sol.reduce((s, f) => s + cost[f], 0);

  const improve = (sol: number[]): number[] => {
    let cur = [...sol];
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 50) {
      changed = false;
      // 删除冗余
      for (const f of [...cur].sort((a, b) => cost[b] - cost[a])) {
        const trial = cur.filter((x) => x !== f);
        if (trial.length < cur.length && coversAll(trial)) {
          cur = trial;
          changed = true;
          break;
        }
      }
      if (changed) continue;
      // 单点交换
      let swapped = false;
      for (const f of cur) {
        for (const g of candidates) {
          if (cur.includes(g) || cost[g] >= cost[f] - EPS) continue;
          const trial = cur.map((x) => (x === f ? g : x));
          if (totalCost(trial) < totalCost(cur) - EPS && coversAll(trial)) {
            cur = trial;
            changed = true;
            swapped = true;
            break;
          }
        }
        if (swapped) break;
      }
    }
    return cur;
  };

  let best = improve(greedy());
  let bestCost = totalCost(best);

  // ---- 精确分支定界 ----
  let nodes = 0;
  let exact = candidates.length <= EXACT_FONT_LIMIT;
  if (exact) {
    const bits: bigint[] = [];
    for (let i = 0; i < P; i++) bits.push(1n << BigInt(i));
    const patFonts: number[][] = remaining.map((p) =>
      allowed[p].filter((f) => mask.has(f) && !dominated.has(f)),
    );
    const minPatCost = patFonts.map((fs) =>
      fs.length ? Math.min(...fs.map((f) => cost[f])) : Infinity,
    );
    const maxGain = Math.max(...candidates.map((f) => popcount(mask.get(f)!)));
    const minFontCost = Math.min(...candidates.map((f) => cost[f]));

    class BudgetExceeded extends Error {}

    const recurse = (uncovered: bigint, chosen: number[], costSoFar: number): void => {
      if (++nodes > nodeBudget) throw new BudgetExceeded();
      if (uncovered === 0n) {
        if (costSoFar < bestCost - EPS) {
          best = chosen;
          bestCost = costSoFar;
        }
        return;
      }
      // 下界：max(各未覆盖模式的最便宜字体, 数量下界×最便宜字体)
      let maxMin = 0;
      let branchPat = -1;
      let branchCount = Infinity;
      let pc = 0;
      for (let i = 0; i < P; i++) {
        if ((uncovered & bits[i]) !== 0n) {
          pc++;
          if (minPatCost[i] > maxMin) maxMin = minPatCost[i];
          if (patFonts[i].length < branchCount) {
            branchCount = patFonts[i].length;
            branchPat = i;
          }
        }
      }
      const countBound = Math.ceil(pc / maxGain) * minFontCost;
      if (costSoFar + Math.max(maxMin, countBound) >= bestCost - EPS) return;

      const order = [...patFonts[branchPat]].sort((a, b) => cost[a] - cost[b]);
      for (const f of order) {
        recurse(uncovered & ~mask.get(f)!, [...chosen, f], costSoFar + cost[f]);
      }
    };

    try {
      recurse(fullMask, [], 0);
    } catch (e) {
      if (!(e instanceof BudgetExceeded)) throw e;
      exact = false;
    }
  }

  return finish(best, exact, nodes);
}
