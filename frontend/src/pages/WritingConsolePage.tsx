import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import { motion, AnimatePresence } from 'framer-motion'
import PageTransition from '../components/ui/PageTransition'
import DisabledTooltip from '../components/ui/DisabledTooltip'
import { validateField, type FieldError } from '../utils/validation'
import ChapterTOC from '../components/chapter/ChapterTOC'
import ChapterExportMenu from '../components/chapter/ChapterExportMenu'
import ReadingModeToolbar from '../components/ui/ReadingModeToolbar'
import type { ChapterContent } from '../services/exportService'
import { useSSEStream } from '../hooks/useSSEStream'
import { useStreamStore, type GenerationForm, type StreamChapter } from '../stores/useStreamStore'
import { useProjectStore } from '../stores/useProjectStore'
import { useToastStore } from '../stores/useToastStore'
import { useActivityStore } from '../stores/useActivityStore'
import { useUIStore } from '../stores/useUIStore'

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
    const { start, stop, generating } = useSSEStream()
    const addToast = useToastStore((s) => s.addToast)
    const addRecord = useActivityStore((s) => s.addRecord)

    const sections = useStreamStore((s) => s.sections)
    const chapters = useStreamStore((s) => s.chapters)
    const logs = useStreamStore((s) => s.logs)
    const error = useStreamStore((s) => s.error)

    const currentProject = useProjectStore((s) => s.currentProject)
    const fetchProject = useProjectStore((s) => s.fetchProject)

    const readingMode = useUIStore((s) => s.readingMode)
    const enterReadingMode = useUIStore((s) => s.enterReadingMode)
    const exitReadingMode = useUIStore((s) => s.exitReadingMode)

    const streamRef = useRef<HTMLElement | null>(null)
    const readingRef = useRef<HTMLElement | null>(null)
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

    const [advErrors, setAdvErrors] = useState<Record<string, FieldError | null>>({})

    /* ── 加载项目信息 ── */
    useEffect(() => {
        if (projectId && !currentProject) {
            fetchProject(projectId)
        }
    }, [projectId, currentProject, fetchProject])

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

    const activeSection = sections[activeChapterIdx]

    /* ── Markdown 合成 ── */
    const markdownText = useMemo(() => {
        if (sections.length === 0) return ''
        return sections
            .map((s) => {
                const body = s.body.trim() || '> 正在生成这一章，请稍候...'
                return `# 第${s.chapterNumber}章 ${s.title}\n\n${body}`
            })
            .join('\n\n---\n\n')
    }, [sections])

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
        return sections.map((s) => ({
            id: s.chapterId,
            chapterNumber: s.chapterNumber,
            title: s.title,
            wordCount: s.body.length,
        }))
    }, [sections])

    /* ── 导出数据 ── */
    const exportChapters: ChapterContent[] = useMemo(() => {
        return sections
            .filter((s) => s.body.trim().length > 0)
            .map((s) => ({
                chapterNumber: s.chapterNumber,
                title: s.title,
                content: s.body,
            }))
    }, [sections])

    /* ── 预设 ── */
    function applyPreset(preset: 'fast' | 'standard' | 'sprint') {
        if (preset === 'fast') {
            setForm((p) => ({ ...p, scope: 'volume' as const, mode: 'quick' as const, chapter_count: 4, words_per_chapter: 1200 }))
        } else if (preset === 'sprint') {
            setForm((p) => ({ ...p, scope: 'book' as const, mode: 'studio' as const, chapter_count: 20, words_per_chapter: 1800 }))
        } else {
            setForm((p) => ({ ...p, scope: 'volume' as const, mode: 'studio' as const, chapter_count: 8, words_per_chapter: 1600 }))
        }
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
            ? `# 第${activeSection.chapterNumber}章 ${activeSection.title}\n\n${activeSection.body}`
            : markdownText

        return (
            <div className="reading-content">
                <AnimatePresence>
                    <ReadingModeToolbar
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
                </AnimatePresence>
                <article className="stream-paper" ref={readingRef}>
                    {readingMarkdown ? (
                        <ReactMarkdown>{readingMarkdown}</ReactMarkdown>
                    ) : (
                        <p className="placeholder-text">暂无内容可阅读</p>
                    )}
                </article>
            </div>
        )
    }

    return (
        <PageTransition>
            <div className="writing-page">
                {/* ── 顶部信息栏 ── */}
                <div className="writing-header">
                    <div>
                        <h1 className="writing-header__title">创作控制台</h1>
                        <p className="writing-header__sub">
                            {currentProject?.name || '加载中…'} · {SCOPE_LABELS[form.scope]} · {MODE_LABELS[form.mode]}
                        </p>
                    </div>
                    <div className="writing-header__presets">
                        <button className="chip-btn" onClick={() => applyPreset('fast')}>试跑 4 章</button>
                        <button className="chip-btn" onClick={() => applyPreset('standard')}>标准整卷</button>
                        <button className="chip-btn" onClick={() => applyPreset('sprint')}>整本冲刺</button>
                        {sections.length > 0 && (
                            <button className="chip-btn" onClick={enterReadingMode} title="进入阅读模式" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
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

                {/* ── 主体区域 ── */}
                <div className="writing-body">
                    {/* ── 左侧：目录 ── */}
                    <aside className="writing-sidebar">
                        <ChapterTOC
                            chapters={tocChapters}
                            onSelect={scrollToChapter}
                        />
                        {/* ── 生成统计 ── */}
                        {chapters.length > 0 && (
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
                        )}
                        {/* ── 日志面板 ── */}
                        <div className="writing-logs" ref={logRef}>
                            <p className="writing-logs__title">生成日志</p>
                            {logs.length === 0 ? (
                                <p className="placeholder-text">暂无日志</p>
                            ) : (
                                logs.map((line, i) => (
                                    <p key={i} className="writing-logs__line">{line}</p>
                                ))
                            )}
                        </div>
                    </aside>

                    {/* ── 右侧：内容 + 表单 ── */}
                    <section className="writing-main">
                        {/* ── 脉冲加载指示器 ── */}
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

                        {/* ── 流式内容展示区 ── */}
                        <article className="stream-paper" ref={streamRef}>
                            {markdownText ? (
                                <ReactMarkdown>{markdownText}</ReactMarkdown>
                            ) : (
                                <p className="placeholder-text">
                                    输入创作提示并点击「开始生成」，这里会实时渲染 Markdown 正文。
                                </p>
                            )}
                        </article>

                        {/* ── 生成表单 ── */}
                        <div className="composer-panel">
                            <textarea
                                className="composer-input"
                                rows={3}
                                value={form.prompt}
                                onChange={(e) => setForm((p) => ({ ...p, prompt: e.target.value }))}
                                placeholder="一句话输入你的小说核心：主角是谁、冲突是什么、目标是什么。"
                            />

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

                                <button className="ghost-btn" onClick={stop} disabled={!generating}>
                                    停止
                                </button>
                            </div>

                            {/* ── 高级设置 ── */}
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
                                            value={form.chapter_count}
                                            onChange={(e) =>
                                                setForm((p) => ({ ...p, chapter_count: Number(e.target.value) || 1 }))
                                            }
                                            onFocus={() =>
                                                setAdvErrors((prev) => ({
                                                    ...prev,
                                                    chapter_count: validateField(form.chapter_count, { min: 1, max: 60, hint: '推荐 8-12 章' }),
                                                }))
                                            }
                                            onBlur={() =>
                                                setAdvErrors((prev) => ({
                                                    ...prev,
                                                    chapter_count: validateField(form.chapter_count, { min: 1, max: 60, hint: '推荐 8-12 章' }),
                                                }))
                                            }
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
                                            value={form.words_per_chapter}
                                            onChange={(e) =>
                                                setForm((p) => ({ ...p, words_per_chapter: Number(e.target.value) || 1600 }))
                                            }
                                            onFocus={() =>
                                                setAdvErrors((prev) => ({
                                                    ...prev,
                                                    words_per_chapter: validateField(form.words_per_chapter, { min: 300, max: 12000, hint: '推荐 1200-2000 字' }),
                                                }))
                                            }
                                            onBlur={() =>
                                                setAdvErrors((prev) => ({
                                                    ...prev,
                                                    words_per_chapter: validateField(form.words_per_chapter, { min: 300, max: 12000, hint: '推荐 1200-2000 字' }),
                                                }))
                                            }
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
                    </section>
                </div>
            </div>
        </PageTransition>
    )
}
