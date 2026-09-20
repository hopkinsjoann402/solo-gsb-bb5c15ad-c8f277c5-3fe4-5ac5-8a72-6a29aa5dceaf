import type { ClusterAudit, FontConstraint, ParsedFont, ScenarioClusterAudit } from '../types';
import { countCodepoints } from './ranges';
import { formatCodepoint } from './grapheme';
import type { FailureScenario } from './resilience';

/** 转义 CSS 字符串中的引号与反斜杠 */
export function cssStringEscape(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function buildFontFamily(chainNames: string[], generic = 'sans-serif'): string {
  return [...chainNames.map((n) => `"${cssStringEscape(n)}"`), generic].join(', ');
}

export interface ChainEntry {
  /** 有效字体列表下标 */
  fontIndex: number;
  name: string;
  preference: number;
  /** 承接簇数（单场景：该场景；场景集：跨所有场景合计） */
  assignedClusters: number;
  /** 用户锁定（必须入链）的字体 */
  locked?: boolean;
}

/** 场景集模式的共享链条目：另含逐场景承接簇数 */
export interface ScenarioChainEntry extends ChainEntry {
  /** 场景 id -> 该字体在该场景承接的非 free 簇数（空场景为 0） */
  scenarioCounts: Record<string, number>;
}

/** 入链约束清单（按有效字体顺序的字体名） */
export interface ConstraintSummary {
  /** 必须入链（锁定） */
  locked: string[];
  /** 禁止入链（排除） */
  excluded: string[];
}

export function buildCssExport(
  chain: ChainEntry[],
  generatedAt: string,
  constraints?: ConstraintSummary,
): string {
  const lines = [
    `/* 由 Unicode 字体回退链审计台生成 · ${generatedAt} */`,
    '/* 回退链（按优先级从高到低）：',
    ...chain.map(
      (e, i) =>
        `   ${i + 1}. "${e.name}" — 承接 ${e.assignedClusters} 个字素簇${e.locked ? '（必须入链）' : ''}`,
    ),
    '   缺失字素簇不在任何字体覆盖范围内，详见审计 JSON。',
  ];
  if (constraints && (constraints.locked.length > 0 || constraints.excluded.length > 0)) {
    const parts: string[] = [];
    if (constraints.locked.length > 0) {
      parts.push(`必须入链 = ${constraints.locked.map((n) => `"${n}"`).join('、')}`);
    }
    if (constraints.excluded.length > 0) {
      parts.push(`禁止入链 = ${constraints.excluded.map((n) => `"${n}"`).join('、')}`);
    }
    lines.push(`   入链约束：${parts.join('；')}`);
  }
  lines.push(
    '*/',
    '.audited-text {',
    `  font-family: ${buildFontFamily(chain.map((e) => e.name))};`,
    '}',
  );
  return lines.join('\n');
}

/** 单字体的入链约束条目（仅记录非「普通」约束） */
export interface FontConstraintInfo {
  name: string;
  /** 原始偏好位次（0 = 最优先） */
  preference: number;
  constraint: FontConstraint;
}

/** 审计输入：单场景模式携带 text；场景集模式携带 scenarios 清单 */
export interface AuditInput {
  mode: 'single' | 'set';
  /** 单场景模式的文本（场景集模式为全部场景拼接，仅供兜底） */
  text: string;
  /** 场景清单；单场景模式仅一项 */
  scenarios: { id?: string; name: string; text: string }[];
  fonts: ParsedFont[];
  /** 有效字体在原始列表中的下标 */
  validFontOrder: number[];
  lengthPriority: number;
  ignoreFormatCodepoints: boolean;
  /** 是否开启“按实测覆盖求解” */
  useMeasuredCoverage: boolean;
  /** 非「普通」入链约束清单（锁定/排除），按有效字体顺序 */
  fontConstraints: FontConstraintInfo[];
}

export interface AuditResultData {
  feasible: boolean;
  exact: boolean;
  objective: number;
  nodesExplored: number;
  chain: ChainEntry[];
  unselected: { name: string; preference: number }[];
  clusters: ClusterAudit[];
  validFonts: ParsedFont[];
}

const fmtRanges = (rs: [number, number][]) =>
  rs.map(([s, e]) => [formatCodepoint(s), formatCodepoint(e)]);

/** 字体条目的审计序列化（单文本与场景集导出共用，保证两形态基线字体块一致） */
function serializeFont(f: ParsedFont, i: number) {
  return {
    preference: i + 1,
    name: f.name,
    /** 入链约束：normal 普通 / locked 必须入链 / excluded 禁止入链 */
    constraint: f.constraint,
    ranges: f.rangesText,
    parsedRanges: f.error ? null : fmtRanges(f.ranges),
    declaredCodepointCount: f.error ? 0 : f.codepointCount,
    declaredError: f.error,
    uploadedFont: f.file
      ? {
          fileName: f.file.name,
          sizeBytes: f.file.size,
          sfntVersion: f.file.sfntVersion,
          cmapFormats: f.file.cmapFormats,
          parsedAt: f.file.parsedAt,
          // 仅输出实测码位区间等元数据；文件二进制从未离开浏览器
          measuredRanges: fmtRanges(f.file.ranges),
          measuredCodepointCount: f.file.codepointCount,
          parseError: f.fileError,
        }
      : null,
    /** 本次分析实际使用的范围来源与区间 */
    effectiveCoverage: {
      source: f.effectiveSource,
      codepointCount: f.effectiveCount,
      ranges: fmtRanges(f.effectiveRanges),
    },
    /** 声明 vs 实测 双向差集 */
    declaredVsMeasured: f.file
      ? {
          declaredOnly: {
            count: f.diffDeclaredOnly ? countCodepoints(f.diffDeclaredOnly) : 0,
            segmentCount: f.diffDeclaredOnly?.length ?? 0,
            ranges: f.diffDeclaredOnly ? fmtRanges(f.diffDeclaredOnly) : [],
          },
          measuredOnly: {
            count: f.diffMeasuredOnly ? countCodepoints(f.diffMeasuredOnly) : 0,
            segmentCount: f.diffMeasuredOnly?.length ?? 0,
            ranges: f.diffMeasuredOnly ? fmtRanges(f.diffMeasuredOnly) : [],
          },
        }
      : null,
    error: f.error,
  };
}

/** 簇条目的审计序列化（单文本与场景集共用，保证两形态基线可互导） */
function serializeCluster(
  c: ClusterAudit,
  validFonts: ParsedFont[],
  extra?: Record<string, unknown>,
) {
  const fontName = (i: number | null) => (i === null ? null : validFonts[i].name);
  return {
    index: c.index,
    ...(extra ?? {}),
    text: c.text,
    codepoints: c.codepoints.map(formatCodepoint),
    requiredCodepoints: c.required.map(formatCodepoint),
    status: c.status,
    // 缺失细分：natural 自然缺失 / constraint 约束导致缺失（仅缺失时输出）
    ...(c.status === 'missing'
      ? {
          missingKind: c.missingKind ?? 'natural',
          unblockFonts: c.unblockFonts.map((i) => validFonts[i].name),
        }
      : {}),
    assignedFont: fontName(c.assigned),
    candidateFonts: c.candidates.map((i) => validFonts[i].name),
    missingCodepoints: c.missingCodepoints.map(formatCodepoint),
  };
}

function serializeChain(e: ChainEntry, i: number) {
  return {
    order: i + 1,
    font: e.name,
    preference: e.preference + 1,
    assignedClusters: e.assignedClusters,
    ...(e.locked ? { locked: true } : {}),
  };
}

/** 入链约束清单的审计序列化（单文本与场景集共用） */
function serializeConstraints(list: FontConstraintInfo[]) {
  const pick = (kind: FontConstraint) =>
    list
      .filter((c) => c.constraint === kind)
      .map((c) => ({ font: c.name, preference: c.preference + 1 }));
  return { locked: pick('locked'), excluded: pick('excluded') };
}

/** 缺失簇的审计序列化（含缺失细分与可解除约束的字体） */
function serializeMissing(c: ClusterAudit, validFonts: ParsedFont[], extra?: Record<string, unknown>) {
  return {
    index: c.index,
    ...(extra ?? {}),
    text: c.text,
    kind: c.missingKind ?? 'natural',
    codepoints: c.codepoints.map(formatCodepoint),
    missingCodepoints: c.missingCodepoints.map(formatCodepoint),
    unblockFonts: c.unblockFonts.map((i) => validFonts[i].name),
  };
}

export function buildAuditReport(
  input: AuditInput,
  result: AuditResultData,
  generatedAt: string,
) {
  const { validFonts } = result;
  const clusters = result.clusters;
  const covered = clusters.filter((c) => c.status !== 'missing').length;
  const missing = clusters.length - covered;
  const constraintMissing = clusters.filter(
    (c) => c.status === 'missing' && c.missingKind === 'constraint',
  ).length;

  return {
    tool: 'unicode-font-fallback-audit',
    version: 1,
    mode: 'single',
    generatedAt,
    input: {
      text: input.text,
      options: {
        lengthPriority: input.lengthPriority,
        ignoreFormatCodepoints: input.ignoreFormatCodepoints,
        useMeasuredCoverage: input.useMeasuredCoverage,
      },
      /** 入链约束清单（仅非「普通」条目） */
      constraints: serializeConstraints(input.fontConstraints),
      fonts: input.fonts.map(serializeFont),
    },
    result: {
      feasible: result.feasible,
      solverExact: result.exact,
      objective: Number(result.objective.toFixed(9)),
      nodesExplored: result.nodesExplored,
      graphemeCount: clusters.length,
      coveredCount: covered,
      missingCount: missing,
      naturalMissingCount: missing - constraintMissing,
      constraintMissingCount: constraintMissing,
      chain: result.chain.map(serializeChain),
      unselectedFonts: result.unselected.map((u) => ({
        font: u.name,
        preference: u.preference + 1,
      })),
      clusters: clusters.map((c) => serializeCluster(c, validFonts)),
      missing: clusters
        .filter((c) => c.status === 'missing')
        .map((c) => serializeMissing(c, validFonts)),
    },
    css: `font-family: ${buildFontFamily(result.chain.map((e) => e.name))};`,
  };
}

/** 场景集模式中逐场景的求解明细（供审计 JSON 序列化） */
export interface ScenarioResultData {
  /** 场景 id（与共享链 perScenario 对应） */
  id: string;
  name: string;
  /** 该场景的全部簇（按场景内顺序，index 为全局展平下标） */
  clusters: ScenarioClusterAudit[];
  /** 共享链中在本场景实际承接过簇的字体（按链顺序），值为本场景承接簇数 */
  chainCounts: { fontIndex: number; preference: number; assignedClusters: number }[];
}

export interface ScenarioSetResultData {
  feasible: boolean;
  exact: boolean;
  objective: number;
  nodesExplored: number;
  /** 共享回退链（字体及顺序全局唯一），含逐场景承接簇数 */
  chain: ScenarioChainEntry[];
  unselected: { name: string; preference: number }[];
  scenarios: ScenarioResultData[];
  /** 全部场景展平后的簇 */
  clusters: ScenarioClusterAudit[];
  validFonts: ParsedFont[];
}

/**
 * 场景集模式审计报告：
 * input.scenarios 为场景清单，result.sharedChain 为全局唯一的共享回退链，
 * result.scenarios 为逐场景明细（覆盖率、缺失簇、承接字体）。
 * 每个场景的 clusters 条目与单文本导出同构（index 额外保留全局/局部双下标），
 * 因此也能被基线导入器读取。
 */
export function buildScenarioSetReport(
  input: AuditInput,
  result: ScenarioSetResultData,
  generatedAt: string,
) {
  const { validFonts } = result;

  const total = result.clusters.length;
  const missingTotal = result.clusters.filter((c) => c.status === 'missing').length;
  const constraintMissingTotal = result.clusters.filter(
    (c) => c.status === 'missing' && c.missingKind === 'constraint',
  ).length;
  const coveredTotal = total - missingTotal;
  const nonEmpty = result.scenarios.filter((s) => s.clusters.length > 0).length;

  return {
    tool: 'unicode-font-fallback-audit',
    version: 1,
    mode: 'scenario-set',
    generatedAt,
    input: {
      options: {
        lengthPriority: input.lengthPriority,
        ignoreFormatCodepoints: input.ignoreFormatCodepoints,
        useMeasuredCoverage: input.useMeasuredCoverage,
      },
      /** 入链约束清单（仅非「普通」条目） */
      constraints: serializeConstraints(input.fontConstraints),
      scenarios: input.scenarios.map((s) => ({ name: s.name, text: s.text })),
      fonts: input.fonts.map(serializeFont),
    },
    result: {
      feasible: result.feasible,
      solverExact: result.exact,
      objective: Number(result.objective.toFixed(9)),
      nodesExplored: result.nodesExplored,
      scenarioCount: result.scenarios.length,
      nonEmptyScenarioCount: nonEmpty,
      graphemeCount: total,
      coveredCount: coveredTotal,
      missingCount: missingTotal,
      naturalMissingCount: missingTotal - constraintMissingTotal,
      constraintMissingCount: constraintMissingTotal,
      sharedChain: result.chain.map((e, i) => ({
        order: i + 1,
        font: e.name,
        preference: e.preference + 1,
        assignedClusters: e.assignedClusters,
        ...(e.locked ? { locked: true } : {}),
        perScenario: result.scenarios.map((s) => ({
          scenarioId: s.id,
          scenario: s.name,
          clusters: e.scenarioCounts[s.id] ?? 0,
        })),
      })),
      unselectedFonts: result.unselected.map((u) => ({
        font: u.name,
        preference: u.preference + 1,
      })),
      scenarios: result.scenarios.map((s) => {
        const m = s.clusters.filter((c) => c.status === 'missing').length;
        const cm = s.clusters.filter(
          (c) => c.status === 'missing' && c.missingKind === 'constraint',
        ).length;
        const free = s.clusters.filter((c) => c.status === 'free').length;
        const n = s.clusters.length;
        // 覆盖率：非缺失簇（含格式簇）占比；空场景为 null（保留但不参与统计）
        const coverageRate = n === 0 ? null : Number(((n - m) / n).toFixed(6));
        return {
          scenario: s.name,
          empty: n === 0,
          graphemeCount: n,
          coveredCount: n - m,
          missingCount: m,
          naturalMissingCount: m - cm,
          constraintMissingCount: cm,
          freeCount: free,
          coverageRate,
          chain: s.chainCounts.map((cc, k) => {
            const order = result.chain.findIndex((e) => e.fontIndex === cc.fontIndex);
            return {
              order: order >= 0 ? order + 1 : k + 1,
              font: validFonts[cc.fontIndex].name,
              preference: cc.preference + 1,
              assignedClusters: cc.assignedClusters,
            };
          }),
          clusters: s.clusters.map((c) =>
            serializeCluster(c, validFonts, {
              globalIndex: c.index,
              scenarioLocalIndex: c.localIndex,
            }),
          ),
          missing: s.clusters
            .filter((c) => c.status === 'missing')
            .map((c) =>
              serializeMissing(c, validFonts, {
                globalIndex: c.index,
                // 场景内局部下标覆盖全局下标语义，与历史导出保持一致
                index: c.localIndex,
              }),
            ),
        };
      }),
    },
    css: `font-family: ${buildFontFamily(result.chain.map((e) => e.name))};`,
  };
}

/** 韧性分析报告的基线（失效前）摘要 */
export interface ResilienceBaseline {
  chain: ChainEntry[];
  graphemeCount: number;
  coveredCount: number;
  missingCount: number;
}

/**
 * 构建「单字体失效韧性分析」JSON 报告。
 * scenarios 中的字体下标均为原始有效字体列表下标，此处统一映射回字体名称。
 * 场景集模式传入 scenarioNames 后，新增缺失/改接簇附场景名与场景内下标。
 */
export function buildResilienceReport(
  input: AuditInput,
  baseline: ResilienceBaseline,
  scenarios: FailureScenario[],
  validFonts: ParsedFont[],
  generatedAt: string,
  scenarioNames?: Map<string, string>,
) {
  const fontName = (i: number) => validFonts[i].name;
  const scenarioName = (id?: string) =>
    id && scenarioNames ? scenarioNames.get(id) ?? null : null;

  return {
    tool: 'unicode-font-fallback-audit',
    analysis: 'single-font-failure-resilience',
    version: 1,
    mode: input.mode,
    generatedAt,
    options: {
      lengthPriority: input.lengthPriority,
      ignoreFormatCodepoints: input.ignoreFormatCodepoints,
      useMeasuredCoverage: input.useMeasuredCoverage,
      ...(input.mode === 'set'
        ? { scenarios: input.scenarios.map((s) => s.name) }
        : {}),
    },
    baseline: {
      graphemeCount: baseline.graphemeCount,
      coveredCount: baseline.coveredCount,
      missingCount: baseline.missingCount,
      chainLength: baseline.chain.length,
      chain: baseline.chain.map((e, i) => ({
        order: i + 1,
        font: e.name,
        preference: e.preference + 1,
        assignedClusters: e.assignedClusters,
      })),
    },
    /** 已按新增缺失数降序排列 */
    scenarios: scenarios.map((s) => ({
      failedFont: {
        font: fontName(s.fontIndex),
        validFontIndex: s.fontIndex,
        preference: s.preference + 1,
      },
      assignedClustersBefore: s.assignedBefore,
      feasibleAfterFailure: s.feasible,
      solverExact: s.exact,
      chainLengthBefore: baseline.chain.length,
      chainLengthAfter: s.chain.length,
      chainLengthDelta: s.chainLengthDelta,
      replacementChain: s.chain.map((f, i) => ({
        order: i + 1,
        font: fontName(f),
        validFontIndex: f,
        assignedClusters: s.chainAssigned[i],
      })),
      newMissingCount: s.newMissing.length,
      newMissing: s.newMissing.map((c) => ({
        index: c.index,
        ...(scenarioName(c.scenarioId)
          ? {
              scenario: scenarioName(c.scenarioId),
              scenarioLocalIndex: c.localIndex,
            }
          : {}),
        text: c.text,
        codepoints: c.codepoints.map(formatCodepoint),
        missingCodepoints: c.missingCodepoints.map(formatCodepoint),
      })),
      reassignedCount: s.reassigned.length,
      reassigned: s.reassigned.map((c) => ({
        index: c.index,
        ...(scenarioName(c.scenarioId)
          ? {
              scenario: scenarioName(c.scenarioId),
              scenarioLocalIndex: c.localIndex,
            }
          : {}),
        text: c.text,
        codepoints: c.codepoints.map(formatCodepoint),
        fromFont: fontName(c.fromFont),
        toFont: fontName(c.toFont),
      })),
      stillMissingCount: s.stillMissing,
    })),
  };
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 回退：隐藏 textarea + execCommand（兼容非安全上下文）
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
