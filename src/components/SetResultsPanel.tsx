import { useMemo, useState } from 'react';
import type { ParsedFont, ScenarioClusterAudit } from '../types';
import type { ScenarioChainEntry } from '../lib/audit';
import {
  buildCssExport,
  buildScenarioSetReport,
  copyToClipboard,
  downloadText,
  type AuditInput,
  type ScenarioResultData,
  type ScenarioSetResultData,
} from '../lib/audit';
import { displayCluster, formatCodepoint } from '../lib/grapheme';
import type { FailureScenario } from '../lib/resilience';
import ClusterTable, { type ClusterFilter } from './ClusterTable';
import ResiliencePanel from './ResiliencePanel';
import BaselineCompare from './BaselineCompare';
import BudgetPanel from './BudgetPanel';
import WebfontPanel from './WebfontPanel';
import type { PatchScenarioInfo } from '../lib/patching';
import type { ParsedBaseline } from '../lib/baseline';

/** 场景集求解视图模型（App 按场景分组计算后传入） */
export interface ScenarioView {
  id: string;
  name: string;
  /** 该场景的全部簇（按场景内顺序） */
  clusters: ScenarioClusterAudit[];
  /** 共享链中在本场景实际承接簇的字体（按链顺序） */
  chainCounts: { fontIndex: number; preference: number; assignedClusters: number }[];
}

interface SetResultsPanelProps {
  scenarios: ScenarioView[];
  activeScenarioId: string;
  onSelectScenario: (id: string) => void;
  /** 全部场景展平后的簇（全局求解顺序） */
  allClusters: ScenarioClusterAudit[];
  validFonts: ParsedFont[];
  chain: ScenarioChainEntry[];
  unselected: { name: string; preference: number }[];
  feasible: boolean;
  exact: boolean;
  objective: number;
  nodesExplored: number;
  auditInput: AuditInput;
  useMeasured: boolean;
  resilience: FailureScenario[];
  /** 构建场景集 JSON 报告所需的求解视图模型 */
  resultScenarios: ScenarioResultData[];
  /** 参与本次求解的场景（按清单顺序），供补字预算规划逐场景统计 */
  patchScenarios: PatchScenarioInfo[];
  /** 每种有效字体的原始偏好位次（与 validFonts 对齐） */
  preference: number[];
  ignoreFormat: boolean;
}

/**
 * 场景集模式结果区：
 * 所有场景的字素簇合并参与一次回退链求解，链中字体及顺序全局唯一；
 * 顶部展示共享链（跨场景合计 + 逐场景承接数），下方按场景分别给出
 * 覆盖率、缺失簇、承接字体与逐簇明细。
 */
export default function SetResultsPanel(props: SetResultsPanelProps) {
  const {
    scenarios,
    activeScenarioId,
    onSelectScenario,
    allClusters,
    validFonts,
    chain,
    unselected,
    feasible,
    exact,
    objective,
    nodesExplored,
    auditInput,
    useMeasured,
    resilience,
    resultScenarios,
    patchScenarios,
    preference,
    ignoreFormat,
  } = props;

  const [filter, setFilter] = useState<ClusterFilter>('all');
  const [copied, setCopied] = useState<'css' | 'json' | null>(null);
  /** 已导入并校验通过的基线（非法导入不覆盖它）；跨场景切换时保留 */
  const [baseline, setBaseline] = useState<ParsedBaseline | null>(null);
  const [baselineFileName, setBaselineFileName] = useState<string | null>(null);

  const nameById = useMemo(
    () => new Map(scenarios.map((s) => [s.id, s.name])),
    [scenarios],
  );
  const scenarioLabel = (c: ScenarioClusterAudit) => nameById.get(c.scenarioId) ?? null;

  const generatedAt = useMemo(() => new Date().toISOString(), [allClusters, chain]);

  const missing = allClusters.filter((c) => c.status === 'missing');
  const naturalMissing = missing.filter((c) => c.missingKind !== 'constraint');
  const constraintMissing = missing.filter((c) => c.missingKind === 'constraint');
  const coveredCount = allClusters.length - missing.length;
  const nonEmpty = scenarios.filter((s) => s.clusters.length > 0).length;
  const emptyCount = scenarios.length - nonEmpty;

  // 入链约束清单（仅有效字体参与求解；约束随字体 id 保留）
  const constraintSummary = useMemo(
    () => ({
      locked: validFonts
        .filter((f) => f.constraint === 'locked')
        .map((f) => f.name || '(未命名)'),
      excluded: validFonts
        .filter((f) => f.constraint === 'excluded')
        .map((f) => f.name || '(未命名)'),
    }),
    [validFonts],
  );
  const constraintsActive =
    constraintSummary.locked.length > 0 || constraintSummary.excluded.length > 0;

  const active =
    scenarios.find((s) => s.id === activeScenarioId) ?? scenarios[0];
  const activeMissing = active
    ? active.clusters.filter((c) => c.status === 'missing')
    : [];
  const activeNaturalMissing = activeMissing.filter((c) => c.missingKind !== 'constraint');
  const activeConstraintMissing = activeMissing.filter((c) => c.missingKind === 'constraint');

  const resolveFontName = (i: number | null): string | null =>
    i === null || i >= validFonts.length ? null : validFonts[i].name;

  const cssText = useMemo(
    () => buildCssExport(chain, generatedAt, constraintSummary),
    [chain, generatedAt, constraintSummary],
  );
  const jsonText = useMemo(() => {
    const result: ScenarioSetResultData = {
      feasible,
      exact,
      objective,
      nodesExplored,
      chain,
      unselected,
      scenarios: resultScenarios,
      clusters: allClusters,
      validFonts,
    };
    return JSON.stringify(buildScenarioSetReport(auditInput, result, generatedAt), null, 2);
  }, [
    auditInput,
    feasible,
    exact,
    objective,
    nodesExplored,
    chain,
    unselected,
    resultScenarios,
    allClusters,
    validFonts,
    generatedAt,
  ]);

  const flashCopied = async (kind: 'css' | 'json', text: string) => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(kind);
      window.setTimeout(() => setCopied((cur) => (cur === kind ? null : cur)), 1500);
    }
  };

  const coverageRate = (s: ScenarioView): number | null => {
    const n = s.clusters.length;
    if (n === 0) return null;
    const m = s.clusters.filter((c) => c.status === 'missing').length;
    return (n - m) / n;
  };
  const pct = (r: number | null) => (r === null ? '—' : `${(r * 100).toFixed(1)}%`);

  return (
    <div className="results">
      <div className="stat-grid">
        <div className="stat">
          <div className="stat-value">{scenarios.length}</div>
          <div className="stat-label">场景{emptyCount > 0 ? `（${emptyCount} 空）` : ''}</div>
        </div>
        <div className="stat">
          <div className="stat-value">{allClusters.length}</div>
          <div className="stat-label">字素簇合计</div>
        </div>
        <div className="stat ok">
          <div className="stat-value">{coveredCount}</div>
          <div className="stat-label">已覆盖</div>
        </div>
        <div className={`stat${naturalMissing.length ? ' bad' : ''}`}>
          <div className="stat-value">{naturalMissing.length}</div>
          <div className="stat-label">自然缺失</div>
        </div>
        <div className={`stat${constraintMissing.length ? ' warn' : ''}`}>
          <div className="stat-value">{constraintMissing.length}</div>
          <div className="stat-label">约束缺失</div>
        </div>
        <div className="stat">
          <div className="stat-value">{chain.length}</div>
          <div className="stat-label">共享链长度</div>
        </div>
      </div>

      {naturalMissing.length > 0 && (
        <div className="alert bad">
          <strong>⚠ 各场景合计 {naturalMissing.length} 个自然缺失字素簇（任何有效字体都不覆盖）</strong>
          <span className="alert-detail">
            {naturalMissing.slice(0, 8).map((c) => (
              <span
                key={`${c.scenarioId}:${c.localIndex}`}
                className="missing-chip"
                title={`「${scenarioLabel(c) ?? '?'}」#${c.localIndex + 1} · ${c.missingCodepoints
                  .map(formatCodepoint)
                  .join(' ')}`}
              >
                {displayCluster(c.text)}
              </span>
            ))}
            {naturalMissing.length > 8 && ` 等 ${naturalMissing.length} 个`}
            —— 请为缺失码位补充字体范围（可在下方逐场景查看缺失归属）。
          </span>
        </div>
      )}
      {constraintMissing.length > 0 && (
        <div className="alert warn">
          <strong>⚠ 各场景合计 {constraintMissing.length} 个字素簇因「禁止入链」约束缺失</strong>
          <span className="alert-detail">
            {constraintMissing.slice(0, 8).map((c) => (
              <span
                key={`${c.scenarioId}:${c.localIndex}`}
                className="missing-chip constraint"
                title={`「${scenarioLabel(c) ?? '?'}」#${c.localIndex + 1} · 解除排除即可恢复：${c.unblockFonts
                  .map((i) => validFonts[i]?.name || '(未命名)')
                  .join('、')}`}
              >
                {displayCluster(c.text)}
              </span>
            ))}
            {constraintMissing.length > 8 && ` 等 ${constraintMissing.length} 个`}
            —— 这些簇仅被已排除的字体覆盖；解除「禁止入链」或补充其他可覆盖字体即可恢复。
          </span>
        </div>
      )}
      {feasible && validFonts.length > 0 && nonEmpty > 0 && (
        <div className="alert ok">
          ✓ 可行：共享回退链可覆盖全部 {nonEmpty} 个非空场景中的 {allClusters.length} 个字素簇。
        </div>
      )}
      {nonEmpty === 0 && (
        <div className="alert mode">
          <strong>所有场景均为空</strong>
          <span className="alert-detail">空场景会保留但不参与求解；在左侧任一场景粘贴文本后即开始合并求解。</span>
        </div>
      )}

      {useMeasured && (
        <div className="alert mode">
          <strong>🧪 按实测覆盖求解已开启</strong>
          <span className="alert-detail">
            已上传字体使用其 cmap（format 4/12）实测码位参与所有场景的分析与求解；未上传字体仍用声明范围。
          </span>
        </div>
      )}

      {constraintsActive && (
        <div className="alert mode">
          <strong>🔒 入链约束已生效</strong>
          <span className="alert-detail">
            {constraintSummary.locked.length > 0 &&
              `必须入链：${constraintSummary.locked.join('、')}`}
            {constraintSummary.locked.length > 0 &&
              constraintSummary.excluded.length > 0 &&
              ' · '}
            {constraintSummary.excluded.length > 0 &&
              `禁止入链：${constraintSummary.excluded.join('、')}`}
            。约束随字体保留，调整顺序或切换声明/实测覆盖不影响；全部场景共用同一约束。
          </span>
        </div>
      )}

      <section className="block">
        <h3>共享回退链（场景集全局唯一，按偏好顺序）</h3>
        {chain.length === 0 ? (
          <p className="muted">暂无可选字体 —— 请先添加至少一种范围有效的字体。</p>
        ) : (
          <>
            <ol className="chain-list">
              {chain.map((e, i) => (
                <li key={e.fontIndex} className="chain-item">
                  <span className="chain-order">{i + 1}</span>
                  <span className="chain-name">{e.name || '(未命名)'}</span>
                  {e.locked && <span className="badge lock">🔒 必须入链</span>}
                  <span
                    className="chain-meta"
                    title={scenarios
                      .filter((s) => s.clusters.length > 0)
                      .map(
                        (s) =>
                          `${s.name}：${e.scenarioCounts[s.id] ?? 0} 簇`,
                      )
                      .join(' · ')}
                  >
                    合计承接 {e.assignedClusters} 簇 · 偏好 #{e.preference + 1}
                  </span>
                </li>
              ))}
            </ol>
            <ul className="scenario-chain-breakdown">
              {chain.map((e, i) => (
                <li key={e.fontIndex} className="scenario-chain-row">
                  <span className="scenario-chain-font">
                    <span className="chain-order tiny">{i + 1}</span>
                    {e.name || '(未命名)'}
                  </span>
                  {scenarios.map((s) => {
                    const n = e.scenarioCounts[s.id] ?? 0;
                    return (
                      <span
                        key={s.id}
                        className={`scenario-chain-cell${n > 0 ? ' hit' : ''}`}
                        title={`「${s.name}」中由该字体承接 ${n} 簇`}
                      >
                        <span className="scenario-chain-cell-name">{s.name}</span>
                        <span className="scenario-chain-cell-num mono">{n}</span>
                      </span>
                    );
                  })}
                </li>
              ))}
            </ul>
            {unselected.length > 0 && (
              <p className="muted small">
                未入选（冗余）：{unselected.map((u) => u.name || '(未命名)').join('、')}
                —— 其覆盖范围已被共享链中更优先的字体包含。
              </p>
            )}
            {constraintSummary.excluded.length > 0 && (
              <p className="muted small">
                已排除（禁止入链）：{constraintSummary.excluded.join('、')}
                —— 求解前已剔除，不计入冗余；可在左侧字体列表改回「普通」。
              </p>
            )}
            <p className="muted small">
              所有场景合并参与一次求解：每种字体在链中只出现一次；每个簇由链中第一种覆盖它的字体承接，
              跨场景重复文本分别计数。
            </p>
          </>
        )}
      </section>

      {resilience.length > 0 && (
        <section className="block">
          <ResiliencePanel
            scenarios={resilience}
            validFonts={validFonts}
            chain={chain}
            graphemeCount={allClusters.length}
            coveredCount={coveredCount}
            missingCount={missing.length}
            auditInput={auditInput}
            generatedAt={generatedAt}
            scenarioNames={new Map(scenarios.map((s) => [s.id, s.name]))}
          />
        </section>
      )}

      <section className="block">
        <BudgetPanel
          clusters={allClusters}
          validFonts={validFonts}
          preference={preference}
          scenarios={patchScenarios}
          mode="set"
          ignoreFormatCodepoints={ignoreFormat}
          useMeasuredCoverage={useMeasured}
        />
      </section>

      <section className="block">
        <WebfontPanel
          clusters={allClusters}
          chain={chain}
          validFonts={validFonts}
          scenarios={patchScenarios}
          mode="set"
          ignoreFormatCodepoints={ignoreFormat}
          useMeasuredCoverage={useMeasured}
        />
      </section>

      <section className="block">
        <h3>逐场景结果</h3>
        <div className="scenario-tabs" role="tablist">
          {scenarios.map((s) => {
            const m = s.clusters.filter((c) => c.status === 'missing').length;
            const rate = coverageRate(s);
            return (
              <button
                key={s.id}
                role="tab"
                aria-selected={s.id === active?.id}
                className={`scenario-tab${s.id === active?.id ? ' active' : ''}${
                  s.clusters.length === 0 ? ' empty' : ''
                }${m > 0 ? ' has-missing' : ''}`}
                onClick={() => onSelectScenario(s.id)}
                title={`覆盖率 ${pct(rate)} · 缺失 ${m} 簇${s.clusters.length === 0 ? ' · 空场景' : ''}`}
              >
                <span className="scenario-tab-name">{s.name || '(未命名)'}</span>
                <span className="scenario-tab-stats mono">
                  {s.clusters.length === 0
                    ? '空'
                    : `${pct(rate)} · 缺 ${m}`}
                </span>
              </button>
            );
          })}
        </div>

        {active && (
          <div className="scenario-detail">
            <div className="scenario-detail-head">
              <h4 className="scenario-detail-title">{active.name || '(未命名)'}</h4>
              {active.clusters.length === 0 ? (
                <span className="muted small">空场景：已保留，但不贡献需求模式、不影响共享链求解。</span>
              ) : (
                <span className="muted small">
                  {active.clusters.length} 簇 · 覆盖率{' '}
                  <strong className={activeMissing.length ? 'text-bad' : 'text-ok'}>
                    {pct(coverageRate(active))}
                  </strong>{' '}
                  · 缺失 {activeMissing.length} 簇
                  {activeConstraintMissing.length > 0 &&
                    `（含约束缺失 ${activeConstraintMissing.length}）`}
                </span>
              )}
            </div>

            {activeNaturalMissing.length > 0 && (
              <div className="alert bad">
                <strong>⚠ 该场景 {activeNaturalMissing.length} 个自然缺失字素簇</strong>
                <span className="alert-detail">
                  {activeNaturalMissing.slice(0, 12).map((c) => (
                    <span
                      key={c.localIndex}
                      className="missing-chip"
                      title={c.missingCodepoints.map(formatCodepoint).join(' ')}
                    >
                      {displayCluster(c.text)}
                    </span>
                  ))}
                  {activeNaturalMissing.length > 12 && ` 等 ${activeNaturalMissing.length} 个`}
                </span>
              </div>
            )}
            {activeConstraintMissing.length > 0 && (
              <div className="alert warn">
                <strong>⚠ 该场景 {activeConstraintMissing.length} 个字素簇因「禁止入链」约束缺失</strong>
                <span className="alert-detail">
                  {activeConstraintMissing.slice(0, 12).map((c) => (
                    <span
                      key={c.localIndex}
                      className="missing-chip constraint"
                      title={`解除排除即可恢复：${c.unblockFonts
                        .map((i) => validFonts[i]?.name || '(未命名)')
                        .join('、')}`}
                    >
                      {displayCluster(c.text)}
                    </span>
                  ))}
                  {activeConstraintMissing.length > 12 &&
                    ` 等 ${activeConstraintMissing.length} 个`}
                  —— 仅被已排除字体覆盖，解除「禁止入链」即可恢复。
                </span>
              </div>
            )}

            {active.chainCounts.length > 0 && (
              <div className="scenario-chain-used">
                <span className="muted small">本场景承接字体：</span>
                {active.chainCounts.map((cc, i) => (
                  <span key={cc.fontIndex} className="scenario-chain-pill">
                    <span className="risk-chain-arrow">{i > 0 ? '→' : ''}</span>
                    <span className="risk-chain-font">
                      {validFonts[cc.fontIndex]?.name || '(未命名)'}
                      <span className="scenario-chain-pill-num"> {cc.assignedClusters}</span>
                    </span>
                  </span>
                ))}
              </div>
            )}

            {active.clusters.length > 0 && (
              <>
                <BaselineCompare
                  clusters={active.clusters}
                  fontName={resolveFontName}
                  hasText={active.clusters.length > 0}
                  baseline={baseline}
                  baselineFileName={baselineFileName}
                  onBaseline={(b, name) => {
                    setBaseline(b);
                    setBaselineFileName(name);
                  }}
                  onClearBaseline={() => {
                    setBaseline(null);
                    setBaselineFileName(null);
                  }}
                  titleHint={`基线与当前场景「${active.name}」的簇序列对齐`}
                />
                <div className="scenario-table">
                  <ClusterTable
                    clusters={active.clusters}
                    validFonts={validFonts}
                    filter={filter}
                    onFilterChange={setFilter}
                    localNumbering
                  />
                </div>
              </>
            )}
          </div>
        )}
      </section>

      <section className="block">
        <h3>导出</h3>
        <div className="export-grid">
          <div className="export-card">
            <div className="export-head">
              <span>CSS font-family（共享链）</span>
              <button className="btn small" onClick={() => flashCopied('css', cssText)}>
                {copied === 'css' ? '✓ 已复制' : '复制'}
              </button>
            </div>
            <pre className="code-block mono">{cssText}</pre>
          </div>
          <div className="export-card">
            <div className="export-head">
              <span>场景集审计 JSON</span>
              <span className="export-actions">
                <button className="btn small" onClick={() => flashCopied('json', jsonText)}>
                  {copied === 'json' ? '✓ 已复制' : '复制'}
                </button>
                <button
                  className="btn small primary"
                  onClick={() => downloadText('font-fallback-audit-scenarios.json', jsonText)}
                >
                  下载 .json
                </button>
              </span>
            </div>
            <pre className="code-block mono json-preview">
              {jsonText.slice(0, 1200)}
              {jsonText.length > 1200 ? '\n…（完整内容请复制或下载）' : ''}
            </pre>
          </div>
        </div>
      </section>
    </div>
  );
}
