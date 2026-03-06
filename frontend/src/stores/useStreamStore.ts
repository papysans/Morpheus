import { create } from 'zustand'

export interface StreamChapter {
    id: string
    chapter_number: number
    title: string
    status: string
    word_count: number
    p0_count: number
}

export interface StreamSection {
    chapterId: string
    chapterNumber: number
    title: string
    body: string
    waiting: boolean
}

export type AgentStageId = 'director' | 'setter' | 'stylist' | 'arbiter'
export type AgentStageStatus = 'started' | 'completed' | 'failed'

export interface ChapterStageEvent {
    chapter_number: number
    chapter_id: string
    stage: AgentStageId
    status: AgentStageStatus
    label: string
    agent_name: string
    progress_pct: number
    elapsed_ms: number
    eta_ms?: number
    mode: string
}

export interface GenerationForm {
    batch_direction: string
    mode: 'studio' | 'quick' | 'cinematic'
    chapter_count: number
    words_per_chapter: number
    auto_approve: boolean
    continuation_mode?: boolean
}

interface StreamStore {
    generating: boolean
    sections: StreamSection[]
    chapters: StreamChapter[]
    logs: string[]
    error: string | null
    stages: Record<string, ChapterStageEvent>

    startStream: (projectId: string, form: GenerationForm) => void
    stopStream: () => void
    clearStream: () => void

    // 内部 setter，供 useSSEStream hook 使用
    setGenerating: (v: boolean) => void
    setSections: (v: StreamSection[] | ((prev: StreamSection[]) => StreamSection[])) => void
    setChapters: (v: StreamChapter[] | ((prev: StreamChapter[]) => StreamChapter[])) => void
    appendLog: (message: string) => void
    setError: (v: string | null) => void
    setChapterStage: (chapterId: string, stage: ChapterStageEvent) => void
    clearStages: () => void
}

function nowLabel() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

export const useStreamStore = create<StreamStore>((set) => ({
    generating: false,
    sections: [],
    chapters: [],
    logs: [],
    error: null,
    stages: {},

    startStream: (_projectId: string, _form: GenerationForm) => {
        // 实际 SSE 逻辑将在 useSSEStream hook（Task 4.1）中实现
        // 这里仅重置状态，准备开始生成
        set({
            generating: true,
            sections: [],
            chapters: [],
            logs: [],
            error: null,
            stages: {},
        })
    },

    stopStream: () => {
        set({ generating: false })
    },

    clearStream: () => {
        set({
            generating: false,
            sections: [],
            chapters: [],
            logs: [],
            error: null,
            stages: {},
        })
    },

    setGenerating: (v) => set({ generating: v }),

    setSections: (v) =>
        set((state) => ({
            sections: typeof v === 'function' ? v(state.sections) : v,
        })),

    setChapters: (v) =>
        set((state) => ({
            chapters: typeof v === 'function' ? v(state.chapters) : v,
        })),

    appendLog: (message) =>
        set((state) => ({
            logs: [...state.logs.slice(-179), `${nowLabel()}  ${message}`],
        })),

    setError: (v) => set({ error: v }),

    setChapterStage: (chapterId, stage) =>
        set((state) => ({
            stages: { ...state.stages, [chapterId]: stage },
        })),

    clearStages: () => set({ stages: {} }),
}))
