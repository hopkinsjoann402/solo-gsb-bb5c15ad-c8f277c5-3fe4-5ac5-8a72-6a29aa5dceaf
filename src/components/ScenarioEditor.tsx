import type { AuditMode, ScenarioSpec } from '../types';
import { MAX_SCENARIOS, scenarioDisplayName } from '../lib/scenarios';

interface ScenarioEditorProps {
  mode: AuditMode;
  scenarios: ScenarioSpec[];
  activeId: string;
  /** 各场景的字素簇数（与 scenarios 对齐） */
  clusterCounts: number[];
  /** 全部场景合计字素簇数（跨场景重复文本分别计数） */
  totalClusters: number;
  /** 当前场景码位数 / UTF-16 单元数（仅活动场景展示） */
  activeCodepoints: number;
  activeUtf16: number;
  onModeChange: (m: AuditMode) => void;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onTextChange: (text: string) => void;
  onDelete: (id: string) => void;
  onLoadSample: () => void;
  onClear: () => void;
}

/**
 * 待渲染文本编辑区：
 * - 单场景模式：与原版一致的单一文本框（文本存放在活动场景中）；
 * - 场景集模式：左侧场景清单（新增 / 重命名 / 删除，最多 20 个）+
 *   活动场景文本框；空场景保留但不影响合并求解。
 */
export default function ScenarioEditor(props: ScenarioEditorProps) {
  const {
    mode,
    scenarios,
    activeId,
    clusterCounts,
    totalClusters,
    activeCodepoints,
    activeUtf16,
    onModeChange,
    onSelect,
    onAdd,
    onRename,
    onTextChange,
    onDelete,
    onLoadSample,
    onClear,
  } = props;

  const active = scenarios.find((s) => s.id === activeId) ?? scenarios[0];
  const activeIndex = Math.max(0, scenarios.findIndex((s) => s.id === active?.id));
  const activeCount = clusterCounts[activeIndex] ?? 0;
  const emptyCount = clusterCounts.filter((n) => n === 0).length;

  return (
    <div className="scenario-editor">
      <div className="mode-toggle" role="tablist" aria-label="审计模式">
        <button
          role="tab"
          aria-selected={mode === 'single'}
          className={`mode-tab${mode === 'single' ? ' active' : ''}`}
          onClick={() => onModeChange('single')}
        >
          单场景
        </button>
        <button
          role="tab"
          aria-selected={mode === 'set'}
          className={`mode-tab${mode === 'set' ? ' active' : ''}`}
          onClick={() => onModeChange('set')}
        >
          场景集（{scenarios.length}/{MAX_SCENARIOS}）
        </button>
      </div>

      {mode === 'set' && (
        <div className="scenario-manager">
          <ul className="scenario-list">
            {scenarios.map((s, i) => {
              const isActive = s.id === active?.id;
              return (
                <li
                  key={s.id}
                  className={`scenario-item${isActive ? ' active' : ''}`}
                  onClick={() => onSelect(s.id)}
                >
                  <input
                    className="scenario-name-input"
                    value={s.name}
                    placeholder={`场景 ${i + 1}`}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onRename(s.id, e.target.value)}
                    aria-label={`重命名场景 ${i + 1}`}
                  />
                  <span className={`scenario-count-badge${clusterCounts[i] === 0 ? ' empty' : ''}`}>
                    {clusterCounts[i]} 簇
                  </span>
                  <button
                    className="btn icon danger scenario-del"
                    title={scenarios.length <= 1 ? '至少保留一个场景' : '删除场景（其文本一并移除）'}
                    disabled={scenarios.length <= 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(s.id);
                    }}
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            className="btn ghost add-scenario"
            onClick={onAdd}
            disabled={scenarios.length >= MAX_SCENARIOS}
            title={
              scenarios.length >= MAX_SCENARIOS
                ? `最多 ${MAX_SCENARIOS} 个场景`
                : '新增文本场景'
            }
          >
            ＋ 新增场景{scenarios.length >= MAX_SCENARIOS ? `（已达上限 ${MAX_SCENARIOS}）` : ''}
          </button>
          <p className="muted small scenario-hint">
            合并求解 {totalClusters} 簇 · {scenarios.length} 个场景{emptyCount > 0 ? ` · ${emptyCount} 个空场景（保留但不参与求解）` : ''}
            ；跨场景重复文本分别计数。
          </p>
        </div>
      )}

      {mode === 'single' && scenarios.length > 1 && (
        <div className="single-scenario-pick">
          <label className="muted small" htmlFor="single-scenario-select">
            单场景审计对象：
          </label>
          <select
            id="single-scenario-select"
            className="filter-select"
            value={active?.id}
            onChange={(e) => onSelect(e.target.value)}
          >
            {scenarios.map((s, i) => (
              <option key={s.id} value={s.id}>
                {s.name.trim() || `场景 ${i + 1}`}（{clusterCounts[i] ?? 0} 簇）
              </option>
            ))}
          </select>
          <span className="muted small">
            仅该场景参与求解；其余 {scenarios.length - 1} 个场景文本保留、不影响本次结果。切到「场景集」可管理场景。
          </span>
        </div>
      )}

      <textarea
        className="text-input mono"
        value={active?.text ?? ''}
        placeholder={
          mode === 'set'
            ? `粘贴「${scenarioDisplayName(active ?? { id: '', name: '', text: '' }, activeIndex)}」场景的待渲染文本…（空场景会保留但不影响求解）`
            : '粘贴需要渲染的文本…'
        }
        rows={7}
        spellCheck={false}
        onChange={(e) => onTextChange(e.target.value)}
      />
      <div className="row-between">
        <span className="muted small">
          {activeCount} 字素簇 · {activeCodepoints} 码位 · {activeUtf16} UTF-16 单元
          {mode === 'set' && scenarios.length > 1 && (
            <> · 合计 {totalClusters} 簇</>
          )}
        </span>
        <span className="row-actions">
          <button className="btn small ghost" onClick={onLoadSample}>
            {mode === 'set' ? '载入示例场景集' : '载入示例'}
          </button>
          <button className="btn small ghost" onClick={onClear}>
            清空
          </button>
        </span>
      </div>
    </div>
  );
}
