/**
 * Webfont 分片。
 *
 * 按当前参与求解场景中**实际承接**的码位，为回退链中每种字体生成
 * `@font-face` + `unicode-range` 分片：
 *   - 每个非自由簇由链中一种字体承接，其全部「需覆盖码位」计入该字体的
 *     分片需求；同一码位跨簇/跨场景重复出现时**只计一次**（但命中场景
 *     会记录全部来源场景）；缺失簇无承接字体，不参与分片；
 *   - 同一字素簇的必需码位不得拆片：每簇的必需码位构成一条超边，
 *     共享码位的簇归并为一个**连通组**（并查集），连通组整体装箱；
 *   - 装箱采用**确定性最佳适配**（best-fit）：连通组按
 *     「码位数降序 → 最小码位升序」排序后依次装入当前剩余容量最小
 *     且能容纳它的片（平局取先创建的片），无片可容则开新片；
 *   - 单个连通组超过每片上限时**独立成片**并标记 `oversized`，
 *     超限片不再装入其他组；
 *   - 全部中间结构按确定性规则排序，输入不变时输出（片序、片内码位、
 *     CSS 与 JSON）完全稳定。
 *
 * 分片完全基于当前生效的声明/实测覆盖与入链约束求解结果，属于导出产物，
 * 不修改原求解结果与字体范围。
 */

import type { ParsedFont, ScenarioClusterAudit } from '../types';
import { cssStringEscape, type ChainEntry } from './audit';
import { formatCodepoint } from './grapheme';
import type { PatchScenarioInfo } from './patching';

export interface WebfontSliceInput {
  /** 当前参与求解的全部簇（单场景模式仅活动场景，须带场景归属字段） */
  clusters: ScenarioClusterAudit[];
  /** 当前回退链（单场景链或场景集共享链），顺序即回退优先级 */
  chain: ChainEntry[];
  /** 有效字体（下标与 chain.fontIndex / 簇 assigned 对齐） */
  validFonts: ParsedFont[];
  /** 参与求解的场景（按清单顺序），用于命中场景排序与命名 */
  scenarios: PatchScenarioInfo[];
  /** 每片最大码位数（>= 1；调用方已做下限收敛） */
  maxPerSlice: number;
}

/** 单个分片（对应一条 @font-face 规则） */
export interface WebfontSlice {
  /** 片序号（该字体内从 1 开始，按装箱创建顺序） */
  index: number;
  /** 片内码位（升序去重） */
  codepoints: number[];
  codepointCount: number;
  /** 码位折叠后的紧凑区间 */
  ranges: [number, number][];
  /** CSS unicode-range 取值，如 "U+0020-007E, U+4E00" */
  unicodeRange: string;
  /** 命中场景 id（按场景清单顺序） */
  scenarioIds: string[];
  /** 单连通组超限独立成片 */
  oversized: boolean;
  /** 该片的完整 @font-face CSS */
  css: string;
}

/** 回退链中一种字体的分片结果 */
export interface WebfontFontSlices {
  /** 有效字体列表下标 */
  fontIndex: number;
  fontName: string;
  /** 原始偏好位次（0 = 最优先） */
  preference: number;
  /** 链中位次（1 = 链首） */
  chainOrder: number;
  locked: boolean;
  /** 该字体承接的非自由簇数（跨场景合计，重复出现分别计数） */
  assignedClusters: number;
  /** 该字体承接的去重码位数（跨场景重复只计一次） */
  uniqueCodepoints: number;
  slices: WebfontSlice[];
}

export interface WebfontSlicePlan {
  /** 本次分片使用的每片最大码位数 */
  maxPerSlice: number;
  /** 按回退链顺序的逐字体分片 */
  fonts: WebfontFontSlices[];
  /** 全部字体合计片数 */
  sliceCount: number;
  /** 其中超限独立片数 */
  oversizedSliceCount: number;
  /** 各字体去重码位数合计（同一码位被不同字体承接时分别计数） */
  uniqueCodepoints: number;
}

/** 并查集：把共享码位的簇需求归并为连通组 */
class CodepointDSU {
  private parent = new Map<number, number>();

  find(x: number): number {
    let root = this.parent.get(x);
    if (root === undefined) {
      this.parent.set(x, x);
      return x;
    }
    if (root !== x) {
      root = this.find(root);
      this.parent.set(x, root);
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** 升序码位折叠为连续闭区间 */
function collapseRanges(sorted: number[]): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push([sorted[i], sorted[j]]);
    i = j + 1;
  }
  return out;
}

/** 紧凑区间格式化为 CSS unicode-range 取值（单码位省略终点；区间终点不带 U+ 前缀） */
export function formatUnicodeRange(ranges: [number, number][]): string {
  return ranges
    .map(([s, e]) =>
      s === e
        ? formatCodepoint(s)
        : `${formatCodepoint(s)}-${e.toString(16).toUpperCase().padStart(4, '0')}`,
    )
    .join(', ');
}

/** CSS 注释内容净化：避免字体/场景名中的注释终止符破坏输出 */
function cssCommentSafe(text: string): string {
  return text.replace(/\*\//g, '* /');
}

function buildSliceCss(
  fontName: string,
  sliceIndex: number,
  sliceCount: number,
  codepointCount: number,
  unicodeRange: string,
  scenarioNames: string[],
  oversized: boolean,
): string {
  const display = fontName.trim() || '(未命名)';
  const esc = cssStringEscape(display);
  const scenNote = scenarioNames.length
    ? ` · 命中场景：${cssCommentSafe(scenarioNames.join('、'))}`
    : '';
  const sizeNote = oversized ? ' · 单连通组超限，独立成片' : '';
  return [
    `/* ${cssCommentSafe(display)} · 片 ${sliceIndex}/${sliceCount} · ${codepointCount} 码位${scenNote}${sizeNote} */`,
    '@font-face {',
    `  font-family: "${esc}";`,
    `  src: local("${esc}"); /* 自托管时替换为 url(...) */`,
    `  unicode-range: ${unicodeRange};`,
    '}',
  ].join('\n');
}

interface ConnectedGroup {
  /** 组内码位（升序） */
  codepoints: number[];
  /** 组内码位命中的场景 id 集合 */
  scenarioIds: Set<string>;
}

interface SliceBin {
  codepoints: number[];
  remaining: number;
  scenarioIds: Set<string>;
  oversized: boolean;
}

/**
 * 计算 Webfont 分片方案。
 * 对回退链中每种字体：收集其承接簇的必需码位（去重）→ 并查集归并连通组 →
 * 确定性最佳适配装箱。链中未承接任何码位的字体保留在结果中（slices 为空）。
 */
export function planWebfontSlices(input: WebfontSliceInput): WebfontSlicePlan {
  const { clusters, chain, validFonts, scenarios } = input;
  const maxPerSlice = Math.max(1, Math.floor(input.maxPerSlice) || 1);

  const scenarioOrder = new Map<string, number>();
  scenarios.forEach((s, i) => scenarioOrder.set(s.id, i));
  const byScenarioOrder = (a: string, b: string) =>
    (scenarioOrder.get(a) ?? Number.MAX_SAFE_INTEGER) -
    (scenarioOrder.get(b) ?? Number.MAX_SAFE_INTEGER);
  const scenarioName = (id: string) => scenarios.find((s) => s.id === id)?.name ?? '';

  const fonts: WebfontFontSlices[] = chain.map((entry, chainIdx) => {
    const fontIndex = entry.fontIndex;
    const fontName = validFonts[fontIndex]?.name ?? entry.name;

    // ---- 收集该字体承接的必需码位，并按共享码位归并连通组 ----
    const dsu = new CodepointDSU();
    const cpScenarios = new Map<number, Set<string>>();
    let assignedClusters = 0;
    for (const c of clusters) {
      if (c.free || c.assigned !== fontIndex) continue;
      assignedClusters += 1;
      const required = c.required;
      for (const cp of required) {
        dsu.find(cp); // 注册孤立码位（单码位簇也自成一组）
        let set = cpScenarios.get(cp);
        if (!set) {
          set = new Set<string>();
          cpScenarios.set(cp, set);
        }
        set.add(c.scenarioId);
      }
      // 同一字素簇的必需码位不得拆片：簇内码位两两连通
      for (let i = 1; i < required.length; i++) dsu.union(required[0], required[i]);
    }

    const groupMap = new Map<number, number[]>();
    for (const cp of cpScenarios.keys()) {
      const root = dsu.find(cp);
      let arr = groupMap.get(root);
      if (!arr) {
        arr = [];
        groupMap.set(root, arr);
      }
      arr.push(cp);
    }
    const groups: ConnectedGroup[] = [];
    for (const cps of groupMap.values()) {
      cps.sort((a, b) => a - b);
      const scenarioIds = new Set<string>();
      for (const cp of cps) {
        for (const sid of cpScenarios.get(cp)!) scenarioIds.add(sid);
      }
      groups.push({ codepoints: cps, scenarioIds });
    }
    // 确定性装箱顺序：码位数降序 → 最小码位升序（连通组码位互不相交，最小码位唯一）
    groups.sort(
      (a, b) => b.codepoints.length - a.codepoints.length || a.codepoints[0] - b.codepoints[0],
    );

    // ---- 确定性最佳适配装箱 ----
    const bins: SliceBin[] = [];
    for (const g of groups) {
      const size = g.codepoints.length;
      if (size > maxPerSlice) {
        // 单连通组超限：独立成片并标记，且不再装入其他组
        bins.push({
          codepoints: [...g.codepoints],
          remaining: maxPerSlice - size,
          scenarioIds: new Set(g.scenarioIds),
          oversized: true,
        });
        continue;
      }
      let best: SliceBin | null = null;
      for (const bin of bins) {
        if (bin.oversized || bin.remaining < size) continue;
        // 剩余容量最小者优先；严格小于保证平局时取先创建的片
        if (!best || bin.remaining < best.remaining) best = bin;
      }
      if (best) {
        best.codepoints.push(...g.codepoints);
        best.remaining -= size;
        for (const sid of g.scenarioIds) best.scenarioIds.add(sid);
      } else {
        bins.push({
          codepoints: [...g.codepoints],
          remaining: maxPerSlice - size,
          scenarioIds: new Set(g.scenarioIds),
          oversized: false,
        });
      }
    }

    // ---- 输出分片（码位升序、命中场景按清单顺序） ----
    const slices: WebfontSlice[] = bins.map((bin, i) => {
      // 连通组之间码位互不相交，此处排序即可保证片内升序
      const codepoints = [...bin.codepoints].sort((a, b) => a - b);
      const ranges = collapseRanges(codepoints);
      const unicodeRange = formatUnicodeRange(ranges);
      const scenarioIds = [...bin.scenarioIds].sort(byScenarioOrder);
      const scenarioNames = scenarioIds.map(scenarioName);
      return {
        index: i + 1,
        codepoints,
        codepointCount: codepoints.length,
        ranges,
        unicodeRange,
        scenarioIds,
        oversized: bin.oversized,
        css: buildSliceCss(
          fontName,
          i + 1,
          bins.length,
          codepoints.length,
          unicodeRange,
          scenarioNames,
          bin.oversized,
        ),
      };
    });

    return {
      fontIndex,
      fontName,
      preference: entry.preference,
      chainOrder: chainIdx + 1,
      locked: !!entry.locked,
      assignedClusters,
      uniqueCodepoints: cpScenarios.size,
      slices,
    };
  });

  return {
    maxPerSlice,
    fonts,
    sliceCount: fonts.reduce((n, f) => n + f.slices.length, 0),
    oversizedSliceCount: fonts.reduce(
      (n, f) => n + f.slices.filter((s) => s.oversized).length,
      0,
    ),
    uniqueCodepoints: fonts.reduce((n, f) => n + f.uniqueCodepoints, 0),
  };
}

/** 分片 JSON 报告构建选项 */
export interface WebfontSliceReportOptions {
  generatedAt: string;
  mode: 'single' | 'set';
  ignoreFormatCodepoints: boolean;
  useMeasuredCoverage: boolean;
  /** 参与求解的场景（按清单顺序），set 模式导出名称清单 */
  scenarios: PatchScenarioInfo[];
}

/**
 * 构建 Webfont 分片 JSON 报告（`font-fallback-webfont-slices.json`）。
 * 含每片完整码位清单、紧凑区间、命中场景与 CSS，可直接用于排查或二次加工。
 */
export function buildWebfontSliceReport(
  plan: WebfontSlicePlan,
  opts: WebfontSliceReportOptions,
) {
  const scenarioName = (id: string) => opts.scenarios.find((s) => s.id === id)?.name ?? '';
  return {
    tool: 'unicode-font-fallback-audit',
    analysis: 'webfont-slices',
    version: 1,
    mode: opts.mode === 'set' ? ('scenario-set' as const) : ('single' as const),
    generatedAt: opts.generatedAt,
    options: {
      maxCodepointsPerSlice: plan.maxPerSlice,
      ignoreFormatCodepoints: opts.ignoreFormatCodepoints,
      useMeasuredCoverage: opts.useMeasuredCoverage,
      ...(opts.mode === 'set'
        ? { scenarios: opts.scenarios.map((s) => s.name) }
        : {}),
    },
    summary: {
      chainFontCount: plan.fonts.length,
      slicedFontCount: plan.fonts.filter((f) => f.slices.length > 0).length,
      sliceCount: plan.sliceCount,
      oversizedSliceCount: plan.oversizedSliceCount,
      /** 各字体去重码位数合计（同一码位被不同字体承接时分别计数） */
      uniqueCodepoints: plan.uniqueCodepoints,
    },
    fonts: plan.fonts.map((f) => ({
      font: f.fontName,
      validFontIndex: f.fontIndex,
      preference: f.preference + 1,
      chainOrder: f.chainOrder,
      locked: f.locked,
      assignedClusters: f.assignedClusters,
      uniqueCodepoints: f.uniqueCodepoints,
      sliceCount: f.slices.length,
      slices: f.slices.map((s) => ({
        index: s.index,
        codepointCount: s.codepointCount,
        oversized: s.oversized,
        scenarios: s.scenarioIds.map(scenarioName),
        unicodeRange: s.unicodeRange,
        ranges: s.ranges.map(([a, b]) => [formatCodepoint(a), formatCodepoint(b)]),
        codepoints: s.codepoints.map(formatCodepoint),
        css: s.css,
      })),
    })),
  };
}
