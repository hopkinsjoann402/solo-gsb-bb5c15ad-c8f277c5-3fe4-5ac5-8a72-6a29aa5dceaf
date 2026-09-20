/**
 * Unicode 覆盖范围解析。
 * 支持 CSS unicode-range 风格语法：
 *   U+0020-007E, U+00A0, 4E00-9FFF, U+4??（通配，等价 U+400-4FF）
 * 多个范围用逗号、分号或空白分隔；解析后排序并合并相邻/重叠区间。
 */

export interface ParseResult {
  ranges: [number, number][];
  error: string | null;
}

const MAX_CP = 0x10ffff;

export function parseUnicodeRanges(input: string): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ranges: [], error: '请输入至少一个范围，例如 U+0020-007E' };
  }
  const tokens = trimmed.split(/[,;\s]+/).filter(Boolean);
  const ranges: [number, number][] = [];

  for (const token of tokens) {
    if (token.includes('?')) {
      const m = /^(?:[Uu]\+)?([0-9A-Fa-f?]{1,6})$/.exec(token);
      if (!m || !m[1].includes('?')) {
        return { ranges: [], error: `无法解析通配范围：“${token}”` };
      }
      const start = parseInt(m[1].replace(/\?/g, '0'), 16);
      const end = parseInt(m[1].replace(/\?/g, 'F'), 16);
      if (end > MAX_CP) return { ranges: [], error: `超出 Unicode 上限 U+10FFFF：“${token}”` };
      ranges.push([start, end]);
      continue;
    }
    const m = /^(?:[Uu]\+)?([0-9A-Fa-f]{1,6})(?:-(?:[Uu]\+)?([0-9A-Fa-f]{1,6}))?$/.exec(token);
    if (!m) {
      return { ranges: [], error: `无法解析：“${token}”（示例：U+0020-007E 或 U+4E00）` };
    }
    const start = parseInt(m[1], 16);
    const end = m[2] ? parseInt(m[2], 16) : start;
    if (start > MAX_CP || end > MAX_CP) {
      return { ranges: [], error: `超出 Unicode 上限 U+10FFFF：“${token}”` };
    }
    if (start > end) {
      return { ranges: [], error: `起点大于终点：“${token}”` };
    }
    ranges.push([start, end]);
  }

  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [s, e] of ranges) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1] + 1) {
      last[1] = Math.max(last[1], e);
    } else {
      merged.push([s, e]);
    }
  }
  return { ranges: merged, error: null };
}

export function countCodepoints(ranges: [number, number][]): number {
  return ranges.reduce((sum, [s, e]) => sum + (e - s + 1), 0);
}

/** 归一化：排序并合并相邻/重叠区间 */
export function normalizeRanges(input: [number, number][]): [number, number][] {
  const sorted = [...input].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
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

/** 区间集合差集 A − B（两组均须为已排序合并的闭区间） */
export function subtractRanges(
  a: [number, number][],
  b: [number, number][],
): [number, number][] {
  const out: [number, number][] = [];
  let j = 0;
  for (let [as, ae] of a) {
    // 推进到与 as 可能相交的 B 区间
    while (j < b.length && b[j][1] < as) j++;
    let k = j;
    let cur = as;
    while (k < b.length && b[k][0] <= ae) {
      const [bs, be] = b[k];
      if (bs > cur) out.push([cur, Math.min(ae, bs - 1)]);
      if (be >= cur) cur = be + 1;
      if (cur > ae) break;
      k++;
    }
    if (cur <= ae) out.push([cur, ae]);
  }
  return normalizeRanges(out);
}

/** 紧凑展示区间，例如 U+0020-007E（单码位省略终点），超出 limit 段时折叠 */
export function formatRangesCompact(
  ranges: [number, number][],
  limit = 12,
): { text: string; hidden: number } {
  const parts = ranges.slice(0, limit).map(([s, e]) =>
    s === e
      ? 'U+' + s.toString(16).toUpperCase().padStart(4, '0')
      : `U+${s.toString(16).toUpperCase().padStart(4, '0')}-${e
          .toString(16)
          .toUpperCase()
          .padStart(4, '0')}`,
  );
  const hidden = ranges.length - parts.length;
  return { text: parts.join(', '), hidden };
}
