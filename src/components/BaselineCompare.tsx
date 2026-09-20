import { useMemo, useRef, useState } from 'react';
import type { ClusterAudit } from '../types';
import { formatCodepoint, displayCluster } from '../lib/grapheme';
import { downloadText } from '../lib/audit';
import {
  alignClusters,
  buildComparisonReport,
  isDegradationRow,
  parseBaselineJson,
  BaselineParseError,
  type AlignmentRow,
  type Comparison,
  type LiveClusterLike,
  type PairChange,
  type ParsedBaseline,
} from '../lib/baseline';

interface BaselineCompareProps {
  /** 当前实时结果 */
  clusters: ClusterAudit[];
  /** 当前有效字体（下标 → 名称解析） */
  fontName: (index: number | null) => string | null;
  hasText: boolean;
  /** 已导入的有效基线（非法导入不会覆盖它） */
  baseline: ParsedBaseline | null;
  baselineFileName: string | null;
  onBaseline: (b: ParsedBaseline, fileName: string) => void;
  onClearBaseline: () => void;
  /** 说明文字的补充上下文（场景集模式指明对齐的是哪个场景） */
  titleHint?: string;
}

const ROW_LIMIT = 300;

function toLiveClusters(
  clusters: ClusterAudit[],
  fontName: (i: number | null) => string | null,
): LiveClusterLike[] {
  return clusters.map((c) => ({
    index: c.index,
    text: c.text,
    status: c.status,
    assignedFont: fontName(c.assigned),
    codepoints: c.codepoints.map(formatCodepoint),
    requiredCodepoints: c.required.map(formatCodepoint),
    missingCodepoints: c.missingCodepoints.map(formatCodepoint),
  }));
}

const CHANGE_LABEL: Record<PairChange, string> = {
  unchanged: '无变化',
  'new-missing': '新增缺失',
  'fixed-missing': '已修复缺失',
  'font-changed': '字体改接',
  'coverage-changed': '覆盖状态变化',
};

function formatTime(iso: string | null): string {
  if (!iso) return '未知时间';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
}

/** 基线对比面板：导入审计 JSON → 保序对齐 → 分类汇总 → 筛选 / 下载 */
export default function BaselineCompare(props: BaselineCompareProps) {
  const { clusters, fontName, hasText, baseline, baselineFileName, onBaseline, onClearBaseline, titleHint } =
    props;
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyDegraded, setOnlyDegraded] = useState(false);

  const live = useMemo(() => toLiveClusters(clusters, fontName), [clusters, fontName]);

  /** 对齐结果或规模上限错误（导入校验错误走 error 状态，二者互不覆盖） */
  const aligned = useMemo((): { comparison: Comparison | null; alignError: string | null } => {
    if (!baseline) return { comparison: null, alignError: null };
    try {
      return { comparison: alignClusters(baseline.clusters, live), alignError: null };
    } catch (e) {
      return {
        comparison: null,
        alignError: e instanceof BaselineParseError ? e.message : String(e),
      };
    }
  }, [baseline, live]);
  const comparison = aligned.comparison;
  const shownError = error ?? aligned.alignError;

  const importFile = async (file: File) => {
    try {
      const raw = await file.text();
      const parsed = parseBaselineJson(raw); // 非法时抛错，不触碰现有基线
      onBaseline(parsed, file.name);
      setError(null);
      setOnlyDegraded(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const downloadComparison = () => {
    if (!baseline || !comparison) return;
    const report = buildComparisonReport({
      baselineFileName,
      baseline,
      comparison,
      generatedAt: new Date().toISOString(),
    });
    downloadText('font-fallback-baseline-comparison.json', JSON.stringify(report, null, 2));
  };

  const s = comparison?.summary ?? null;
  const baselineMissing =
    baseline?.missingCount ??
    (baseline ? baseline.clusters.filter((c) => c.status === 'missing').length : 0);

  const rows: AlignmentRow[] = useMemo(() => {
    if (!comparison) return [];
    return onlyDegraded ? comparison.rows.filter(isDegradationRow) : comparison.rows;
  }, [comparison, onlyDegraded]);
  const shown = rows.slice(0, ROW_LIMIT);
  const degradedTotal = comparison ? comparison.rows.filter(isDegradationRow).length : 0;

  const sideCell = (
    r: AlignmentRow,
    side: 'baseline' | 'live',
  ): { text: string; codepoints: string[]; status: string; assignedFont: string | null; missingCodepoints: string[]; index: number } | null => {
    const c = side === 'baseline' ? r.baseline : r.live;
    if (!c) return null;
    return {
      text: c.text,
      codepoints: c.codepoints,
      status: c.status,
      assignedFont: c.assignedFont,
      missingCodepoints: c.missingCodepoints,
      index: c.index,
    };
  };

  const renderSide = (r: AlignmentRow, side: 'baseline' | 'live') => {
    const c = sideCell(r, side);
    if (!c) return <span className="cmp-empty">—</span>;
    return (
      <div className="cmp-side">
        <span className="glyph-cell" title={c.codepoints.join(' ')}>
          {displayCluster(c.text)}
        </span>
        <span className="cmp-side-meta">
          {c.status === 'missing' ? (
            <span className="badge bad">缺失</span>
          ) : c.status === 'free' ? (
            <span className="badge muted-badge">格式簇</span>
          ) : c.assignedFont ? (
            <span className="badge ok">{c.assignedFont}</span>
          ) : (
            <span className="badge muted-badge">已覆盖</span>
          )}
          {c.status === 'missing' && c.missingCodepoints.length > 0 && (
            <span className="muted small mono" title={c.missingCodepoints.join(' ')}>
              {c.missingCodepoints.slice(0, 4).join(' ')}
              {c.missingCodepoints.length > 4 ? ' …' : ''}
            </span>
          )}
        </span>
      </div>
    );
  };

  return (
    <div className="baseline-compare">
      <div className="resilience-head">
        <h3>基线对比</h3>
        <span className="export-actions">
          <button className="btn small" onClick={() => fileRef.current?.click()}>
            导入审计 JSON
          </button>
          {baseline && (
            <>
              <button
                className="btn small primary"
                onClick={downloadComparison}
                disabled={!comparison}
              >
                下载对比 JSON
              </button>
              <button className="btn small ghost" onClick={onClearBaseline}>
                移除基线
              </button>
            </>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="file-input-hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importFile(f);
              e.target.value = '';
            }}
          />
        </span>
      </div>

      <p className="muted small">
        导入本工具导出的审计 JSON，按字素簇文本序列与当前实时结果保序对齐：重复簇按出现次序
        逐次匹配，插入/删除只标记自身、不影响后续簇索引；已对齐簇区分覆盖状态变化与承接字体变化。
        {titleHint ? ` ${titleHint}。` : ''}
        场景集导出的 JSON 也可导入（按其全部场景顺序展平）。
      </p>

      {shownError && (
        <div className="alert bad cmp-error" role="alert">
          <strong>{error ? '基线导入失败' : '基线对比失败'}</strong>
          <span className="alert-detail">
            {shownError}
            {baseline ? '（当前仍保留上一次有效基线）' : ''}
          </span>
        </div>
      )}

      {!baseline && !shownError && (
        <div className="cmp-empty-hint muted small">
          尚未导入基线。先用「下载 .json」保存某次审计结果，之后修改文本/字体范围，再回到这里导入做对比。
        </div>
      )}

      {baseline && comparison && s && (
        <>
          <div className="cmp-baseline-meta muted small">
            基线文件：{baselineFileName ?? '(未命名)'} · 生成于 {formatTime(baseline.generatedAt)} ·
            基线 {baseline.clusters.length} 簇（缺失 {baselineMissing}）
          </div>

          {s.newMissing > 0 || degradedTotal > 0 ? (
            <div className="alert bad">
              <strong>
                ⚠ 检测到退化：新增缺失 {s.newMissing}
                {s.inserted > 0 &&
                  `（另插入 ${s.inserted} 簇，其中缺失 ${
                    degradedTotal - s.newMissing
                  }）`}
              </strong>
              <span className="alert-detail">
                已修复缺失 {s.fixedMissing} · 字体改接 {s.fontChanged} · 实时缺失共{' '}
                {s.liveMissingTotal} 簇。
              </span>
            </div>
          ) : (
            <div className="alert ok">
              ✓ 无新增缺失（已修复缺失 {s.fixedMissing} · 字体改接 {s.fontChanged}）。
            </div>
          )}

          <div className="cmp-stat-grid">
            <div className="cmp-stat">
              <div className="cmp-stat-value">{s.matched}</div>
              <div className="cmp-stat-label">已对齐</div>
            </div>
            <div className="cmp-stat">
              <div className="cmp-stat-value">{s.inserted}</div>
              <div className="cmp-stat-label">新增簇（插入）</div>
            </div>
            <div className="cmp-stat">
              <div className="cmp-stat-value">{s.deleted}</div>
              <div className="cmp-stat-label">移除簇（删除）</div>
            </div>
            <div className="cmp-stat bad">
              <div className="cmp-stat-value">{s.newMissing}</div>
              <div className="cmp-stat-label">新增缺失</div>
            </div>
            <div className="cmp-stat ok">
              <div className="cmp-stat-value">{s.fixedMissing}</div>
              <div className="cmp-stat-label">已修复缺失</div>
            </div>
            <div className="cmp-stat">
              <div className="cmp-stat-value">{s.fontChanged}</div>
              <div className="cmp-stat-label">字体改接</div>
            </div>
          </div>

          <label className="check-row cmp-filter">
            <input
              type="checkbox"
              checked={onlyDegraded}
              onChange={(e) => setOnlyDegraded(e.target.checked)}
            />
            仅看退化项（新增缺失的对齐簇 + 新插入的缺失簇，共 {degradedTotal} 行）
          </label>

          <div className="table-scroll cmp-scroll">
            <table className="cluster-table cmp-table">
              <thead>
                <tr>
                  <th>基线 #</th>
                  <th>基线字素簇</th>
                  <th></th>
                  <th>实时字素簇</th>
                  <th>实时 #</th>
                  <th>变化</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const degraded = isDegradationRow(r);
                  return (
                    <tr
                      key={`${r.kind}-${r.row}`}
                      className={degraded ? 'cmp-row-degraded' : r.kind === 'matched' ? 'cmp-row-matched' : 'cmp-row-indel'}
                    >
                      <td className="mono muted">
                        {r.baseline ? `#${r.baseline.index + 1}` : ''}
                      </td>
                      <td className={r.kind === 'live-only' ? 'cmp-cell-ins' : ''}>
                        {renderSide(r, 'baseline')}
                      </td>
                      <td className="cmp-arrow">
                        {r.kind === 'matched' ? '→' : r.kind === 'live-only' ? '+' : '−'}
                      </td>
                      <td className={r.kind === 'baseline-only' ? 'cmp-cell-del' : ''}>
                        {renderSide(r, 'live')}
                      </td>
                      <td className="mono muted">{r.live ? `#${r.live.index + 1}` : ''}</td>
                      <td>
                        {r.kind === 'matched' ? (
                          <span
                            className={`cmp-change cmp-${r.change}`}
                            title={`出现序数：基线第 ${r.occurrence.baseline} 次 / 实时第 ${r.occurrence.live} 次`}
                          >
                            {CHANGE_LABEL[r.change ?? 'unchanged']}
                          </span>
                        ) : r.kind === 'live-only' ? (
                          <span className="cmp-change cmp-inserted">
                            插入{r.live?.status === 'missing' ? ' · 缺失' : ''}
                          </span>
                        ) : (
                          <span className="cmp-change cmp-deleted">
                            删除{r.baseline?.status === 'missing' ? ' · 原缺失' : ''}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty-cell">
                      无退化项
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {rows.length > ROW_LIMIT && (
            <div className="table-note">
              仅显示前 {ROW_LIMIT} 行（共 {rows.length} 行），完整对齐明细请下载对比 JSON。
            </div>
          )}
          {!hasText && (
            <div className="table-note">当前文本为空：实时侧无簇，基线全部记为删除。</div>
          )}
        </>
      )}
    </div>
  );
}
