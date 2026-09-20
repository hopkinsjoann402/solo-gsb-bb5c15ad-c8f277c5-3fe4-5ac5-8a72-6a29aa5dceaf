import { useMemo, useState } from 'react';
import type {
  AuditMode,
  FontSpec,
  ParsedFont,
  ScenarioClusterAudit,
  ScenarioSpec,
} from './types';
import { segmentGraphemes } from './lib/grapheme';
import {
  countCodepoints,
  parseUnicodeRanges,
  subtractRanges,
} from './lib/ranges';
import {
  analyzeGroupedCoverage,
  findMissingCodepoints,
  toScenarioClusterAudit,
} from './lib/coverage';
import { solveFallbackChain } from './lib/solver';
import { analyzeSingleFontFailure } from './lib/resilience';
import type { AuditInput, ChainEntry, ScenarioChainEntry } from './lib/audit';
import { SAMPLE_TEXT, sampleFonts, uid } from './lib/sample';
import {
  MAX_SCENARIOS,
  createScenario,
  nextDefaultName,
  sampleScenarios,
  scenarioDisplayName,
} from './lib/scenarios';
import { parseSfntFile } from './lib/sfnt';
import FontEditor from './components/FontEditor';
import FontUpgradePanel from './components/FontUpgradePanel';
import ScenarioEditor from './components/ScenarioEditor';
import ResultsPanel from './components/ResultsPanel';
import SetResultsPanel, { type ScenarioView } from './components/SetResultsPanel';
import type { PatchScenarioInfo } from './lib/patching';

/** 文件大小上限 20 MB（防止误选超大文件卡死浏览器解析） */
const MAX_FONT_BYTES = 20 * 1024 * 1024;

/** 初始单场景（载入示例文本） */
const initialScenario = createScenario('', SAMPLE_TEXT);

export default function App() {
  const [mode, setMode] = useState<AuditMode>('single');
  /**
   * 文本始终保存在场景清单中：单场景模式下也只有一个场景，
   * 切换模式不丢失文本；活动场景 id 决定当前编辑/查看哪一段文本。
   */
  const [scenarios, setScenarios] = useState<ScenarioSpec[]>([initialScenario]);
  const [activeId, setActiveId] = useState<string>(initialScenario.id);
  const [fonts, setFonts] = useState<FontSpec[]>(sampleFonts);
  const [lengthPriority, setLengthPriority] = useState(0.7);
  const [ignoreFormat, setIgnoreFormat] = useState(true);
  /** 按实测覆盖求解：已上传字体用 cmap 区间，未上传字体仍用声明范围 */
  const [useMeasured, setUseMeasured] = useState(false);
  /** 正在解析的条目 id 集合（上传后异步读取期间显示忙碌，支持并发上传） */
  const [parsingIds, setParsingIds] = useState<Set<string>>(new Set());
  /** 解析失败信息（与 font.file 解耦：坏文件不会覆盖上次成功结果） */
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({});

  // 活动场景 id 兜底（删除后重定向）
  const activeScenario =
    scenarios.find((s) => s.id === activeId) ?? scenarios[0];
  const activeScenarioId = activeScenario.id;

  // ---- 字体范围解析（声明范围始终解析；实测范围仅在开关开启时生效） ----
  const parsed: ParsedFont[] = useMemo(
    () =>
      fonts.map((f) => {
        const { ranges, error } = parseUnicodeRanges(f.rangesText);
        const fileError = fileErrors[f.id] ?? null;

        let diffDeclaredOnly: [number, number][] | undefined;
        let diffMeasuredOnly: [number, number][] | undefined;
        if (f.file && !error) {
          diffDeclaredOnly = subtractRanges(ranges, f.file.ranges);
          diffMeasuredOnly = subtractRanges(f.file.ranges, ranges);
        }

        const measuredActive = useMeasured && !!f.file;
        const effectiveRanges = measuredActive ? f.file!.ranges : ranges;

        return {
          ...f,
          ranges,
          error,
          codepointCount: error ? 0 : countCodepoints(ranges),
          fileError,
          effectiveRanges,
          effectiveSource: measuredActive ? ('measured' as const) : ('declared' as const),
          effectiveCount: countCodepoints(effectiveRanges),
          diffDeclaredOnly,
          diffMeasuredOnly,
        };
      }),
    [fonts, useMeasured, fileErrors],
  );

  // 有效字体及其在原始列表中的位次（位次即偏好顺序）。
  const validEntries = useMemo(
    () =>
      parsed
        .map((font, order) => ({ font, order }))
        .filter((e) =>
          e.font.effectiveSource === 'measured'
            ? e.font.effectiveRanges.length > 0
            : !e.font.error && e.font.ranges.length > 0,
        ),
    [parsed],
  );
  const validFonts = useMemo(() => validEntries.map((e) => e.font), [validEntries]);

  // ---- 入链约束：按有效字体下标汇总（约束随字体 id 保留，排序/覆盖源切换不影响） ----
  const lockedIdx = useMemo(
    () => validEntries.flatMap((e, i) => (e.font.constraint === 'locked' ? [i] : [])),
    [validEntries],
  );
  const excludedIdx = useMemo(
    () => validEntries.flatMap((e, i) => (e.font.constraint === 'excluded' ? [i] : [])),
    [validEntries],
  );
  const lockedSet = useMemo(() => new Set(lockedIdx), [lockedIdx]);
  const excludedSet = useMemo(() => new Set(excludedIdx), [excludedIdx]);

  // ---- 各场景字素簇切分 ----
  const groupsGraphemes = useMemo(
    () => scenarios.map((s) => ({ scenarioId: s.id, graphemes: segmentGraphemes(s.text) })),
    [scenarios],
  );

  // 参与本次求解的场景：单场景模式仅活动场景；场景集模式为全部场景。
  // （场景清单在模式切换间完整保留，只是单场景模式不合并其他场景。）
  const solveGroups = useMemo(
    () =>
      mode === 'single'
        ? groupsGraphemes.filter((g) => g.scenarioId === activeScenarioId)
        : groupsGraphemes,
    [mode, groupsGraphemes, activeScenarioId],
  );

  // ---- 全部参与场景簇合并覆盖分析（需求模式跨场景全局去重，簇不合并） ----
  const analysis = useMemo(
    () => analyzeGroupedCoverage(solveGroups, validFonts, ignoreFormat),
    [solveGroups, validFonts, ignoreFormat],
  );

  // ---- 回退链求解：所有场景的需求模式参与一次求解，链中字体全局唯一 ----
  // 求解器先剔除「禁止入链」候选，再把「必须入链」字体纳入链中，最后优化其余字体。
  const solution = useMemo(
    () =>
      solveFallbackChain({
        fontCount: validFonts.length,
        preference: validEntries.map((e) => e.order),
        patterns: analysis.patterns,
        lengthPriority,
        locked: lockedIdx,
        excluded: excludedIdx,
      }),
    [validFonts.length, validEntries, analysis.patterns, lengthPriority, lockedIdx, excludedIdx],
  );

  // ---- 承接分配：每个簇由共享链中第一种可覆盖字体承接（与浏览器回退语义一致） ----
  const flatClusters: ScenarioClusterAudit[] = useMemo(() => {
    const chainOrder = solution.selected; // 已按偏好排序
    return analysis.clusters.map((c) => {
      if (c.free) {
        return toScenarioClusterAudit(
          c,
          chainOrder.length > 0 ? chainOrder[0] : null,
          'free',
          [],
        );
      }
      const assigned = chainOrder.find((f) => c.candidates.includes(f)) ?? null;
      if (assigned === null) {
        // 约束导致缺失：有候选字体，但候选全部被「禁止入链」排除；
        // 可解除该缺失的字体 = 候选中被排除的字体
        const constraintMissing =
          c.candidates.length > 0 && c.candidates.every((f) => excludedSet.has(f));
        return toScenarioClusterAudit(
          c,
          null,
          'missing',
          constraintMissing ? [] : findMissingCodepoints(c.required, validFonts),
          constraintMissing ? 'constraint' : 'natural',
          constraintMissing ? c.candidates.filter((f) => excludedSet.has(f)) : [],
        );
      }
      return toScenarioClusterAudit(c, assigned, 'covered', []);
    });
  }, [analysis.clusters, solution.selected, validFonts, excludedSet]);

  // ---- 共享链上每种字体的承接簇数（参与场景合计 + 逐场景拆分；按场景 id 索引） ----
  const chain: ScenarioChainEntry[] = useMemo(() => {
    const totals = new Map<number, number>();
    const perScenario = new Map<number, Map<string, number>>();
    for (const c of flatClusters) {
      if (c.assigned !== null && c.status !== 'free') {
        totals.set(c.assigned, (totals.get(c.assigned) ?? 0) + 1);
        let byId = perScenario.get(c.assigned);
        if (!byId) {
          byId = new Map<string, number>();
          perScenario.set(c.assigned, byId);
        }
        byId.set(c.scenarioId, (byId.get(c.scenarioId) ?? 0) + 1);
      }
    }
    return solution.selected.map((fontIndex) => ({
      fontIndex,
      name: validFonts[fontIndex].name,
      preference: validEntries[fontIndex].order,
      assignedClusters: totals.get(fontIndex) ?? 0,
      scenarioCounts: Object.fromEntries(perScenario.get(fontIndex) ?? new Map()),
      locked: lockedSet.has(fontIndex),
    }));
  }, [flatClusters, solution.selected, validFonts, validEntries, lockedSet]);

  // 未入选（冗余）：不含被「禁止入链」排除的字体（排除不是冗余）
  const unselected = useMemo(
    () =>
      validEntries
        .filter((_, i) => !solution.selected.includes(i) && !excludedSet.has(i))
        .map((e) => ({ name: e.font.name, preference: e.order })),
    [validEntries, solution.selected, excludedSet],
  );

  // ---- 逐场景视图：覆盖率 / 缺失簇 / 承接字体（场景内簇保序） ----
  // 展示/导出名：名称留空时按清单位次回退为「场景 N」（id 不变，重命名只改显示）
  const scenarioViews: ScenarioView[] = useMemo(
    () =>
      scenarios.map((s, i) => {
        const name = scenarioDisplayName(s, i);
        const clusters = flatClusters.filter((c) => c.scenarioId === s.id);
        const counts = new Map<number, number>();
        for (const c of clusters) {
          if (c.assigned !== null && c.status !== 'free') {
            counts.set(c.assigned, (counts.get(c.assigned) ?? 0) + 1);
          }
        }
        return {
          id: s.id,
          name,
          clusters,
          chainCounts: chain
            .filter((e) => (counts.get(e.fontIndex) ?? 0) > 0)
            .map((e) => ({
              fontIndex: e.fontIndex,
              preference: e.preference,
              assignedClusters: counts.get(e.fontIndex) ?? 0,
            })),
        };
      }),
    [scenarios, flatClusters, chain],
  );

  // ---- 单字体失效韧性分析：逐一移除链中字体并对参与场景重解（入链约束保持生效） ----
  const resilience = useMemo(
    () =>
      solution.selected.length > 0
        ? analyzeSingleFontFailure({
            groups: solveGroups,
            validFonts,
            preference: validEntries.map((e) => e.order),
            ignoreFormat,
            lengthPriority,
            baselineClusters: flatClusters,
            baselineChain: solution.selected,
            locked: lockedIdx,
            excluded: excludedIdx,
          })
        : [],
    [
      solveGroups,
      validFonts,
      validEntries,
      ignoreFormat,
      lengthPriority,
      flatClusters,
      solution.selected,
      lockedIdx,
      excludedIdx,
    ],
  );

  // ---- 补字预算规划：参与求解的场景元数据（单场景仅活动场景） ----
  const patchScenarios: PatchScenarioInfo[] = useMemo(
    () =>
      solveGroups.map((g) => {
        const idx = scenarios.findIndex((s) => s.id === g.scenarioId);
        const spec = scenarios[idx];
        return {
          id: g.scenarioId,
          name: spec
            ? scenarioDisplayName(spec, idx)
            : '',
        };
      }),
    [solveGroups, scenarios],
  );

  const auditInput: AuditInput = useMemo(
    () => ({
      mode,
      // 单场景导出保持原形态（input.text 为该场景原文）；场景集导出 text 留空、使用 scenarios
      text: mode === 'single' ? (scenarios.find((s) => s.id === activeScenarioId)?.text ?? '') : '',
      scenarios:
        mode === 'set'
          ? scenarios.map((s, i) => ({ id: s.id, name: scenarioDisplayName(s, i), text: s.text }))
          : [{ name: '', text: scenarios.find((s) => s.id === activeScenarioId)?.text ?? '' }],
      fonts: parsed,
      validFontOrder: validEntries.map((e) => e.order),
      lengthPriority,
      ignoreFormatCodepoints: ignoreFormat,
      useMeasuredCoverage: useMeasured,
      // 入链约束清单（仅非「普通」条目），随审计 JSON 导出
      fontConstraints: validEntries.flatMap((e) =>
        e.font.constraint === 'normal'
          ? []
          : [{ name: e.font.name, preference: e.order, constraint: e.font.constraint }],
      ),
    }),
    [mode, scenarios, activeScenarioId, parsed, validEntries, lengthPriority, ignoreFormat, useMeasured],
  );

  const hasUploaded = useMemo(() => fonts.some((f) => !!f.file), [fonts]);

  // ---- 字体列表编辑 ----
  const updateFont = (id: string, patch: Partial<FontSpec>) =>
    setFonts((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const moveFont = (id: string, dir: -1 | 1) =>
    setFonts((fs) => {
      const i = fs.findIndex((f) => f.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= fs.length) return fs;
      const next = [...fs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const removeFont = (id: string) =>
    setFonts((fs) => fs.filter((f) => f.id !== id));
  const addFont = () =>
    setFonts((fs) => [
      ...fs,
      { id: uid(), name: '', rangesText: '', file: null, constraint: 'normal' },
    ]);

  // ---- 场景编辑 ----
  const patchActive = (patch: Partial<ScenarioSpec>) =>
    setScenarios((ss) => ss.map((s) => (s.id === activeScenarioId ? { ...s, ...patch } : s)));

  const addScenario = () =>
    setScenarios((ss) => {
      if (ss.length >= MAX_SCENARIOS) return ss;
      const created = createScenario(nextDefaultName(ss), '');
      setActiveId(created.id);
      return [...ss, created];
    });

  const renameScenario = (id: string, name: string) =>
    setScenarios((ss) => ss.map((s) => (s.id === id ? { ...s, name } : s)));

  const deleteScenario = (id: string) =>
    setScenarios((ss) => {
      if (ss.length <= 1) return ss;
      const idx = ss.findIndex((s) => s.id === id);
      const next = ss.filter((s) => s.id !== id);
      if (id === activeScenarioId) {
        const fallback = next[Math.min(idx, next.length - 1)];
        setActiveId(fallback.id);
      }
      return next;
    });

  const switchMode = (m: AuditMode) => {
    // 切换模式不改动场景清单：单场景模式只编辑/求解活动场景，
    // 切回场景集模式时其余场景文本原样保留。
    setMode(m);
  };

  const loadSample = () => {
    if (mode === 'set') {
      const seeded = sampleScenarios();
      setScenarios(seeded);
      setActiveId(seeded[0].id);
    } else {
      setScenarios((ss) =>
        ss.map((s) => (s.id === activeScenarioId ? { ...s, text: SAMPLE_TEXT } : s)),
      );
    }
  };

  const clearActive = () => patchActive({ text: '' });

  // ---- 本地字体文件：浏览器内读取 + 解析 cmap，绝不离开当前页面 ----
  const uploadFontFile = (id: string, file: File) => {
    setParsingIds((s) => new Set(s).add(id));
    // File 只在本次读取期间存在；ArrayBuffer 解析完即可被 GC，不写入任何存储
    parseSfntFile(file, MAX_FONT_BYTES)
      .then((info) => {
        setFonts((fs) => fs.map((f) => (f.id === id ? { ...f, file: info } : f)));
        setFileErrors((m) => {
          const rest = { ...m };
          delete rest[id];
          return rest;
        });
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        setFileErrors((m) => ({ ...m, [id]: msg }));
      })
      .finally(() => {
        setParsingIds((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        });
      });
  };

  const clearFontFile = (id: string) => {
    setFonts((fs) => fs.map((f) => (f.id === id ? { ...f, file: null } : f)));
    setFileErrors((m) => {
      const rest = { ...m };
      delete rest[id];
      return rest;
    });
    // 全部清除后自动回到声明范围求解
    const anyLeft = fonts.some((f) => f.id !== id && f.file);
    if (!anyLeft) setUseMeasured(false);
  };

  // ---- 界面统计 ----
  const clusterCounts = useMemo(
    () => groupsGraphemes.map((g) => g.graphemes.length),
    [groupsGraphemes],
  );
  const totalClusters = clusterCounts.reduce((a, b) => a + b, 0);
  const activeText = activeScenario.text;
  const activeCodepointCount = useMemo(() => [...activeText].length, [activeText]);

  const singleClusters: ScenarioClusterAudit[] = useMemo(
    () => flatClusters.filter((c) => c.scenarioId === activeScenarioId),
    [flatClusters, activeScenarioId],
  );
  // 单场景模式下求解仅含活动场景：共享链即该场景回退链，未入选字体按全局解呈现
  const singleChain: ChainEntry[] = useMemo(
    () =>
      chain.map((e) => ({
        fontIndex: e.fontIndex,
        name: e.name,
        preference: e.preference,
        assignedClusters: e.assignedClusters,
        locked: e.locked,
      })),
    [chain],
  );

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>Unicode 字体回退链审计台</h1>
          <p className="subtitle">
            按字素簇审计字体覆盖 · 在「顺序偏好」与「最短链」之间求解可行回退链 · 导出 CSS / JSON
          </p>
        </div>
        <span className="badge-soft">
          {mode === 'set' ? '场景集模式 · ' : ''}无需登录 · 全部本地计算 · 字体文件不上传
        </span>
      </header>

      <main className="layout">
        <section className="panel">
          <h2>
            <span className="step">1</span> 待渲染文本{mode === 'set' ? ' · 场景集' : ''}
          </h2>
          <ScenarioEditor
            mode={mode}
            scenarios={scenarios}
            activeId={activeScenarioId}
            clusterCounts={clusterCounts}
            totalClusters={totalClusters}
            activeCodepoints={activeCodepointCount}
            activeUtf16={activeText.length}
            onModeChange={switchMode}
            onSelect={setActiveId}
            onAdd={addScenario}
            onRename={renameScenario}
            onTextChange={(t) => patchActive({ text: t })}
            onDelete={deleteScenario}
            onLoadSample={loadSample}
            onClear={clearActive}
          />

          <h2>
            <span className="step">2</span> 字体与 Unicode 覆盖范围
          </h2>
          <p className="muted small">
            列表顺序即回退偏好（↑ 更优先）。范围语法：<code>U+0020-007E</code>、<code>U+4E00</code>、
            <code>U+4??</code>，逗号或空白分隔。可上传本地 TTF/OTF，浏览器端解析 cmap（format 4/12）
            得到实测覆盖，文件仅在本机内存中解析。每个字体可设入链约束：
            <strong>普通 / 必须入链 / 禁止入链</strong>，约束随字体保留，调整顺序或切换声明/实测覆盖不影响。
            {mode === 'set' && ' 字体与顺序由全部场景共享。'}
          </p>
          <FontEditor
            fonts={fonts}
            parsed={parsed}
            parsingIds={parsingIds}
            useMeasured={useMeasured}
            hasUploaded={hasUploaded}
            onUpdate={updateFont}
            onMove={moveFont}
            onRemove={removeFont}
            onAdd={addFont}
            onToggleMeasured={setUseMeasured}
            onUploadFile={uploadFontFile}
            onClearFile={clearFontFile}
          />

          <FontUpgradePanel
            fonts={fonts}
            groups={solveGroups}
            scenarios={patchScenarios}
            mode={mode}
            ignoreFormatCodepoints={ignoreFormat}
            maxFileBytes={MAX_FONT_BYTES}
          />

          <h2>
            <span className="step">3</span> 求解偏好
          </h2>
          <div className="slider-row">
            <span className="slider-label">顺序优先</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(lengthPriority * 100)}
              onChange={(e) => setLengthPriority(Number(e.target.value) / 100)}
            />
            <span className="slider-label">链长优先</span>
            <span className="slider-value mono">{Math.round(lengthPriority * 100)}%</span>
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={ignoreFormat}
              onChange={(e) => setIgnoreFormat(e.target.checked)}
            />
            忽略透明格式字符（ZWJ、变体选择符等，随簇内其它字符渲染）
          </label>
        </section>

        <section className="panel results-panel">
          {mode === 'single' ? (
            <ResultsPanel
              clusters={singleClusters}
              validFonts={validFonts}
              chain={singleChain}
              unselected={unselected}
              feasible={solution.feasible}
              exact={solution.exact}
              objective={solution.objective}
              nodesExplored={solution.nodesExplored}
              auditInput={auditInput}
              hasText={activeText.length > 0}
              useMeasured={useMeasured}
              resilience={resilience}
              patchScenarios={patchScenarios}
              preference={validEntries.map((e) => e.order)}
              ignoreFormat={ignoreFormat}
            />
          ) : (
            <SetResultsPanel
              scenarios={scenarioViews}
              activeScenarioId={activeScenarioId}
              onSelectScenario={setActiveId}
              allClusters={flatClusters}
              validFonts={validFonts}
              chain={chain}
              unselected={unselected}
              feasible={solution.feasible}
              exact={solution.exact}
              objective={solution.objective}
              nodesExplored={solution.nodesExplored}
              auditInput={auditInput}
              useMeasured={useMeasured}
              resilience={resilience}
              resultScenarios={scenarioViews.map((v) => ({
                id: v.id,
                name: v.name,
                clusters: v.clusters,
                chainCounts: v.chainCounts,
              }))}
              patchScenarios={patchScenarios}
              preference={validEntries.map((e) => e.order)}
              ignoreFormat={ignoreFormat}
            />
          )}
        </section>
      </main>

      <footer className="app-footer">
        字素簇切分基于 Intl.Segmenter · 求解器：入链约束（锁定/排除）+ 唯一候选强制 + 支配约简 +
        分支定界（预算内精确，超时退回贪心/局部搜索）
        {mode === 'set' && ' · 场景集：全部场景簇合并参与一次求解，共享链全局唯一'}
        · 上传字体仅在浏览器内解析 cmap，不发送服务端、不持久化
      </footer>
    </div>
  );
}
