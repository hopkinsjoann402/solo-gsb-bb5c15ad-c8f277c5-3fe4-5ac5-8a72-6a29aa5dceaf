import { useMemo, useState } from 'react';
import type { ClusterAudit, ParsedFont, ScenarioClusterAudit } from '../types';
import type { ChainEntry } from '../lib/audit';
import { copyToClipboard, downloadText } from '../lib/audit';
import type { PatchScenarioInfo } from '../lib/patching';
import {
  buildWebfontSliceReport,
  planWebfontSlices,
} from '../lib/webfont';

interface WebfontPanelProps {
  /** 当前参与求解的全部簇（单场景模式仅活动场景；单场景簇无场景归属字段） */
  clusters: ClusterAudit[];
  /** 当前回退链（单场景链或场景集共享链） */
  chain: ChainEntry[];
  /** 当前有效字体（下标与簇 assigned / chain.fontIndex 对齐） */
  validFonts: ParsedFont[];
  /** 参与求解的场景（单场景模式仅一项），按清单顺序 */
  scenarios: PatchScenarioInfo[];
  mode: 'single' | 'set';
  ignoreFormatCodepoints: boolean;
  useMeasuredCoverage: boolean;
}

const DEFAULT_MAX_PER_SLICE = 256;

/**
 * Webfont 分片面板：
 * 按当前场景实际承接的码位，为回退链中每种字体生成 @font-face unicode-range 分片。
 * 同一字素簇的必需码位不拆片，共享码位的连通组整体装箱（确定性最佳适配），
 * 超限连通组独立成片并标记；跨场景重复码位只计一次。
 */
export default function WebfontPanel(props: WebfontPanelProps) {
  const {
    clusters,
    chain,
    validFonts,
    scenarios,
    mode,
    ignoreFormatCodepoints,
    useMeasuredCoverage,
  } = props;

  const [maxText, setMaxText] = useState(String(DEFAULT_MAX_PER_SLICE));
  const [copiedFont, setCopiedFont] = useState<number | null>(null);

  const parsedMax = Number.parseInt(maxText, 10);
  const maxInvalid = !maxText.trim() || !Number.isFinite(parsedMax) || parsedMax < 1;
  // 无效输入按 1 收敛计算（每连通组独立成片），同时在输入行提示
  const maxPerSlice = maxInvalid ? 1 : Math.floor(parsedMax);

  // 单场景模式的簇不带场景归属字段，补齐为唯一场景的 id 与场景内序号
  const planClusters: ScenarioClusterAudit[] = useMemo(() => {
    if (clusters.length === 0) return [];
    const asScenario = clusters as ScenarioClusterAudit[];
    if (asScenario[0].scenarioId !== undefined) return asScenario;
    const only = scenarios[0];
    return clusters.map((c, i) => ({
      ...c,
      scenarioId: only?.id ?? '',
      localIndex: i,
    }));
  }, [clusters, scenarios]);

  // 文本 / 字体覆盖 / 入链约束（经 chain 与 clusters 体现）/ 上限变化时同步重算
  const plan = useMemo(
    () =>
      planWebfontSlices({
        clusters: planClusters,
        chain,
        validFonts,
        scenarios,
        maxPerSlice,
      }),
    [planClusters, chain, validFonts, scenarios, maxPerSlice],
  );

  const generatedAt = useMemo(() => new Date().toISOString(), [plan]);

  const scenarioName = (id: string) => scenarios.find((s) => s.id === id)?.name ?? '';

  const download = () => {
    const report = buildWebfontSliceReport(plan, {
      generatedAt,
      mode,
      ignoreFormatCodepoints,
      useMeasuredCoverage,
      scenarios,
    });
    downloadText('font-fallback-webfont-slices.json', JSON.stringify(report, null, 2));
  };

  const copyFontCss = async (fontIndex: number, css: string) => {
    const ok = await copyToClipboard(css);
    if (ok) {
      setCopiedFont(fontIndex);
      window.setTimeout(
        () => setCopiedFont((cur) => (cur === fontIndex ? null : cur)),
        1500,
      );
    }
  };

  const slicedFonts = plan.fonts.filter((f) => f.slices.length > 0).length;

  return (
    <>
      <div className="resilience-head">
        <h3>Webfont 分片</h3>
        <button
          className="btn small primary"
          onClick={download}
          disabled={plan.sliceCount === 0}
          title="下载完整分片 JSON（含每片码位、命中场景与 CSS）"
        >
          下载分片 JSON
        </button>
      </div>
      <p className="muted small">
        按当前场景<strong>实际承接</strong>的码位，为回退链中每种字体生成
        <code>@font-face</code> + <code>unicode-range</code> 分片：同一字素簇的必需码位不拆片，
        共享码位形成的连通组整体参与<strong>确定性最佳适配装箱</strong>；单个连通组超过上限时
        独立成片并标记。跨场景重复码位只计一次，缺失簇无承接字体、不参与分片。
        {useMeasuredCoverage ? '当前按实测覆盖计算。' : '当前按声明覆盖计算。'}
        输入不变时分片结果保持稳定；本面板不修改原求解结果与字体范围。
      </p>

      <div className="budget-input-row">
        <label className="budget-input-label" htmlFor="webfont-slice-max-input">
          每片最大码位数
        </label>
        <input
          id="webfont-slice-max-input"
          className="budget-input mono"
          type="number"
          min={1}
          step={1}
          value={maxText}
          onChange={(e) => setMaxText(e.target.value)}
        />
        <span className="muted small">
          共 <strong className="mono">{plan.sliceCount}</strong> 片
          {plan.oversizedSliceCount > 0 && (
            <>
              {' '}· 超限独立片 <strong className="mono">{plan.oversizedSliceCount}</strong>
            </>
          )}
        </span>
        {maxInvalid && (
          <span className="budget-error small">请输入不小于 1 的整数（当前按 1 计算）</span>
        )}
      </div>

      {chain.length === 0 ? (
        <div className="alert mode">
          <strong>暂无回退链</strong>
          <span className="alert-detail">
            请先在左侧添加至少一种范围有效的字体并求解出回退链，分片才有承接对象。
          </span>
        </div>
      ) : plan.uniqueCodepoints === 0 ? (
        <div className="alert mode">
          <strong>回退链未承接任何码位</strong>
          <span className="alert-detail">
            当前参与求解的场景没有由链中字体承接的非自由字素簇（文本为空或全部缺失），暂无可分片内容。
          </span>
        </div>
      ) : (
        <>
          <div className="cmp-stat-grid budget-stat-grid">
            <div className="cmp-stat">
              <div className="cmp-stat-value">{plan.fonts.length}</div>
              <div className="cmp-stat-label">链中字体</div>
            </div>
            <div className="cmp-stat">
              <div className="cmp-stat-value">{slicedFonts}</div>
              <div className="cmp-stat-label">分片字体</div>
            </div>
            <div className="cmp-stat">
              <div className="cmp-stat-value">{plan.sliceCount}</div>
              <div className="cmp-stat-label">分片总数</div>
            </div>
            <div className={`cmp-stat${plan.oversizedSliceCount ? ' bad' : ''}`}>
              <div className="cmp-stat-value">{plan.oversizedSliceCount}</div>
              <div className="cmp-stat-label">超限独立片</div>
            </div>
            <div className="cmp-stat">
              <div className="cmp-stat-value">{plan.uniqueCodepoints}</div>
              <div className="cmp-stat-label">承接码位（去重合计）</div>
            </div>
          </div>

          {plan.oversizedSliceCount > 0 && (
            <div className="alert warn">
              <strong>
                ⚠ {plan.oversizedSliceCount} 个分片因单连通组超过每片上限（{plan.maxPerSlice} 码位）独立成片
              </strong>
              <span className="alert-detail">
                同一字素簇的必需码位不得拆片，超限连通组只能整体独立成片；如需消除超限，
                请调大每片最大码位数。
              </span>
            </div>
          )}

          <div className="budget-font-list">
            {plan.fonts.map((f) => (
              <div key={f.fontIndex} className="budget-font-card webfont-font-card">
                <div className="risk-head">
                  <span className="risk-name webfont-font-name" title={f.fontName}>
                    <span className="chain-order tiny">{f.chainOrder}</span> {f.fontName || '(未命名)'}
                    <span className="muted small"> · 偏好 #{f.preference + 1}</span>
                    {f.locked && <span className="badge lock">🔒 必须入链</span>}
                  </span>
                  <span className="webfont-font-actions">
                    <span className="badge muted-badge">
                      {f.slices.length > 0
                        ? `${f.slices.length} 片 · ${f.uniqueCodepoints} 码位 · 承接 ${f.assignedClusters} 簇`
                        : '未承接码位'}
                    </span>
                    {f.slices.length > 0 && (
                      <button
                        className="btn small"
                        onClick={() =>
                          copyFontCss(
                            f.fontIndex,
                            f.slices.map((s) => s.css).join('\n\n'),
                          )
                        }
                        title="复制该字体全部片的 @font-face CSS"
                      >
                        {copiedFont === f.fontIndex ? '✓ 已复制' : '复制 CSS'}
                      </button>
                    )}
                  </span>
                </div>
                {f.slices.length === 0 ? (
                  <p className="muted small webfont-empty-note">
                    该字体在链中但未承接任何码位
                    {f.locked ? '（锁定入链）' : ''}，无需分片。
                  </p>
                ) : (
                  <div className="webfont-slice-list">
                    {f.slices.map((s) => (
                      <div
                        key={s.index}
                        className={`webfont-slice-row${s.oversized ? ' oversized' : ''}`}
                      >
                        <div className="webfont-slice-head">
                          <span className="webfont-slice-title mono">片 #{s.index}</span>
                          <span className="badge muted-badge">{s.codepointCount} 码位</span>
                          {s.oversized && (
                            <span className="badge warn">超限独立片</span>
                          )}
                          <span className="webfont-slice-scenes">
                            <span className="muted small">命中场景：</span>
                            {s.scenarioIds.map((id) => (
                              <span key={id} className="risk-scenario-tag" title={`命中场景「${scenarioName(id)}」`}>
                                {scenarioName(id) || '(未命名)'}
                              </span>
                            ))}
                          </span>
                        </div>
                        <div className="webfont-slice-range mono">
                          unicode-range: {s.unicodeRange};
                        </div>
                        <details className="risk-details webfont-slice-css">
                          <summary>@font-face CSS</summary>
                          <pre className="code-block mono">{s.css}</pre>
                        </details>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
