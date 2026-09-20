import type { FontSpec } from '../types';

let counter = 0;
export function uid(): string {
  counter += 1;
  return `font-${Date.now().toString(36)}-${counter}`;
}

export const SAMPLE_TEXT = `Hello 世界！Grüße café ☕
Emoji: 🌍 🚀 👨‍👩‍👧‍👦 ❤️
生僻字：𠮷野家、𡈽
Arabic: مرحبا بالعالم`;

/**
 * 样例字体：
 * - 前四种分别覆盖拉丁 / 汉字 / 表情 / 阿拉伯文，构成最短可行链；
 * - Backup Sans 与前两者重叠，应被求解器判定为冗余而丢弃；
 * - 𠮷(U+20BB7)、𡈽(U+2123D) 不在任何范围内，用于演示“缺失”标记。
 */
export function sampleFonts(): FontSpec[] {
  return [
    { name: 'Latin Core', rangesText: 'U+0009-000A, U+0020-007E, U+00A0-00FF' },
    { name: 'Han Sans SC', rangesText: 'U+3000-303F, U+4E00-9FFF, U+FF00-FFEF' },
    { name: 'Emoji Color', rangesText: 'U+200D, U+FE0F, U+2615, U+1F1E6-1F1FF, U+1F300-1FAFF, U+2700-27BF' },
    { name: 'Arabic Naskh', rangesText: 'U+0600-06FF, U+0750-077F, U+FE70-FEFF' },
    { name: 'Backup Sans', rangesText: 'U+0020-007E, U+4E00-9FFF' },
  ].map((f) => ({ id: uid(), ...f, file: null, constraint: 'normal' as const }));
}
