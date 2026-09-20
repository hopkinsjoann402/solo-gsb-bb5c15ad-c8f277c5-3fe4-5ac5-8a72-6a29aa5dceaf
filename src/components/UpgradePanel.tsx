import { useMemo, useRef, useState } from 'react';
import type { AuditMode, FontFileInfo, FontSpec } from '../types';
import type { GraphemeGroup } from '../lib/coverage';
import { downloadText } from '../lib/audit';
import { displayCluster, formatCodepoint } from '../lib/grapheme';
import { formatRangesCompact } from '../lib/ranges';
import { formatSfntTag, parseSfntFont, SfntParseError } from '../lib/sfnt';
import {
  assessFontUpgrade,
  buildUpgradeReport,
  type UpgradeChangeKind,
  type UpgradeClusterChange,
} from '../lib/upgrade';

/** 与主字体上传一致：单文件上限 20 MB（防止误选超大文件卡死浏览器解析） */
const MAX_FONT_BYTES = 20 * 1024 * 1024;
const ROW_LIMIT = 300;

type Side = 'old' | 'new';
type ChangeFilter = 'all' | UpgradeChangeKind;

interface UpgradePanelProps {
  /** 字体条目清单（选择本次评估对象；列表顺序即偏好位次） */
  fonts: FontSpec[];
  /** 当前参与求解的场景字素簇（单场景模式仅活动场景） */
  groups: GraphemeGroup[];
  /** 参与求解场景的显示名（与 groups 对齐） */
  scenarios: { id: string; name: string }[];
  mode: AuditMode;
  /** 是否忽略透明格式字符（与主求解设置联动） */
  ignoreFormat: boolean;
}

const SIDE_LABEL: Record<Side, string> = { old: '旧版', new: '新版' };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 码位差集明细：可折叠的紧凑区间列表（与字体编辑器的差集展示一致） */
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

function changeBadge(c: UpgradeClusterChange) {
  if (c.change === 'gained') return <span className="badge ok">新增支持</span>;
  if (c.change === 'lost') return <span className="badge bad">失去支持</span>;
  return c.oldSupported ? (
    <span className="badge muted-badge">不变 · 仍支持</span>
  ) : (
    <span className="badge muted-badge">不变 · 仍不支持</span>
  );
}

/**
 * 字体版本升级影响评估：
 * 选择一个字体条目并分别上传旧版 / 新版 TTF/OTF（仅在浏览器内解析 cmap，
 * 文件不上传、不持久化），按当前参与求解的场景与透明格式字符设置逐字素簇
 * 比较两个版本的支持情况，汇总码位差集与逐场景变化，并可下载完整 JSON。
 * 单侧解析失败时保留另一侧结果并就地报错；文本、模式、活动场景或
 * 忽略透明字符设置变化时自动重算。
 */
export default function UpgradePanel({
  fonts,
  groups,
  scenarios,
  mode,
  ignoreFormat,
}: UpgradePanelProps) {
  const [entryId, setEntryId] = useState<string | null>(null);
  /** 两版本文件解析结果相互独立：单侧失败绝不影响另一侧 */
  const [files, setFiles] = useState<Record<Side, FontFileInfo | null>>({
    old: null,
    new: null,
  });
  const [errors, setErrors] = useState<Record<Side, string | null>>({
    old: null,
    new: null,
  });
  const [parsing, setParsing] = useState<Record<Side, boolean>>({
    old: false,
    new: false,
  });
  const [filter, setFilter] = useState<ChangeFilter>('all');
  const inputRefs = useRef<Record<Side, HTMLInputElement | null>>({
    old: null,
    new: null,
  });

  // 评估对象条目：默认取列表第 1 位；所选条目被删除时回退到第 1 位
  const effectiveEntryId =
    entryId && fonts.some((f) => f.id === entryId) ? entryId : (fonts[0]?.id ?? null);
  const entryIndex = fonts.findIndex((f) => f.id === effectiveEntryId);
  const selectedEntry =
    entryIndex >= 0 ? { preference: entryIndex, name: fonts[entryIndex].name } : null;

  const scenarioNames = useMemo(
    () => Object.fromEntries(scenarios.map((s) => [s.id, s.name])),
    [scenarios],
  );

  // 两侧文件齐备后自动评估；groups / ignoreFormat 变化（文本、模式、
  // 活动场景、透明字符设置）时自动重算
  const assessment = useMemo(
    () =>
      files.old && files.new
        ? assessFontUpgrade(groups, files.old.ranges, files.new.ranges, ignoreFormat)
        : null,
    [files.old, files.new, groups, ignoreFormat],
  );

  // ---- 本地字体文件：浏览器内读取 + 解析 cmap，绝不离开当前页面 ----
  const upload = (side: Side, file: File) => {
    const fail = (msg: string) => setErrors((e) => ({ ...e, [side]: msg }));
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.ttf') && !lower.endsWith('.otf')) {
      fail('仅支持 .ttf / .otf 字体文件');
      return;
    }
    if (file.size > MAX_FONT_BYTES) {
      fail(`文件过大（${file.size} 字节），上限 20 MB`);
      return;
    }
    setParsing((p) => ({ ...p, [side]: true }));
    // File 只在本次读取期间存在；ArrayBuffer 解析完即可被 GC，不写入任何存储
    file
      .arrayBuffer()
      .then((buffer) => {
        try {
          const result = parseSfntFont(buffer);
          if (result.ranges.length === 0) {
            throw new SfntParseError('cmap 未映射任何非 0 glyph（实测覆盖为空）');
          }
          const info: FontFileInfo = {
            name: file.name,
            size: file.size,
            ranges: result.ranges,
            codepointCount: result.codepointCount,
            cmapFormats: result.cmap.formats,
            sfntVersion: formatSfntTag(result.sfntVersion),
            parsedAt: new Date().toISOString(),
          };
          setFiles((m) => ({ ...m, [side]: info }));
          setErrors((e) => ({ ...e, [side]: null }));
        } catch (err) {
          // 单侧解析失败：保留该侧上次成功结果与另一侧全部结果，就地报错
          fail(err instanceof Error ? err.message : String(err));
        } finally {
          setParsing((p) => ({ ...p, [side]: false }));
        }
      })
      .catch((err) => {
        fail(`文件读取失败：${err instanceof Error ? err.message : String(err)}`);
        setParsing((p) => ({ ...p, [side]: false }));
      });
  };

  const clearFile = (side: Side) => {
    setFiles((m) => ({ ...m, [side]: null }));
    setErrors((e) => ({ ...e, [side]: null }));
  };

  const download = () => {
    if (!assessment || !files.old || !files.new) return;
    const report = buildUpgradeReport(assessment, {
      fontEntry: selectedEntry,
      mode,
      ignoreFormatCodepoints: ignoreFormat,
      scenarioNames,
      oldFile: files.old,
      newFile: files.new,
      generatedAt: new Date().toISOString(),
    });
    downloadText('font-version-upgrade-impact.json', JSON.stringify(report, null, 2));
  };

  const filtered = useMemo(
    () =>
      assessment
        ? assessment.clusters.filter((c) => filter === 'all' || c.change === filter)
        : [],
    [assessment, filter],
  );
  const shown = filtered.slice(0, ROW_LIMIT);
  const colSpan = mode === 'set' ? 7 : 6;

  return (
    <div className="upgrade-panel">
      <div className="resilience-head">
        <h3>字体版本升级影响评估</h3>
        <button
          className="btn small primary"
          onClick={download}
          disabled={!assessment}
          title="下载升级影响评估 JSON（文件元数据、码位差集、逐场景汇总与完整变化明细）"
        >
          下载评估 JSON
        </button>
      </div>
      <p className="muted small">
        选择一个字体条目，分别上传其<strong>旧版</strong>与<strong>新版</strong> TTF/OTF：
        复用浏览器端 cmap 解析（文件不上传、不持久化），按当前参与求解的场景
        {mode === 'single' ? '（仅活动场景）' : '（全部场景）'}
        与透明格式字符设置逐字素簇比较；簇内全部必需码位均被某版本覆盖才算该版本支持，
        重复簇按场景与出现位置独立计数。文本、模式、活动场景或忽略透明字符设置变化时自动重算。
      </p>

      <div className="upgrade-entry-row">
        <label className="upgrade-entry-label" htmlFor="upgrade-entry-select">
          字体条目
        </label>
        <select
          id="upgrade-entry-select"
          className="filter-select upgrade-entry-select"
          value={effectiveEntryId ?? ''}
          disabled={fonts.length === 0}
          onChange={(e) => setEntryId(e.target.value || null)}
        >
          {fonts.length === 0 && <option value="">（无字体条目）</option>}
          {fonts.map((f, i) => (
            <option key={f.id} value={f.id}>
              #{i + 1} {f.name.trim() || '(未命名)'}
            </option>
          ))}
        </select>
        {selectedEntry && (
          <span className="muted small">
            评估对象：{selectedEntry.name.trim() || '(未命名)'}（仅作标注，比较对象为上传的两个文件）
          </span>
        )}
      </div>

      <div className="upgrade-slots">
        {(['old', 'new'] as Side[]).map((side) => {
          const file = files[side];
          const error = errors[side];
          return (
            <div key={side} className={`upgrade-slot${error ? ' has-error' : ''}`}>
              <div className="upgrade-slot-title">{SIDE_LABEL[side]}</div>
              {file ? (
                <div className="file-meta">
                  <span className="file-chip" title={file.name}>
                    📄 {file.name} · {formatSize(file.size)} · cmap format{' '}
                    {file.cmapFormats.join('/')} · {file.codepointCount.toLocaleString()} 码位
                  </span>
                  <button
                    className="btn small ghost"
                    onClick={() => clearFile(side)}
                    title="清除浏览器中已解析的字体文件（不影响磁盘文件）"
                  >
                    清除
                  </button>
                </div>
              ) : parsing[side] ? (
                <div className="file-meta">
                  <span className="muted small parsing-hint">⏳ 正在浏览器内解析 cmap…</span>
                </div>
              ) : (
                <div className="file-meta">
                  <button
                    className="btn small"
                    onClick={() => inputRefs.current[side]?.click()}
                  >
                    上传{SIDE_LABEL[side]} TTF/OTF
                  </button>
                  <span className="muted small">仅本地解析</span>
                </div>
              )}
              <input
                ref={(el) => {
                  inputRefs.current[side] = el;
                }}
                type="file"
                accept=".ttf,.otf,font/ttf,font/otf"
                className="file-input-hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload(side, f);
                  e.target.value = '';
                }}
              />
              {error && (
                <div className="font-msg error">
                  {SIDE_LABEL[side]}解析失败：{error}
                  {file ? '（当前仍使用上次成功解析的结果）' : ''}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {assessment ? (
        <>
          <div className="upgrade-stat-grid">
            <div className="cmp-stat ok">
              <div className="cmp-stat-value">{assessment.gainedCount}</div>
              <div className="cmp-stat-label">新增支持簇</div>
            </div>
            <div className={`cmp-stat${assessment.lostCount ? ' bad' : ''}`}>
              <div className="cmp-stat-value">{assessment.lostCount}</div>
              <div className="cmp-stat-label">失去支持簇</div>
            </div>
            <div className="cmp-stat">
              <div className="cmp-stat-value">{assessment.unchangedCount}</div>
              <div className="cmp-stat-label">不变簇</div>
            </div>
            <div className="cmp-stat ok">
              <div className="cmp-stat-value">{assessment.addedCount.toLocaleString()}</div>
              <div className="cmp-stat-label">新版新增覆盖码位</div>
            </div>
            <div className={`cmp-stat${assessment.removedCount ? ' bad' : ''}`}>
              <div className="cmp-stat-value">{assessment.removedCount.toLocaleString()}</div>
              <div className="cmp-stat-label">新版失去覆盖码位</div>
            </div>
          </div>

          {assessment.lostCount > 0 && (
            <div className="alert bad">
              <strong>⚠ 升级后 {assessment.lostCount} 个字素簇失去支持</strong>
              <span className="alert-detail">
                这些簇的全部必需码位在旧版中被完整覆盖、但在新版中不再完整覆盖，详见下方明细。
              </span>
            </div>
          )}
          {assessment.total === 0 && (
            <div className="alert mode">
              <strong>当前参与求解的场景没有字素簇</strong>
              <span className="alert-detail">请先在上方输入待渲染文本，评估将自动重算。</span>
            </div>
          )}

          {/* ---- 新旧版本覆盖码位差集 ---- */}
          <div className="diff-box">
            <div className="diff-title muted small">新旧版本覆盖码位差集（cmap 实测）</div>
            <DiffDetails
              label="新版新增覆盖"
              count={assessment.addedCount}
              ranges={assessment.addedRanges}
              tone="ok"
            />
            <DiffDetails
              label="新版失去覆盖"
              count={assessment.removedCount}
              ranges={assessment.removedRanges}
              tone="warn"
            />
          </div>

          {/* ---- 逐场景汇总 ---- */}
          <div className="upgrade-table-wrap">
            <table className="cluster-table budget-table">
              <thead>
                <tr>
                  <th>场景</th>
                  <th className="num">簇总数</th>
                  <th className="num">新增支持</th>
                  <th className="num">失去支持</th>
                  <th className="num">仍支持</th>
                  <th className="num">仍不支持</th>
                </tr>
              </thead>
              <tbody>
                {assessment.scenarioStats.map((s) => (
                  <tr key={s.scenarioId}>
                    <td>{scenarioNames[s.scenarioId] || '(未命名)'}</td>
                    <td className="num mono">{s.clusterCount}</td>
                    <td className="num mono text-ok">{s.gained}</td>
                    <td className={`num mono${s.lost ? ' text-bad' : ''}`}>{s.lost}</td>
                    <td className="num mono">{s.stillSupported}</td>
                    <td className="num mono">{s.stillUnsupported}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ---- 逐簇变化明细（重复簇按场景与出现位置独立成行） ---- */}
          <div className="cluster-table-wrap">
            <div className="table-toolbar">
              <h3>逐簇变化明细</h3>
              <select
                className="filter-select"
                value={filter}
                onChange={(e) => setFilter(e.target.value as ChangeFilter)}
              >
                <option value="all">全部（{assessment.total}）</option>
                <option value="gained">仅新增支持（{assessment.gainedCount}）</option>
                <option value="lost">仅失去支持（{assessment.lostCount}）</option>
                <option value="unchanged">仅不变（{assessment.unchangedCount}）</option>
              </select>
            </div>
            <div className="table-scroll">
              <table className="cluster-table">
                <thead>
                  <tr>
                    <th>#</th>
                    {mode === 'set' && <th>场景</th>}
                    <th>字素</th>
                    <th>必需码位</th>
                    <th>旧版</th>
                    <th>新版</th>
                    <th>变化</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((c) => (
                    <tr
                      key={`${c.scenarioId}:${c.localIndex}`}
                      className={
                        c.change === 'lost'
                          ? 'row-missing'
                          : c.change === 'gained'
                            ? 'row-gained'
                            : ''
                      }
                    >
                      <td className="mono muted">{c.localIndex + 1}</td>
                      {mode === 'set' && (
                        <td className="small muted scenario-col">
                          {scenarioNames[c.scenarioId] ?? '—'}
                        </td>
                      )}
                      <td className="glyph-cell" title={c.text}>
                        {displayCluster(c.text)}
                      </td>
                      <td className="mono small">
                        {c.required.length > 0
                          ? c.required.map(formatCodepoint).join(' ')
                          : '（仅格式字符）'}
                      </td>
                      <td>
                        {c.oldSupported ? (
                          <span className="badge ok">支持</span>
                        ) : (
                          <span className="badge muted-badge">不支持</span>
                        )}
                      </td>
                      <td>
                        {c.newSupported ? (
                          <span className="badge ok">支持</span>
                        ) : (
                          <span className="badge muted-badge">不支持</span>
                        )}
                      </td>
                      <td>{changeBadge(c)}</td>
                    </tr>
                  ))}
                  {shown.length === 0 && (
                    <tr>
                      <td colSpan={colSpan} className="empty-cell">
                        无匹配的字素簇
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {filtered.length > ROW_LIMIT && (
              <div className="table-note">
                仅显示前 {ROW_LIMIT} 条（共 {filtered.length} 条），完整数据请下载 JSON。
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="cmp-empty-hint muted small">
          {files.old || files.new
            ? `已解析${files.old ? '旧版' : '新版'}（${(files.old ?? files.new)!.name}），请再上传${files.old ? '新版' : '旧版'}文件以生成对比。`
            : '尚未上传字体文件：请分别上传旧版与新版 TTF/OTF，上传后评估自动进行。'}
        </div>
      )}
    </div>
  );
}
