import { useEffect, useState, useCallback, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { api } from '../lib/api'
import { useProjectStore } from '../stores/useProjectStore'
import { useToastStore } from '../stores/useToastStore'
import PageTransition from '../components/ui/PageTransition'
import Skeleton from '../components/ui/Skeleton'

interface MemoryResult {
    item_id: string
    layer: 'L1' | 'L2' | 'L3'
    source_path: string
    summary: string
    evidence?: string
    content?: string
    combined_score?: number
    score?: number
}

type TabKey = 'identity' | 'search' | 'layers'

const LAYER_OPTIONS = [
    { value: '', label: '全部层级' },
    { value: 'L1', label: '仅 L1' },
    { value: 'L2', label: '仅 L2' },
    { value: 'L3', label: '仅 L3' },
] as const

const QUICK_MEMORY_QUERIES = [
    { label: '主角动机', query: '主角 目标 动机', layer: '' },
    { label: '最近冲突', query: '冲突 对峙 误解', layer: 'L2' },
    { label: '伏笔与回收', query: '伏笔 回收 线索', layer: 'L3' },
    { label: '时间线', query: '时间线 顺序 先后', layer: '' },
]

const LAYER_BORDER_COLORS: Record<string, string> = {
    L1: 'rgba(31, 159, 97, 0.4)',
    L2: 'rgba(45, 126, 192, 0.4)',
    L3: 'rgba(173, 111, 27, 0.4)',
}

const COLLAPSED_SNIPPET_LIMIT = 96
const EXPANDED_SNIPPET_LIMIT = 180
const SNIPPET_HIT_PATTERN = /(\[\[H\]\][\s\S]*?\[\[\/H\]\]|\[[^\]\n]{1,80}\])/g

function compactText(text: string | undefined): string {
    return String(text || '').replace(/\s+/g, ' ').trim()
}

function getMemorySnippet(result: MemoryResult, limit: number): string {
    const primary = compactText(result.evidence)
    const fallback = compactText(result.content)
    const raw = primary || fallback
    if (!raw) return ''
    if (raw.length <= limit) return raw
    return `${raw.slice(0, limit)}…`
}

function renderSnippetWithHighlight(text: string, shouldHighlight: boolean): ReactNode {
    if (!shouldHighlight || !text) return text

    const parts = text.split(SNIPPET_HIT_PATTERN)
    if (parts.length === 1) return text

    return parts.map((part, index) => {
        if (!part) return null

        const taggedMatch = part.match(/^\[\[H\]\]([\s\S]*?)\[\[\/H\]\]$/)
        if (taggedMatch) {
            return (
                <mark key={`mark-tagged-${index}`} className="memory-hit-mark">
                    {taggedMatch[1]}
                </mark>
            )
        }

        const legacyMatch = part.match(/^\[([^\]\n]{1,80})\]$/)
        if (legacyMatch) {
            return (
                <mark key={`mark-legacy-${index}`} className="memory-hit-mark">
                    {legacyMatch[1]}
                </mark>
            )
        }

        return <span key={`text-${index}`}>{part}</span>
    })
}

function resolveChapterIdFromSourcePath(sourcePath: string): string | null {
    const match = sourcePath.match(/(?:^|\/)chapters\/([^/]+)\.md$/)
    if (!match) return null
    return match[1]
}

export default function MemoryBrowserPage() {
    const { projectId } = useParams<{ projectId: string }>()
    const navigate = useNavigate()
    const fetchProject = useProjectStore((s) => s.fetchProject)
    const currentProject = useProjectStore((s) => s.currentProject)
    const addToast = useToastStore((s) => s.addToast)

    const [activeTab, setActiveTab] = useState<TabKey>('identity')
    const [identity, setIdentity] = useState('')
    const [identityLoading, setIdentityLoading] = useState(true)
    const [saving, setSaving] = useState(false)

    const [query, setQuery] = useState('')
    const [layerFilter, setLayerFilter] = useState('')
    const [results, setResults] = useState<MemoryResult[]>([])
    const [searching, setSearching] = useState(false)
    const [expandedId, setExpandedId] = useState<string | null>(null)

    // Load project context
    useEffect(() => {
        if (projectId && currentProject?.id !== projectId) {
            fetchProject(projectId)
        }
    }, [projectId, currentProject, fetchProject])

    // Load identity on mount
    useEffect(() => {
        if (!projectId) return
        loadIdentity()
    }, [projectId])

    const loadIdentity = async () => {
        setIdentityLoading(true)
        try {
            const response = await api.get(`/identity/${projectId}`)
            setIdentity(response.data.content)
        } catch (error) {
            addToast('error', '加载身份设定失败')
            console.error(error)
        } finally {
            setIdentityLoading(false)
        }
    }

    const saveIdentity = async () => {
        setSaving(true)
        try {
            await api.put(`/identity/${projectId}`, { content: identity })
            addToast('success', '身份设定已保存')
        } catch (error) {
            addToast('error', '保存身份设定失败')
            console.error(error)
        } finally {
            setSaving(false)
        }
    }

    const searchMemory = useCallback(async (options?: { query?: string; layer?: string; silentWhenEmpty?: boolean }) => {
        const effectiveQuery = (options?.query ?? query).trim()
        if (!effectiveQuery) return
        const effectiveLayer = options?.layer ?? layerFilter
        setSearching(true)
        setExpandedId(null)
        try {
            const response = await api.get('/memory/query', {
                timeout: 45000,
                params: {
                    project_id: projectId,
                    query: effectiveQuery,
                    layers: effectiveLayer || undefined,
                },
            })
            setResults(response.data.results ?? [])
            const count = response.data.results?.length ?? 0
            if (count === 0 && !options?.silentWhenEmpty) {
                addToast('info', '未找到匹配的记忆条目')
            }
        } catch (error: any) {
            const isTimeout = error?.code === 'ECONNABORTED' || /timeout/i.test(String(error?.message || ''))
            addToast('error', isTimeout ? '记忆检索超时，请稍后重试或换更短关键词' : '记忆检索失败')
            console.error(error)
            setResults([])
        } finally {
            setSearching(false)
        }
    }, [query, projectId, layerFilter, addToast])

    const filteredResults = layerFilter
        ? results.filter((r) => r.layer === layerFilter)
        : results

    const toggleExpand = (itemId: string) => {
        setExpandedId((prev) => (prev === itemId ? null : itemId))
    }

    const handleQuickSearch = (queryText: string, layer: string) => {
        setQuery(queryText)
        setLayerFilter(layer)
        void searchMemory({ query: queryText, layer, silentWhenEmpty: true })
    }

    const tabs: { key: TabKey; label: string }[] = [
        { key: 'identity', label: 'L1 身份设定' },
        { key: 'search', label: 'L2/L3 记忆搜索' },
        { key: 'layers', label: '分层说明' },
    ]

    return (
        <PageTransition>
            <div className="memory-page">
                {/* Header */}
                <div className="page-head" style={{ marginBottom: 16 }}>
                    <div>
                        <Link
                            to={`/project/${projectId}`}
                            className="muted"
                            style={{ textDecoration: 'none', fontSize: '0.88rem' }}
                        >
                            ← 返回项目
                        </Link>
                        <h1 className="title" style={{ marginTop: 6 }}>记忆浏览器</h1>
                        <p className="muted" style={{ margin: '4px 0 0', fontSize: '0.88rem' }}>
                            检索三层记忆、维护身份设定、审阅长期知识沉淀。
                        </p>
                    </div>
                </div>

                {/* Tab bar */}
                <div
                    style={{
                        display: 'flex',
                        gap: 6,
                        marginBottom: 16,
                        flexWrap: 'wrap',
                    }}
                    role="tablist"
                    aria-label="记忆浏览器标签页"
                >
                    {tabs.map((tab) => (
                        <button
                            key={tab.key}
                            role="tab"
                            aria-selected={activeTab === tab.key}
                            className={`chip-btn ${activeTab === tab.key ? 'active' : ''}`}
                            onClick={() => setActiveTab(tab.key)}
                            style={{ padding: '8px 16px' }}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>

                {/* Tab content */}
                <AnimatePresence mode="wait">
                    {activeTab === 'identity' && (
                        <motion.section
                            key="identity"
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -8 }}
                            transition={{ duration: 0.15 }}
                            className="card"
                            style={{ padding: 16 }}
                            role="tabpanel"
                            aria-label="L1 身份设定"
                        >
                            <h2 style={{ margin: '0 0 8px', fontSize: '1rem', fontWeight: 700 }}>
                                身份设定（L1 稳态记忆）
                            </h2>
                            <p className="muted" style={{ margin: '0 0 12px', fontSize: '0.84rem' }}>
                                世界观、角色硬约束、文风契约、禁忌规则。优先级最高，所有 Agent 决策均以此为准。
                            </p>

                            {identityLoading ? (
                                <Skeleton variant="card" count={1} />
                            ) : (
                                <>
                                    <textarea
                                        className="composer-input"
                                        rows={18}
                                        value={identity}
                                        onChange={(e) => setIdentity(e.target.value)}
                                        placeholder="在此编辑身份设定内容..."
                                        aria-label="身份设定文本"
                                        style={{ minHeight: 300 }}
                                    />
                                    <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                                        <button
                                            className="primary-btn"
                                            onClick={saveIdentity}
                                            disabled={saving}
                                        >
                                            {saving ? '保存中...' : '保存身份设定'}
                                        </button>
                                    </div>
                                </>
                            )}
                        </motion.section>
                    )}

                    {activeTab === 'search' && (
                        <motion.section
                            key="search"
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -8 }}
                            transition={{ duration: 0.15 }}
                            role="tabpanel"
                            aria-label="记忆搜索"
                        >
                            {/* Search bar */}
                            <div
                                className="card"
                                style={{
                                    padding: 14,
                                    display: 'grid',
                                    gridTemplateColumns: '1fr 140px 120px',
                                    gap: 8,
                                    marginBottom: 12,
                                }}
                            >
                                <input
                                    className="composer-input"
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && searchMemory()}
                                    placeholder="输入角色、事件、伏笔、规则关键词..."
                                    aria-label="记忆搜索关键词"
                                    style={{ padding: '9px 12px' }}
                                />
                                <select
                                    className="select-control"
                                    value={layerFilter}
                                    onChange={(e) => setLayerFilter(e.target.value)}
                                    aria-label="层级筛选"
                                    style={{ minWidth: 0 }}
                                >
                                    {LAYER_OPTIONS.map((opt) => (
                                        <option key={opt.value} value={opt.value}>
                                            {opt.label}
                                        </option>
                                    ))}
                                </select>
                                <button
                                    className="primary-btn"
                                    onClick={() => searchMemory()}
                                    disabled={searching || !query.trim()}
                                >
                                    {searching ? '检索中...' : '检索'}
                                </button>
                            </div>

                            {!searching && filteredResults.length === 0 && !query.trim() && (
                                <section className="card" style={{ padding: 12, marginBottom: 10 }}>
                                    <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>快速开始</div>
                                    <p className="muted" style={{ margin: '6px 0 10px', fontSize: '0.82rem' }}>
                                        点击下方预设关键词，直接查看 L2/L3 记忆命中结果。
                                    </p>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                        {QUICK_MEMORY_QUERIES.map((item) => (
                                            <button
                                                key={item.label}
                                                type="button"
                                                className="chip-btn"
                                                onClick={() => handleQuickSearch(item.query, item.layer)}
                                            >
                                                {item.label}
                                            </button>
                                        ))}
                                    </div>
                                </section>
                            )}

                            {/* Results */}
                            <div style={{ display: 'grid', gap: 10 }}>
                                {searching && <Skeleton variant="card" count={3} />}

                                {!searching && filteredResults.length === 0 && (
                                    <p className="muted" style={{ padding: '12px 0' }}>
                                        暂无结果。输入关键词开始检索。
                                    </p>
                                )}

                                <AnimatePresence>
                                    {!searching &&
                                        filteredResults.map((result) => {
                                            const isExpanded = expandedId === result.item_id
                                            const collapsedSnippet = getMemorySnippet(result, COLLAPSED_SNIPPET_LIMIT)
                                            const expandedSnippet = getMemorySnippet(result, EXPANDED_SNIPPET_LIMIT)
                                            const shouldHighlightSnippet = Boolean(result.evidence)
                                            const sourceHref = projectId
                                                ? `/api/projects/${encodeURIComponent(projectId)}/memory/source?source_path=${encodeURIComponent(result.source_path)}`
                                                : '#'
                                            const chapterId = resolveChapterIdFromSourcePath(result.source_path)
                                            return (
                                                <motion.article
                                                    key={result.item_id}
                                                    layout
                                                    initial={{ opacity: 0, y: 6 }}
                                                    animate={{ opacity: 1, y: 0 }}
                                                    exit={{ opacity: 0, y: -6 }}
                                                    transition={{ duration: 0.15 }}
                                                    className="card"
                                                    style={{
                                                        padding: 14,
                                                        cursor: 'pointer',
                                                        transition: 'border-color 150ms ease',
                                                        borderColor: isExpanded
                                                            ? LAYER_BORDER_COLORS[result.layer]
                                                            : undefined,
                                                    }}
                                                    onClick={() => toggleExpand(result.item_id)}
                                                    role="button"
                                                    aria-expanded={isExpanded}
                                                    tabIndex={0}
                                                    onKeyDown={(e) => {
                                                        if (e.key === 'Enter' || e.key === ' ') {
                                                            e.preventDefault()
                                                            toggleExpand(result.item_id)
                                                        }
                                                    }}
                                                >
                                                    <div
                                                        style={{
                                                            display: 'flex',
                                                            justifyContent: 'space-between',
                                                            alignItems: 'center',
                                                        }}
                                                    >
                                                        <span className={`layer-badge layer-badge--${result.layer}`}>
                                                            {result.layer}
                                                        </span>
                                                        <span
                                                            style={{
                                                                fontSize: '0.78rem',
                                                                color: 'var(--text-secondary)',
                                                            }}
                                                        >
                                                            相关性{' '}
                                                            {(
                                                                result.combined_score ??
                                                                result.score ??
                                                                0
                                                            ).toFixed(3)}
                                                        </span>
                                                    </div>

                                                    <h3
                                                        style={{
                                                            marginTop: 8,
                                                            marginBottom: 4,
                                                            fontSize: '0.95rem',
                                                        }}
                                                    >
                                                        {result.summary}
                                                    </h3>

                                                    {/* Expanded content */}
                                                    <AnimatePresence>
                                                        {isExpanded && (
                                                            <motion.div
                                                                initial={{ height: 0, opacity: 0 }}
                                                                animate={{ height: 'auto', opacity: 1 }}
                                                                exit={{ height: 0, opacity: 0 }}
                                                                transition={{ duration: 0.2 }}
                                                                style={{ overflow: 'hidden' }}
                                                            >
                                                                <p
                                                                    className="muted"
                                                                    style={{
                                                                        margin: '8px 0 6px',
                                                                        fontSize: '0.82rem',
                                                                        fontFamily:
                                                                            'ui-monospace, SFMono-Regular, Menlo, monospace',
                                                                    }}
                                                                >
                                                                    来源: {result.source_path}
                                                                </p>
                                                                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                                                                    <a
                                                                        href={sourceHref}
                                                                        target="_blank"
                                                                        rel="noreferrer"
                                                                        className="chip-btn"
                                                                        style={{ textDecoration: 'none' }}
                                                                        onClick={(e) => e.stopPropagation()}
                                                                    >
                                                                        打开原文 MD
                                                                    </a>
                                                                    {chapterId && projectId && (
                                                                        <button
                                                                            type="button"
                                                                            className="chip-btn"
                                                                            onClick={(e) => {
                                                                                e.stopPropagation()
                                                                                navigate(`/project/${projectId}/chapter/${chapterId}`)
                                                                            }}
                                                                        >
                                                                            跳到章节
                                                                        </button>
                                                                    )}
                                                                    {result.source_path === 'memory/L1/IDENTITY.md' && (
                                                                        <button
                                                                            type="button"
                                                                            className="chip-btn"
                                                                            onClick={(e) => {
                                                                                e.stopPropagation()
                                                                                setActiveTab('identity')
                                                                            }}
                                                                        >
                                                                            跳到身份设定
                                                                        </button>
                                                                    )}
                                                                </div>
                                                                {expandedSnippet && (
                                                                    <div
                                                                        className="card-strong"
                                                                        style={{
                                                                            marginTop: 8,
                                                                            whiteSpace: 'pre-wrap',
                                                                            fontSize: '0.86rem',
                                                                            lineHeight: 1.7,
                                                                        }}
                                                                    >
                                                                        <div className="muted" style={{ marginBottom: 6, fontSize: '0.78rem' }}>
                                                                            {result.evidence ? '关键词命中片段' : '语义命中片段'}
                                                                        </div>
                                                                        {renderSnippetWithHighlight(expandedSnippet, shouldHighlightSnippet)}
                                                                    </div>
                                                                )}
                                                            </motion.div>
                                                        )}
                                                    </AnimatePresence>

                                                    {!isExpanded && (
                                                        <p
                                                            className="muted"
                                                            style={{
                                                                margin: '4px 0 0',
                                                                fontSize: '0.78rem',
                                                            }}
                                                        >
                                                            {collapsedSnippet
                                                                ? renderSnippetWithHighlight(collapsedSnippet, shouldHighlightSnippet)
                                                                : '点击展开查看来源与原文入口'}
                                                        </p>
                                                    )}
                                                </motion.article>
                                            )
                                        })}
                                </AnimatePresence>
                            </div>
                        </motion.section>
                    )}

                    {activeTab === 'layers' && (
                        <motion.section
                            key="layers"
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -8 }}
                            transition={{ duration: 0.15 }}
                            style={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                                gap: 12,
                            }}
                            role="tabpanel"
                            aria-label="分层说明"
                        >
                            <article className="card" style={{ padding: 16 }}>
                                <div className="layer-badge layer-badge--L1" style={{ marginBottom: 10 }}>
                                    L1
                                </div>
                                <h3 style={{ margin: '0 0 8px', fontSize: '1rem' }}>
                                    L1 稳态记忆
                                </h3>
                                <p className="muted" style={{ margin: 0, fontSize: '0.86rem', lineHeight: 1.6 }}>
                                    世界观、角色硬约束、文风契约、禁忌规则。优先级最高。
                                </p>
                            </article>
                            <article className="card" style={{ padding: 16 }}>
                                <div className="layer-badge layer-badge--L2" style={{ marginBottom: 10 }}>
                                    L2
                                </div>
                                <h3 style={{ margin: '0 0 8px', fontSize: '1rem' }}>
                                    L2 过程记忆
                                </h3>
                                <p className="muted" style={{ margin: 0, fontSize: '0.86rem', lineHeight: 1.6 }}>
                                    章节决策、临时线索、创作日志，支持近期上下文回溯。
                                </p>
                            </article>
                            <article className="card" style={{ padding: 16 }}>
                                <div className="layer-badge layer-badge--L3" style={{ marginBottom: 10 }}>
                                    L3
                                </div>
                                <h3 style={{ margin: '0 0 8px', fontSize: '1rem' }}>
                                    L3 长期记忆
                                </h3>
                                <p className="muted" style={{ margin: 0, fontSize: '0.86rem', lineHeight: 1.6 }}>
                                    章节摘要、事件卡、关系变化、主题演化，保障长程一致性。
                                </p>
                            </article>
                        </motion.section>
                    )}
                </AnimatePresence>
            </div>
        </PageTransition>
    )
}
