import { useRef } from 'react';
import type { FontConstraint, FontSpec, ParsedFont, RangeDiff } from '../types';
import { countCodepoints, formatRangesCompact } from '../lib/ranges';
import { formatCodepoint } from '../lib/grapheme';

/** 入链约束三态选项（随字体 id 保留，排序与声明/实测切换不影响） */
const CONSTRAINT_OPTIONS: { value: FontConstraint; label: string; hint: string }[] = [
  { value: 'normal', label: '普通', hint: '正常参与求解，由求解器决定是否入链' },
  { value: 'locked', label: '🔒 必须入链', hint: '锁定：求解后必定出现在回退链中，即使不承接任何字素簇' },
  { value: 'excluded', label: '🚫 禁止入链', hint: '排除：求解前从候选中剔除；仅能被它覆盖的簇会标记为「约束缺失」' },
];

interface FontEditorProps {
  fonts: FontSpec[];
  parsed: ParsedFont[];
  /** 正在解析文件的条目 id 集合 */
  parsingIds: Set<string>;
  /** “按实测覆盖求解”开关 */
  useMeasured: boolean;
  /** 当前是否至少有一个已解析的上传文件 */
  hasUploaded: boolean;
  onUpdate: (id: string, patch: Partial<FontSpec>) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
  onToggleMeasured: (v: boolean) => void;
  onUploadFile: (id: string, file: File) => void;
  onClearFile: (id: string) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 差集明细：可折叠的紧凑区间列表 */
function DiffDetails({
  label,
  count,
  ranges,
  tone,
}: {
  label: string;
  count: number;
  ranges: [number, number][];
  tone: 'warn' | 'ok';
}) {
  const { text, hidden } = formatRangesCompact(ranges);
  return (
    <details className="diff-details">
      <summary className={tone === 'warn' ? 'diff-count warn' : 'diff-count ok'}>
        {label} <strong>{count.toLocaleString()}</strong> 码位 · {ranges.length} 段
      </summary>
      <div className="diff-ranges mono">
        {ranges.length === 0 ? '（空集）' : text}
        {hidden > 0 ? ` …另 ${hidden} 段未展开` : ''}
      </div>
    </details>
  );
}

/**
 * 字体列表编辑器：顺序即回退偏好（第 1 位最优先）。
 * 范围语法：U+0020-007E、U+4E00、U+4??（通配），逗号/空白分隔。
 * 每个条目可上传本地 TTF/OTF：仅在浏览器内解析 cmap format 4/12，
 * 文件内容不上传、不持久化；解析错误只在该条目内提示。
 */
export default function FontEditor({
  fonts,
  parsed,
  parsingIds,
  useMeasured,
  hasUploaded,
  onUpdate,
  onMove,
  onRemove,
  onAdd,
  onToggleMeasured,
  onUploadFile,
  onClearFile,
}: FontEditorProps) {
  const inputRefs = useRef<Map<string, HTMLInputElement | null>>(new Map());

  return (
    <div className="font-editor">
      <label className={`switch-row${hasUploaded ? '' : ' disabled'}`}>
        <input
          type="checkbox"
          checked={useMeasured}
          disabled={!hasUploaded}
          onChange={(e) => onToggleMeasured(e.target.checked)}
        />
        <span>
          <strong>按实测覆盖求解</strong>
          <span className="muted small">
            ：已上传字体以 cmap 实测码位参与字素簇分析、回退链求解与审计 JSON；
            未上传字体仍用声明范围，清除文件立即恢复声明范围。
          </span>
        </span>
      </label>

      <div className="font-list">
        {fonts.map((f, i) => {
          const p = parsed[i];
          const busy = parsingIds.has(f.id);
          const declaredOk = p && !p.error;
          const activeError =
            p && (p.effectiveSource === 'measured' ? p.fileError : p.error);
          const diff: RangeDiff | null =
            p && p.file && !p.error
              ? {
                  declaredOnly: p.diffDeclaredOnly ?? [],
                  declaredOnlyCount: countCodepoints(p.diffDeclaredOnly ?? []),
                  measuredOnly: p.diffMeasuredOnly ?? [],
                  measuredOnlyCount: countCodepoints(p.diffMeasuredOnly ?? []),
                }
              : null;
          return (
            <div
              className={`font-row${activeError ? ' has-error' : ''}${
                f.constraint !== 'normal' ? ` constraint-${f.constraint}` : ''
              }`}
              key={f.id}
            >
              <div className="font-order" title="偏好顺序（1 = 最优先）">
                {i + 1}
              </div>
              <div className="font-fields">
                <input
                  className="font-name"
                  value={f.name}
                  placeholder="字体名称，如 Han Sans SC"
                  onChange={(e) => onUpdate(f.id, { name: e.target.value })}
                />
                <input
                  className="font-ranges mono"
                  value={f.rangesText}
                  placeholder="U+0020-007E, U+4E00-9FFF（支持 U+4?? 通配）"
                  spellCheck={false}
                  onChange={(e) => onUpdate(f.id, { rangesText: e.target.value })}
                />
                {p?.error ? (
                  <div className="font-msg error">声明范围：{p.error}</div>
                ) : p ? (
                  <div className="font-msg">
                    声明范围覆盖 {p.codepointCount.toLocaleString()} 个码位 · {p.ranges.length} 段
                  </div>
                ) : null}

                {/* ---- 入链约束（普通 / 必须入链 / 禁止入链） ---- */}
                <div className="constraint-row">
                  <span className="constraint-label muted small">入链约束</span>
                  <div className="constraint-group" role="group" aria-label="入链约束">
                    {CONSTRAINT_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`constraint-btn${
                          f.constraint === opt.value ? ` active ${opt.value}` : ''
                        }`}
                        title={opt.hint}
                        onClick={() => onUpdate(f.id, { constraint: opt.value })}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  {f.constraint === 'locked' && (
                    <span className="muted small">求解后必定入链</span>
                  )}
                  {f.constraint === 'excluded' && (
                    <span className="muted small">求解前剔除，不入链</span>
                  )}
                </div>

                {/* ---- 本地字体文件 ---- */}
                <div className="file-row">
                  {f.file ? (
                    <div className="file-meta">
                      <span className="file-chip" title={f.file.name}>
                        📄 {f.file.name} · {formatSize(f.file.size)} · cmap format{' '}
                        {f.file.cmapFormats.join('/')} · sfnt {f.file.sfntVersion}
                      </span>
                      <span
                        className={`source-badge ${p?.effectiveSource === 'measured' && useMeasured ? 'live' : 'idle'}`}
                      >
                        {p?.effectiveSource === 'measured' && useMeasured
                          ? `实测生效 · ${f.file.codepointCount.toLocaleString()} 码位`
                          : '实测待用（开关关闭）'}
                      </span>
                      <button
                        className="btn small ghost"
                        onClick={() => onClearFile(f.id)}
                        title="清除浏览器中已解析的字体文件（不影响磁盘文件）"
                      >
                        清除文件
                      </button>
                    </div>
                  ) : busy ? (
                    <div className="file-meta">
                      <span className="muted small parsing-hint">⏳ 正在浏览器内解析 cmap…</span>
                    </div>
                  ) : (
                    <div className="file-meta">
                      <button
                        className="btn small"
                        onClick={() => inputRefs.current.get(f.id)?.click()}
                      >
                        上传 TTF/OTF（仅本地解析）
                      </button>
                      <span className="muted small">
                        文件不会上传服务端，也不会写入浏览器存储
                      </span>
                    </div>
                  )}
                  <input
                    ref={(el) => {
                      inputRefs.current.set(f.id, el);
                    }}
                    type="file"
                    accept=".ttf,.otf,font/ttf,font/otf"
                    className="file-input-hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) onUploadFile(f.id, file);
                      e.target.value = '';
                    }}
                  />
                </div>

                {p?.fileError && (
                  <div className="font-msg error">
                    字体文件解析失败：{p.fileError}
                    {f.file ? '（当前仍使用上次成功解析的结果）' : '（该条目回退为声明范围）'}
                  </div>
                )}

                {/* ---- 声明 vs 实测 双向差集 ---- */}
                {f.file && declaredOk && p && diff && (
                  <div className="diff-box">
                    <div className="diff-title muted small">声明范围 vs cmap 实测覆盖</div>
                    <DiffDetails
                      label="声明有 · 实测无"
                      count={diff.declaredOnlyCount}
                      ranges={diff.declaredOnly}
                      tone="warn"
                    />
                    <DiffDetails
                      label="实测有 · 声明无"
                      count={diff.measuredOnlyCount}
                      ranges={diff.measuredOnly}
                      tone="ok"
                    />
                  </div>
                )}

                {f.file && p?.effectiveSource === 'measured' && !p.fileError && useMeasured && (
                  <div className="font-msg">
                    当前分析使用实测范围：{p.effectiveCount.toLocaleString()} 个码位 ·{' '}
                    {p.effectiveRanges.length} 段（首段{' '}
                    {p.effectiveRanges[0]
                      ? `${formatCodepoint(p.effectiveRanges[0][0])}–${formatCodepoint(
                          p.effectiveRanges[0][1],
                        )}`
                      : '—'}
                    ）
                  </div>
                )}
              </div>
              <div className="font-actions">
                <button
                  className="btn icon"
                  title="上移（提高优先级）"
                  disabled={i === 0}
                  onClick={() => onMove(f.id, -1)}
                >
                  ↑
                </button>
                <button
                  className="btn icon"
                  title="下移（降低优先级）"
                  disabled={i === fonts.length - 1}
                  onClick={() => onMove(f.id, 1)}
                >
                  ↓
                </button>
                <button className="btn icon danger" title="删除字体" onClick={() => onRemove(f.id)}>
                  ✕
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <button className="btn ghost add-font" onClick={onAdd}>
        ＋ 添加字体
      </button>
    </div>
  );
}
