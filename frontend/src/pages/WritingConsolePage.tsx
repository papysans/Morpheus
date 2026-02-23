import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import { motion, AnimatePresence } from 'framer-motion'
import PageTransition from '../components/ui/PageTransition'
import DisabledTooltip from '../components/ui/DisabledTooltip'
import { validateField, type FieldError } from '../utils/validation'
import { api } from '../lib/api'
import ChapterTOC from '../components/chapter/ChapterTOC'
import ChapterExportMenu from '../components/chapter/ChapterExportMenu'
import ReadingModeView from '../components/ui/ReadingModeView'
import type { ChapterContent } from '../services/exportService'
import { useSSEStream } from '../hooks/useSSEStream'
import { useStreamStore, type GenerationForm, type StreamChapter, type StreamSection } from '../stores/useStreamStore'
import { useProjectStore } from '../stores/useProjectStore'
import { useToastStore } from '../stores/useToastStore'
import { useActivityStore } from '../stores/useActivityStore'
import { useUIStore } from '../stores/useUIStore'
import { STORY_TEMPLATE_PRESETS, getStoryTemplateById } from '../config/storyTemplates'

/* ── SVG 图标 ── */

export const IconBookOpen = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
        <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
)

/* ── 常量 ── */

const MODE_LABELS: Record<string, string> = {
    studio: '工作室',
    quick: '快速',
    cinematic: '电影感',
}

const SCOPE_LABELS: Record<string, string> = {
    volume: '单卷',
    book: '整本',
}

const CHAPTER_COUNT_RULE = { min: 1, max: 60, hint: '推荐 8-12 章' } as const
const WORDS_PER_CHAPTER_RULE = { min: 300, max: 12000, hint: '推荐 1200-2000 字' } as const
const CONTINUATION_FALLBACK_PROMPT = '延续当前故事，推进未决冲突与人物关系，章尾保留下一章触发点。'

type PersistedWritingSettings = Pick<
    GenerationForm,
    'mode' | 'scope' | 'chapter_count' | 'words_per_chapter' | 'auto_approve'
>

type ChapterPlanDraft = {
    beats: string[]
    conflicts: string[]
    foreshadowing: string[]
    callbackTargets: string[]
    roleGoals: Array<{ role: string; goal: string }>
}

type ParsedSectionBody = {
    narrative: string
    plan: ChapterPlanDraft | null
}

type SectionViewModel = StreamSection & {
    narrativeBody: string
    planDraft: ChapterPlanDraft | null
    displayBody: string
    exportBody: string
}

const PLAN_DRAFT_KEYS = ['beats', 'conflicts', 'foreshadowing', 'callback_targets', 'role_goals'] as const

function isDigitsOnly(value: string) {
    return /^\d*$/.test(value)
}

function normalizePersistedSettings(raw: unknown): PersistedWritingSettings | null {
    if (!raw || typeof raw !== 'object') return null
    const data = raw as Partial<Record<keyof PersistedWritingSettings, unknown>>

    const mode = data.mode === 'studio' || data.mode === 'quick' || data.mode === 'cinematic' ? data.mode : null
    const scope = data.scope === 'volume' || data.scope === 'book' ? data.scope : null
    const chapterCountNum = typeof data.chapter_count === 'number' ? data.chapter_count : Number(data.chapter_count)
    const wordsNum = typeof data.words_per_chapter === 'number' ? data.words_per_chapter : Number(data.words_per_chapter)
    const autoApprove = typeof data.auto_approve === 'boolean' ? data.auto_approve : true

    if (!mode || !scope || Number.isNaN(chapterCountNum) || Number.isNaN(wordsNum)) return null

    return {
        mode,
        scope,
        chapter_count: Math.max(CHAPTER_COUNT_RULE.min, Math.min(CHAPTER_COUNT_RULE.max, Math.floor(chapterCountNum))),
        words_per_chapter: Math.max(WORDS_PER_CHAPTER_RULE.min, Math.min(WORDS_PER_CHAPTER_RULE.max, Math.floor(wordsNum))),
        auto_approve: autoApprove,
    }
}

function normalizeDraftText(value: unknown): string {
    return String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
}

function normalizeDraftList(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value.map((item) => normalizeDraftText(item)).filter(Boolean)
}

function normalizeRoleGoals(value: unknown): Array<{ role: string; goal: string }> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const record = value as Record<string, unknown>
    return Object.entries(record)
        .map(([role, goal]) => ({
            role: normalizeDraftText(role),
            goal: normalizeDraftText(goal),
        }))
        .filter((entry) => entry.role.length > 0 && entry.goal.length > 0)
}

function normalizePlanDraft(raw: unknown): ChapterPlanDraft | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const record = raw as Record<string, unknown>
    const matchedKeys = PLAN_DRAFT_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(record, key))
    if (matchedKeys.length < 2) return null

    const plan: ChapterPlanDraft = {
        beats: normalizeDraftList(record.beats),
        conflicts: normalizeDraftList(record.conflicts),
        foreshadowing: normalizeDraftList(record.foreshadowing),
        callbackTargets: normalizeDraftList(record.callback_targets),
        roleGoals: normalizeRoleGoals(record.role_goals),
    }
    const hasAnyContent =
        plan.beats.length > 0
        || plan.conflicts.length > 0
        || plan.foreshadowing.length > 0
        || plan.callbackTargets.length > 0
        || plan.roleGoals.length > 0

    return hasAnyContent || matchedKeys.length >= 3 ? plan : null
}

function collectJsonCandidates(body: string): Array<{ start: number; end: number; content: string }> {
    const candidates: Array<{ start: number; end: number; content: string }> = []
    const seen = new Set<string>()
    const source = String(body || '')
    const pushCandidate = (start: number, end: number, content: string) => {
        if (start < 0 || end <= start) return
        const normalized = content.trim()
        if (!normalized) return
        const key = `${start}:${end}:${normalized.length}`
        if (seen.has(key)) return
        seen.add(key)
        candidates.push({ start, end, content: normalized })
    }

    const trimmed = source.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        const start = source.indexOf(trimmed)
        pushCandidate(start, start + trimmed.length, trimmed)
    }

    const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi
    let fenceMatch: RegExpExecArray | null = fenceRegex.exec(source)
    while (fenceMatch) {
        pushCandidate(fenceMatch.index, fenceRegex.lastIndex, String(fenceMatch[1] || ''))
        fenceMatch = fenceRegex.exec(source)
    }

    const firstBrace = source.indexOf('{')
    const lastBrace = source.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        pushCandidate(firstBrace, lastBrace + 1, source.slice(firstBrace, lastBrace + 1))
    }

    return candidates
}

function stripDuplicateChapterHeading(text: string, chapterNumber: number, chapterTitle: string): string {
    const source = String(text || '').trim()
    if (!source) return ''
    const lines = source.split(/\r?\n/)
    const firstLine = lines[0]?.trim() ?? ''
    const title = chapterTitle.trim()
    if (!title) return source

    const firstLineCompact = firstLine.replace(/\s+/g, '')
    const headingCompact = `第${chapterNumber}章${title}`.replace(/\s+/g, '')
    if (firstLineCompact === headingCompact || firstLine === title) {
        return lines.slice(1).join('\n').trim()
    }
    return source
}

function parseSectionBody(body: string, chapterNumber: number, chapterTitle: string): ParsedSectionBody {
    const source = String(body || '')
    if (!source.trim()) return { narrative: '', plan: null }

    const candidates = collectJsonCandidates(source)
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate.content)
            const plan = normalizePlanDraft(parsed)
            if (!plan) continue
            const before = source.slice(0, candidate.start).trim()
            const after = source.slice(candidate.end).trim()
            const narrative = [before, after].filter(Boolean).join('\n\n')
            return {
                narrative: stripDuplicateChapterHeading(narrative, chapterNumber, chapterTitle),
                plan,
            }
        } catch {
            // Ignore invalid JSON candidate and continue.
        }
    }

    return {
        narrative: stripDuplicateChapterHeading(source, chapterNumber, chapterTitle),
        plan: null,
    }
}

function formatPlanDraftAsMarkdown(plan: ChapterPlanDraft): string {
    const blocks: string[] = ['## 章节计划草稿']
    if (plan.beats.length > 0) {
        blocks.push('### 节拍', plan.beats.map((item, idx) => `${idx + 1}. ${item}`).join('\n'))
    }
    if (plan.conflicts.length > 0) {
        blocks.push('### 冲突', plan.conflicts.map((item) => `- ${item}`).join('\n'))
    }
    if (plan.foreshadowing.length > 0) {
        blocks.push('### 伏笔', plan.foreshadowing.map((item) => `- ${item}`).join('\n'))
    }
    if (plan.callbackTargets.length > 0) {
        blocks.push('### 回收目标', plan.callbackTargets.map((item) => `- ${item}`).join('\n'))
    }
    if (plan.roleGoals.length > 0) {
        blocks.push('### 角色目标', plan.roleGoals.map((item) => `- **${item.role}**：${item.goal}`).join('\n'))
    }
    if (blocks.length === 1) {
        blocks.push('> 暂无可展示的结构化内容。')
    }
    return blocks.join('\n\n')
}

function composeSectionBodies(
    narrativeBody: string,
    planDraft: ChapterPlanDraft | null,
    waiting: boolean,
): { displayBody: string; exportBody: string } {
    const parts: string[] = []
    const normalizedNarrative = narrativeBody.trim()
    if (normalizedNarrative) parts.push(normalizedNarrative)
    if (planDraft) parts.push(formatPlanDraftAsMarkdown(planDraft))
    const exportBody = parts.join('\n\n').trim()
    return {
        exportBody,
        displayBody: exportBody || (waiting ? '> 正在生成这一章，请稍候...' : ''),
    }
}

function PlanDraftBlock({ plan }: { plan: ChapterPlanDraft }) {
    const hasAnyContent =
        plan.beats.length > 0
        || plan.conflicts.length > 0
        || plan.foreshadowing.length > 0
        || plan.callbackTargets.length > 0
        || plan.roleGoals.length > 0

    if (!hasAnyContent) return null

    return (
        <section className="stream-plan" aria-label="章节计划草稿">
            <div className="stream-plan__head">
                <p className="stream-plan__title">章节计划草稿</p>
                <span className="stream-plan__badge">结构化</span>
            </div>

            <div className="stream-plan__grid">
                <article className="stream-plan__card">
                    <p className="stream-plan__card-title">节拍</p>
                    {plan.beats.length > 0 ? (
                        <ol className="stream-plan__list stream-plan__list--ordered">
                            {plan.beats.map((item, idx) => <li key={`${item}-${idx}`}>{item}</li>)}
                        </ol>
                    ) : (
                        <p className="stream-plan__empty">暂无节拍。</p>
                    )}
                </article>

                <article className="stream-plan__card">
                    <p className="stream-plan__card-title">冲突</p>
                    {plan.conflicts.length > 0 ? (
                        <ul className="stream-plan__list">
                            {plan.conflicts.map((item, idx) => <li key={`${item}-${idx}`}>{item}</li>)}
                        </ul>
                    ) : (
                        <p className="stream-plan__empty">暂无冲突。</p>
                    )}
                </article>

                <article className="stream-plan__card">
                    <p className="stream-plan__card-title">伏笔</p>
                    {plan.foreshadowing.length > 0 ? (
                        <ul className="stream-plan__list">
                            {plan.foreshadowing.map((item, idx) => <li key={`${item}-${idx}`}>{item}</li>)}
                        </ul>
                    ) : (
                        <p className="stream-plan__empty">暂无伏笔。</p>
                    )}
                </article>

                <article className="stream-plan__card">
                    <p className="stream-plan__card-title">回收目标</p>
                    {plan.callbackTargets.length > 0 ? (
                        <ul className="stream-plan__list">
                            {plan.callbackTargets.map((item, idx) => <li key={`${item}-${idx}`}>{item}</li>)}
                        </ul>
                    ) : (
                        <p className="stream-plan__empty">暂无回收目标。</p>
                    )}
                </article>
            </div>

            <article className="stream-plan__card">
                <p className="stream-plan__card-title">角色目标</p>
                {plan.roleGoals.length > 0 ? (
                    <ul className="stream-plan__list">
                        {plan.roleGoals.map((item, idx) => (
                            <li key={`${item.role}-${idx}`}>
                                <strong>{item.role}</strong>：{item.goal}
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="stream-plan__empty">暂无角色目标。</p>
                )}
            </article>
        </section>
    )
}

/* ── 脉冲加载指示器 ── */

function PulseIndicator({ generated, total }: { generated: number; total: number }) {
    return (
        <div className="writing-pulse">
            <span className="writing-pulse__dot" />
            <span className="writing-pulse__text">
                正在生成中… {generated}/{total} 章已完成
            </span>
        </div>
    )
}

/* ── 主页面 ── */

export default function WritingConsolePage() {
    const { projectId } = useParams<{ projectId: string }>()
    const [searchParams, setSearchParams] = useSearchParams()
    const { start, stop, generating } = useSSEStream()
    const addToast = useToastStore((s) => s.addToast)
    const addRecord = useActivityStore((s) => s.addRecord)

    const sections = useStreamStore((s) => s.sections)
    const chapters = useStreamStore((s) => s.chapters)
    const logs = useStreamStore((s) => s.logs)
    const error = useStreamStore((s) => s.error)
    const clearStream = useStreamStore((s) => s.clearStream)

    const currentProject = useProjectStore((s) => s.currentProject)
    const fetchProject = useProjectStore((s) => s.fetchProject)

    const readingMode = useUIStore((s) => s.readingMode)
    const enterReadingMode = useUIStore((s) => s.enterReadingMode)
    const exitReadingMode = useUIStore((s) => s.exitReadingMode)

    const streamRef = useRef<HTMLElement | null>(null)
    const logRef = useRef<HTMLDivElement | null>(null)

    const [activeChapterIdx, setActiveChapterIdx] = useState(0)

    const [form, setForm] = useState<GenerationForm>({
        prompt: '',
        mode: 'studio',
        scope: 'volume',
        chapter_count: 8,
        words_per_chapter: 1600,
        auto_approve: true,
    })
    const [chapterCountInput, setChapterCountInput] = useState('8')
    const [wordsPerChapterInput, setWordsPerChapterInput] = useState('1600')
    const [continuationPreparing, setContinuationPreparing] = useState(false)
    const [auxPanelOpen, setAuxPanelOpen] = useState(false)
    const [auxPanelTab, setAuxPanelTab] = useState<'toc' | 'stats' | 'logs'>('toc')

    const [advErrors, setAdvErrors] = useState<Record<string, FieldError | null>>({})
    const prefillAppliedRef = useRef(false)
    const settingsLoadedRef = useRef<string | null>(null)
    const settingsHydratedRef = useRef(false)
    const lastSavedSettingsRef = useRef<string | null>(null)

    const settingsStorageKey = useMemo(
        () => (projectId ? `writing-console-settings:${projectId}` : null),
        [projectId],
    )
    const projectTemplate = useMemo(
        () => getStoryTemplateById(currentProject?.template_id),
        [currentProject?.template_id],
    )

    /* ── 加载项目信息 ── */
    useEffect(() => {
        if (projectId && currentProject?.id !== projectId) {
            fetchProject(projectId)
        }
    }, [projectId, currentProject, fetchProject])

    /* ── 读取并持久化高级设置（按项目） ── */
    useEffect(() => {
        if (!settingsStorageKey) return
        if (settingsLoadedRef.current === settingsStorageKey) return
        settingsLoadedRef.current = settingsStorageKey
        settingsHydratedRef.current = false
        try {
            const raw = localStorage.getItem(settingsStorageKey)
            if (!raw) return
            const parsed = normalizePersistedSettings(JSON.parse(raw))
            if (!parsed) return
            lastSavedSettingsRef.current = JSON.stringify(parsed)
            setForm((prev) => ({
                ...prev,
                ...parsed,
            }))
        } catch {
            // Ignore localStorage parse/access failures.
        } finally {
            settingsHydratedRef.current = true
        }
    }, [settingsStorageKey])

    useEffect(() => {
        if (!settingsStorageKey || !settingsHydratedRef.current) return
        const payload: PersistedWritingSettings = {
            mode: form.mode,
            scope: form.scope,
            chapter_count: form.chapter_count,
            words_per_chapter: form.words_per_chapter,
            auto_approve: form.auto_approve,
        }
        const serialized = JSON.stringify(payload)
        if (lastSavedSettingsRef.current === serialized) return
        try {
            localStorage.setItem(settingsStorageKey, serialized)
            lastSavedSettingsRef.current = serialized
        } catch {
            // Ignore localStorage write failures.
        }
    }, [
        settingsStorageKey,
        form.mode,
        form.scope,
        form.chapter_count,
        form.words_per_chapter,
        form.auto_approve,
    ])

    useEffect(() => {
        setChapterCountInput(String(form.chapter_count))
    }, [form.chapter_count])

    useEffect(() => {
        setWordsPerChapterInput(String(form.words_per_chapter))
    }, [form.words_per_chapter])

    /* ── 从项目概览接收快速启动参数 ── */
    useEffect(() => {
        if (prefillAppliedRef.current) return

        const prompt = searchParams.get('prompt')?.trim() ?? ''
        const scope = searchParams.get('scope')
        const hasPrompt = prompt.length > 0
        const hasScope = scope === 'volume' || scope === 'book'

        if (!hasPrompt && !hasScope) {
            prefillAppliedRef.current = true
            return
        }

        setForm((prev) => {
            const next = { ...prev }
            if (hasPrompt && !prev.prompt.trim()) {
                next.prompt = prompt
            }
            if (scope === 'volume' || scope === 'book') {
                next.scope = scope
                if (scope === 'book') {
                    next.chapter_count = Math.max(next.chapter_count, 12)
                } else {
                    next.chapter_count = Math.min(next.chapter_count, 10)
                }
            }
            return next
        })

        prefillAppliedRef.current = true
        setSearchParams((prev) => {
            const next = new URLSearchParams(prev)
            next.delete('prompt')
            next.delete('scope')
            return next
        }, { replace: true })
    }, [searchParams, setSearchParams])

    /* ── Escape 退出阅读模式 ── */
    useEffect(() => {
        function handleKeyDown(e: KeyboardEvent) {
            if (e.key === 'Escape' && readingMode) {
                exitReadingMode()
            }
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [readingMode, exitReadingMode])

    /* ── 阅读模式章节导航 ── */
    const goToPrevChapter = useCallback(() => {
        setActiveChapterIdx((i) => Math.max(0, i - 1))
    }, [])

    const goToNextChapter = useCallback(() => {
        setActiveChapterIdx((i) => Math.min(sections.length - 1, i + 1))
    }, [sections.length])

    const selectReadingChapter = useCallback((idx: number) => {
        setActiveChapterIdx(Math.max(0, Math.min(idx, sections.length - 1)))
        window.scrollTo({ top: 0, behavior: 'smooth' })
    }, [sections.length])

    const sectionViewModels = useMemo<SectionViewModel[]>(
        () =>
            sections.map((section) => {
                const parsed = parseSectionBody(section.body, section.chapterNumber, section.title)
                const bodies = composeSectionBodies(parsed.narrative, parsed.plan, section.waiting)
                return {
                    ...section,
                    narrativeBody: parsed.narrative,
                    planDraft: parsed.plan,
                    displayBody: bodies.displayBody,
                    exportBody: bodies.exportBody,
                }
            }),
        [sections],
    )

    const activeSection = sectionViewModels[activeChapterIdx]
    const readingTocItems = useMemo(
        () =>
            sectionViewModels.map((section, idx) => ({
                id: section.chapterId,
                label: `第${section.chapterNumber}章 · ${section.title}`,
                active: idx === activeChapterIdx,
                onClick: () => selectReadingChapter(idx),
            })),
        [sectionViewModels, activeChapterIdx, selectReadingChapter],
    )

    /* ── Markdown 合成 ── */
    const markdownText = useMemo(() => {
        if (sectionViewModels.length === 0) return ''
        return sectionViewModels
            .map((s) => {
                const body = s.displayBody.trim() || '> 正在生成这一章，请稍候...'
                return `# 第${s.chapterNumber}章 ${s.title}\n\n${body}`
            })
            .join('\n\n---\n\n')
    }, [sectionViewModels])

    /* ── 自动滚动 ── */
    useEffect(() => {
        if (streamRef.current) {
            streamRef.current.scrollTop = streamRef.current.scrollHeight
        }
    }, [markdownText])

    useEffect(() => {
        if (logRef.current) {
            logRef.current.scrollTop = logRef.current.scrollHeight
        }
    }, [logs])

    /* ── 统计 ── */
    const metrics = useMemo(() => {
        const totalWords = chapters.reduce((sum, c) => sum + c.word_count, 0)
        const totalP0 = chapters.reduce((sum, c) => sum + c.p0_count, 0)
        return { generated: chapters.length, totalWords, totalP0 }
    }, [chapters])

    /* ── 目录数据 ── */
    const tocChapters = useMemo(() => {
        return sectionViewModels.map((s) => ({
            id: s.chapterId,
            chapterNumber: s.chapterNumber,
            title: s.title,
            wordCount: s.exportBody.length,
        }))
    }, [sectionViewModels])

    /* ── 导出数据 ── */
    const exportChapters: ChapterContent[] = useMemo(() => {
        return sectionViewModels
            .filter((s) => s.exportBody.trim().length > 0)
            .map((s) => ({
                chapterNumber: s.chapterNumber,
                title: s.title,
                content: s.exportBody,
            }))
    }, [sectionViewModels])

    function applyTemplatePreset(templateId: string) {
        const template = getStoryTemplateById(templateId)
        if (!template) return
        setForm((prev) => ({
            ...prev,
            scope: template.recommended.scope,
            mode: template.recommended.mode,
            chapter_count: template.recommended.chapterCount,
            words_per_chapter: template.recommended.wordsPerChapter,
        }))
        addToast('info', `已套用模板参数：${template.name}`)
    }

    /* ── 开始生成 ── */
    function handleStart() {
        if (!projectId || !form.prompt.trim() || generating) return
        addToast('info', '开始生成，请稍候…')
        start({
            projectId,
            form,
            onChapterStart: (ch: StreamChapter) => {
                addToast('info', `开始第 ${ch.chapter_number} 章：${ch.title}`)
            },
            onChapterDone: (ch: StreamChapter) => {
                addToast('success', `第 ${ch.chapter_number} 章完成（${ch.word_count} 字）`)
            },
            onError: (err: string) => {
                addToast('error', '流式生成中断', {
                    context: '流式生成',
                    actions: [
                        { label: '继续生成', onClick: () => handleStart() },
                        { label: '重新开始', onClick: () => { stop(); handleStart() } },
                    ],
                    detail: err,
                })
                addRecord({ type: 'generate', description: '流式生成中断', status: 'error', retryAction: () => handleStart() })
            },
            onComplete: () => {
                addToast('success', '全部章节生成完成！')
                addRecord({ type: 'generate', description: '全部章节生成完成', status: 'success' })
            },
        })
    }

    async function handleContinueFromLatest() {
        if (!projectId || generating || continuationPreparing) return
        setContinuationPreparing(true)
        try {
            const chapterRes = await api.get(`/projects/${projectId}/chapters`)
            const chapterList = Array.isArray(chapterRes.data) ? chapterRes.data : []
            const latestChapterNumber = chapterList.reduce((max, chapter) => {
                const chapterNo = Number(chapter?.chapter_number || 0)
                return Number.isFinite(chapterNo) ? Math.max(max, chapterNo) : max
            }, 0)
            const startChapterNumber = latestChapterNumber > 0 ? latestChapterNumber + 1 : 1
            const continuationPrompt = form.prompt.trim() || CONTINUATION_FALLBACK_PROMPT
            if (!form.prompt.trim()) {
                addToast('info', '未填写梗概，已使用默认续写提示。')
            }
            addToast('info', `从第 ${startChapterNumber} 章开始续写。`)
            start({
                projectId,
                form: {
                    ...form,
                    prompt: continuationPrompt,
                    continuation_mode: true,
                    start_chapter_number: startChapterNumber,
                },
                onChapterStart: (ch: StreamChapter) => {
                    addToast('info', `开始第 ${ch.chapter_number} 章：${ch.title}`)
                },
                onChapterDone: (ch: StreamChapter) => {
                    addToast('success', `第 ${ch.chapter_number} 章完成（${ch.word_count} 字）`)
                },
                onError: (err: string) => {
                    addToast('error', '续写中断', {
                        context: '续写任务',
                        actions: [
                            { label: '继续续写', onClick: () => void handleContinueFromLatest() },
                            { label: '重新开始', onClick: () => { stop(); void handleContinueFromLatest() } },
                        ],
                        detail: err,
                    })
                    addRecord({ type: 'generate', description: '续写任务中断', status: 'error', retryAction: () => void handleContinueFromLatest() })
                },
                onComplete: () => {
                    addToast('success', '续写批次完成！')
                    addRecord({ type: 'generate', description: '续写批次完成', status: 'success' })
                },
            })
        } catch (error: any) {
            addToast('error', '准备续写失败', {
                context: '续写任务',
                detail: error?.response?.data?.detail || error?.message,
            })
        } finally {
            setContinuationPreparing(false)
        }
    }

    function handleClearCurrentDraft() {
        if (generating) return
        if (sections.length === 0 && chapters.length === 0 && logs.length === 0) return
        const confirmed = window.confirm('确认清空当前创作草稿显示区？该操作不影响已保存章节。')
        if (!confirmed) return
        clearStream()
        addToast('success', '已清空当前创作草稿显示区')
    }

    /* ── 章节跳转 ── */
    function scrollToChapter(chapterId: string) {
        const idx = sections.findIndex((s) => s.chapterId === chapterId)
        if (idx < 0 || !streamRef.current) return
        // 简单实现：按比例滚动
        const el = streamRef.current
        const ratio = idx / Math.max(sections.length, 1)
        el.scrollTo({ top: ratio * el.scrollHeight, behavior: 'smooth' })
    }

    /* ── "开始生成"按钮禁用状态 ── */
    const startDisabled = !projectId || generating || !form.prompt.trim()
    const startDisabledReason = !projectId
        ? '缺少项目信息'
        : !form.prompt.trim()
            ? '请先输入创作提示'
            : generating
                ? '正在生成中，请等待完成或停止当前任务'
                : ''

    /* ── 阅读模式渲染 ── */
    if (readingMode) {
        const readingMarkdown = activeSection
            ? `# 第${activeSection.chapterNumber}章 ${activeSection.title}\n\n${activeSection.displayBody}`
            : markdownText

        return (
            <ReadingModeView
                content={readingMarkdown}
                contentType="markdown"
                emptyText="暂无内容可阅读"
                tocItems={readingTocItems}
                tocTitle="章节选择"
                onExit={exitReadingMode}
                onPrevChapter={goToPrevChapter}
                onNextChapter={goToNextChapter}
                hasPrev={activeChapterIdx > 0}
                hasNext={activeChapterIdx < sections.length - 1}
                currentLabel={
                    activeSection
                        ? `第${activeSection.chapterNumber}章 ${activeSection.title}`
                        : undefined
                }
            />
        )
    }

    return (
        <PageTransition>
            <div className="writing-page">
                <div className="writing-header">
                    <div>
                        <h1 className="writing-header__title">创作控制台</h1>
                        <p className="writing-header__sub">
                            {currentProject?.name || '加载中…'} · {SCOPE_LABELS[form.scope]} · {MODE_LABELS[form.mode]}
                        </p>
                        <p className="muted" style={{ marginTop: 6, marginBottom: 0, fontSize: '0.82rem' }}>
                            本页负责一句话拆章与整卷/整本生成。章节细修、审批和冲突处理请在章节工作台完成。
                        </p>
                    </div>
                    <div className="writing-header__controls">
                        <label className="writing-template-picker">
                            <span>模板预设</span>
                            <select
                                aria-label="模板预设"
                                defaultValue=""
                                onChange={(e) => {
                                    const templateId = e.target.value
                                    if (!templateId) return
                                    applyTemplatePreset(templateId)
                                    e.currentTarget.value = ''
                                }}
                            >
                                <option value="">选择模板（可选）</option>
                                {STORY_TEMPLATE_PRESETS.map((template) => (
                                    <option key={template.id} value={template.id}>
                                        {template.name}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>
                </div>

                <div className={`writing-body${auxPanelOpen ? ' writing-body--with-panel' : ''}`}>
                    <section className="writing-main">
                        <AnimatePresence>
                            {generating && (
                                <motion.div
                                    initial={{ opacity: 0, y: -10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -10 }}
                                    transition={{ duration: 0.2 }}
                                >
                                    <PulseIndicator generated={metrics.generated} total={form.chapter_count} />
                                </motion.div>
                            )}
                        </AnimatePresence>

                        <div className="writing-main__tools">
                            <div className="writing-main__tools-left">
                                <button
                                    className={`chip-btn ${auxPanelOpen ? 'active' : ''}`}
                                    onClick={() => setAuxPanelOpen((v) => !v)}
                                >
                                    {auxPanelOpen ? '隐藏辅助面板' : '显示辅助面板'}
                                </button>
                                {auxPanelOpen && (
                                    <>
                                        <button
                                            className={`chip-btn ${auxPanelTab === 'toc' ? 'active' : ''}`}
                                            onClick={() => setAuxPanelTab('toc')}
                                        >
                                            目录
                                        </button>
                                        <button
                                            className={`chip-btn ${auxPanelTab === 'stats' ? 'active' : ''}`}
                                            onClick={() => setAuxPanelTab('stats')}
                                        >
                                            统计
                                        </button>
                                        <button
                                            className={`chip-btn ${auxPanelTab === 'logs' ? 'active' : ''}`}
                                            onClick={() => setAuxPanelTab('logs')}
                                        >
                                            日志
                                        </button>
                                    </>
                                )}
                            </div>
                            <div className="writing-main__tools-right">
                                {sections.length > 0 && (
                                    <button
                                        className="chip-btn"
                                        onClick={enterReadingMode}
                                        title="进入阅读模式"
                                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                                    >
                                        <IconBookOpen /> 阅读模式
                                    </button>
                                )}
                                {exportChapters.length > 0 && (
                                    <ChapterExportMenu
                                        allChapters={exportChapters}
                                        projectName={currentProject?.name || '未命名项目'}
                                    />
                                )}
                            </div>
                        </div>

                        <article className="stream-paper" ref={streamRef}>
                            {sectionViewModels.length > 0 ? (
                                sectionViewModels.map((section, idx) => (
                                    <section key={section.chapterId} className="stream-section">
                                        <h1 className="stream-section__title">第{section.chapterNumber}章 {section.title}</h1>
                                        {section.narrativeBody && (
                                            <ReactMarkdown>{section.narrativeBody}</ReactMarkdown>
                                        )}
                                        {section.planDraft && <PlanDraftBlock plan={section.planDraft} />}
                                        {!section.narrativeBody && !section.planDraft && (
                                            <p className="placeholder-text">正在生成这一章，请稍候...</p>
                                        )}
                                        {idx < sectionViewModels.length - 1 && <hr />}
                                    </section>
                                ))
                            ) : (
                                <p className="placeholder-text">
                                    输入创作提示并点击「开始生成」，这里会实时渲染 Markdown 正文。
                                </p>
                            )}
                        </article>
                    </section>

                    {auxPanelOpen && (
                        <aside className="writing-aux-panel">
                            {auxPanelTab === 'toc' && (
                                <>
                                    <p className="writing-aux-panel__title">章节目录</p>
                                    {tocChapters.length > 0 ? (
                                        <ChapterTOC
                                            chapters={tocChapters}
                                            onSelect={scrollToChapter}
                                        />
                                    ) : (
                                        <p className="placeholder-text">暂无目录数据</p>
                                    )}
                                </>
                            )}
                            {auxPanelTab === 'stats' && (
                                <>
                                    <p className="writing-aux-panel__title">生成统计</p>
                                    <div className="writing-stats">
                                        <div className="writing-stats__item">
                                            <span className="writing-stats__label">已生成</span>
                                            <strong>{metrics.generated} 章</strong>
                                        </div>
                                        <div className="writing-stats__item">
                                            <span className="writing-stats__label">总字数</span>
                                            <strong>{metrics.totalWords.toLocaleString()}</strong>
                                        </div>
                                        <div className="writing-stats__item">
                                            <span className="writing-stats__label">P0 冲突</span>
                                            <strong>{metrics.totalP0}</strong>
                                        </div>
                                    </div>
                                </>
                            )}
                            {auxPanelTab === 'logs' && (
                                <>
                                    <p className="writing-aux-panel__title">生成日志</p>
                                    <div className="writing-logs" ref={logRef}>
                                        {logs.length === 0 ? (
                                            <p className="placeholder-text">暂无日志</p>
                                        ) : (
                                            logs.map((line, i) => (
                                                <p key={i} className="writing-logs__line">{line}</p>
                                            ))
                                        )}
                                    </div>
                                </>
                            )}
                        </aside>
                    )}
                </div>

                <div className="writing-composer-dock">
                    <div className="composer-panel">
                        <p className="writing-composer-dock__title">创作输入</p>
                        <p className="writing-composer-dock__subtitle">保留一个主入口：输入梗概后开始生成或续写。</p>
                        <div className="writing-composer-dock__prompt">
                            <textarea
                                className="composer-input"
                                rows={3}
                                value={form.prompt}
                                onChange={(e) => setForm((p) => ({ ...p, prompt: e.target.value }))}
                                placeholder="一句话输入你的小说核心：主角是谁、冲突是什么、目标是什么。"
                            />
                            {projectTemplate && (
                                <p className="muted" style={{ margin: '6px 0 0', fontSize: '0.8rem' }}>
                                    当前项目模板：{projectTemplate.name}。{projectTemplate.promptHint}
                                </p>
                            )}
                        </div>

                        <div className="composer-actions">
                            <div className="mode-group">
                                {(['studio', 'quick', 'cinematic'] as const).map((mode) => (
                                    <button
                                        key={mode}
                                        className={`chip-btn ${form.mode === mode ? 'active' : ''}`}
                                        onClick={() => setForm((p) => ({ ...p, mode }))}
                                    >
                                        {MODE_LABELS[mode]}
                                    </button>
                                ))}
                            </div>

                            <div className="mode-group">
                                {(['volume', 'book'] as const).map((scope) => (
                                    <button
                                        key={scope}
                                        className={`chip-btn ${form.scope === scope ? 'active' : ''}`}
                                        onClick={() =>
                                            setForm((p) => ({
                                                ...p,
                                                scope,
                                                chapter_count: scope === 'book'
                                                    ? Math.max(p.chapter_count, 12)
                                                    : Math.min(p.chapter_count, 10),
                                            }))
                                        }
                                    >
                                        {SCOPE_LABELS[scope]}
                                    </button>
                                ))}
                            </div>

                            <DisabledTooltip reason={startDisabledReason} disabled={startDisabled}>
                                <button
                                    className="primary-btn"
                                    onClick={handleStart}
                                    disabled={startDisabled}
                                >
                                    {generating ? '生成中…' : '开始生成'}
                                </button>
                            </DisabledTooltip>

                            <DisabledTooltip
                                reason={
                                    !projectId
                                        ? '缺少项目信息'
                                        : generating
                                            ? '正在生成中，请等待完成或停止当前任务'
                                            : continuationPreparing
                                                ? '正在准备续写任务'
                                                : ''
                                }
                                disabled={!projectId || generating || continuationPreparing}
                            >
                                <button
                                    className="btn btn-secondary"
                                    onClick={() => void handleContinueFromLatest()}
                                    disabled={!projectId || generating || continuationPreparing}
                                >
                                    {continuationPreparing ? '准备续写...' : '从最新章节续写'}
                                </button>
                            </DisabledTooltip>

                            <DisabledTooltip
                                reason={
                                    generating
                                        ? '正在生成中，请先停止当前任务'
                                        : (sections.length === 0 && chapters.length === 0 && logs.length === 0)
                                            ? '当前没有可清空的草稿内容'
                                            : '仅清空当前创作台草稿显示，不影响已保存章节'
                                }
                                disabled={generating || (sections.length === 0 && chapters.length === 0 && logs.length === 0)}
                            >
                                <button
                                    className="btn btn-secondary"
                                    onClick={handleClearCurrentDraft}
                                    disabled={generating || (sections.length === 0 && chapters.length === 0 && logs.length === 0)}
                                >
                                    清空当前草稿
                                </button>
                            </DisabledTooltip>

                            <button className="ghost-btn" onClick={stop} disabled={!generating}>
                                停止
                            </button>
                        </div>

                        <details className="advanced-box">
                            <summary>高级设置</summary>
                            <div className="advanced-grid">
                                <div className="form-group">
                                    <label className="form-label" htmlFor="adv-chapter-count">章节数</label>
                                    <input
                                        id="adv-chapter-count"
                                        className={`field-control${advErrors.chapter_count?.type === 'error' ? ' field-error' : ''}`}
                                        type="number"
                                        min={1}
                                        max={60}
                                        value={chapterCountInput}
                                        onChange={(e) => {
                                            const raw = e.target.value
                                            if (!isDigitsOnly(raw)) return
                                            setChapterCountInput(raw)
                                            if (raw === '') return
                                            setForm((p) => ({ ...p, chapter_count: Number(raw) }))
                                        }}
                                        onFocus={() =>
                                            setAdvErrors((prev) => ({
                                                ...prev,
                                                chapter_count: validateField(form.chapter_count, CHAPTER_COUNT_RULE),
                                            }))
                                        }
                                        onBlur={() => {
                                            if (chapterCountInput.trim() === '') {
                                                setChapterCountInput(String(form.chapter_count))
                                            }
                                            setAdvErrors((prev) => ({
                                                ...prev,
                                                chapter_count: validateField(
                                                    chapterCountInput.trim() === '' ? form.chapter_count : Number(chapterCountInput),
                                                    CHAPTER_COUNT_RULE,
                                                ),
                                            }))
                                        }}
                                    />
                                    {advErrors.chapter_count && (
                                        <span className={`field-message--${advErrors.chapter_count.type}`}>
                                            {advErrors.chapter_count.message}
                                        </span>
                                    )}
                                </div>
                                <div className="form-group">
                                    <label className="form-label" htmlFor="adv-words-per-chapter">每章目标字数</label>
                                    <input
                                        id="adv-words-per-chapter"
                                        className={`field-control${advErrors.words_per_chapter?.type === 'error' ? ' field-error' : ''}`}
                                        type="number"
                                        min={300}
                                        max={12000}
                                        value={wordsPerChapterInput}
                                        onChange={(e) => {
                                            const raw = e.target.value
                                            if (!isDigitsOnly(raw)) return
                                            setWordsPerChapterInput(raw)
                                            if (raw === '') return
                                            setForm((p) => ({ ...p, words_per_chapter: Number(raw) }))
                                        }}
                                        onFocus={() =>
                                            setAdvErrors((prev) => ({
                                                ...prev,
                                                words_per_chapter: validateField(form.words_per_chapter, WORDS_PER_CHAPTER_RULE),
                                            }))
                                        }
                                        onBlur={() => {
                                            if (wordsPerChapterInput.trim() === '') {
                                                setWordsPerChapterInput(String(form.words_per_chapter))
                                            }
                                            setAdvErrors((prev) => ({
                                                ...prev,
                                                words_per_chapter: validateField(
                                                    wordsPerChapterInput.trim() === '' ? form.words_per_chapter : Number(wordsPerChapterInput),
                                                    WORDS_PER_CHAPTER_RULE,
                                                ),
                                            }))
                                        }}
                                    />
                                    {advErrors.words_per_chapter && (
                                        <span className={`field-message--${advErrors.words_per_chapter.type}`}>
                                            {advErrors.words_per_chapter.message}
                                        </span>
                                    )}
                                </div>
                                <label className="checkbox-row">
                                    <input
                                        type="checkbox"
                                        checked={form.auto_approve}
                                        onChange={(e) =>
                                            setForm((p) => ({ ...p, auto_approve: e.target.checked }))
                                        }
                                    />
                                    无 P0 冲突自动审批
                                </label>
                            </div>
                        </details>

                        {error && <p className="error-line">{error}</p>}
                    </div>
                </div>
            </div>
        </PageTransition>
    )
}
