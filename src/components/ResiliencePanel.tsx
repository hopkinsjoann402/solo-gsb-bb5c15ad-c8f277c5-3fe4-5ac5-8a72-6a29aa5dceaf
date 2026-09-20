import type { ParsedFont } from '../types';
import type { AuditInput, ChainEntry } from '../lib/audit';
import { buildResilienceReport, downloadText } from '../lib/audit';
import type { FailureScenario } from '../lib/resilience';
import { displayCluster, formatCodepoint } from '../lib/grapheme';

interface ResiliencePanelProps {
  /** 失效场景（已按新增缺失数降序排序） */
  scenarios: FailureScenario[];
  validFonts: ParsedFont[];
  /** 基线（失效前）回退链 */
  chain: ChainEntry[];
  graphemeCount: number;
  coveredCount: number;
  missingCount: number;
  auditInput: AuditInput;
  generatedAt: string;
  /** 场景集模式：簇场景 id -> 场景名，用于在变化明细中标注场景 */
  scenarioNames?: Map<string, string>;
}

const CHIP_LIMIT = 16;
const ROW_LIMIT = 12;

/** 单字体失效韧性分析：逐一模拟链中字体不可用并重解，按新增缺失数排序风险卡片 */
export default function ResiliencePanel(props: ResiliencePanelProps) {
  const {
    scenarios,
    validFonts,
    chain,
    graphemeCount,
    coveredCount,
    missingCount,
    auditInput,
    generatedAt,
    scenarioNames,
  } = props;

  const fontName = (i: number) => validFonts[i].name || '(未命名)';
  const scenName = (id?: string) => (id ? scenarioNames?.get(id) ?? null : null);

  const download = () => {
    const report = buildResilienceReport(
      auditInput,
      { chain, graphemeCount, coveredCount, missingCount },
      scenarios,
      validFonts,
      generatedAt,
      scenarioNames,
    );
    downloadText('font-fallback-resilience.json', JSON.stringify(report, null, 2));
  };

  const risky = scenarios.filter((s) => s.newMissing.length > 0);
  const worst = risky[0];

  const deltaText = (d: number) => (d > 0 ? `+${d}` : d === 0 ? '持平' : `${d}`);

  return (
    <>
      <div className="resilience-head">
        <h3>单字体失效韧性分析</h3>
        <button className="btn small primary" onClick={download}>
          下载韧性分析 JSON
        </button>
      </div>
      <p className="muted small">
        逐一模拟链中每种字体不可用，保持原始偏好顺序与当前
        {auditInput.useMeasuredCoverage ? '实测' : '声明'}
        覆盖模式重新求解；卡片按新增缺失数降序排列。
      </p>

      {risky.length === 0 ? (
        <div className="alert ok">
          ✓ 链中任意单一字体失效，剩余字体均可承接全部可覆盖簇（无新增缺失）。
        </div>
      ) : (
        <div className="alert bad">
          <strong>⚠ {risky.length} 种字体失效会产生新增缺失</strong>
          <span className="alert-detail">
            最严重：「{fontName(worst.fontIndex)}」失效将新增 {worst.newMissing.length} 个缺失簇
            —— 建议为其覆盖码位补充冗余字体。
          </span>
        </div>
      )}

      <div className="risk-grid">
        {scenarios.map((s) => (
          <div key={s.fontIndex} className={`risk-card${s.newMissing.length ? ' bad' : ' ok'}`}>
            <div className="risk-head">
              <span className="risk-name" title={fontName(s.fontIndex)}>
                {fontName(s.fontIndex)}
              </span>
              <span className={`badge ${s.newMissing.length ? 'bad' : 'ok'}`}>
                {s.newMissing.length ? `⚠ 新增缺失 ${s.newMissing.length}` : '✓ 无新增缺失'}
              </span>
            </div>
            <div className="muted small">
              偏好 #{s.preference + 1} · 原承接 {s.assignedBefore} 簇 · 改接 {s.reassigned.length} 簇
            </div>
            <div className="muted small">
              链长 {chain.length} → {s.chain.length}（{deltaText(s.chainLengthDelta)}）
              · {s.exact ? '精确' : '启发式'}重解
            </div>
            <div className="risk-chain">
              <span className="muted">替代链：</span>
              {s.chain.length === 0 ? (
                <span className="muted">（无可用字体）</span>
              ) : (
                s.chain.map((f, i) => (
                  <span key={f} className="risk-chain-item">
                    {i > 0 && <span className="risk-chain-arrow">→</span>}
                    <span className="risk-chain-font" title={`承接 ${s.chainAssigned[i]} 簇`}>
                      {fontName(f)}
                    </span>
                  </span>
                ))
              )}
            </div>

            {(s.newMissing.length > 0 || s.reassigned.length > 0) && (
              <details className="risk-details">
                <summary>
                  变化明细（新增缺失 {s.newMissing.length} · 改接 {s.reassigned.length}）
                </summary>
                {s.newMissing.length > 0 && (
                  <div className="risk-section">
                    <div className="risk-section-title">新增缺失簇（无字体可承接）</div>
                    <div className="risk-chips">
                      {s.newMissing.slice(0, CHIP_LIMIT).map((c) => (
                        <span
                          key={`${c.scenarioId ?? ''}:${c.index}`}
                          className="missing-chip"
                          title={
                            (scenName(c.scenarioId)
                              ? `「${scenName(c.scenarioId)}」#${(c.localIndex ?? 0) + 1} · `
                              : '') + c.missingCodepoints.map(formatCodepoint).join(' ')
                          }
                        >
                          {displayCluster(c.text)}
                        </span>
                      ))}
                      {s.newMissing.length > CHIP_LIMIT && (
                        <span className="muted small">等 {s.newMissing.length} 个</span>
                      )}
                    </div>
                  </div>
                )}
                {s.reassigned.length > 0 && (
                  <div className="risk-section">
                    <div className="risk-section-title">改由其他字体承接</div>
                    <ul className="risk-reassign-list">
                      {s.reassigned.slice(0, ROW_LIMIT).map((c) => (
                        <li key={`${c.scenarioId ?? ''}:${c.index}`}>
                          {scenName(c.scenarioId) && (
                            <span className="risk-scenario-tag" title={`场景「${scenName(c.scenarioId)}」内 #${(c.localIndex ?? 0) + 1}`}>
                              {scenName(c.scenarioId)}
                            </span>
                          )}
                          <span className="glyph-inline" title={c.codepoints.map(formatCodepoint).join(' ')}>
                            {displayCluster(c.text)}
                          </span>
                          <span className="muted mono">#{c.index + 1}</span>
                          <span className="risk-from">{fontName(c.fromFont)}</span>
                          <span className="risk-chain-arrow">→</span>
                          <span className="risk-to">{fontName(c.toFont)}</span>
                        </li>
                      ))}
                      {s.reassigned.length > ROW_LIMIT && (
                        <li className="muted small">… 等 {s.reassigned.length} 条</li>
                      )}
                    </ul>
                  </div>
                )}
              </details>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
