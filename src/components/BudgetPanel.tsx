import { useMemo, useState } from 'react';
import type { ClusterAudit, ParsedFont, ScenarioClusterAudit } from '../types';
import { downloadText } from '../lib/audit';
import { displayCluster, formatCodepoint } from '../lib/grapheme';
import {
  buildBudgetPlanReport,
  planGlyphBudget,
  type BudgetPlan,
  type PatchScenarioInfo,
} from '../lib/patching';

interface BudgetPanelProps {
  /** 当前参与求解的全部簇（单场景模式仅活动场景；单场景簇无场景归属字段） */
  clusters: ClusterAudit[];
  /** 当前有效字体（下标与簇 candidates 对齐） */
  validFonts: ParsedFont[];
  /** 每种有效字体的原始偏好位次 */
  preference: number[];
  /** 参与求解的场景（单场景模式仅一项），按清单顺序 */
  scenarios: PatchScenarioInfo[];
  mode: 'single' | 'set';
  ignoreFormatCodepoints: boolean;
  useMeasuredCoverage: boolean;
}

const DEFAULT_BUDGET = 50;
const CP_CHIP_LIMIT = 24;
const MISSING_CHIP_LIMIT = 12;

/** 把升序码位折叠为连续区间文本，如 U+0041-005A */
function compactRanges(codepoints: number[]): string[] {
  if (codepoints.length === 0) return [];
  const runs: [number, number][] = [];
  let s = codepoints[0];
  let e = s;
  for (let i = 1; i < codepoints.length; i++) {
    if (codepoints[i] === e + 1) {
      e = codepoints[i];
    } else {
      runs.push([s, e]);
      s = codepoints[i];
      e = s;
    }
  }
  runs.push([s, e]);
  return runs.map(([a, b]) =>
    a === b ? formatCodepoint(a) : `${formatCodepoint(a)}–${formatCodepoint(b)}`,
  );
}

const stopReasonText = (reason: BudgetPlan['stopReason']): string => {
  switch (reason) {
    case 'all-recovered':
      return '预算内已恢复全部缺失簇';
    case 'budget-exhausted':
      return '预算已用完';
    case 'unaffordable':
      return '剩余预算不足以恢复任何一簇';
  }
};

/**
 * 补字预算规划面板：
 * 给定最多可新增的（字体, 码位）对数，贪心规划应向哪些有效字体补哪些码位，
 * 并逐场景给出预计恢复/仍缺失簇数与按字体归组的补码清单。
 * 结果为预演，不修改原求解结果与字体范围。
 */
export default function BudgetPanel(props: BudgetPanelProps) {
  const {
    clusters,
    validFonts,
    preference,
    scenarios,
    mode,
    ignoreFormatCodepoints,
    useMeasuredCoverage,
  } = props;

  const [budgetText, setBudgetText] = useState(String(DEFAULT_BUDGET));
  const parsedBudget = Number.parseInt(budgetText, 10);
  const budget = Number.isFinite(parsedBudget) && parsedBudget > 0 ? Math.floor(parsedBudget) : 0;

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

  // 被「禁止入链」排除的字体不作为补字对象（补了也不会进入回退链）
  const eligible = useMemo(() => {
    const fonts: ParsedFont[] = [];
    const pref: number[] = [];
    validFonts.forEach((f, i) => {
      if (f.constraint !== 'excluded') {
        fonts.push(f);
        pref.push(preference[i] ?? i);
      }
    });
    return { fonts, pref };
  }, [validFonts, preference]);

  const plan = useMemo(
    () =>
      planGlyphBudget({
        clusters: planClusters,
        fonts: eligible.fonts,
        preference: eligible.pref,
        scenarios,
        budget,
      }),
    [planClusters, eligible, scenarios, budget],
  );

  const generatedAt = useMemo(() => new Date().toISOString(), [plan]);

  const download = () => {
    const report = buildBudgetPlanReport(plan, {
      generatedAt,
      mode,
      ignoreFormatCodepoints,
      useMeasuredCoverage,
    });
    downloadText(
      'font-fallback-budget-plan.json',
      JSON.stringify(report, null, 2),
    );
  };

  const budgetInvalid = !budgetText.trim() || !Number.isFinite(parsedBudget) || parsedBudget < 0;

  return (
    <>
      <div className="resilience-head">
        <h3>补字预算规划</h3>
        <button
          className="btn small primary"
          onClick={download}
          disabled={plan.initiallyMissing === 0}
          title="下载本轮补字方案 JSON"
        >
          下载方案 JSON
        </button>
      </div>
      <p className="muted small">
        仅针对当前缺失（非自由）字素簇预演补字：簇内全部必需码位须由<strong>同一有效字体</strong>
        的已有覆盖或补丁覆盖才算恢复；同一（字体, 码位）对跨簇复用只计一次，不同字体分别计费。
        每轮枚举「缺失簇 × 有效字体」的最小补丁，按
        <strong> 新增恢复簇数 / 新增对数 </strong>
        贪心选择，平局依次取较少新增对数、较前字体、较前场景/簇；每轮后重新计算恢复数。
        被「禁止入链」排除的字体不作为补字对象。
        {useMeasuredCoverage ? '当前按实测覆盖计算。' : '当前按声明覆盖计算。'}
        本面板不修改原求解结果与字体范围。
      </p>

      <div className="budget-input-row">
        <label className="budget-input-label" htmlFor="glyph-budget-input">
          新增（字体, 码位）对预算上限
        </label>
        <input
          id="glyph-budget-input"
          className="budget-input mono"
          type="number"
          min={0}
          step={1}
          value={budgetText}
          onChange={(e) => setBudgetText(e.target.value)}
        />
        <span className="muted small">
          已规划 <strong className="mono">{plan.pairsUsed}</strong> 对 · 剩余{' '}
          <strong className="mono">{Math.max(0, budget - plan.pairsUsed)}</strong> 对
        </span>
        {budgetInvalid && <span className="budget-error small">请输入不小于 0 的整数</span>}
      </div>

      {validFonts.length === 0 ? (
        <div className="alert mode">
          <strong>暂无有效字体</strong>
          <span className="alert-detail">
            请先在左侧添加至少一种范围有效的字体，补字方案才有承接对象。
          </span>
        </div>
      ) : eligible.fonts.length === 0 ? (
        <div className="alert mode">
          <strong>全部有效字体均被「禁止入链」排除</strong>
          <span className="alert-detail">
            补字规划需要至少一种可入链的字体作为补丁承接对象；请先将某个字体改回「普通」或「必须入链」。
          </span>
        </div>
      ) : plan.initiallyMissing === 0 ? (
        <div className="alert ok">
          <strong>✓ 当前参与求解的场景没有缺失簇</strong>
          <span className="alert-detail">全部字素簇均可由现有字体覆盖，无需新增补字。</span>
        </div>
      ) : (
        <>
          <div className="cmp-stat-grid budget-stat-grid">
            <div className="cmp-stat">
              <div className="cmp-stat-value bad">{plan.initiallyMissing}</div>
              <div className="cmp-stat-label">规划前缺失簇</div>
            </div>
            <div className="cmp-stat ok">
              <div className="cmp-stat-value">{plan.recoveredCount}</div>
              <div className="cmp-stat-label">预计恢复簇</div>
            </div>
            <div className={`cmp-stat${plan.stillMissingCount ? ' bad' : ''}`}>
              <div className="cmp-stat-value">{plan.stillMissingCount}</div>
              <div className="cmp-stat-label">仍缺失簇</div>
            </div>
            <div className="cmp-stat">
              <div className="cmp-stat-value">{plan.pairsUsed}</div>
              <div className="cmp-stat-label">新增对数</div>
            </div>
            <div className="cmp-stat">
              <div className="cmp-stat-value">
                {plan.minPairsToCoverAll === null ? '—' : plan.minPairsToCoverAll}
              </div>
              <div className="cmp-stat-label">全恢复所需最少对</div>
            </div>
            <div className="cmp-stat">
              <div className="cmp-stat-value">{plan.steps.length}</div>
              <div className="cmp-stat-label">贪心轮次</div>
            </div>
          </div>

          {plan.stillMissingCount === 0 ? (
            <div className="alert ok">
              <strong>✓ {stopReasonText(plan.stopReason)}</strong>
              <span className="alert-detail">
                共向 {plan.fontPatches.length} 种字体新增 {plan.pairsUsed} 个（字体, 码位）对，
                恢复全部 {plan.initiallyMissing} 个缺失簇。
              </span>
            </div>
          ) : (
            <div className="alert bad">
              <strong>⚠ 预算后仍有 {plan.stillMissingCount} 个缺失簇（{stopReasonText(plan.stopReason)}）</strong>
              <span className="alert-detail">
                {plan.minPairsToCoverAll === null
                  ? '存在任何字体都无法补齐的码位。'
                  : plan.minPairsToCoverAll > budget
                    ? `恢复全部缺失簇至少需要 ${plan.minPairsToCoverAll} 对（当前预算 ${budget} 对）。`
                    : '可尝试调整预算后重算。'}
              </span>
            </div>
          )}

          {/* 逐场景预计恢复 / 仍缺失 */}
          <div className="budget-table-wrap">
            <table className="cluster-table budget-table">
              <thead>
                <tr>
                  <th>场景</th>
                  <th className="num">簇总数</th>
                  <th className="num">原已覆盖</th>
                  <th className="num">原缺失</th>
                  <th className="num">预计恢复</th>
                  <th className="num">仍缺失</th>
                </tr>
              </thead>
              <tbody>
                {plan.scenarioStats.map((s) => (
                  <tr key={s.scenarioId}>
                    <td>{s.scenarioName || '(未命名)'}</td>
                    <td className="num mono">{s.totalClusters}</td>
                    <td className="num mono">{s.alreadyCovered}</td>
                    <td className="num mono">{s.initiallyMissing}</td>
                    <td className="num mono text-ok">{s.recovered}</td>
                    <td className={`num mono${s.stillMissing ? ' text-bad' : ''}`}>
                      {s.stillMissing}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 按字体归组的补码清单 */}
          {plan.fontPatches.length > 0 && (
            <div className="budget-font-list">
              <div className="budget-section-title">按字体归组的补码清单</div>
              {plan.fontPatches.map((g) => {
                const ranges = compactRanges(g.codepoints);
                const shown = g.codepoints.slice(0, CP_CHIP_LIMIT);
                return (
                  <div key={g.fontIndex} className="budget-font-card">
                    <div className="risk-head">
                      <span className="risk-name" title={g.fontName}>
                        {g.fontName}
                        <span className="muted small"> · 偏好 #{g.preference + 1}</span>
                      </span>
                      <span className="badge muted-badge">
                        +{g.pairCount} 对 · 恢复 {g.recoveredClusters} 簇 · 第 {g.firstRound}
                        {g.lastRound !== g.firstRound ? `–${g.lastRound}` : ''} 轮
                      </span>
                    </div>
                    <div className="budget-cp-chips">
                      {shown.map((cp) => (
                        <span key={cp} className="budget-cp-chip mono">
                          {formatCodepoint(cp)}
                        </span>
                      ))}
                      {g.codepoints.length > CP_CHIP_LIMIT && (
                        <span className="muted small">
                          等 {g.codepoints.length} 个码位
                        </span>
                      )}
                    </div>
                    <details className="risk-details">
                      <summary>
                        紧凑区间（{ranges.length} 段）与全部 {g.codepoints.length} 个码位
                      </summary>
                      <div className="diff-ranges">{ranges.join(', ')}</div>
                      <div className="diff-ranges">
                        {g.codepoints.map(formatCodepoint).join(' ')}
                      </div>
                    </details>
                  </div>
                );
              })}
            </div>
          )}

          {/* 逐轮选择明细 */}
          {plan.steps.length > 0 && (
            <details className="risk-details budget-rounds">
              <summary>逐轮贪心选择明细（{plan.steps.length} 轮）</summary>
              <div className="budget-table-wrap">
                <table className="cluster-table budget-table">
                  <thead>
                    <tr>
                      <th className="num">轮</th>
                      <th>字体</th>
                      <th className="num">新增对</th>
                      <th className="num">新增恢复簇</th>
                      <th className="num">恢复/对</th>
                      <th className="num">累计对</th>
                      <th>新增码位</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.steps.map((st) => (
                      <tr key={st.round}>
                        <td className="num mono">{st.round}</td>
                        <td>{st.fontName || '(未命名)'}</td>
                        <td className="num mono">{st.addedPairs}</td>
                        <td className="num mono text-ok">{st.recoveredClusters}</td>
                        <td className="num mono">{st.ratio.toFixed(2)}</td>
                        <td className="num mono">{st.pairsUsed}</td>
                        <td className="budget-step-cps">
                          {st.addedCodepoints.slice(0, 10).map(formatCodepoint).join(' ')}
                          {st.addedCodepoints.length > 10 &&
                            ` … +${st.addedCodepoints.length - 10}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}

          {/* 仍缺失簇 */}
          {plan.stillMissingClusters.length > 0 && (
            <div className="budget-section">
              <div className="budget-section-title">
                预算后仍缺失的簇（{plan.stillMissingClusters.length}）
              </div>
              <div className="risk-chips">
                {plan.stillMissingClusters.slice(0, MISSING_CHIP_LIMIT).map((c) => (
                  <span
                    key={`${c.scenarioId}:${c.localIndex}`}
                    className="missing-chip"
                    title={
                      (mode === 'set' ? `「${c.scenarioName}」#${c.localIndex + 1} · ` : '') +
                      (c.uncoveredCodepoints.length
                        ? `无字体可补：${c.uncoveredCodepoints.map(formatCodepoint).join(' ')}`
                        : c.codepoints.map(formatCodepoint).join(' '))
                    }
                  >
                    {displayCluster(c.text)}
                  </span>
                ))}
                {plan.stillMissingClusters.length > MISSING_CHIP_LIMIT && (
                  <span className="muted small">
                    等 {plan.stillMissingClusters.length} 个，完整清单见下载 JSON
                  </span>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
