/**
 * 纯浏览器端 sfnt（TTF/OTF）解析：只读取 cmap 表，解析 format 4 与 format 12 子表，
 * 合并为实际码位覆盖区间（glyphId !== 0 的码位）。
 *
 * 设计原则：
 * - 不依赖任何第三方库，只读 DataView；
 * - 所有偏移/长度均做边界校验，任何非法结构抛出 SfontParseError，
 *   调用方按字体条目隔离错误（一个坏文件不影响其他字体）；
 * - 不缓存、不上传文件内容，解析完仅返回码位区间。
 *
 * 参考：OpenType 规范 §4.8 cmap — Character to Glyph Index Mapping Table
 *   https://learn.microsoft.com/en-us/typography/opentype/spec/cmap
 */

export class SfntParseError extends Error {}

export interface CmapTableInfo {
  /** 实际使用到的子表格式（4 / 12） */
  formats: number[];
  /** 参与合并的 cmap 编码记录数 */
  subtableCount: number;
  /** 表目录中记录的 cmap 表校验和 */
  checksum: number;
}

export interface SfntParseResult {
  /** 归一化、排序合并后的闭区间码位范围（映射到非 0 glyph id） */
  ranges: [number, number][];
  /** 覆盖的码位总数 */
  codepointCount: number;
  /** sfnt 版本标识（如 0x00010000、'true'、'OTTO'、'ttcf'） */
  sfntVersion: number;
  /** 表数量 */
  numTables: number;
  cmap: CmapTableInfo;
}

const TAG_CMAP = 0x636d6170; // 'cmap'
const MAX_CP = 0x10ffff;
const MIN_FILE = 12; // offset table 长度

/** 视为 Unicode 的编码记录：(platformID, encodingID) */
interface EncodingRecord {
  platformID: number;
  encodingID: number;
  offset: number;
}

/**
 * 解析 sfnt 二进制。抛出 SfntParseError 表示文件结构非法或缺少可用 cmap。
 */
export function parseSfntFont(buffer: ArrayBuffer): SfntParseResult {
  if (buffer.byteLength < MIN_FILE) {
    throw new SfntParseError('文件过小，不是有效的 TTF/OTF 字体（缺少 sfnt 头）');
  }
  const dv = new DataView(buffer);
  const sfntVersion = dv.getUint32(0);

  // 0x00010000 = TrueType, 'true' = Apple TrueType, 'OTTO' = CFF/OpenType, 'typ1'
  // 'ttcf' = 字体集合（本工具按单字体处理，明确报错）
  if (sfntVersion === 0x74746366) {
    throw new SfntParseError('暂不支持 TTC 字体集合（.ttc），请使用单个 TTF/OTF 文件');
  }
  const known =
    sfntVersion === 0x00010000 ||
    sfntVersion === 0x74727565 || // 'true'
    sfntVersion === 0x4f54544f || // 'OTTO'
    sfntVersion === 0x74797031; // 'typ1'
  if (!known) {
    throw new SfntParseError('无法识别的 sfnt 版本标识（不是 TTF/OTF 文件）');
  }

  const numTables = dv.getUint16(4);
  if (numTables === 0) {
    throw new SfntParseError('字体表目录为空（numTables=0）');
  }

  // ---- 表目录：12 字节头 + 每条 16 字节 ----
  const dirEnd = 12 + numTables * 16;
  if (dirEnd > buffer.byteLength) {
    throw new SfntParseError('表目录越界（文件被截断？）');
  }

  let cmapOffset = -1;
  let cmapLength = -1;
  let cmapChecksum = 0;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = dv.getUint32(rec);
    if (tag === TAG_CMAP) {
      cmapChecksum = dv.getUint32(rec + 4);
      cmapOffset = dv.getUint32(rec + 8);
      cmapLength = dv.getUint32(rec + 12);
      break;
    }
  }
  if (cmapOffset < 0) {
    throw new SfntParseError('字体缺少 cmap 表，无法获取码位覆盖');
  }
  if (cmapLength < 4) {
    throw new SfntParseError('cmap 表长度非法');
  }
  if (!safeEnd(cmapOffset, cmapLength, buffer.byteLength)) {
    throw new SfntParseError('cmap 表偏移或长度越界（文件损坏）');
  }

  // ---- cmap 头：version(u16) + numTables(u16) + 编码记录[numTables]（各 8 字节） ----
  const cmapStart = cmapOffset;
  const cmapVersion = dv.getUint16(cmapStart);
  if (cmapVersion > 1) {
    throw new SfntParseError(`cmap 版本号非法：${cmapVersion}`);
  }
  const numEncodings = dv.getUint16(cmapStart + 2);
  if (numEncodings === 0) {
    throw new SfntParseError('cmap 表不含任何编码子表');
  }
  const recordsEnd = cmapStart + 4 + numEncodings * 8;
  if (recordsEnd > cmapStart + cmapLength) {
    throw new SfntParseError('cmap 编码记录数组越界');
  }

  const records: EncodingRecord[] = [];
  for (let i = 0; i < numEncodings; i++) {
    const r = cmapStart + 4 + i * 8;
    const platformID = dv.getUint16(r);
    const encodingID = dv.getUint16(r + 2);
    const offset = dv.getUint32(r + 4);
    // offset 为相对 cmap 起始的字节偏移，子表至少要有 format(u16) 两个字节
    if (offset + 2 > cmapLength) {
      // 单个编码记录非法：跳过该记录（不影响其他子表）
      continue;
    }
    records.push({ platformID, encodingID, offset });
  }

  /**
   * 选出用于 Unicode 覆盖的子表：
   * - format 12：platform 0（任意 Unicode）或 platform 3 / encoding 10（UCS-4）；
   * - format 4：platform 0，或 platform 3 / encoding 1（BMP UCS-2）；
   * 同偏移子表去重；找到 format 12 时仍合并 format 4（规范允许两者并存且互补）。
   * 排除 platform 3 / encoding 0（Symbol，非 Unicode 码位语义）。
   */
  const seenOffsets = new Set<number>();
  let subtableCount = 0;
  const usedFormats = new Set<number>();
  let segments: number[][] = [];

  for (const rec of records) {
    const sub = cmapStart + rec.offset;
    const isUnicode12 =
      (rec.platformID === 0 || (rec.platformID === 3 && rec.encodingID === 10)) &&
      dv.getUint16(sub) === 12;
    const isUnicode4 =
      (rec.platformID === 0 || (rec.platformID === 3 && rec.encodingID === 1)) &&
      dv.getUint16(sub) === 4;
    if (!isUnicode12 && !isUnicode4) continue;
    if (seenOffsets.has(rec.offset)) continue;
    seenOffsets.add(rec.offset);

    const fmt = dv.getUint16(sub);
    const parsed =
      fmt === 12
        ? parseFormat12(dv, sub, cmapStart + cmapLength)
        : parseFormat4(dv, sub, cmapStart + cmapLength);
    segments = segments.concat(parsed);
    usedFormats.add(fmt);
    subtableCount += 1;
  }

  if (subtableCount === 0) {
    throw new SfntParseError('cmap 中没有可用的 Unicode 子表（仅支持 format 4 / 12）');
  }

  const ranges = mergeSegments(segments);
  let codepointCount = 0;
  for (const [s, e] of ranges) codepointCount += e - s + 1;

  return {
    ranges,
    codepointCount,
    sfntVersion,
    numTables,
    cmap: {
      formats: [...usedFormats].sort((a, b) => a - b),
      subtableCount,
      checksum: cmapChecksum,
    },
  };
}

/** 区间 [offset, offset+length) 是否安全落在 size 内（防加法溢出） */
function safeEnd(offset: number, length: number, size: number): boolean {
  return (
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    length >= 0 &&
    offset >= 0 &&
    offset <= size &&
    offset + length <= size
  );
}

/** sfnt 版本标识转可读标签 */
export function formatSfntTag(version: number): string {
  const tags: Record<number, string> = {
    0x4f54544f: 'OTTO',
    0x74727565: 'true',
    0x74797031: 'typ1',
    0x74746366: 'ttcf',
  };
  return tags[version] ?? '0x' + version.toString(16).toUpperCase().padStart(8, '0');
}

/**
 * cmap format 4：分段映射到 delta / rangeOffset（仅 BMP）。
 * 返回 [start, end] 段数组（已剔除 glyphId=0），不做跨段合并。
 */
function parseFormat4(dv: DataView, start: number, tableEnd: number): number[][] {
  // 定长头部 14 字节 + 4 个数组各 segCount*2
  if (start + 14 > tableEnd) {
    throw new SfntParseError('cmap format 4 头部越界');
  }
  const length = dv.getUint16(start + 2);
  if (length < 16) {
    throw new SfntParseError('cmap format 4 长度非法');
  }
  const subEnd = start + length;
  if (subEnd > tableEnd) {
    throw new SfntParseError('cmap format 4 声明长度越界');
  }
  const language = dv.getUint16(start + 4);
  if (language !== 0) {
    throw new SfntParseError(`cmap format 4 language 非 0：${language}`);
  }
  const segCount2 = dv.getUint16(start + 6);
  if (segCount2 === 0 || segCount2 % 2 !== 0) {
    throw new SfntParseError('cmap format 4 segCountX2 非法');
  }
  const segCount = segCount2 / 2;
  if (segCount > 0xffff / 2) {
    throw new SfntParseError('cmap format 4 分段数量异常');
  }
  const arraysEnd = start + 14 + segCount * 8 + 2; // 4 个 segCount 长数组 + reservedPad(2)
  if (arraysEnd > subEnd) {
    throw new SfntParseError('cmap format 4 分段数组越界');
  }

  const endCodes: number[] = new Array(segCount);
  const startCodes: number[] = new Array(segCount);
  const idDeltas: number[] = new Array(segCount);
  const idRangeOffsets: number[] = new Array(segCount);
  for (let i = 0; i < segCount; i++) {
    endCodes[i] = dv.getUint16(start + 14 + i * 2);
  }
  // reservedPad 紧跟 endCode 数组
  const reserved = dv.getUint16(start + 14 + segCount * 2);
  if (reserved !== 0) {
    throw new SfntParseError('cmap format 4 reservedPad 非 0');
  }
  const startBase = start + 14 + segCount * 2 + 2;
  const deltaBase = start + 14 + segCount * 4 + 2;
  const rangeBase = start + 14 + segCount * 6 + 2;
  for (let i = 0; i < segCount; i++) {
    startCodes[i] = dv.getUint16(startBase + i * 2);
    idDeltas[i] = dv.getInt16(deltaBase + i * 2);
    idRangeOffsets[i] = dv.getUint16(rangeBase + i * 2);
  }

  // 末段必须为哨兵 0xFFFF-0xFFFF
  if (endCodes[segCount - 1] !== 0xffff || startCodes[segCount - 1] !== 0xffff) {
    throw new SfntParseError('cmap format 4 缺少 0xFFFF 哨兵段');
  }

  const out: number[][] = [];
  let runStart = -1;
  let prevSegEnd = -1;
  let lastRealEnd = -1;

  for (let i = 0; i < segCount; i++) {
    const segStart = startCodes[i];
    const segEnd = endCodes[i];
    if (segStart > segEnd) {
      throw new SfntParseError(`cmap format 4 第 ${i} 段起点大于终点`);
    }
    if (i > 0 && segStart < startCodes[i - 1]) {
      throw new SfntParseError('cmap format 4 分段未按码位升序排列');
    }

    // format 4 段间可能存在间隙（上一段 end+1 … 本段 start-1 隐式未映射）：
    // 若上一段结束时 run 仍开放，必须在间隙前闭合
    if (runStart >= 0 && segStart > prevSegEnd + 1) {
      out.push([runStart, prevSegEnd]);
      runStart = -1;
    }

    // 0xFFFF-0xFFFF 哨兵段：不产生任何覆盖
    if (segStart === 0xffff && segEnd === 0xffff) break;

    const rangeOffset = idRangeOffsets[i];
    const delta = idDeltas[i];

    for (let cp = segStart; cp <= segEnd; cp++) {
      let glyphId = 0;
      if (rangeOffset === 0) {
        glyphId = (cp + delta) & 0xffff;
      } else {
        // glyphIdOffset 地址 = rangeOffset 字段自身地址 + rangeOffset + (cp - segStart)*2
        const addr = rangeBase + i * 2 + rangeOffset + (cp - segStart) * 2;
        if (addr < 0 || addr + 2 > subEnd) {
          throw new SfntParseError(`cmap format 4 第 ${i} 段 glyphIdArray 寻址越界（U+${cp.toString(16)}）`);
        }
        const g = dv.getUint16(addr);
        glyphId = g === 0 ? 0 : (g + delta) & 0xffff;
      }
      if (glyphId !== 0) {
        if (runStart < 0) runStart = cp;
      } else if (runStart >= 0) {
        out.push([runStart, cp - 1]);
        runStart = -1;
      }
    }
    lastRealEnd = segEnd;
    prevSegEnd = segEnd;
  }
  if (runStart >= 0) out.push([runStart, lastRealEnd]);
  return out;
}

/**
 * cmap format 12：分段 32 位恒定映射（含 BMP 外码位）。
 */
function parseFormat12(dv: DataView, start: number, tableEnd: number): number[][] {
  if (start + 16 > tableEnd) {
    throw new SfntParseError('cmap format 12 头部越界');
  }
  // format u16 / reserved u16 / length u32 / language u32 / numGroups u32
  const reserved = dv.getUint16(start + 2);
  if (reserved !== 0) {
    throw new SfntParseError('cmap format 12 reserved 非 0');
  }
  const length = dv.getUint32(start + 4);
  if (length < 16) {
    throw new SfntParseError('cmap format 12 长度非法');
  }
  const subEnd = start + length;
  if (subEnd > tableEnd) {
    throw new SfntParseError('cmap format 12 声明长度越界');
  }
  const language = dv.getUint32(start + 8);
  if (language !== 0) {
    throw new SfntParseError(`cmap format 12 language 非 0：${language}`);
  }
  const numGroups = dv.getUint32(start + 12);
  const groupsBytes = numGroups * 12;
  if (!Number.isSafeInteger(groupsBytes) || start + 16 + groupsBytes > subEnd) {
    throw new SfntParseError('cmap format 12 分组数组越界或长度非法');
  }

  const out: number[][] = [];
  let prevEnd = -1;
  for (let i = 0; i < numGroups; i++) {
    const g = start + 16 + i * 12;
    const startCharCode = dv.getUint32(g);
    const endCharCode = dv.getUint32(g + 4);
    const startGlyphCode = dv.getUint32(g + 8);
    if (startCharCode > MAX_CP || endCharCode > MAX_CP) {
      throw new SfntParseError(`cmap format 12 第 ${i} 组码位超出 U+10FFFF`);
    }
    if (startCharCode > endCharCode) {
      throw new SfntParseError(`cmap format 12 第 ${i} 组起点大于终点`);
    }
    if (startCharCode <= prevEnd) {
      throw new SfntParseError('cmap format 12 分组未按码位升序排列或存在重叠');
    }
    prevEnd = endCharCode;
    // startGlyphCode=0 表示整组映射到 .notdef，不产生覆盖
    if (startGlyphCode !== 0) {
      const span = endCharCode - startCharCode;
      if (!Number.isSafeInteger(startGlyphCode + span)) {
        throw new SfntParseError(`cmap format 12 第 ${i} 组 glyph id 溢出`);
      }
      out.push([startCharCode, endCharCode]);
    }
  }
  return out;
}

/** 排序并合并相邻/重叠段 */
function mergeSegments(segments: number[][]): [number, number][] {
  const sorted = segments.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1] + 1) {
      last[1] = Math.max(last[1], e);
    } else {
      merged.push([s, e]);
    }
  }
  return merged;
}
