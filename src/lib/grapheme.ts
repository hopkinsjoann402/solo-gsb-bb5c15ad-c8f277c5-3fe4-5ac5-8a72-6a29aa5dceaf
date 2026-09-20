/**
 * 字素簇切分与码位工具。
 * 优先使用 Intl.Segmenter（按用户感知的字素簇切分，正确处理 ZWJ 序列、
 * 组合符、区域指示符旗帜等）；老环境退化为按码位切分。
 */

export interface Grapheme {
  text: string;
  start: number;
  codepoints: number[];
}

interface SegmentLike {
  segment: string;
  index: number;
}

type SegmenterCtor = new (
  locales?: string,
  options?: { granularity: 'grapheme' },
) => { segment(input: string): Iterable<SegmentLike> };

export function toCodepoints(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) out.push(ch.codePointAt(0)!);
  return out;
}

export function segmentGraphemes(text: string): Grapheme[] {
  if (!text) return [];
  const Ctor = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  const out: Grapheme[] = [];
  if (Ctor) {
    const segmenter = new Ctor('und', { granularity: 'grapheme' });
    for (const part of segmenter.segment(text)) {
      out.push({ text: part.segment, start: part.index, codepoints: toCodepoints(part.segment) });
    }
    return out;
  }
  let i = 0;
  for (const ch of text) {
    out.push({ text: ch, start: i, codepoints: toCodepoints(ch) });
    i += ch.length;
  }
  return out;
}

/**
 * 透明（默认不参与覆盖判定的）格式码位：
 * ZWNJ/ZWJ、蒙古文自由变体选择符、变体选择符、标签字符、补充变体选择符。
 * 这些字符本身不需要字体提供字形，跟随簇内其它字符渲染。
 */
const TRANSPARENT_RANGES: [number, number][] = [
  [0x200c, 0x200d],
  [0x180b, 0x180d],
  [0xfe00, 0xfe0f],
  [0xe0020, 0xe007f],
  [0xe0100, 0xe01ef],
];

export function isTransparentCodepoint(cp: number): boolean {
  for (const [s, e] of TRANSPARENT_RANGES) {
    if (cp >= s && cp <= e) return true;
  }
  return false;
}

export function formatCodepoint(cp: number): string {
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}

/** 表格里展示簇文本：空白与控制字符用可见符号代替 */
export function displayCluster(text: string): string {
  if (text === ' ') return '␣';
  if (text === '\t') return '⇥';
  if (text === '\n') return '⏎';
  if (text === '\r') return '␍';
  if (/^\p{Cc}$/u.test(text)) return '�';
  return text;
}
