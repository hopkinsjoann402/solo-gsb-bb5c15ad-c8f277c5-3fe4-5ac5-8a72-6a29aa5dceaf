import { useMemo, useRef, useState } from 'react';
import type { FontFileInfo, FontSpec } from '../types';
import { parseSfntFile } from '../lib/sfnt';
import {
  buildFontUpgradeReport,
  compareFontUpgrade,
  type UpgradeChangeKind,
  type UpgradeClusterOccurrence,
  type UpgradeGroup,
  type UpgradeScenarioRef,
} from '../lib/fontUpgrade';
import { downloadText } from '../lib/audit';
import { displayCluster, formatCodepoint } from '../lib/grapheme';
import { formatRangesCompact } from '../lib/ranges';

interface FontUpgradePanelProps {
  /** 全部字体条目（仅用于选择评估对象；声明范围/实测开关不参与本评估） */
  fonts: FontSpec[];
  /** 当前参与求解的场景字素簇（单场景模式仅活动场景），顺序即计数顺序 */
  groups: UpgradeGroup[];
  /** 与 groups 对齐的场景元数据（按清单顺序） */
  scenarios: UpgradeScenarioRef[];
  /** 当前模式（单场景 / 场景集） */
  mode: 'single' | 'set';
  /** 是否忽略透明格式字符（与求解偏好联动） */
  ignoreFormatCodepoints: boolean;
  /** 文件大小上限（与字体条目上传一致） */
  maxFileBytes: number;
}

type SideKey = 'old' | 'new';

interface SideState {
  /** 最近一次成功解析的元数据（重新上传失败时保留，与字体条目上传行为一致） */
  info: FontFileInfo | null;
  /** 最近一次上传/解析的错误信息；null 表示无错误 */
  error: string | null;
  /** 正在读取/解析 */
  busy: boolean;
}

const EMPTY_SIDE: SideState = { info: null, error: null, busy: false };

/** 界面每类变化明细最多展示的簇数（JSON 不截断） */
const OCCURRENCE_LIMIT = 100;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 单个版本（旧版 / 新版）的上传卡片 */
function VersionSlot({
  label,
  tone,
  state,
  onBrowse,
  onPick,
  onClear,
  registerInput,
}: {
  label: string;
  tone: 'old' | 'new';
  state: SideState;
  onBrowse: () => void;
  onPick: (file: File) => void;
  onClear: () => void;
  registerInput: (el: HTMLInputElement | null) => void;
}) {
  return (
    <div className={`upgrade-slot ${tone}${state.error ? ' has-error' : ''}`}>
      <div className="upgrade-slot-head">
        <span className="upgrade-slot-label">{label}</span>
        {state.info && (
          <button className="btn small ghost" onClick={onClear} title="清除该版本（不影响磁盘文件）">
            清除
          </button>
        )}
      </div>

      {state.busy ? (
        <div className="muted small">⏳ 正在浏览器内解析 cmap…</div>
      ) : state.info ? (
        <div className="upgrade-slot-meta">
          <span className="file-chip" title={state.info.name}>
            📄 {state.info.name} · {formatSize(state.info.size)}
          </span>
          <div className="muted small">
            cmap format {state.info.cmapFormats.join('/')} · sfnt {state.info.sfntVersion} ·{' '}
            {state.info.codepointCount.toLocaleString()} 码位 · {state.info.ranges.length} 段
          </div>
        </div>
      ) : (
        <div className="upgrade-slot-meta">
          <button className="btn small" onClick={onBrowse}>
            选择 TTF/OTF
          </button>
          <span className="muted small">仅本地解析，不上传、不持久化</span>
        </div>
      )}

      <input
        ref={registerInput}
        type="file"
        accept=".ttf,.otf,font/ttf,font/otf"
        className="file-input-hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPick(file);
          e.target.value = '';
        }}
      />

      {state.error && (
        <div className="font-msg error">
          解析失败：{state.error}
          {state.info ? '（下方仍展示上一次成功解析的结果，但不参与本次比较）' : '（该版本尚无可用解析结果）'}
        </div>
      )}
    </div>
  );
}

const KIND_SECTIONS: {
  key: UpgradeChangeKind;
  title: string;
  desc: string;
  tone: string;
}[] = [
  { key: 'gained', title: '升级后新增支持', desc: '旧版不支持 → 新版支持', tone: 'ok' },
  { key: 'lost', title: '升级后失去支持', desc: '旧版支持 → 新版不支持', tone: 'bad' },
  { key: 'unchanged', title: '支持状态不变', desc: '两版本判定一致', tone: 'muted' },
];

function OccurrenceRow({
  o,
  showScenario,
  scenarioName,
}: {
  o: UpgradeClusterOccurrence;
  showScenario: boolean;
  scenarioName: string;
}) {
  const missing =
    o.kind === 'gained'
      ? { label: '旧版缺', cps: o.oldMissingCodepoints }
      : o.kind === 'lost'
        ? { label: '新版缺', cps: o.newMissingCodepoints }
        : null;
  return (
    <div className={`upgrade-occ-row ${o.kind}`} title={o.codepoints.map(formatCodepoint).join(' ')}>
      <span className="upgrade-occ-index mono">#{o.localIndex + 1}</span>
      {showScenario && <span className="upgrade-occ-scenario">{scenarioName || '(未命名)'}</span>}
      <span className="upgrade-occ-text">{displayCluster(o.text)}</span>
      {o.unchangedState === 'free' && <span className="badge muted-badge">透明格式簇</span>}
      {o.unchangedState === 'unsupported' && <span className="badge warn">两版均不支持</span>}
      {missing && missing.cps.length > 0 && (
        <span className="muted small mono upgrade-occ-missing" title={missing.cps.map(formatCodepoint).join(' ')}>
          {missing.label} {missing.cps.slice(0, 8).map(formatCodepoint).join(' ')}
          {missing.cps.length > 8 ? ` 等 ${missing.cps.length} 个` : ''}
        </span>
      )}
    </div>
  );
}

/**
 * 字体版本升级影响评估面板（放在字体编辑区下方）：
 * 选择一个字体条目并分别上传旧版 / 新版 TTF/OTF，复用浏览器端 cmap 解析，
 * 按当前参与求解的场景与透明格式字符设置逐字素簇比较；
 * 文本、模式、活动场景或忽略透明字符设置变化时自动重算。
 */
export default function FontUpgradePanel({
  fonts,
  groups,
  scenarios,
  mode,
  ignoreFormatCodepoints,
  maxFileBytes,
}: FontUpgradePanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [oldSide, setOldSide] = useState<SideState>(EMPTY_SIDE);
  const [newSide, setNewSide] = useState<SideState>(EMPTY_SIDE);
  const oldInputRef = useRef<HTMLInputElement | null>(null);
  const newInputRef = useRef<HTMLInputElement | null>(null);
  /** 防止同一侧边并发上传时旧响应覆盖新响应 */
  const reqSeq = useRef<{ old: number; new: number }>({ old: 0, new: 0 });

  const selectedFont = fonts.find((f) => f.id === selectedId) ?? null;
  const effectiveId = selectedFont ? selectedFont.id : fonts[0]?.id ?? null;

  const pickFile = (side: SideKey, file: File) => {
    const seq = ++reqSeq.current[side];
    const setSide = side === 'old' ? setOldSide : setNewSide;
    setSide((s) => ({ ...s, busy: true, error: null }));
    parseSfntFile(file, maxFileBytes)
      .then((info) => {
        if (reqSeq.current[side] !== seq) return;
        setSide({ info, error: null, busy: false });
      })
      .catch((e: unknown) => {
        if (reqSeq.current[side] !== seq) return;
        const msg = e instanceof Error ? e.message : String(e);
        // 保留另一侧（以及该侧上一次成功）的结果，只就地报错
        setSide((s) => ({ ...s, info: s.info, error: msg, busy: false }));
      });
  };

  const clearSide = (side: SideKey) => {
    reqSeq.current[side] += 1;
    if (side === 'old') setOldSide(EMPTY_SIDE);
    else setNewSide(EMPTY_SIDE);
  };

  const scenarioNameById = useMemo(
    () => new Map(scenarios.map((s) => [s.id, s.name])),
    [scenarios],
  );

  // 两侧最近一次成功结果齐全时即可比较；单侧失败保留其上次成功结果并继续比较
  const comparison = useMemo(() => {
    if (!effectiveId || !selectedFont || !oldSide.info || !newSide.info) return null;
    return compareFontUpgrade({
      font: { id: effectiveId, name: selectedFont.name },
      oldVersion: oldSide.info,
      newVersion: newSide.info,
      groups,
      scenarios,
      ignoreFormatCodepoints,
    });
  }, [effectiveId, selectedFont, oldSide.info, newSide.info, groups, scenarios, ignoreFormatCodepoints]);

  const generatedAt = useMemo(() => new Date().toISOString(), [comparison]);

  const download = () => {
    if (!comparison || !selectedFont || !oldSide.info || !newSide.info) return;
    const report = buildFontUpgradeReport(
      {
        font: { id: effectiveId!, name: selectedFont.name },
        oldVersion: oldSide.info,
        newVersion: newSide.info,
        groups,
        scenarios,
        ignoreFormatCodepoints,
      },
      comparison,
      generatedAt,
      mode,
    );
    downloadText('font-version-upgrade-impact.json', JSON.stringify(report, null, 2));
  };

  const showScenario = mode === 'set' || scenarios.length > 1;
  const totalNonEmpty = comparison?.scenarios.reduce((a, s) => a + s.total, 0) ?? 0;

  const renderOccurrences = (kind: UpgradeChangeKind) => {
    if (!comparison) return null;
    const list =
      kind === 'gained'
        ? comparison.gained
        : kind === 'lost'
          ? comparison.lost
          : comparison.unchanged;
    const section = KIND_SECTIONS.find((s) => s.key === kind)!;
    const shown = list.slice(0, OCCURRENCE_LIMIT);
    return (
      <details className="upgrade-occ-section" open={kind !== 'unchanged'}>
        <summary className={`upgrade-occ-summary ${section.tone}`}>
          {section.title} <strong className="mono">{list.length}</strong> 簇
          <span className="muted small"> · {section.desc}</span>
        </summary>
        {list.length === 0 ? (
          <div className="muted small upgrade-occ-empty">（无）</div>
        ) : (
          <div className="upgrade-occ-list">
            {shown.map((o) => (
              <OccurrenceRow
                key={`${o.scenarioId}:${o.localIndex}:${o.start}`}
                o={o}
                showScenario={showScenario}
                scenarioName={scenarioNameById.get(o.scenarioId) ?? ''}
              />
            ))}
            {list.length > shown.length && (
              <div className="muted small">
                … 另 {list.length - shown.length} 簇未在界面展开，完整明细请下载 JSON。
              </div>
            )}
          </div>
        )}
      </details>
    );
  };

  return (
    <div className="font-upgrade">
      <h2 className="upgrade-title">字体版本升级影响评估</h2>
      <p className="muted small">
        选择一个字体条目，分别上传其<strong>旧版</strong>与<strong>新版</strong> TTF/OTF：
        复用浏览器端 cmap（format 4/12）解析，文件仍不上传、不持久化。按当前
        {mode === 'set' ? '参与求解的全部场景' : '活动场景'}
        与{ignoreFormatCodepoints ? '已忽略透明格式字符的' : '包含透明格式字符的'}必需码位
        逐字素簇比较——簇内全部必需码位均被某版本覆盖才算支持；重复簇按场景与出现位置独立计数。
      </p>

      <div className="upgrade-font-pick">
        <label className="budget-input-label" htmlFor="font-upgrade-select">
          评估字体条目
        </label>
        <select
          id="font-upgrade-select"
          className="upgrade-select"
          value={effectiveId ?? ''}
          onChange={(e) => setSelectedId(e.target.value || null)}
          disabled={fonts.length === 0}
        >
          {fonts.length === 0 && <option value="">（请先添加字体条目）</option>}
          {fonts.map((f, i) => (
            <option key={f.id} value={f.id}>
              #{i + 1} {f.name || '(未命名)'}
            </option>
          ))}
        </select>
        <span className="muted small">仅用于标识评估对象，使用两个上传版本的 cmap 实测覆盖比较</span>
      </div>

      <div className="upgrade-slots">
        <VersionSlot
          label="旧版字体"
          tone="old"
          state={oldSide}
          onBrowse={() => oldInputRef.current?.click()}
          onPick={(file) => pickFile('old', file)}
          onClear={() => clearSide('old')}
          registerInput={(el) => {
            oldInputRef.current = el;
          }}
        />
        <VersionSlot
          label="新版字体"
          tone="new"
          state={newSide}
          onBrowse={() => newInputRef.current?.click()}
          onPick={(file) => pickFile('new', file)}
          onClear={() => clearSide('new')}
          registerInput={(el) => {
            newInputRef.current = el;
          }}
        />
      </div>

      {(oldSide.error || newSide.error) && (
        <div className="alert warn">
          <strong>一侧文件解析失败</strong>
          <span className="alert-detail">
            {oldSide.error && `旧版：${oldSide.error}；`}
            {newSide.error && `新版：${newSide.error}；`}
            另一侧结果已保留
            {(!oldSide.info || !newSide.info) ? '，请重新上传失败一侧后再比较。' : '，当前比较使用各侧上一次成功解析的结果。'}
          </span>
        </div>
      )}

      {!comparison ? (
        <div className="alert mode">
          <strong>等待两侧版本就绪</strong>
          <span className="alert-detail">
            请为旧版与新版分别成功解析一个 TTF/OTF 文件；解析在本机完成，文件不会发送到服务端。
          </span>
        </div>
      ) : (
        <>
          <div className="resilience-head">
            <h3>
              评估结果 · {selectedFont?.name || '(未命名)'}
              {totalNonEmpty === 0 && <span className="muted small">（当前参与场景无文本）</span>}
            </h3>
            <button className="btn small primary" onClick={download}>
              下载评估 JSON
            </button>
          </div>

          <div className="cmp-stat-grid budget-stat-grid upgrade-stat-grid">
            <div className={`cmp-stat${comparison.gained.length ? ' ok' : ''}`}>
              <div className="cmp-stat-value">{comparison.gained.length}</div>
              <div className="cmp-stat-label">新增支持簇</div>
            </div>
            <div className={`cmp-stat${comparison.lost.length ? ' bad' : ''}`}>
              <div className="cmp-stat-value">{comparison.lost.length}</div>
              <div className="cmp-stat-label">失去支持簇</div>
            </div>
            <div className="cmp-stat">
              <div className="cmp-stat-value">{comparison.unchanged.length}</div>
              <div className="cmp-stat-label">不变簇</div>
            </div>
            <div className={`cmp-stat${comparison.addedCodepointCount ? ' ok' : ''}`}>
              <div className="cmp-stat-value">+{comparison.addedCodepointCount.toLocaleString()}</div>
              <div className="cmp-stat-label">新版新增码位</div>
            </div>
            <div className={`cmp-stat${comparison.removedCodepointCount ? ' bad' : ''}`}>
              <div className="cmp-stat-value">−{comparison.removedCodepointCount.toLocaleString()}</div>
              <div className="cmp-stat-label">新版移除码位</div>
            </div>
          </div>

          {comparison.lost.length > 0 && (
            <div className="alert bad">
              <strong>⚠ 升级后 {comparison.lost.length} 个字素簇失去支持</strong>
              <span className="alert-detail">
                这些簇的全部必需码位在旧版 cmap 中均有字形、新版却缺失至少一个；
                升级前请确认可接受回退或补字。
              </span>
            </div>
          )}
          {comparison.lost.length === 0 && comparison.gained.length > 0 && (
            <div className="alert ok">
              ✓ 升级未失去任何簇的支持，另有 {comparison.gained.length} 个簇新增支持。
            </div>
          )}

          {/* ---- 新旧覆盖码位差集 ---- */}
          <div className="upgrade-diff-box">
            <div className="diff-title muted small">新旧 cmap 覆盖码位差集（与文本无关的全集差异）</div>
            <UpgradeDiffDetails
              label="新版有 · 旧版无"
              count={comparison.addedCodepointCount}
              ranges={comparison.addedRanges}
              tone="ok"
            />
            <UpgradeDiffDetails
              label="旧版有 · 新版无"
              count={comparison.removedCodepointCount}
              ranges={comparison.removedRanges}
              tone="warn"
            />
            <div className="muted small">
              覆盖规模：旧版 {comparison.oldCodepointCount.toLocaleString()} 码位 /{' '}
              {comparison.oldRangeCount} 段 → 新版 {comparison.newCodepointCount.toLocaleString()} 码位 /{' '}
              {comparison.newRangeCount} 段
            </div>
          </div>

          {/* ---- 逐场景汇总 ---- */}
          <div className="budget-table-wrap upgrade-scenario-wrap">
            <table className="budget-table upgrade-scenario-table">
              <thead>
                <tr>
                  <th>场景</th>
                  <th className="num">簇数</th>
                  <th className="num">新增支持</th>
                  <th className="num">失去支持</th>
                  <th className="num">仍支持</th>
                  <th className="num">仍不支持</th>
                  <th className="num">透明格式簇</th>
                  <th className="num">旧版支持</th>
                  <th className="num">新版支持</th>
                </tr>
              </thead>
              <tbody>
                {comparison.scenarios.map((s) => (
                  <tr key={s.scenarioId}>
                    <td>{s.scenarioName || '(未命名)'}</td>
                    <td className="num">{s.total}</td>
                    <td className="num text-ok">{s.gained}</td>
                    <td className="num text-bad">{s.lost}</td>
                    <td className="num">{s.unchangedSupported}</td>
                    <td className="num">{s.unchangedUnsupported}</td>
                    <td className="num">{s.free}</td>
                    <td className="num">{s.oldSupportedCount}</td>
                    <td className="num">{s.newSupportedCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ---- 完整变化明细（界面截断，JSON 不截断） ---- */}
          {renderOccurrences('gained')}
          {renderOccurrences('lost')}
          {renderOccurrences('unchanged')}
        </>
      )}
    </div>
  );
}

/** 码位差集明细（复用声明/实测差集的折叠样式） */
function UpgradeDiffDetails({
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
        {hidden > 0 ? ` …另 ${hidden} 段未展开（完整区间见下载的 JSON）` : ''}
      </div>
    </details>
  );
}
