/**
 * 基线对比：导入本工具导出的审计 JSON，与当前实时结果按字素簇文本序列做保序对齐。
 *
 * 对齐模型（LCS，按簇文本相等匹配）：
 * - 重复簇按出现次序逐次匹配（相同序数优先），不会跨序错配；
 * - 插入/删除只标记自身所在行，后续簇以各自序列中的真实 index 呈现，不会整体错位；
 * - 已对齐（matched）簇再区分「覆盖状态变化」（新增缺失 / 已修复缺失 /
 *   自由簇状态变化）与「承接字体变化」（字体改接）。
 */

export const BASELINE_TOOL = 'unicode-font-fallback-audit';
export const BASELINE_VERSION = 1;

/** 审计 JSON 中单个字素簇的最小可用形态（只取对比需要的字段） */
export interface BaselineCluster {
  index: number;
  text: string;
  status: 'covered' | 'missing' | 'free';
  assignedFont: string | null;
  codepoints: string[];
  requiredCodepoints: string[];
  missingCodepoints: string[];
}

/** 解析并校验通过的基线 */
export interface ParsedBaseline {
  generatedAt: string | null;
  graphemeCount: number | null;
  coveredCount: number | null;
  missingCount: number | null;
  clusters: BaselineCluster[];
}

export class BaselineParseError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asClusterStatus(v: unknown): BaselineCluster['status'] | null {
  return v === 'covered' || v === 'missing' || v === 'free' ? v : null;
}

/**
 * 解析导入的审计 JSON。任何非法情形都抛出 BaselineParseError，
 * 由调用方在面板内展示并保留上一次有效基线（不覆盖已有基线状态）。
 */
export function parseBaselineJson(raw: string): ParsedBaseline {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new BaselineParseError(
      `非法 JSON：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!isRecord(data)) {
    throw new BaselineParseError('非法 JSON：顶层必须是对象');
  }
  if (data.tool !== BASELINE_TOOL) {
    throw new BaselineParseError(
      `工具不匹配：tool 应为 "${BASELINE_TOOL}"，实际为 ${JSON.stringify(data.tool ?? null)}`,
    );
  }
  if (data.version !== BASELINE_VERSION) {
    throw new BaselineParseError(
      `version 不匹配：仅支持 ${BASELINE_VERSION}，实际为 ${JSON.stringify(data.version ?? null)}`,
    );
  }
  const rawResult = data.result;
  if (!isRecord(rawResult)) {
    throw new BaselineParseError('缺少 result：不是有效的审计 JSON');
  }
  let clusterItems: unknown[];
  if (Array.isArray(rawResult.clusters)) {
    clusterItems = rawResult.clusters;
  } else if (
    // 场景集导出的簇在 result.scenarios[*].clusters，展平后与单文本形态同构
    Array.isArray(rawResult.scenarios) &&
    rawResult.scenarios.every((s) => isRecord(s) && Array.isArray(s.clusters))
  ) {
    clusterItems = (rawResult.scenarios as Record<string, unknown>[]).flatMap((s) =>
      (s.clusters as unknown[]).map((c) => c),
    );
  } else {
    throw new BaselineParseError('缺少 result.clusters：不是有效的审计 JSON');
  }
  const result: Record<string, unknown> = { ...rawResult, clusters: clusterItems };

  const clusters: BaselineCluster[] = [];
  clusterItems.forEach((item, i) => {
    if (!isRecord(item)) {
      throw new BaselineParseError(`clusters[${i}] 不是对象`);
    }
    if (typeof item.text !== 'string') {
      throw new BaselineParseError(`clusters[${i}] 缺少字符串字段 text`);
    }
    const status = asClusterStatus(item.status);
    if (!status) {
      throw new BaselineParseError(
        `clusters[${i}] 的 status 非法：${JSON.stringify(item.status ?? null)}`,
      );
    }
    const strArray = (key: string): string[] => {
      const v = item[key];
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        throw new BaselineParseError(`clusters[${i}].${key} 必须是字符串数组`);
      }
      return v as string[];
    };
    const assignedFont =
      item.assignedFont === null || item.assignedFont === undefined
        ? null
        : typeof item.assignedFont === 'string'
          ? item.assignedFont
          : (() => {
              throw new BaselineParseError(`clusters[${i}].assignedFont 必须是字符串或 null`);
            })();
    clusters.push({
      index: typeof item.index === 'number' ? item.index : i,
      text: item.text,
      status,
      assignedFont,
      codepoints: strArray('codepoints'),
      requiredCodepoints: Array.isArray(item.requiredCodepoints)
        ? strArray('requiredCodepoints')
        : [],
      missingCodepoints: Array.isArray(item.missingCodepoints)
        ? strArray('missingCodepoints')
        : [],
    });
  });

  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    generatedAt: typeof data.generatedAt === 'string' ? data.generatedAt : null,
    graphemeCount: num(result.graphemeCount),
    coveredCount: num(result.coveredCount),
    missingCount: num(result.missingCount),
    clusters,
  };
}

/** 参与对齐的实时簇最小形态 */
export interface LiveClusterLike {
  index: number;
  text: string;
  status: 'covered' | 'missing' | 'free';
  assignedFont: string | null;
  codepoints: string[];
  requiredCodepoints: string[];
  missingCodepoints: string[];
}

/** 已对齐簇的变化类别 */
export type PairChange =
  | 'unchanged'
  | 'new-missing' // 基线非缺失 → 实时缺失（退化）
  | 'fixed-missing' // 基线缺失 → 实时非缺失（修复）
  | 'font-changed' // 两侧均覆盖，承接字体不同
  | 'coverage-changed'; // 其余覆盖状态变化（如 free ↔ covered/missing）

/** 对齐行：基线/实时各占一侧，至多一侧为空（插入/删除） */
export interface AlignmentRow {
  kind: 'matched' | 'baseline-only' | 'live-only';
  /** 行在对齐序列中的位置（从 0 开始） */
  row: number;
  baseline: BaselineCluster | null;
  live: LiveClusterLike | null;
  /** 仅 matched 行有值 */
  change: PairChange | null;
  /** 该文本在各自序列中的出现序数（从 1 开始），用于核对重复簇逐次匹配 */
  occurrence: { baseline: number; live: number };
}

export interface ComparisonSummary {
  baselineCount: number;
  liveCount: number;
  matched: number;
  inserted: number;
  deleted: number;
  /** 已对齐簇中：基线非缺失、实时缺失 */
  newMissing: number;
  /** 已对齐簇中：基线缺失、实时非缺失 */
  fixedMissing: number;
  /** 已对齐簇中：两侧均覆盖且承接字体不同 */
  fontChanged: number;
  /** 实时侧缺失总数（对齐簇新增 + 插入缺失 + 实时仍缺失） */
  liveMissingTotal: number;
}

export interface Comparison {
  rows: AlignmentRow[];
  summary: ComparisonSummary;
}

/** DP 规模上限（行数 × 列数），防止异常长文本撑爆内存 */
const MAX_CELLS = 8_000_000;

const isMissing = (s: 'covered' | 'missing' | 'free') => s === 'missing';

/**
 * 按字素簇文本序列保序对齐。
 *
 * DP 单元分值 = 匹配数 × BONUS + 同序数奖励：
 * 先最大化匹配数（LCS 长度），匹配数相同时优先让「相同出现序数」的簇配对，
 * 从而保证重复簇逐次匹配（a 的第 k 次出现对 a 的第 k 次出现）。
 */
export function alignClusters(
  baseline: BaselineCluster[],
  live: LiveClusterLike[],
): Comparison {
  const m = baseline.length;
  const n = live.length;
  if (m * n > MAX_CELLS) {
    throw new BaselineParseError(
      `对比规模过大（${m} × ${n} 簇），超出对齐上限，请缩短文本后再试`,
    );
  }

  // 每个文本在各自序列中的出现序数
  const occurrences = (seq: { text: string }[]) => {
    const seen = new Map<string, number>();
    return seq.map((c) => {
      const k = (seen.get(c.text) ?? 0) + 1;
      seen.set(c.text, k);
      return k;
    });
  };
  const baseOcc = occurrences(baseline);
  const liveOcc = occurrences(live);

  const BONUS = 10000; // 远大于最大同序数奖励（≤ min(m,n)）
  const dp: Float64Array[] = Array.from({ length: m + 1 }, () => new Float64Array(n + 1));
  // 回溯方向：0 待定/边界，1 匹配，2 基线删除（上），3 实时插入（左）
  const dir: Uint8Array[] = Array.from({ length: m + 1 }, () => new Uint8Array(n + 1));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      let best = dp[i - 1][j];
      let d: number = 2;
      if (dp[i][j - 1] > best) {
        best = dp[i][j - 1];
        d = 3;
      }
      if (baseline[i - 1].text === live[j - 1].text) {
        const sameOccurrence = baseOcc[i - 1] === liveOcc[j - 1];
        const match =
          dp[i - 1][j - 1] + BONUS + (sameOccurrence ? 1 : 0);
        // 匹配与跳过等分时优先匹配（重复簇逐次配对，而非走插入+删除）
        if (match >= best) {
          best = match;
          d = 1;
        }
      }
      dp[i][j] = best;
      dir[i][j] = d;
    }
  }

  // 回溯：逆序产出后再翻转，保证行顺序与文本顺序一致
  const reversed: AlignmentRow[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    const d = i > 0 && j > 0 ? dir[i][j] : i > 0 ? 2 : 3;
    const rowPlaceholder = reversed.length;
    if (d === 1) {
      const b = baseline[i - 1];
      const l = live[j - 1];
      reversed.push({
        kind: 'matched',
        row: rowPlaceholder,
        baseline: b,
        live: l,
        change: classifyPair(b, l),
        occurrence: { baseline: baseOcc[i - 1], live: liveOcc[j - 1] },
      });
      i--;
      j--;
    } else if (d === 2) {
      reversed.push({
        kind: 'baseline-only',
        row: rowPlaceholder,
        baseline: baseline[i - 1],
        live: null,
        change: null,
        occurrence: { baseline: baseOcc[i - 1], live: 0 },
      });
      i--;
    } else {
      reversed.push({
        kind: 'live-only',
        row: rowPlaceholder,
        baseline: null,
        live: live[j - 1],
        change: null,
        occurrence: { baseline: 0, live: liveOcc[j - 1] },
      });
      j--;
    }
  }
  const rows = reversed.reverse().map((r, idx) => ({ ...r, row: idx }));

  const summary: ComparisonSummary = {
    baselineCount: m,
    liveCount: n,
    matched: rows.filter((r) => r.kind === 'matched').length,
    inserted: rows.filter((r) => r.kind === 'live-only').length,
    deleted: rows.filter((r) => r.kind === 'baseline-only').length,
    newMissing: rows.filter((r) => r.change === 'new-missing').length,
    fixedMissing: rows.filter((r) => r.change === 'fixed-missing').length,
    fontChanged: rows.filter((r) => r.change === 'font-changed').length,
    liveMissingTotal: live.filter((c) => c.status === 'missing').length,
  };
  return { rows, summary };
}

/** 已对齐簇：区分覆盖状态变化与承接字体变化 */
function classifyPair(b: BaselineCluster, l: LiveClusterLike): PairChange {
  const bMiss = isMissing(b.status);
  const lMiss = isMissing(l.status);
  if (!bMiss && lMiss) return 'new-missing';
  if (bMiss && !lMiss) return 'fixed-missing';
  if (!bMiss && !lMiss) {
    // 两侧均为 covered 才比较承接字体；free 簇无真实承接字体
    if (b.status === 'covered' && l.status === 'covered') {
      if (b.assignedFont !== l.assignedFont) return 'font-changed';
    }
    if (b.status !== l.status) return 'coverage-changed'; // free ↔ covered
  }
  // 两侧都缺失（仍缺失）或状态与字体均未变
  if (b.status !== l.status) return 'coverage-changed';
  return 'unchanged';
}

/** 是否属于退化项（筛选「仅看退化项」用）：新增缺失 + 实时侧新插入的缺失簇 */
export function isDegradationRow(r: AlignmentRow): boolean {
  if (r.change === 'new-missing') return true;
  if (r.kind === 'live-only' && r.live && r.live.status === 'missing') return true;
  return false;
}

export interface ComparisonReportOptions {
  baselineFileName: string | null;
  baseline: ParsedBaseline;
  comparison: Comparison;
  generatedAt: string;
}

/** 构建含对齐明细的对比 JSON */
export function buildComparisonReport(o: ComparisonReportOptions) {
  const { baseline, comparison } = o;
  return {
    tool: BASELINE_TOOL,
    analysis: 'baseline-comparison',
    version: BASELINE_VERSION,
    generatedAt: o.generatedAt,
    baseline: {
      fileName: o.baselineFileName,
      baselineGeneratedAt: baseline.generatedAt,
      declaredGraphemeCount: baseline.graphemeCount,
      declaredCoveredCount: baseline.coveredCount,
      declaredMissingCount: baseline.missingCount,
      clusterCount: baseline.clusters.length,
    },
    current: {
      graphemeCount: comparison.summary.liveCount,
      missingCount: comparison.summary.liveMissingTotal,
    },
    alignment: {
      method: 'order-preserving-lcs-by-cluster-text',
      notes:
        '重复字素簇按出现次序逐次匹配；inserted/deleted 仅标记自身，不改变两侧簇的原始 index',
      ...comparison.summary,
    },
    details: comparison.rows.map((r) => ({
      kind: r.kind,
      row: r.row,
      occurrence: r.occurrence,
      change: r.change,
      baseline: r.baseline
        ? {
            index: r.baseline.index,
            text: r.baseline.text,
            codepoints: r.baseline.codepoints,
            requiredCodepoints: r.baseline.requiredCodepoints,
            status: r.baseline.status,
            assignedFont: r.baseline.assignedFont,
            missingCodepoints: r.baseline.missingCodepoints,
          }
        : null,
      current: r.live
        ? {
            index: r.live.index,
            text: r.live.text,
            codepoints: r.live.codepoints,
            requiredCodepoints: r.live.requiredCodepoints,
            status: r.live.status,
            assignedFont: r.live.assignedFont,
            missingCodepoints: r.live.missingCodepoints,
          }
        : null,
    })),
  };
}
