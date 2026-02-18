export interface StoryTemplatePreset {
  id: string
  name: string
  category: 'serial' | 'length' | 'structure'
  description: string
  promptHint: string
  recommended: {
    scope: 'volume' | 'book'
    mode: 'studio' | 'quick' | 'cinematic'
    chapterCount: number
    wordsPerChapter: number
    chapterRange?: [number, number]
    targetLength?: number
  }
}

export const STORY_TEMPLATE_PRESETS: StoryTemplatePreset[] = [
  {
    id: 'serial-gintama',
    name: '超长连载 · 单元喜剧主线',
    category: 'serial',
    description: '单元剧日常 + 季度主线并行，强制反收束，适合持续连载。',
    promptHint: '每章新增1个钩子，最多回收1个，章尾必须保留续写触发点。',
    recommended: {
      scope: 'book',
      mode: 'studio',
      chapterCount: 24,
      wordsPerChapter: 1800,
      chapterRange: [18, 40],
      targetLength: 320000,
    },
  },
  {
    id: 'short-story',
    name: '短篇小说',
    category: 'length',
    description: '聚焦单冲突并快速收束，适合测试文风和设定爆发力。',
    promptHint: '一条主冲突，不开第二战场，末段完成情绪闭环。',
    recommended: {
      scope: 'volume',
      mode: 'cinematic',
      chapterCount: 1,
      wordsPerChapter: 6000,
      chapterRange: [1, 2],
      targetLength: 6000,
    },
  },
  {
    id: 'novelette',
    name: '中短篇（Novelette）',
    category: 'length',
    description: '7,500–17,500 字，适合单主线+少量副线。',
    promptHint: '集中讲完一个命题，副线仅用于托举主线。',
    recommended: {
      scope: 'volume',
      mode: 'studio',
      chapterCount: 4,
      wordsPerChapter: 3500,
      chapterRange: [3, 6],
      targetLength: 14000,
    },
  },
  {
    id: 'novella',
    name: '中篇（Novella）',
    category: 'length',
    description: '17,500–40,000 字，角色弧完整但世界观适度展开。',
    promptHint: '人物变化优先于设定铺陈。',
    recommended: {
      scope: 'volume',
      mode: 'studio',
      chapterCount: 10,
      wordsPerChapter: 3000,
      chapterRange: [8, 14],
      targetLength: 30000,
    },
  },
  {
    id: 'novel-standard',
    name: '长篇小说（Novel）',
    category: 'length',
    description: '40,000+ 字长线叙事，主线+两条以内副线。',
    promptHint: '冲突阶梯要持续升级，避免前期透支高潮。',
    recommended: {
      scope: 'book',
      mode: 'studio',
      chapterCount: 20,
      wordsPerChapter: 4500,
      chapterRange: [16, 30],
      targetLength: 90000,
    },
  },
  {
    id: 'three-act',
    name: '三幕式结构',
    category: 'structure',
    description: '开端-对抗-解决，适合商业叙事和节奏稳定的长篇。',
    promptHint: '先定义幕目标，再定义章目标。',
    recommended: {
      scope: 'book',
      mode: 'studio',
      chapterCount: 18,
      wordsPerChapter: 3800,
      chapterRange: [12, 24],
      targetLength: 70000,
    },
  },
  {
    id: 'hero-journey',
    name: '英雄之旅',
    category: 'structure',
    description: '召唤-试炼-归来的成长结构，适合冒险/史诗类。',
    promptHint: '成长来自代价，不来自外挂。',
    recommended: {
      scope: 'book',
      mode: 'studio',
      chapterCount: 24,
      wordsPerChapter: 4200,
      chapterRange: [18, 32],
      targetLength: 100000,
    },
  },
]

export function getStoryTemplateById(templateId?: string | null): StoryTemplatePreset | undefined {
  if (!templateId) return undefined
  return STORY_TEMPLATE_PRESETS.find((item) => item.id === templateId)
}
