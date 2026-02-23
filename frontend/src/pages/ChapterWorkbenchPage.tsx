import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { api, LLM_TIMEOUT } from '../lib/api'
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

interface PlanQuality {
    status: 'ok' | 'warn' | 'bad' | string
    score: number
    parser_source?: string
    used_fallback?: boolean
    retried?: boolean
    attempts?: number
    template_phrase_hits?: number
    defaulted_fields?: string[]
    issues?: string[]
    warnings?: string[]
}

interface PlanQualityDebug {
    selected_source?: string
    initial_output_length?: number
    retry_output_length?: number
    initial_output_preview?: string
}

interface Chapter {
    id: string
    chapter_number: number
    title: string
    goal: string
    plan?: Plan
    plan_quality?: PlanQuality | null
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

type BlueprintValueCard = {
    headline: string
    body: string
}

type FanqieCreateFormState = {
    intro: string
    protagonist1: string
    protagonist2: string
    targetReader: 'male' | 'female'
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
    const normalizeKey = (raw: string) =>
        String(raw || '')
            .trim()
            .toLowerCase()
            .replace(/[：:]/g, '')
            .replace(/\s+/g, '_')

    const titleKeys = new Set(options.titleKeys.map(normalizeKey))
    const detailKeys = new Set(options.detailKeys.map(normalizeKey))
    const ignoreKeys = new Set((options.ignoreKeys || []).map(normalizeKey))
    const items: BlueprintDetailItem[] = []
    const flattenedTokens: string[] = []

    for (const raw of values) {
        const source = String(raw || '')
        if (!source.trim()) continue
        const bySlash = source
            .split(/\s*\/\s*/)
            .map((part) => part.trim())
            .filter(Boolean)
        if (bySlash.length > 1) {
            flattenedTokens.push(...bySlash)
            continue
        }
        const byLine = source
            .split(/\r?\n/)
            .map((part) => part.trim())
            .filter(Boolean)
        if (byLine.length > 1) {
            flattenedTokens.push(...byLine)
            continue
        }
        flattenedTokens.push(source.trim())
    }

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
        currentTitle = ''
        currentDetail = ''
    }

    for (let i = 0; i < flattenedTokens.length; i += 1) {
        const token = flattenedTokens[i]
        const key = normalizeKey(token)
        const next = i + 1 < flattenedTokens.length ? flattenedTokens[i + 1] : ''

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

        const cleaned = cleanBlueprintText(token)
        if (!cleaned) continue
        if (!currentTitle) {
            currentTitle = cleaned
            continue
        }
        if (!currentDetail) {
            currentDetail = cleaned
            continue
        }
        pushCurrent()
        currentTitle = cleaned
    }
    if (currentTitle || currentDetail) {
        pushCurrent()
    }

    const deduped = new Map<string, BlueprintDetailItem>()
    for (const item of items) {
        const key = `${item.title}|||${item.detail}`
        if (!deduped.has(key)) deduped.set(key, item)
    }

    return Array.from(deduped.values())
}

export default function ChapterWorkbenchPage() {
    const { projectId, chapterId } = useParams<{ projectId: string; chapterId: string }>()
    const navigate = useNavigate()

    /* ── Zustand stores ── */
    const currentProject = useProjectStore((s) => s.currentProject)
    const storeChapters = useProjectStore((s) => s.chapters)
    const fetchChapters = useProjectStore((s) => s.fetchChapters)
    const fetchProject = useProjectStore((s) => s.fetchProject)
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
    const [editing, setEditing] = useState(true)
    const [savingDraft, setSavingDraft] = useState(false)
    const [publishing, setPublishing] = useState(false)
    const [creatingFanqieBook, setCreatingFanqieBook] = useState(false)
    const [fillingFanqieByLLM, setFillingFanqieByLLM] = useState(false)
    const [showFanqieCreateForm, setShowFanqieCreateForm] = useState(false)
    const [fanqieCreateForm, setFanqieCreateForm] = useState<FanqieCreateFormState>({
        intro: '',
        protagonist1: '',
        protagonist2: '',
        targetReader: 'male',
    })
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
    const [showClearWorkspaceConfirm, setShowClearWorkspaceConfirm] = useState(false)
    const [deletingChapter, setDeletingChapter] = useState(false)

    /* ── 加载章节 ── */
    const loadChapter = useCallback(async () => {
        if (!chapterId) return
        try {
            const response = await api.get(`/chapters/${chapterId}`)
            setChapter(response.data)
            setDraftContent(response.data.draft ?? response.data.final ?? '')
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
        // 同步获取项目与章节列表，避免项目级字段（如 fanqie_book_id）显示滞后
        if (projectId) {
            try {
                void fetchProject(projectId)
            } catch {
                // ignore project preload errors here; chapter load/toast handles main flow
            }
            fetchChapters(projectId)
        }
        return () => {
            eventSourceRef.current?.close()
        }
    }, [chapterId, projectId, loadChapter, fetchChapters, fetchProject])

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

    // 检测本地草稿：只有本地草稿与服务端内容不一致时才提示恢复
    useEffect(() => {
        if (loading || !chapter || !autoSave.hasDraft) return
        const localDraft = autoSave.draftContent ?? ''
        const remoteDraft = chapter.draft ?? chapter.final ?? ''
        if (!localDraft) return

        if (localDraft === remoteDraft) {
            autoSave.clearDraft()
            setShowDraftRestore(false)
            return
        }
        setShowDraftRestore(true)
    }, [loading, chapter, autoSave.hasDraft, autoSave.draftContent, autoSave.clearDraft])

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
            if (!editing || savingDraft || streaming) return
            event.preventDefault()
            void saveDraft()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [editing, savingDraft, streaming, draftContent]) // eslint-disable-line react-hooks/exhaustive-deps

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

    const blueprintConflicts = useMemo<BlueprintValueCard[]>(
        () =>
            parseBlueprintDetailItems(chapter?.plan?.conflicts || [], {
                titleKeys: ['type', '冲突', '冲突类型'],
                detailKeys: ['description', '说明'],
            }).map((item) => ({
                headline: item.title,
                body: item.detail,
            })),
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

    const planQuality = chapter?.plan_quality || null
    const planQualityMessages = useMemo(() => {
        if (!planQuality) return [] as string[]
        const issues = Array.isArray(planQuality.issues) ? planQuality.issues : []
        const warnings = Array.isArray(planQuality.warnings) ? planQuality.warnings : []
        return [...issues, ...warnings].filter(Boolean)
    }, [planQuality])

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
            const response = await api.post(`/chapters/${chapterId}/plan`, null, { timeout: LLM_TIMEOUT })
            const quality = response?.data?.quality as PlanQuality | undefined
            const qualityDebug = response?.data?.quality_debug as PlanQualityDebug | undefined
            if (response?.data?.plan) {
                setChapter((prev) => (prev ? {
                    ...prev,
                    plan: response.data.plan,
                    plan_quality: quality || prev.plan_quality || null,
                } : prev))
            }
            await loadChapter()
            addToast('success', '蓝图生成成功')
            if (quality && String(quality.status).toLowerCase() !== 'ok') {
                const debugMeta = qualityDebug
                    ? `解析来源=${quality.parser_source || '-'}；选用=${qualityDebug.selected_source || '-'}；初次输出长度=${qualityDebug.initial_output_length ?? 0}；重试输出长度=${qualityDebug.retry_output_length ?? 0}`
                    : ''
                const detail = [...(quality.issues || []), ...(quality.warnings || []), debugMeta].filter(Boolean).join('；')
                addToast('warning', '蓝图质量告警', {
                    context: `质量分 ${quality.score ?? '-'}，建议继续重试或手动微调`,
                    detail: detail || '蓝图已生成，但结构质量未达到最佳阈值。',
                })
            }
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
            await api.post('/review', { chapter_id: chapterId, action }, { timeout: LLM_TIMEOUT })
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
            setDraftContent(response.data.chapter?.draft ?? draftContent)
            setEditing(true)
            autoSave.clearDraft()
            if (projectId) {
                invalidateCache('project', projectId)
                invalidateCache('chapters', projectId)
                await Promise.all([
                    fetchProject(projectId, { force: true }),
                    fetchChapters(projectId, { force: true }),
                ])
            }
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
            }, { timeout: LLM_TIMEOUT })
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

    const publishChapterExternally = async () => {
        if (!chapterId || !chapter) return
        const content = (draftContent || chapter.final || chapter.draft || '').trim()
        if (!content) {
            addToast('error', '当前章节内容为空，无法发布')
            return
        }

        setPublishing(true)
        try {
            const response = await api.post(
                `/chapters/${chapterId}/publish`,
                {
                    title: `第${chapter.chapter_number}章 ${chapter.title}`.trim(),
                    content,
                },
                { timeout: 300000 },
            )
            const payload = response.data || {}
            if (projectId) {
                invalidateCache('project', projectId)
                await fetchProject(projectId, { force: true })
            }
            addToast('success', `发布成功：第 ${payload.chapter_number ?? chapter.chapter_number} 章`)
            addRecord({
                type: 'save',
                description: `一键发布成功（book_id=${payload.book_id || 'N/A'}）`,
                status: 'success',
            })
        } catch (err: any) {
            console.error(err)
            const detailRaw = err?.response?.data?.detail
            const detail = typeof detailRaw === 'string'
                ? detailRaw
                : detailRaw?.message || err?.message || '一键发布失败'
            addToast('error', '一键发布失败', {
                context: '番茄发布',
                detail,
                actions: [{ label: '重试', onClick: () => void publishChapterExternally() }],
            })
            addRecord({
                type: 'save',
                description: '一键发布失败',
                status: 'error',
                retryAction: () => void publishChapterExternally(),
            })
        } finally {
            setPublishing(false)
        }
    }

    const createAndBindFanqieBook = async () => {
        if (!projectId) return
        const titleRef = String(currentProject?.name || '').trim()
        const payload = {
            title: titleRef,
            intro: fanqieCreateForm.intro.trim(),
            protagonist1: fanqieCreateForm.protagonist1.trim(),
            protagonist2: fanqieCreateForm.protagonist2.trim(),
            target_reader: fanqieCreateForm.targetReader,
        }
        if (!payload.title) {
            addToast('error', '缺少可引用标题，请先确认项目名称')
            return
        }
        setCreatingFanqieBook(true)
        try {
            const response = await api.post(
                `/projects/${projectId}/fanqie/create-book`,
                payload,
                { timeout: 300000 },
            )
            const result = response.data || {}
            if (projectId) {
                invalidateCache('project', projectId)
                await fetchProject(projectId, { force: true })
            }
            addToast('success', `番茄书本创建并绑定成功（book_id=${result.book_id || 'N/A'}）`)
            addRecord({
                type: 'create',
                description: `番茄书本创建成功（book_id=${result.book_id || 'N/A'}）`,
                status: 'success',
            })
        } catch (err: any) {
            console.error(err)
            const detailRaw = err?.response?.data?.detail
            const detail = typeof detailRaw === 'string'
                ? detailRaw
                : detailRaw?.message || err?.message || '番茄书本创建失败'
            addToast('error', '番茄书本创建失败', {
                context: '番茄创建',
                detail,
                actions: [{ label: '重试', onClick: () => void createAndBindFanqieBook() }],
            })
            addRecord({
                type: 'create',
                description: '番茄书本创建失败',
                status: 'error',
                retryAction: () => void createAndBindFanqieBook(),
            })
        } finally {
            setCreatingFanqieBook(false)
        }
    }

    const clearWorkspaceLocally = () => {
        setDraftContent('')
        setOneShotPrompt('')
        setEditing(true)
        autoSave.clearDraft()
        setShowDraftRestore(false)
        addToast('success', '创作台已清空（仅本地，不影响已保存章节）')
        addRecord({ type: 'save', description: '清空创作台（仅本地）', status: 'success' })
    }

    const fillFanqieFormWithLLM = async () => {
        if (!projectId) return
        setFillingFanqieByLLM(true)
        try {
            const response = await api.post(
                `/projects/${projectId}/fanqie/create-book/suggest`,
                {
                    prompt: chapter?.goal || '',
                },
                { timeout: 120000 },
            )
            const result = response.data || {}
            setFanqieCreateForm((prev) => ({
                ...prev,
                intro: String(result.intro || prev.intro || ''),
                protagonist1: String(result.protagonist1 || prev.protagonist1 || ''),
                protagonist2: String(result.protagonist2 || prev.protagonist2 || ''),
                targetReader: result.target_reader === 'female' ? 'female' : 'male',
            }))
            addToast('success', 'LLM 已填充番茄创建参数')
        } catch (err: any) {
            console.error(err)
            const detailRaw = err?.response?.data?.detail
            const detail = typeof detailRaw === 'string'
                ? detailRaw
                : detailRaw?.message || err?.message || 'LLM 填充失败'
            addToast('error', 'LLM 填充失败', {
                context: '番茄参数',
                detail,
            })
        } finally {
            setFillingFanqieByLLM(false)
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
            .replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, '')
            .replace(/【\s*(?:thinking|thoughts?|reasoning)\s*[:：][^】]*】/gi, '')
            .replace(/^\s*\[(?:thinking|thoughts?|reasoning)\s*[:：][^\]]*]\s*$/gim, '')
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
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', width: '100%', flexBasis: '100%' }}>
                        <div className="grid-actions">
                            <button className="btn btn-secondary" onClick={() => setShowDeleteConfirm(true)} disabled={streaming || deletingChapter}>
                                {deletingChapter ? '处理中...' : '删除本章'}
                            </button>
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
                        <div className="grid-actions" style={{ marginLeft: 'auto' }}>
                            <button
                                className="btn btn-secondary"
                                onClick={() => setShowFanqieCreateForm((v) => !v)}
                                disabled={creatingFanqieBook || fillingFanqieByLLM || streaming}
                            >
                                {showFanqieCreateForm ? '收起番茄参数' : '填写番茄参数'}
                            </button>
                            <DisabledTooltip
                                reason={
                                    creatingFanqieBook
                                        ? '正在创建番茄书本，请稍候'
                                        : streaming
                                            ? '请先等待当前生成流程结束'
                                            : '将调用 Playwright 在番茄后台创建新书并自动绑定 book_id'
                                }
                                disabled={creatingFanqieBook || fillingFanqieByLLM || streaming}
                            >
                                <button
                                    className="btn btn-secondary"
                                    onClick={() => void createAndBindFanqieBook()}
                                    disabled={creatingFanqieBook || fillingFanqieByLLM || streaming}
                                >
                                    {creatingFanqieBook ? '创建中...' : '创建并绑定番茄书本'}
                                </button>
                            </DisabledTooltip>
                            <ChapterExportMenu
                                currentChapter={currentChapterExport}
                                allChapters={allChaptersExport.length > 0 ? allChaptersExport : undefined}
                                projectName={projectName}
                            />
                            <DisabledTooltip
                                reason={
                                    publishing
                                        ? '正在发布，请稍候'
                                        : !draftContent.trim()
                                            ? '当前无可发布正文'
                                            : '请先等待当前生成流程结束'
                                }
                                disabled={publishing || streaming || !draftContent.trim()}
                            >
                                <button
                                    className="btn btn-primary"
                                    onClick={() => void publishChapterExternally()}
                                    disabled={publishing || streaming || !draftContent.trim()}
                                >
                                    {publishing ? '发布中...' : '一键发布章节'}
                                </button>
                            </DisabledTooltip>
                            <span className="muted" style={{ fontSize: '0.78rem' }}>
                                当前 book_id：{currentProject?.fanqie_book_id || '未绑定'}
                            </span>
                        </div>
                    </div>
                </div>

                {showFanqieCreateForm && (
                    <section className="card" style={{ padding: 14, marginBottom: 14 }}>
                        <h3 className="section-title" style={{ marginTop: 0, marginBottom: 12 }}>番茄创建参数</h3>
                        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                            <button
                                className="btn btn-secondary"
                                onClick={() => void fillFanqieFormWithLLM()}
                                disabled={fillingFanqieByLLM || creatingFanqieBook}
                            >
                                {fillingFanqieByLLM ? 'LLM 填充中...' : 'LLM 填充剩余字段'}
                            </button>
                            <span className="muted" style={{ fontSize: '0.78rem', alignSelf: 'center' }}>
                                标题固定引用项目名，不参与 LLM 生成。
                            </span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(220px, 1fr))', gap: 10 }}>
                            <label>
                                <div className="metric-label" style={{ marginBottom: 6 }}>书本名称（≤15）</div>
                                <input
                                    className="input"
                                    value={String(currentProject?.name || '')}
                                    maxLength={15}
                                    readOnly
                                    placeholder="引用项目名"
                                />
                            </label>
                            <label>
                                <div className="metric-label" style={{ marginBottom: 6 }}>目标读者</div>
                                <select
                                    className="select"
                                    value={fanqieCreateForm.targetReader}
                                    onChange={(e) =>
                                        setFanqieCreateForm((prev) => ({
                                            ...prev,
                                            targetReader: e.target.value === 'female' ? 'female' : 'male',
                                        }))
                                    }
                                >
                                    <option value="male">男频</option>
                                    <option value="female">女频</option>
                                </select>
                            </label>
                            <label>
                                <div className="metric-label" style={{ marginBottom: 6 }}>主角名1（可选）</div>
                                <input
                                    className="input"
                                    value={fanqieCreateForm.protagonist1}
                                    maxLength={5}
                                    onChange={(e) =>
                                        setFanqieCreateForm((prev) => ({ ...prev, protagonist1: e.target.value }))
                                    }
                                    placeholder="最多5字"
                                />
                            </label>
                            <label>
                                <div className="metric-label" style={{ marginBottom: 6 }}>主角名2（可选）</div>
                                <input
                                    className="input"
                                    value={fanqieCreateForm.protagonist2}
                                    maxLength={5}
                                    onChange={(e) =>
                                        setFanqieCreateForm((prev) => ({ ...prev, protagonist2: e.target.value }))
                                    }
                                    placeholder="最多5字"
                                />
                            </label>
                        </div>
                        <label style={{ display: 'block', marginTop: 10 }}>
                            <div className="metric-label" style={{ marginBottom: 6 }}>作品简介（建议 ≥50）</div>
                            <textarea
                                className="input"
                                value={fanqieCreateForm.intro}
                                maxLength={500}
                                onChange={(e) =>
                                    setFanqieCreateForm((prev) => ({ ...prev, intro: e.target.value }))
                                }
                                placeholder="可留空（后端会按项目信息补全）"
                                style={{ minHeight: 100, resize: 'vertical' }}
                            />
                        </label>
                        <div className="muted" style={{ marginTop: 6, fontSize: '0.78rem' }}>
                            当前简介字数：{fanqieCreateForm.intro.trim().length}，若不足 50 字后端会自动补齐。
                        </div>
                    </section>
                )}

                {/* 主体内容 */}
                <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1.4fr', gap: 14 }}>
                    {/* 左栏 */}
                    <div style={{ display: 'grid', gap: 12 }}>
                        {/* 章节蓝图 */}
                        <section className="card" style={{ padding: 14 }}>
                            <h2 className="section-title">章节蓝图</h2>
                            {planQuality && String(planQuality.status).toLowerCase() !== 'ok' && (
                                <div
                                    className={`blueprint-quality-alert ${String(planQuality.status).toLowerCase() === 'bad' ? 'blueprint-quality-alert--bad' : ''}`}
                                    role="status"
                                >
                                    <div className="blueprint-quality-alert__head">
                                        <span>蓝图质量告警</span>
                                        <span>评分 {planQuality.score ?? '-'}</span>
                                    </div>
                                    {planQualityMessages.length > 0 && (
                                        <ul className="blueprint-quality-alert__list">
                                            {planQualityMessages.map((msg, idx) => (
                                                <li key={`${msg}-${idx}`}>{msg}</li>
                                            ))}
                                        </ul>
                                    )}
                                    {planQuality?.retried && (
                                        <p className="blueprint-quality-alert__meta">
                                            已自动重试 {planQuality.attempts || 1} 次；仍建议人工微调蓝图后再生成正文。
                                        </p>
                                    )}
                                </div>
                            )}
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
                                                    <li key={`${item.headline}-${item.body}-${i}`} className="blueprint-item blueprint-item--conflict">
                                                        <span className="blueprint-item__tag">冲突</span>
                                                        <div>
                                                            <p className="blueprint-item__text" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                                                                {item.headline}
                                                            </p>
                                                            {item.body && (
                                                                <p className="blueprint-item__text" style={{ marginTop: 4 }}>
                                                                    {item.body}
                                                                </p>
                                                            )}
                                                        </div>
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
                                {editing ? '预览正文' : '返回编辑'}
                            </button>
                            <button className="btn btn-secondary" disabled={savingDraft || streaming} onClick={saveDraft}>
                                {savingDraft ? '保存中...' : '保存编辑并重检'}
                            </button>
                            <button
                                className="btn btn-secondary"
                                disabled={streaming || (!draftContent.trim() && !oneShotPrompt.trim())}
                                onClick={() => setShowClearWorkspaceConfirm(true)}
                            >
                                清空创作台
                            </button>
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

                {/* 清空创作台确认对话框 */}
                {showClearWorkspaceConfirm && (
                    <div className="modal-backdrop">
                        <div className="card" style={{ padding: 20, textAlign: 'center', maxWidth: 380 }}>
                            <p style={{ margin: '0 0 8px', fontWeight: 500 }}>清空当前创作台？</p>
                            <p className="muted" style={{ margin: '0 0 16px' }}>
                                该操作只清空当前页面编辑区和本地草稿，不会删除服务器已保存内容与历史章节。
                            </p>
                            <div style={{ display: 'flex', justifyContent: 'center', gap: 10 }}>
                                <button className="btn btn-secondary" onClick={() => setShowClearWorkspaceConfirm(false)}>
                                    取消
                                </button>
                                <button
                                    className="btn btn-primary"
                                    onClick={() => {
                                        setShowClearWorkspaceConfirm(false)
                                        clearWorkspaceLocally()
                                    }}
                                >
                                    确认清空
                                </button>
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
