/** 用户上传并在浏览器端解析完成的字体文件信息（文件内容本身不持久化） */
export interface FontFileInfo {
  /** 原始文件名，仅用于界面展示与审计说明 */
  name: string;
  /** 文件大小（字节） */
  size: number;
  /** 解析得到的实际码位范围（cmap format 4/12 合并、glyphId!==0） */
  ranges: [number, number][];
  /** 实际覆盖码位总数 */
  codepointCount: number;
  /** 参与合并的 cmap 子表格式，如 [4, 12] */
  cmapFormats: number[];
  /** sfnt 版本标识的十六进制字符串，如 "0x00010000" / "OTTO" */
  sfntVersion: string;
  /** 解析完成时间（ISO） */
  parsedAt: string;
}

/**
 * 字体的入链约束：
 * - normal：普通，参与正常求解；
 * - locked：必须入链（锁定），求解后必定出现在回退链中；
 * - excluded：禁止入链（排除），求解前从候选中剔除。
 */
export type FontConstraint = 'normal' | 'locked' | 'excluded';

/** 用户录入的字体条目（编辑态） */
export interface FontSpec {
  id: string;
  name: string;
  rangesText: string;
  /**
   * 已上传字体文件的解析结果；null 表示未上传。
   * 注意：只保存解析出的区间元数据，File/ArrayBuffer 绝不上传、不持久化。
   */
  file: FontFileInfo | null;
  /**
   * 入链约束。约束随字体 id 保留：调整列表顺序、上传/清除字体文件、
   * 切换「按实测覆盖求解」均不影响；仅对范围有效的字体生效。
   */
  constraint: FontConstraint;
}

/** 解析后的字体条目 */
export interface ParsedFont extends FontSpec {
  /** 声明范围：归一化、合并后的闭区间码位范围 */
  ranges: [number, number][];
  /** 声明范围解析错误信息；null 表示可用 */
  error: string | null;
  /** 声明范围覆盖的码位总数 */
  codepointCount: number;
  /** 字体文件解析错误（仅该条目自身，不影响声明范围与其他字体） */
  fileError: string | null;
  /**
   * 当前分析实际生效的范围：
   * - 开关开启且文件已解析：文件 cmap 实测范围
   * - 否则：声明范围
   */
  effectiveRanges: [number, number][];
  /** 生效范围来源 */
  effectiveSource: 'declared' | 'measured';
  /** 生效范围的码位总数 */
  effectiveCount: number;
  /** 声明有、实测无的区间（仅文件解析成功且声明范围有效时计算） */
  diffDeclaredOnly?: [number, number][];
  /** 实测有、声明无的区间 */
  diffMeasuredOnly?: [number, number][];
}

/** 声明范围与实测覆盖的双向差集 */
export interface RangeDiff {
  /** 声明有、实测无（A − B） */
  declaredOnly: [number, number][];
  declaredOnlyCount: number;
  /** 实测有、声明无（B − A） */
  measuredOnly: [number, number][];
  measuredOnlyCount: number;
}

/** 字素簇的承接状态 */
export type ClusterStatus = 'covered' | 'missing' | 'free';

/**
 * 缺失细分（仅 status === 'missing' 时有意义）：
 * - natural：自然缺失，任何有效字体都不覆盖；
 * - constraint：约束导致缺失，候选字体全部被「禁止入链」排除。
 */
export type MissingKind = 'natural' | 'constraint';

/** 单个字素簇的审计结果 */
export interface ClusterAudit {
  index: number;
  /** 簇文本（原样） */
  text: string;
  /** 在原文中的 UTF-16 偏移 */
  start: number;
  /** 簇内全部码位 */
  codepoints: number[];
  /** 需要字体实际覆盖的码位（已剔除透明格式字符时） */
  required: number[];
  /** 可完整覆盖该簇的字体下标（相对有效字体列表） */
  candidates: number[];
  /** 仅含透明格式字符，无需专门字体 */
  free: boolean;
  /** 回退链中实际承接它的字体下标；null 表示缺失 */
  assigned: number | null;
  status: ClusterStatus;
  /** 缺失细分；非缺失簇为 null */
  missingKind: MissingKind | null;
  /**
   * 约束缺失时：解除「禁止入链」即可覆盖该簇的字体下标（相对有效字体列表）；
   * 其余情况为空数组。
   */
  unblockFonts: number[];
  /** 所有字体都不覆盖的码位（仅自然缺失时有值） */
  missingCodepoints: number[];
}

/** 审计模式：单场景（原单文本）或场景集（多文本合并求解） */
export type AuditMode = 'single' | 'set';

/** 文本场景：一段独立命名的待渲染文本 */
export interface ScenarioSpec {
  id: string;
  /** 用户可重命名的场景名 */
  name: string;
  text: string;
}

/** 场景集模式下带场景归属的字素簇审计结果 */
export interface ScenarioClusterAudit extends ClusterAudit {
  /** 所属场景 id */
  scenarioId: string;
  /** 簇在所属场景内的局部下标（从 0 开始） */
  localIndex: number;
}
