import type { ClusterAudit, ParsedFont, ScenarioClusterAudit } from '../types';
import { displayCluster, formatCodepoint } from '../lib/grapheme';

const ROW_LIMIT = 300;

export type ClusterFilter =
  | 'all'
  | 'missing'
  | 'missing-natural'
  | 'missing-constraint'
  | `font:${number}`;

interface ClusterTableProps {
  clusters: ClusterAudit[];
  validFonts: ParsedFont[];
  filter: ClusterFilter;
  onFilterChange: (f: ClusterFilter) => void;
  /** 编号使用场景内局部下标（场景集模式） */
  localNumbering?: boolean;
  /** 簇 -> 所属场景名（场景集模式在每行前展示） */
  scenarioLabel?: (c: ScenarioClusterAudit) => string | null;
}

/** 字素簇明细表：每个簇由链中哪种字体承接、缺失原因 */
export default function ClusterTable({
  clusters,
  validFonts,
  filter,
  onFilterChange,
  localNumbering = false,
  scenarioLabel,
}: ClusterTableProps) {
  const filtered = clusters.filter((c) => {
    if (filter === 'all') return true;
    if (filter === 'missing') return c.status === 'missing';
    if (filter === 'missing-natural') {
      return c.status === 'missing' && c.missingKind !== 'constraint';
    }
    if (filter === 'missing-constraint') {
      return c.status === 'missing' && c.missingKind === 'constraint';
    }
    const idx = Number(filter.slice(5));
    return c.assigned === idx;
  });
  const shown = filtered.slice(0, ROW_LIMIT);
  const missingTotal = clusters.filter((c) => c.status === 'missing').length;
  const naturalTotal = clusters.filter(
    (c) => c.status === 'missing' && c.missingKind !== 'constraint',
  ).length;
  const constraintTotal = missingTotal - naturalTotal;
  const rowNumber = (c: ClusterAudit) =>
    localNumbering ? (c as ScenarioClusterAudit).localIndex + 1 : c.index + 1;
  const rowKey = (c: ClusterAudit) => {
    if (localNumbering) {
      const sc = c as ScenarioClusterAudit;
      return `${sc.scenarioId}:${sc.localIndex}`;
    }
    return String(c.index);
  };

  return (
    <div className="cluster-table-wrap">
      <div className="table-toolbar">
        <h3>字素簇明细</h3>
        <select
          className="filter-select"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value as ClusterFilter)}
        >
          <option value="all">全部（{clusters.length}）</option>
          <option value="missing">仅缺失（{missingTotal}）</option>
          <option value="missing-natural">仅自然缺失（{naturalTotal}）</option>
          <option value="missing-constraint">仅约束缺失（{constraintTotal}）</option>
          {validFonts.map((f, i) => (
            <option key={f.id} value={`font:${i}`}>
              由「{f.name || '(未命名)'}」承接（{clusters.filter((c) => c.assigned === i).length}）
            </option>
          ))}
        </select>
      </div>
      <div className="table-scroll">
        <table className="cluster-table">
          <thead>
            <tr>
              <th>#</th>
              {scenarioLabel && <th>场景</th>}
              <th>字素</th>
              <th>码位</th>
              <th>承接字体</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => {
              const label = scenarioLabel ? scenarioLabel(c as ScenarioClusterAudit) : null;
              const constraintMissing =
                c.status === 'missing' && c.missingKind === 'constraint';
              return (
                <tr
                  key={rowKey(c)}
                  className={constraintMissing ? 'row-constraint' : `row-${c.status}`}
                >
                  <td className="mono muted">{rowNumber(c)}</td>
                  {scenarioLabel && (
                    <td className="small muted scenario-col">{label ?? '—'}</td>
                  )}
                  <td className="glyph-cell" title={c.text}>
                    {displayCluster(c.text)}
                  </td>
                  <td className="mono small">
                    {c.codepoints.map(formatCodepoint).join(' ')}
                  </td>
                  <td>
                    {c.status === 'missing' ? (
                      constraintMissing ? (
                        <span className="badge warn">约束缺失</span>
                      ) : (
                        <span className="badge bad">缺失</span>
                      )
                    ) : c.assigned !== null ? (
                      <span className="badge ok">{validFonts[c.assigned].name || '(未命名)'}</span>
                    ) : (
                      <span className="badge muted-badge">—</span>
                    )}
                  </td>
                  <td className="small note">
                    {c.status === 'missing' &&
                      (constraintMissing ? (
                        <>
                          仅被排除字体覆盖：
                          {c.unblockFonts
                            .map((i) => validFonts[i]?.name || '(未命名)')
                            .join('、')}
                          （解除「禁止入链」即可恢复）
                        </>
                      ) : (
                        <>无字体覆盖 {c.missingCodepoints.map(formatCodepoint).join(' ')}</>
                      ))}
                    {c.status === 'covered' && (
                      <>链中首个可覆盖字体（共 {c.candidates.length} 种候选）</>
                    )}
                    {c.status === 'free' && <>仅含格式字符，随上下文渲染</>}
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={scenarioLabel ? 6 : 5} className="empty-cell">
                  无匹配的字素簇
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {filtered.length > ROW_LIMIT && (
        <div className="table-note">仅显示前 {ROW_LIMIT} 条（共 {filtered.length} 条），完整数据请导出 JSON。</div>
      )}
    </div>
  );
}
