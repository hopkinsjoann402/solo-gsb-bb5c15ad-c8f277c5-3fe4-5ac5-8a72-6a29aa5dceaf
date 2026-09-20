import type { ScenarioSpec } from '../types';

/** 场景集允许的最大场景数 */
export const MAX_SCENARIOS = 20;

let counter = 0;
export function scenarioUid(): string {
  counter += 1;
  return `scenario-${Date.now().toString(36)}-${counter}`;
}

/** 新建场景：名称可指定，否则使用「场景 N」默认名 */
export function createScenario(name?: string, text = ''): ScenarioSpec {
  return { id: scenarioUid(), name: name ?? '', text };
}

/** 场景默认名（场景名为空时界面展示用） */
export function scenarioDisplayName(s: ScenarioSpec, index: number): string {
  return s.name.trim() ? s.name : `场景 ${index + 1}`;
}

/** 给定同序号场景清单，生成不重名的「场景 N」候选名 */
export function nextDefaultName(existing: ScenarioSpec[]): string {
  const used = new Set(existing.map((s) => s.name.trim()));
  let n = existing.length + 1;
  while (used.has(`场景 ${n}`)) n++;
  return `场景 ${n}`;
}

/**
 * 场景集模式的样例：三段覆盖不同文字体系的文本，
 * 合并后由 Latin Core / Han Sans SC / Emoji Color / Arabic Naskh 构成共享回退链。
 */
export function sampleScenarios(): ScenarioSpec[] {
  const mk = (name: string, text: string): ScenarioSpec => ({
    id: scenarioUid(),
    name,
    text,
  });
  return [
    mk('西语标题', `Hello 世界！Grüße café ☕\nEmoji: 🌍 🚀 ❤️`),
    mk('CJK 正文', `生僻字：𠮷野家、𡈽\n家庭：👨‍👩‍👧‍👦\n旗帜：🇨🇳`),
    mk('阿拉伯语段落', `Arabic: مرحبا بالعالم`),
  ];
}
