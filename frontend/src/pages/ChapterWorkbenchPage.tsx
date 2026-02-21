import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useProjectStore } from '../stores/useProjectStore'
import { useToastStore } from '../stores/useToastStore'
import { useActivityStore } from '../stores/useActivityStore'
import { useRecentAccessStore } from '../stores/useRecentAccessStore'
import { useUIStore } from '../stores/useUIStore'
import { useAutoSave } from '../hooks/useAutoSave'
import ChapterExportMenu from '../components/chapter/ChapterExportMenu'
import DisabledTooltip from '../components/ui/DisabledTooltip'
import ReadingModeView from '../components/ui/ReadingModeView'
import Skeleton from '../components/ui/Skeleton'
import PageTransition from '../components/ui/PageTransition'
import type { ChapterContent } from '../services/exportService'

/* ── SVG 图标 ── */

export const IconBookOpen = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
        <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
)

/* ── 类型 ── */

interface Conflict {
    id: string
    severity: 'P0' | 'P1' | 'P2'
    rule_id: string
    reason: string
    suggested_fix?: string
    evidence_paths?: string[]
}

interface Plan {
    beats: string[]
    conflicts: string[]
    foreshadowing: string[]
    callback_targets: string[]
    role_goals: Record<string, string>
}

interface Chapter {
    id: string
    chapter_number: number
    title: string
    goal: string
    plan?: Plan
    draft?: string
    final?: string
    status: string
    word_count: number
    conflicts: Conflict[]
}

interface StreamDonePayload {
    consistency?: {
        can_submit: boolean
        conflicts: Conflict[]
    }
}

type OneShotMode = 'studio' | 'quick' | 'cinematic'

type BlueprintDetailItem = {
    title: string
    detail: string
}

const BLUEPRINT_NOISE_TOKENS = new Set([
    'id',
    'description',
    'type',
    'item',
    'target',
    'source_chapter',
    'potential_use',
])

function cleanBlueprintText(raw: string): string {
    const text = String(raw || '')
        .replace(/\s+/g, ' ')
        .replace(/^[-•*]\s*/, '')
        .trim()
    if (!text) return ''
    if (BLUEPRINT_NOISE_TOKENS.has(text.toLowerCase())) return ''
    return text
}

function parseBlueprintDetailItems(
    values: string[],
    options: {
        titleKeys: string[]
        detailKeys: string[]
        ignoreKeys?: string[]
    },
): BlueprintDetailItem[] {
    const titleKeys = new Set(options.titleKeys.map((k) => k.toLowerCase()))
    const detailKeys = new Set(options.detailKeys.map((k) => k.toLowerCase()))
    const ignoreKeys = new Set((options.ignoreKeys || []).map((k) => k.toLowerCase()))
    const items: BlueprintDetailItem[] = []

    for (const raw of values) {
        const parts = String(raw || '')
            .split(/\s*\/\s*/)
            .map((part) => part.trim())
            .filter(Boolean)

        if (parts.length >= 4) {
            let currentTitle = ''
            let currentDetail = ''
            const pushCurrent = () => {
                const title = cleanBlueprintText(currentTitle)
                const detail = cleanBlueprintText(currentDetail)
                if (!title && !detail) return
                items.push({
                    title: title || '未命名线索',
                    detail: detail || '',
                })
            }

            for (let i = 0; i < parts.length; i += 1) {
                const token = parts[i]
                const key = token.toLowerCase()
                const next = i + 1 < parts.length ? parts[i + 1] : ''
                if (titleKeys.has(key)) {
                    if (currentTitle || currentDetail) pushCurrent()
                    currentTitle = next
                    currentDetail = ''
                    i += 1
                    continue
                }
                if (detailKeys.has(key)) {
                    currentDetail = next
                    i += 1
                    continue
                }
                if (ignoreKeys.has(key)) {
                    i += 1
                    continue
                }
            }
            if (currentTitle || currentDetail) pushCurrent()
            continue
        }

        const cleaned = cleanBlueprintText(raw)
        if (cleaned) {
            items.push({ title: cleaned, detail: '' })
        }
    }

    return items
}

export default function ChapterWorkbenchPage() {
    const { projectId, chapterId } = useParams<{ projectId: string; chapterId: string }>()
    const navigate = useNavigate()

    /* ── Zustand stores ── */
    const currentProject = useProjectStore((s) => s.currentProject)
    const storeChapters = useProjectStore((s) => s.chapters)
    const fetchChapters = useProjectStore((s) => s.fetchChapters)
    const invalidateCache = useProjectStore((s) => s.invalidateCache)
    const addToast = useToastStore((s) => s.addToast)
    const addRecord = useActivityStore((s) => s.addRecord)
    const addAccess = useRecentAccessStore((s) => s.addAccess)
    const readingMode = useUIStore((s) => s.readingMode)
    const enterReadingMode = useUIStore((s) => s.enterReadingMode)
    const exitReadingMode = useUIStore((s) => s.exitReadingMode)

    /* ── 本地状态 ── */
    const [chapter, setChapter] = useState<Chapter | null>(null)
    const [loading, setLoading] = useState(true)
    const [draftContent, setDraftContent] = useState('')
    const [oneShotPrompt, setOneShotPrompt] = useState('')
    const [oneShotMode, setOneShotMode] = useState<OneShotMode>('studio')
    const [oneShotWords, setOneShotWords] = useState(1600)
    const [oneShotWordsInput, setOneShotWordsInput] = useState('1600')
    const [oneShotLoading, setOneShotLoading] = useState(false)
    const [loadingPlan, setLoadingPlan] = useState(false)
    const [streaming, setStreaming] = useState(false)
    const [editing, setEditing] = useState(false)
    const [savingDraft, setSavingDraft] = useState(false)
    const eventSourceRef = useRef<EventSource | null>(null)

    /* ── 自动保存 ── */
    const autoSave = useAutoSave({
        key: `draft-${chapterId}`,
        content: editing ? draftContent : '',
        debounceMs: 2000,
    })
    const [showDraftRestore, setShowDraftRestore] = useState(false)
    const [showRejectConfirm, setShowRejectConfirm] = useState(false)
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
    const [deletingChapter, setDeletingChapter] = useState(false)

    /* ── 加载章节 ── */
    const loadChapter = useCallback(async () => {
        if (!chapterId) return
        try {
            const response = await api.get(`/chapters/${chapterId}`)
            setChapter(response.data)
            setDraftContent(response.data.draft ?? '')
            setOneShotPrompt((prev) => prev || response.data.goal || '')
            setLoading(false)
        } catch (err: any) {
            console.error(err)
            addToast('error', '加载章节失败，请稍后重试')
            setLoading(false)
        }
    }, [chapterId, addToast])

    /* ── 无 chapterId 时加载章节列表 ── */
    useEffect(() => {
        if (!projectId || chapterId) return
        setLoading(true)
        fetchChapters(projectId).finally(() => setLoading(false))
    }, [projectId, chapterId, fetchChapters])

    useEffect(() => {
        if (!chapterId) return
        setLoading(true)
        loadChapter()
        // 同时获取章节列表（用于导出整书和章节导航）
        if (projectId) fetchChapters(projectId)
        return () => {
            eventSourceRef.current?.close()
        }
    }, [chapterId, projectId, loadChapter, fetchChapters])

    useEffect(() => {
        if (chapter && chapterId && projectId) {
            addAccess({
                type: 'chapter',
                id: chapterId,
                name: `第 ${chapter.chapter_number} 章 · ${chapter.title}`,
                path: `/project/${projectId}/chapter/${chapterId}`,
                projectId,
            })
        }
    }, [chapter, chapterId, projectId, addAccess])

    // 退出阅读模式时清理
    useEffect(() => {
        return () => {
            if (readingMode) exitReadingMode()
        }
    }, []) // eslint-disable-line react-hooks/exhaustive-deps

    // 检测本地草稿
    useEffect(() => {
        if (!loading && chapter && autoSave.hasDraft) {
            setShowDraftRestore(true)
        }
    }, [loading, chapter]) // eslint-disable-line react-hooks/exhaustive-deps

    /* ── 草稿恢复处理 ── */
    const handleRestoreDraft = () => {
        const restored = autoSave.restoreDraft()
        if (restored) {
            setDraftContent(restored)
            setEditing(true)
        }
        setShowDraftRestore(false)
    }

    const handleDiscardDraft = () => {
        autoSave.discardDraft()
        setShowDraftRestore(false)
    }

    /* ── 冲突分类 ── */
    const p0Conflicts = useMemo(
        () => (chapter?.conflicts || []).filter((c) => c.severity === 'P0'),
        [chapter],
    )
    const p1Conflicts = useMemo(
        () => (chapter?.conflicts || []).filter((c) => c.severity === 'P1'),
        [chapter],
    )
    const p2Conflicts = useMemo(
        () => (chapter?.conflicts || []).filter((c) => c.severity === 'P2'),
        [chapter],
    )

    const blueprintBeats = useMemo(
        () => (chapter?.plan?.beats || []).map(cleanBlueprintText).filter(Boolean),
        [chapter?.plan?.beats],
    )

    const blueprintConflicts = useMemo(
        () => (chapter?.plan?.conflicts || []).map(cleanBlueprintText).filter(Boolean),
        [chapter?.plan?.conflicts],
    )

    const blueprintForeshadowing = useMemo(
        () =>
            parseBlueprintDetailItems(chapter?.plan?.foreshadowing || [], {
                titleKeys: ['item', '伏笔', '埋伏笔'],
                detailKeys: ['description', '说明'],
            }),
        [chapter?.plan?.foreshadowing],
    )

    const blueprintCallbacks = useMemo(
        () =>
            parseBlueprintDetailItems(chapter?.plan?.callback_targets || [], {
                titleKeys: ['target', '回收目标'],
                detailKeys: ['potential_use', '用途', '回收方式'],
                ignoreKeys: ['source_chapter'],
            }),
        [chapter?.plan?.callback_targets],
    )

    /* ── 章节导航（阅读模式用） ── */
    const sortedChapters = useMemo(
        () => [...storeChapters].sort((a, b) => a.chapter_number - b.chapter_number),
        [storeChapters],
    )
    const currentChapterIndex = useMemo(
        () => sortedChapters.findIndex((c) => c.id === chapterId),
        [sortedChapters, chapterId],
    )
    const hasPrevChapter = currentChapterIndex > 0
    const hasNextChapter = currentChapterIndex >= 0 && currentChapterIndex < sortedChapters.length - 1

    const navigateToChapter = useCallback(
        (idx: number) => {
            const ch = sortedChapters[idx]
            if (ch && projectId) navigate(`/project/${projectId}/chapter/${ch.id}`)
        },
        [sortedChapters, projectId, navigate],
    )
    const readingTocItems = useMemo(
        () =>
            sortedChapters.map((ch, idx) => ({
                id: ch.id,
                label: `第${ch.chapter_number}章 · ${ch.title || '未命名章节'}`,
                active: idx === currentChapterIndex,
                onClick: () => navigateToChapter(idx),
            })),
        [sortedChapters, currentChapterIndex, navigateToChapter],
    )

    /* ── 导出数据 ── */
    const currentChapterExport: ChapterContent | undefined = chapter
        ? {
            chapterNumber: chapter.chapter_number,
            title: chapter.title,
            content: chapter.final || chapter.draft || draftContent || '',
        }
        : undefined

    const allChaptersExport: ChapterContent[] = useMemo(
        () =>
            storeChapters
                .filter((c) => c.word_count > 0)
                .map((c) => ({
                    chapterNumber: c.chapter_number,
                    title: c.title,
                    content: '', // 整书导出需要完整内容，这里仅提供元数据
                })),
        [storeChapters],
    )

    /* ── 操作函数 ── */
    const generatePlan = async () => {
        if (!chapterId) return
        setLoadingPlan(true)
        try {
            await api.post(`/chapters/${chapterId}/plan`)
            await loadChapter()
            addToast('success', '蓝图生成成功')
            addRecord({ type: 'generate', description: '蓝图生成成功', status: 'success' })
        } catch (err: any) {
            console.error(err)
            addToast('error', '蓝图生成失败', {
                context: '蓝图生成',
                actions: [{ label: '重试', onClick: () => void generatePlan() }],
                detail: err?.response?.data?.detail || err?.message,
            })
            addRecord({ type: 'generate', description: '蓝图生成失败', status: 'error', retryAction: () => void generatePlan() })
        } finally {
            setLoadingPlan(false)
        }
    }

    const startDraftStream = (force: boolean, resume: boolean) => {
        if (!chapterId) return
        setStreaming(true)
        const startOffset = resume ? draftContent.length : 0
        if (!resume) setDraftContent('')

        eventSourceRef.current?.close()
        const params = new URLSearchParams({
            force: force ? 'true' : 'false',
            resume_from: String(startOffset),
        })

        const source = new EventSource(`/api/chapters/${chapterId}/draft/stream?${params.toString()}`)
        eventSourceRef.current = source

        source.addEventListener('chunk', (event) => {
            const payload = JSON.parse((event as MessageEvent).data) as { chunk: string }
            setDraftContent((prev) => prev + payload.chunk)
        })

        source.addEventListener('done', async (event) => {
            const payload = JSON.parse((event as MessageEvent).data) as StreamDonePayload
            source.close()
            setStreaming(false)
            if (payload.consistency && chapter) {
                setChapter({
                    ...chapter,
                    conflicts: payload.consistency.conflicts ?? chapter.conflicts,
                    status: payload.consistency.can_submit ? 'reviewing' : chapter.status,
                })
            }
            await loadChapter()
            addToast('success', '草稿生成完成')
            addRecord({ type: 'generate', description: '草稿生成完成', status: 'success' })
        })

        source.onerror = () => {
            source.close()
            setStreaming(false)
            addToast('error', '流式生成中断', {
                context: '流式生成',
                actions: [
                    { label: '继续生成', onClick: () => startDraftStream(false, true) },
                    { label: '重新开始', onClick: () => startDraftStream(true, false) },
                ],
            })
            addRecord({ type: 'generate', description: '流式生成中断', status: 'error', retryAction: () => startDraftStream(false, true) })
        }
    }

    const reviewDraft = async (action: 'approve' | 'reject') => {
        if (!chapterId) return
        try {
            await api.post('/review', { chapter_id: chapterId, action })
            if (projectId) invalidateCache('chapters', projectId)
            await loadChapter()
            addToast('success', action === 'approve' ? '审批通过，可进入下一章节继续创作' : '已退回重写')
            addRecord({ type: 'approve', description: action === 'approve' ? '审批通过' : '退回重写', status: 'success' })
        } catch (err: any) {
            console.error(err)
            addToast('error', '提交审批失败', {
                context: '审批操作',
                actions: [{ label: '重试', onClick: () => void reviewDraft(action) }],
                detail: err?.response?.data?.detail || err?.message,
            })
            addRecord({ type: 'approve', description: '审批操作失败', status: 'error', retryAction: () => void reviewDraft(action) })
        }
    }

    const saveDraft = async () => {
        if (!chapterId) return
        setSavingDraft(true)
        try {
            const response = await api.put(`/chapters/${chapterId}/draft`, { draft: draftContent })
            setChapter(response.data.chapter)
            setEditing(false)
            autoSave.clearDraft()
            if (projectId) invalidateCache('chapters', projectId)
            addToast('success', '草稿保存成功')
            addRecord({ type: 'save', description: '草稿保存成功', status: 'success' })
        } catch (err: any) {
            console.error(err)
            addToast('error', '保存草稿失败', {
                context: '草稿保存',
                actions: [{ label: '重试', onClick: () => void saveDraft() }],
                detail: err?.response?.data?.detail || err?.message,
            })
            addRecord({ type: 'save', description: '草稿保存失败', status: 'error', retryAction: () => void saveDraft() })
        } finally {
            setSavingDraft(false)
        }
    }

    const generateOneShot = async () => {
        if (!chapterId || !oneShotPrompt.trim()) return
        setOneShotLoading(true)
        try {
            const response = await api.post(`/chapters/${chapterId}/one-shot`, {
                prompt: oneShotPrompt.trim(),
                mode: oneShotMode,
                target_words: oneShotWords,
                override_goal: true,
                rewrite_plan: true,
            })
            if (response.data?.chapter) {
                setChapter(response.data.chapter)
                setDraftContent(response.data.chapter.draft ?? response.data.draft ?? '')
            } else {
                setDraftContent(response.data?.draft ?? '')
                await loadChapter()
            }
            addToast('success', '一句话整篇生成完成')
        } catch (err: any) {
            console.error(err)
            addToast('error', err?.response?.data?.detail ?? '一句话整篇生成失败')
        } finally {
            setOneShotLoading(false)
        }
    }

    const projectName = currentProject?.name ?? '小说项目'

    const deleteChapterRequest = async (targetChapterId: string) => {
        try {
            await api.delete(`/chapters/${targetChapterId}`)
        } catch (error: any) {
            if (error?.response?.status === 405) {
                await api.post(`/chapters/${targetChapterId}/delete`)
                return
            }
            throw error
        }
    }

    const handleDeleteChapter = async (recreate: boolean) => {
        if (!chapter || !chapterId || !projectId) return
        setDeletingChapter(true)
        const snapshot = {
            chapter_number: chapter.chapter_number,
            title: chapter.title,
            goal: chapter.goal,
        }
        try {
            await deleteChapterRequest(chapterId)
            if (recreate) {
                const created = await api.post('/chapters', {
                    project_id: projectId,
                    chapter_number: snapshot.chapter_number,
                    title: snapshot.title,
                    goal: snapshot.goal,
                })
                const newChapterId = created?.data?.id
                if (!newChapterId) {
                    throw new Error('章节重建失败：缺少新章节 ID')
                }
                if (projectId) {
                    invalidateCache('project', projectId)
                    invalidateCache('chapters', projectId)
                    await fetchChapters(projectId, { force: true })
                }
                addToast('success', `第 ${snapshot.chapter_number} 章已重建`)
                addRecord({ type: 'delete', description: `删除并重建章节: ${snapshot.title}`, status: 'success' })
                navigate(`/project/${projectId}/chapter/${newChapterId}`)
            } else {
                if (projectId) {
                    invalidateCache('project', projectId)
                    invalidateCache('chapters', projectId)
                }
                addToast('success', `第 ${snapshot.chapter_number} 章已删除`)
                addRecord({ type: 'delete', description: `删除章节: ${snapshot.title}`, status: 'success' })
                navigate(`/project/${projectId}`)
            }
        } catch (error: any) {
            addToast('error', recreate ? '删除并重建失败' : '删除章节失败', {
                context: '章节删除',
                detail: error?.response?.data?.detail || error?.message,
                actions: [
                    {
                        label: '重试',
                        onClick: () => {
                            setShowDeleteConfirm(true)
                        },
                    },
                ],
            })
            addRecord({ type: 'delete', description: recreate ? '删除并重建失败' : '删除章节失败', status: 'error' })
        } finally {
            setDeletingChapter(false)
            setShowDeleteConfirm(false)
        }
    }

    /* ── 无 chapterId：显示章节选择列表 ── */
    if (!chapterId) {
        return (
            <PageTransition>
                <div>
                    <div className="page-head">
                        <div>
                            <Link to={`/project/${projectId}`} className="muted" style={{ textDecoration: 'none' }}>
                                ← 返回项目
                            </Link>
                            <h1 className="title" style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                                <IconBookOpen /> 章节工作台
                            </h1>
                            <p className="subtitle">请选择一个章节进入工作台：</p>
                        </div>
                    </div>
                    {loading ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            <Skeleton variant="card" count={3} />
                        </div>
                    ) : storeChapters.length === 0 ? (
                        <div className="card" style={{ padding: 24, textAlign: 'center' }}>
                            <p className="muted">暂无章节，请先在项目详情页创建章节或使用创作控制台生成。</p>
                            <Link to={`/project/${projectId}`} className="btn btn-primary" style={{ marginTop: 12, textDecoration: 'none', display: 'inline-block' }}>
                                返回项目详情
                            </Link>
                        </div>
                    ) : (
                        <div style={{ display: 'grid', gap: 8 }}>
                            {[...storeChapters].sort((a, b) => a.chapter_number - b.chapter_number).map((ch) => (
                                <button
                                    key={ch.id}
                                    onClick={() => navigate(`/project/${projectId}/chapter/${ch.id}`)}
                                    className="card clickable-card"
                                    style={{
                                        padding: '14px 18px',
                                        textAlign: 'left',
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        border: '1px solid var(--glass-border)',
                                    }}
                                >
                                    <span>
                                        第 {ch.chapter_number} 章{ch.title ? ` · ${ch.title}` : ''}
                                    </span>
                                    <span className="chip">{ch.status}</span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </PageTransition>
        )
    }

    /* ── 骨架屏加载状态 ── */
    if (loading) {
        return (
            <PageTransition>
                <div style={{ padding: 18 }}>
                    <Skeleton variant="text" count={2} />
                    <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1.4fr', gap: 14, marginTop: 16 }}>
                        <div style={{ display: 'grid', gap: 12 }}>
                            <Skeleton variant="card" />
                            <Skeleton variant="card" />
                        </div>
                        <Skeleton variant="card" />
                    </div>
                </div>
            </PageTransition>
        )
    }

    if (!chapter) {
        return (
            <PageTransition>
                <div className="card" style={{ padding: 18 }}>
                    <p style={{ marginTop: 0 }}>章节数据不可用</p>
                    <Link to={`/project/${projectId}`} className="btn btn-secondary" style={{ textDecoration: 'none' }}>
                        返回项目详情
                    </Link>
                </div>
            </PageTransition>
        )
    }

    /* ── 阅读模式 ── */
    if (readingMode) {
        const rawContent = chapter.final || chapter.draft || draftContent || ''
        const displayContent = rawContent
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/【.*?】/g, '')
            .replace(/\[.*?\]/g, '')
            .trim()

        return (
            <PageTransition>
                <ReadingModeView
                    content={displayContent}
                    contentType="markdown"
                    emptyText="暂无内容"
                    tocItems={readingTocItems}
                    tocTitle="章节目录"
                    onExit={exitReadingMode}
                    onPrevChapter={hasPrevChapter ? () => navigateToChapter(currentChapterIndex - 1) : undefined}
                    onNextChapter={hasNextChapter ? () => navigateToChapter(currentChapterIndex + 1) : undefined}
                    hasPrev={hasPrevChapter}
                    hasNext={hasNextChapter}
                    currentLabel={`第 ${chapter.chapter_number} 章 · ${chapter.title}`}
                />
            </PageTransition>
        )
    }

    /* ── 正常模式 ── */
    return (
        <PageTransition>
            <div>
                {/* 页面头部 */}
                <div className="page-head">
                    <div>
                        <Link to={`/project/${projectId}`} className="muted" style={{ textDecoration: 'none' }}>
                            ← 返回项目
                        </Link>
                        <h1 className="title" style={{ marginTop: 6 }}>
                            第 {chapter.chapter_number} 章 · {chapter.title}
                        </h1>
                        <p className="subtitle" style={{ marginBottom: 0 }}>
                            {chapter.goal}
                        </p>
                    </div>
                    <div className="grid-actions">
                        <button className="btn btn-secondary" onClick={() => setShowDeleteConfirm(true)} disabled={streaming || deletingChapter}>
                            {deletingChapter ? '处理中...' : '删除本章'}
                        </button>
                        <ChapterExportMenu
                            currentChapter={currentChapterExport}
                            allChapters={allChaptersExport.length > 0 ? allChaptersExport : undefined}
                            projectName={projectName}
                        />
                        <button className="btn btn-secondary" onClick={enterReadingMode}>
                            阅读模式
                        </button>
                        <Link
                            to={`/project/${projectId}/trace/${chapterId}`}
                            className="btn btn-secondary"
                            style={{ textDecoration: 'none' }}
                        >
                            决策回放
                        </Link>
                    </div>
                </div>

                {/* 主体内容 */}
                <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1.4fr', gap: 14 }}>
                    {/* 左栏 */}
                    <div style={{ display: 'grid', gap: 12 }}>
                        {/* 章节蓝图 */}
                        <section className="card" style={{ padding: 14 }}>
                            <h2 className="section-title">章节蓝图</h2>
                            {!chapter.plan && <p className="muted">尚未生成蓝图。</p>}
                            {chapter.plan && (
                                <div className="blueprint-panel">
                                    <div className="blueprint-group">
                                        <div className="blueprint-group__head">
                                            <div className="metric-label">节拍</div>
                                            <span className="chip">{blueprintBeats.length}</span>
                                        </div>
                                        {blueprintBeats.length === 0 && (
                                            <p className="muted" style={{ margin: '6px 0 0' }}>暂无节拍。</p>
                                        )}
                                        {blueprintBeats.length > 0 && (
                                            <ol className="blueprint-list">
                                                {blueprintBeats.map((item, i) => (
                                                    <li key={`${item}-${i}`} className="blueprint-item">
                                                        <span className="blueprint-item__index">{i + 1}</span>
                                                        <p className="blueprint-item__text">{item}</p>
                                                    </li>
                                                ))}
                                            </ol>
                                        )}
                                    </div>

                                    <div className="blueprint-group">
                                        <div className="blueprint-group__head">
                                            <div className="metric-label">冲突点</div>
                                            <span className="chip p1">{blueprintConflicts.length}</span>
                                        </div>
                                        {blueprintConflicts.length === 0 && (
                                            <p className="muted" style={{ margin: '6px 0 0' }}>暂无冲突点。</p>
                                        )}
                                        {blueprintConflicts.length > 0 && (
                                            <ul className="blueprint-list">
                                                {blueprintConflicts.map((item, i) => (
                                                    <li key={`${item}-${i}`} className="blueprint-item blueprint-item--conflict">
                                                        <span className="blueprint-item__tag">冲突</span>
                                                        <p className="blueprint-item__text">{item}</p>
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>

                                    <div className="blueprint-group">
                                        <div className="blueprint-group__head">
                                            <div className="metric-label">伏笔与回收</div>
                                        </div>
                                        <div className="blueprint-grid">
                                            <article className="blueprint-detail-card">
                                                <div className="blueprint-detail-card__title">埋伏笔</div>
                                                {blueprintForeshadowing.length === 0 && (
                                                    <p className="muted" style={{ margin: '6px 0 0' }}>暂无伏笔。</p>
                                                )}
                                                {blueprintForeshadowing.length > 0 && (
                                                    <ul className="blueprint-detail-list">
                                                        {blueprintForeshadowing.map((item, i) => (
                                                            <li key={`${item.title}-${i}`} className="blueprint-detail-item">
                                                                <p className="blueprint-detail-item__title">{item.title}</p>
                                                                {item.detail && <p className="blueprint-detail-item__detail">{item.detail}</p>}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )}
                                            </article>

                                            <article className="blueprint-detail-card">
                                                <div className="blueprint-detail-card__title">回收目标</div>
                                                {blueprintCallbacks.length === 0 && (
                                                    <p className="muted" style={{ margin: '6px 0 0' }}>暂无回收目标。</p>
                                                )}
                                                {blueprintCallbacks.length > 0 && (
                                                    <ul className="blueprint-detail-list">
                                                        {blueprintCallbacks.map((item, i) => (
                                                            <li key={`${item.title}-${i}`} className="blueprint-detail-item">
                                                                <p className="blueprint-detail-item__title">{item.title}</p>
                                                                {item.detail && <p className="blueprint-detail-item__detail">{item.detail}</p>}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )}
                                            </article>
                                        </div>
                                    </div>
                                </div>
                            )}
                            <div style={{ marginTop: 12 }}>
                                <button className="btn btn-secondary" onClick={generatePlan} disabled={loadingPlan || streaming}>
                                    {loadingPlan ? '生成中...' : chapter.plan ? '重新生成蓝图' : '生成蓝图'}
                                </button>
                            </div>
                        </section>

                        {/* 一致性冲突 */}
                        <section className="card" style={{ padding: 14 }}>
                            <h2 className="section-title">一致性冲突</h2>
                            <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                <span className="chip p0">P0 {p0Conflicts.length}</span>
                                <span className="chip p1">P1 {p1Conflicts.length}</span>
                                <span className="chip p2">P2 {p2Conflicts.length}</span>
                            </div>
                            <div style={{ marginTop: 12, display: 'grid', gap: 8, maxHeight: 220, overflow: 'auto' }}>
                                {(chapter.conflicts || []).length === 0 && (
                                    <p className="muted" style={{ margin: 0 }}>当前无冲突。</p>
                                )}
                                {(chapter.conflicts || []).map((conflict) => (
                                    <article key={conflict.id} className="card-strong" style={{ padding: 10 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                                            <span className={`chip ${conflict.severity.toLowerCase()}`}>{conflict.severity}</span>
                                            <span className="metric-label">{conflict.rule_id}</span>
                                        </div>
                                        <p style={{ margin: '8px 0 0' }}>{conflict.reason}</p>
                                        {conflict.suggested_fix && (
                                            <p className="muted" style={{ margin: '6px 0 0' }}>建议：{conflict.suggested_fix}</p>
                                        )}
                                    </article>
                                ))}
                            </div>
                        </section>
                    </div>

                    {/* 右栏 - 正文草稿 */}
                    <section className="card" style={{ padding: 14 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                            <h2 className="section-title">正文草稿</h2>
                            <span className="chip">字数 {chapter.word_count || draftContent.length}</span>
                        </div>

                        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {/* 一句话整篇 */}
                            <div className="card-strong" style={{ width: '100%', padding: 10, marginBottom: 4 }}>
                                <div className="metric-label" style={{ marginBottom: 6 }}>一句话整篇</div>
                                <textarea
                                    className="textarea"
                                    rows={3}
                                    placeholder="输入一句话梗概，例如：雪夜里主角被同伴背叛后设局反杀。"
                                    value={oneShotPrompt}
                                    onChange={(e) => setOneShotPrompt(e.target.value)}
                                    disabled={streaming || oneShotLoading}
                                />
                                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                                    <select
                                        className="input"
                                        value={oneShotMode}
                                        onChange={(e) => setOneShotMode(e.target.value as OneShotMode)}
                                        disabled={streaming || oneShotLoading}
                                        style={{ width: 170 }}
                                    >
                                        <option value="studio">Studio 多Agent</option>
                                        <option value="quick">Quick 极速</option>
                                        <option value="cinematic">Cinematic 电影感</option>
                                    </select>
                                    <input
                                        className="input"
                                        type="number"
                                        min={300}
                                        max={12000}
                                        value={oneShotWordsInput}
                                        onChange={(e) => {
                                            const raw = e.target.value
                                            if (!/^\d*$/.test(raw)) return
                                            setOneShotWordsInput(raw)
                                            if (!raw) return
                                            const parsed = Number(raw)
                                            if (Number.isFinite(parsed)) {
                                                setOneShotWords(parsed)
                                            }
                                        }}
                                        onBlur={() => {
                                            if (!oneShotWordsInput.trim()) {
                                                setOneShotWordsInput(String(oneShotWords))
                                                return
                                            }
                                            const parsed = Number(oneShotWordsInput)
                                            if (!Number.isFinite(parsed)) {
                                                setOneShotWordsInput(String(oneShotWords))
                                                return
                                            }
                                            const normalized = Math.max(300, Math.min(12000, parsed))
                                            setOneShotWords(normalized)
                                            setOneShotWordsInput(String(normalized))
                                        }}
                                        disabled={streaming || oneShotLoading}
                                        style={{ width: 130 }}
                                    />
                                    <button
                                        className="btn btn-primary"
                                        onClick={generateOneShot}
                                        disabled={streaming || oneShotLoading || !oneShotPrompt.trim()}
                                    >
                                        {oneShotLoading ? '整篇生成中...' : '一句话生成整篇'}
                                    </button>
                                </div>
                            </div>

                            {!chapter.plan && (
                                <button className="btn btn-secondary" onClick={generatePlan} disabled={loadingPlan || streaming}>
                                    先生成蓝图
                                </button>
                            )}
                            <DisabledTooltip reason="正在生成中，请等待完成或停止当前任务" disabled={streaming}>
                                <button className="btn btn-primary" disabled={streaming} onClick={() => startDraftStream(true, false)}>
                                    {streaming ? '流式生成中...' : '流式生成草稿'}
                                </button>
                            </DisabledTooltip>
                            {draftContent.length > 0 && (
                                <button className="btn btn-secondary" disabled={streaming} onClick={() => startDraftStream(false, true)}>
                                    继续流式生成
                                </button>
                            )}
                            <button className="btn btn-secondary" onClick={() => setEditing((s) => !s)}>
                                {editing ? '只读预览' : '手动编辑'}
                            </button>
                            {editing && (
                                <button className="btn btn-secondary" disabled={savingDraft || streaming} onClick={saveDraft}>
                                    {savingDraft ? '保存中...' : '保存编辑并重检'}
                                </button>
                            )}
                            {editing && autoSave.lastSaved && (
                                <span className="muted" style={{ fontSize: '0.8rem', alignSelf: 'center' }}>
                                    已自动保存
                                </span>
                            )}
                        </div>

                        <div style={{ marginTop: 12 }}>
                            {editing ? (
                                <textarea
                                    className="textarea"
                                    rows={22}
                                    value={draftContent}
                                    onChange={(e) => setDraftContent(e.target.value)}
                                />
                            ) : (
                                <div
                                    className="card-strong"
                                    style={{
                                        padding: 12,
                                        minHeight: 420,
                                        whiteSpace: 'pre-wrap',
                                        lineHeight: 1.7,
                                        overflow: 'auto',
                                    }}
                                >
                                    {draftContent || '点击"流式生成草稿"开始创作。'}
                                </div>
                            )}
                        </div>

                        <div className="grid-actions" style={{ marginTop: 12 }}>
                            <DisabledTooltip
                                reason={
                                    p0Conflicts.length > 0
                                        ? '存在 P0 冲突，请先解决后再审批'
                                        : !draftContent.trim()
                                            ? '无草稿内容'
                                            : '正在生成中，请等待完成或停止当前任务'
                                }
                                disabled={streaming || p0Conflicts.length > 0 || !draftContent.trim()}
                            >
                                <button
                                    className="btn btn-primary"
                                    onClick={() => reviewDraft('approve')}
                                    disabled={streaming || p0Conflicts.length > 0 || !draftContent.trim()}
                                >
                                    审批通过
                                </button>
                            </DisabledTooltip>
                            <button className="btn btn-secondary" onClick={() => setShowRejectConfirm(true)} disabled={streaming}>
                                退回重写
                            </button>
                            {p0Conflicts.length > 0 && (
                                <span className="muted" style={{ fontSize: '0.85rem' }}>
                                    存在 {p0Conflicts.length} 个 P0 冲突需解决
                                </span>
                            )}
                        </div>
                    </section>
                </div>

                {/* 退回重写确认对话框 */}
                {showRejectConfirm && (
                    <div className="modal-backdrop">
                        <div className="card" style={{ padding: 20, textAlign: 'center', maxWidth: 360 }}>
                            <p style={{ margin: '0 0 8px', fontWeight: 500 }}>确认退回重写？</p>
                            <p className="muted" style={{ margin: '0 0 16px' }}>
                                退回后当前草稿将标记为需要重写，此操作不可撤销。
                            </p>
                            <div style={{ display: 'flex', justifyContent: 'center', gap: 10 }}>
                                <button className="btn btn-secondary" onClick={() => setShowRejectConfirm(false)}>取消</button>
                                <button className="btn btn-primary" onClick={() => { setShowRejectConfirm(false); reviewDraft('reject') }}>确认退回</button>
                            </div>
                        </div>
                    </div>
                )}

                {/* 删除章节确认对话框 */}
                {showDeleteConfirm && (
                    <div className="modal-backdrop">
                        <div className="card" style={{ padding: 20, textAlign: 'center', maxWidth: 420 }}>
                            <p style={{ margin: '0 0 8px', fontWeight: 500 }}>删除当前章节？</p>
                            <p className="muted" style={{ margin: '0 0 16px' }}>
                                你可以直接删除，或删除后按相同章节号重建一个空白章节继续写。
                            </p>
                            <div style={{ display: 'flex', justifyContent: 'center', gap: 10, flexWrap: 'wrap' }}>
                                <button className="btn btn-secondary" onClick={() => setShowDeleteConfirm(false)} disabled={deletingChapter}>
                                    取消
                                </button>
                                <button className="btn btn-secondary" onClick={() => void handleDeleteChapter(false)} disabled={deletingChapter}>
                                    {deletingChapter ? '删除中...' : '仅删除并返回'}
                                </button>
                                <button className="btn btn-primary" onClick={() => void handleDeleteChapter(true)} disabled={deletingChapter}>
                                    {deletingChapter ? '重建中...' : '删除并重建同编号'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* 草稿恢复对话框 */}
                {showDraftRestore && (
                    <div className="modal-backdrop">
                        <div className="card" style={{ padding: 20, textAlign: 'center', maxWidth: 360 }}>
                            <p style={{ margin: '0 0 8px', fontWeight: 500 }}>发现本地草稿</p>
                            <p className="muted" style={{ margin: '0 0 16px' }}>
                                上次编辑的内容尚未保存到服务器，是否恢复？
                            </p>
                            <div style={{ display: 'flex', justifyContent: 'center', gap: 10 }}>
                                <button className="btn btn-secondary" onClick={handleDiscardDraft}>丢弃草稿</button>
                                <button className="btn btn-primary" onClick={handleRestoreDraft}>恢复草稿</button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </PageTransition>
    )
}
