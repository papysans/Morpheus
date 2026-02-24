import { useEffect, useState, useCallback, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { api } from '../lib/api'
import { useProjectStore } from '../stores/useProjectStore'
import { useToastStore } from '../stores/useToastStore'
import PageTransition from '../components/ui/PageTransition'
import Skeleton from '../components/ui/Skeleton'

/* ── Types ── */

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

interface MemoryFileItem {
    layer: string
    name: string
    path: string
    summary: string
    item_type: string
    size_bytes: number
    modified_at: string
}

/* ── Constants ── */

const LAYER_OPTIONS = [
    { value: '', label: '全部层级' },
    { value: 'L1', label: '仅 L1' },
    { value: 'L2', label: '仅 L2' },
    { value: 'L3', label: '仅 L3' },
] as const

const QUICK_QUERIES = [
    { label: '主角动机', query: '主角 目标 动机', layer: '' },
    { label: '最近冲突', query: '冲突 对峙 误解', layer: 'L2' },
    { label: '伏笔回收', query: '伏笔 回收 线索', layer: 'L3' },
    { label: '时间线', query: '时间线 顺序 先后', layer: '' },
]

const LAYER_META: Record<string, { label: string; color: string; desc: string }> = {
    L1: { label: 'L1 稳态', color: 'rgba(31, 159, 97, 0.4)', desc: '世界观 · 角色约束 · 文风契约' },
    L2: { label: 'L2 过程', color: 'rgba(45, 126, 192, 0.4)', desc: '章节决策 · 临时线索 · 创作日志' },
    L3: { label: 'L3 长期', color: 'rgba(173, 111, 27, 0.4)', desc: '章节摘要 · 事件卡 · 关系变化' },
    root: { label: '根目录', color: 'rgba(140, 80, 160, 0.4)', desc: '项目级配置文件' },
}

const SNIPPET_HIT_PATTERN = /(\[\[H\]\][\s\S]*?\[\[\/H\]\]|\[[^\]\n]{1,80}\])/g
const COLLAPSED_SNIPPET_LIMIT = 96
const EXPANDED_SNIPPET_LIMIT = 180

/* ── Helpers ── */

function compactText(text: string | undefined): string {
    return String(text || '').replace(/\s+/g, ' ').trim()
}

function getMemorySnippet(result: MemoryResult, limit: number): string {
    const raw = compactText(result.evidence) || compactText(result.content)
    if (!raw) return ''
    return raw.length <= limit ? raw : `${raw.slice(0, limit)}…`
}

function renderSnippetWithHighlight(text: string, shouldHighlight: boolean): ReactNode {
    if (!shouldHighlight || !text) return text
    const parts = text.split(SNIPPET_HIT_PATTERN)
    if (parts.length === 1) return text
    return parts.map((part, index) => {
        if (!part) return null
        const taggedMatch = part.match(/^\[\[H\]\]([\s\S]*?)\[\[\/H\]\]$/)
        if (taggedMatch) {
            return <mark key={`mark-t-${index}`} className="memory-hit-mark">{taggedMatch[1]}</mark>
        }
        const legacyMatch = part.match(/^\[([^\]\n]{1,80})\]$/)
        if (legacyMatch) {
            return <mark key={`mark-l-${index}`} className="memory-hit-mark">{legacyMatch[1]}</mark>
        }
        return <span key={`t-${index}`}>{part}</span>
    })
}

function resolveChapterIdFromSourcePath(sourcePath: string): string | null {
    const match = sourcePath.match(/(?:^|\/)chapters\/([^/]+)\.md$/)
    return match ? match[1] : null
}

/* ── Layer Stats Summary ── */

function LayerStatsBar({ files }: { files: MemoryFileItem[] }) {
    const counts: Record<string, number> = {}
    let totalSize = 0
    for (const f of files) {
        counts[f.layer] = (counts[f.layer] || 0) + 1
        totalSize += f.size_bytes
    }
    return (
        <div className="mb-stats-bar">
            {(['L1', 'L2', 'L3', 'root'] as const).map((layer) => {
                const meta = LAYER_META[layer]
                const count = counts[layer] || 0
                return (
                    <div key={layer} className="mb-stat-chip">
                        <span className={`layer-badge layer-badge--${layer}`}>{meta.label}</span>
                        <span className="mb-stat-chip__count">{count} 条</span>
                    </div>
                )
            })}
            <div className="mb-stat-chip" style={{ marginLeft: 'auto' }}>
                <span className="mb-stat-chip__label">总计</span>
                <span className="mb-stat-chip__count">{files.length} 条 · {(totalSize / 1024).toFixed(0)} KB</span>
            </div>
        </div>
    )
}

/* ── Main Component ── */

export default function MemoryBrowserPage() {
    const { projectId } = useParams<{ projectId: string }>()
    const navigate = useNavigate()
    const fetchProject = useProjectStore((s) => s.fetchProject)
    const currentProject = useProjectStore((s) => s.currentProject)
    const addToast = useToastStore((s) => s.addToast)

    // View mode: 'browse' (file overview + search) or 'identity' (editor)
    const [view, setView] = useState<'browse' | 'identity'>('browse')

    // Identity state
    const [identity, setIdentity] = useState('')
    const [runtimeState, setRuntimeState] = useState('')
    const [identityLoading, setIdentityLoading] = useState(true)
    const [saving, setSaving] = useState(false)

    // Search state
    const [query, setQuery] = useState('')
    const [layerFilter, setLayerFilter] = useState('')
    const [results, setResults] = useState<MemoryResult[]>([])
    const [searching, setSearching] = useState(false)
    const [expandedId, setExpandedId] = useState<string | null>(null)

    // Memory files state
    const [memoryFiles, setMemoryFiles] = useState<MemoryFileItem[]>([])
    const [memoryFilesLoading, setMemoryFilesLoading] = useState(false)
    const [expandedFilePath, setExpandedFilePath] = useState<string | null>(null)
    const [expandedFileContent, setExpandedFileContent] = useState<string>('')
    const [fileContentLoading, setFileContentLoading] = useState(false)
    const [overviewFilter, setOverviewFilter] = useState<string>('')
    const [fileSearchQuery, setFileSearchQuery] = useState('')

    // Load project context
    useEffect(() => {
        if (projectId && currentProject?.id !== projectId) fetchProject(projectId)
    }, [projectId, currentProject, fetchProject])

    // Load identity + files on mount
    useEffect(() => {
        if (!projectId) return
        loadIdentity()
        loadMemoryFiles()
    }, [projectId])

    const loadIdentity = async () => {
        setIdentityLoading(true)
        try {
            const res = await api.get(`/identity/${projectId}`)
            setIdentity(res.data.content)
            setRuntimeState(res.data.runtime_state || '')
        } catch {
            addToast('error', '加载身份设定失败')
        } finally {
            setIdentityLoading(false)
        }
    }

    const loadMemoryFiles = async () => {
        if (!projectId) return
        setMemoryFilesLoading(true)
        try {
            const res = await api.get(`/projects/${projectId}/memory/files`)
            setMemoryFiles(res.data.files ?? [])
        } catch {
            addToast('error', '加载记忆文件列表失败')
        } finally {
            setMemoryFilesLoading(false)
        }
    }

    const loadFileContent = async (sourcePath: string) => {
        if (!projectId) return
        if (expandedFilePath === sourcePath) { setExpandedFilePath(null); return }
        setExpandedFilePath(sourcePath)
        setFileContentLoading(true)
        try {
            const res = await api.get(`/projects/${projectId}/memory/source`, { params: { source_path: sourcePath } })
            setExpandedFileContent(typeof res.data === 'string' ? res.data : res.data.content ?? JSON.stringify(res.data, null, 2))
        } catch {
            setExpandedFileContent('(加载失败)')
        } finally {
            setFileContentLoading(false)
        }
    }

    const saveIdentity = async () => {
        setSaving(true)
        try {
            await api.put(`/identity/${projectId}`, { content: identity })
            addToast('success', '身份设定已保存')
        } catch {
            addToast('error', '保存身份设定失败')
        } finally {
            setSaving(false)
        }
    }

    const searchMemory = useCallback(async (opts?: { query?: string; layer?: string; silentWhenEmpty?: boolean }) => {
        const q = (opts?.query ?? query).trim()
        if (!q) return
        const layer = opts?.layer ?? layerFilter
        setSearching(true)
        setExpandedId(null)
        try {
            const res = await api.get('/memory/query', {
                timeout: 45000,
                params: { project_id: projectId, query: q, layers: layer || undefined },
            })
            setResults(res.data.results ?? [])
            if ((res.data.results?.length ?? 0) === 0 && !opts?.silentWhenEmpty) {
                addToast('info', '未找到匹配的记忆条目')
            }
        } catch (error: any) {
            const isTimeout = error?.code === 'ECONNABORTED' || /timeout/i.test(String(error?.message || ''))
            addToast('error', isTimeout ? '记忆检索超时，请稍后重试' : '记忆检索失败')
            setResults([])
        } finally {
            setSearching(false)
        }
    }, [query, projectId, layerFilter, addToast])

    const filteredResults = layerFilter ? results.filter((r) => r.layer === layerFilter) : results

    const handleQuickSearch = (queryText: string, layer: string) => {
        setQuery(queryText)
        setLayerFilter(layer)
        void searchMemory({ query: queryText, layer, silentWhenEmpty: true })
    }

    const filteredFiles = (() => {
        let list = overviewFilter ? memoryFiles.filter((f) => f.layer === overviewFilter) : memoryFiles
        if (fileSearchQuery.trim()) {
            const q = fileSearchQuery.trim().toLowerCase()
            list = list.filter(
                (f) =>
                    f.name.toLowerCase().includes(q) ||
                    f.summary.toLowerCase().includes(q) ||
                    f.path.toLowerCase().includes(q) ||
                    (f.item_type || '').toLowerCase().includes(q),
            )
        }
        return list
    })()

    return (
        <PageTransition>
            <div className="mb-page">
                {/* ── Header ── */}
                <header className="mb-header">
                    <div>
                        <Link to={`/project/${projectId}`} className="muted mb-back-link">← 返回项目</Link>
                        <h1 className="title" style={{ marginTop: 6 }}>记忆浏览器</h1>
                        <p className="muted" style={{ margin: '4px 0 0', fontSize: '0.88rem' }}>
                            检索三层记忆、维护身份设定、审阅长期知识沉淀
                        </p>
                    </div>
                    <div className="mb-header__actions">
                        <button
                            className={`chip-btn ${view === 'browse' ? 'active' : ''}`}
                            onClick={() => setView('browse')}
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                            浏览与搜索
                        </button>
                        <button
                            className={`chip-btn ${view === 'identity' ? 'active' : ''}`}
                            onClick={() => setView('identity')}
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>
                            身份设定
                        </button>
                    </div>
                </header>

                <AnimatePresence mode="wait">
                    {view === 'browse' && (
                        <motion.div
                            key="browse"
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -8 }}
                            transition={{ duration: 0.15 }}
                        >
                            {/* ── Layer Stats ── */}
                            {!memoryFilesLoading && memoryFiles.length > 0 && (
                                <LayerStatsBar files={memoryFiles} />
                            )}

                            {/* ── Two-column layout: Search + File Browser ── */}
                            <div className="mb-browse-grid">
                                {/* Left: Search Panel */}
                                <section className="mb-search-panel" aria-label="记忆搜索">
                                    <div className="mb-section-head">
                                        <h2 className="mb-section-title">
                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                                            语义搜索
                                        </h2>
                                    </div>

                                    {/* Search input */}
                                    <div className="mb-search-bar">
                                        <input
                                            className="composer-input"
                                            value={query}
                                            onChange={(e) => setQuery(e.target.value)}
                                            onKeyDown={(e) => e.key === 'Enter' && searchMemory()}
                                            placeholder="输入角色、事件、伏笔关键词..."
                                            aria-label="记忆搜索关键词"
                                        />
                                        <div className="mb-search-bar__controls">
                                            <select
                                                className="select-control"
                                                value={layerFilter}
                                                onChange={(e) => setLayerFilter(e.target.value)}
                                                aria-label="层级筛选"
                                            >
                                                {LAYER_OPTIONS.map((opt) => (
                                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                                ))}
                                            </select>
                                            <button
                                                className="primary-btn"
                                                onClick={() => searchMemory()}
                                                disabled={searching || !query.trim()}
                                                style={{ whiteSpace: 'nowrap' }}
                                            >
                                                {searching ? '检索中...' : '检索'}
                                            </button>
                                        </div>
                                    </div>

                                    {/* Quick queries */}
                                    {!searching && filteredResults.length === 0 && !query.trim() && (
                                        <div className="mb-quick-queries">
                                            <span className="muted" style={{ fontSize: '0.8rem' }}>快速检索:</span>
                                            {QUICK_QUERIES.map((item) => (
                                                <button
                                                    key={item.label}
                                                    type="button"
                                                    className="chip-btn"
                                                    onClick={() => handleQuickSearch(item.query, item.layer)}
                                                    style={{ fontSize: '0.78rem', padding: '4px 10px' }}
                                                >
                                                    {item.label}
                                                </button>
                                            ))}
                                        </div>
                                    )}

                                    {/* Search results */}
                                    <div className="mb-results">
                                        {searching && <Skeleton variant="card" count={3} />}

                                        {!searching && results.length > 0 && filteredResults.length === 0 && (
                                            <p className="muted" style={{ padding: '8px 0', fontSize: '0.84rem' }}>当前层级无匹配结果，试试切换筛选。</p>
                                        )}

                                        {!searching && results.length === 0 && query.trim() && (
                                            <p className="muted" style={{ padding: '8px 0', fontSize: '0.84rem' }}>未找到匹配结果。</p>
                                        )}

                                        <AnimatePresence>
                                            {!searching && filteredResults.map((result) => {
                                                const isExpanded = expandedId === result.item_id
                                                const snippet = getMemorySnippet(result, isExpanded ? EXPANDED_SNIPPET_LIMIT : COLLAPSED_SNIPPET_LIMIT)
                                                const shouldHL = Boolean(result.evidence)
                                                const chapterId = resolveChapterIdFromSourcePath(result.source_path)
                                                const sourceHref = projectId
                                                    ? `/api/projects/${encodeURIComponent(projectId)}/memory/source?source_path=${encodeURIComponent(result.source_path)}`
                                                    : '#'
                                                return (
                                                    <motion.article
                                                        key={result.item_id}
                                                        layout
                                                        initial={{ opacity: 0, y: 6 }}
                                                        animate={{ opacity: 1, y: 0 }}
                                                        exit={{ opacity: 0, y: -6 }}
                                                        transition={{ duration: 0.15 }}
                                                        className={`card mb-result-card ${isExpanded ? 'mb-result-card--expanded' : ''}`}
                                                        style={{ borderColor: isExpanded ? LAYER_META[result.layer]?.color : undefined }}
                                                        onClick={() => setExpandedId(prev => prev === result.item_id ? null : result.item_id)}
                                                        role="button"
                                                        aria-expanded={isExpanded}
                                                        tabIndex={0}
                                                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedId(prev => prev === result.item_id ? null : result.item_id) } }}
                                                    >
                                                        <div className="mb-result-card__head">
                                                            <span className={`layer-badge layer-badge--${result.layer}`}>{result.layer}</span>
                                                            <span className="mb-result-card__score">
                                                                {((result.combined_score ?? result.score ?? 0) * 100).toFixed(0)}% 相关
                                                            </span>
                                                        </div>
                                                        <h3 className="mb-result-card__title">{result.summary}</h3>

                                                        {!isExpanded && snippet && (
                                                            <p className="muted mb-result-card__snippet">
                                                                {renderSnippetWithHighlight(snippet, shouldHL)}
                                                            </p>
                                                        )}

                                                        <AnimatePresence>
                                                            {isExpanded && (
                                                                <motion.div
                                                                    initial={{ height: 0, opacity: 0 }}
                                                                    animate={{ height: 'auto', opacity: 1 }}
                                                                    exit={{ height: 0, opacity: 0 }}
                                                                    transition={{ duration: 0.2 }}
                                                                    style={{ overflow: 'hidden' }}
                                                                >
                                                                    <p className="muted mb-result-card__source">{result.source_path}</p>
                                                                    <div className="mb-result-card__actions">
                                                                        <a href={sourceHref} target="_blank" rel="noreferrer" className="chip-btn" style={{ textDecoration: 'none', fontSize: '0.78rem', padding: '4px 10px' }} onClick={(e) => e.stopPropagation()}>打开原文</a>
                                                                        {chapterId && projectId && (
                                                                            <button type="button" className="chip-btn" style={{ fontSize: '0.78rem', padding: '4px 10px' }} onClick={(e) => { e.stopPropagation(); navigate(`/project/${projectId}/chapter/${chapterId}`) }}>跳到章节</button>
                                                                        )}
                                                                        {result.source_path === 'memory/L1/IDENTITY.md' && (
                                                                            <button type="button" className="chip-btn" style={{ fontSize: '0.78rem', padding: '4px 10px' }} onClick={(e) => { e.stopPropagation(); setView('identity') }}>编辑身份设定</button>
                                                                        )}
                                                                    </div>
                                                                    {snippet && (
                                                                        <div className="card-strong mb-result-card__evidence">
                                                                            <div className="muted" style={{ marginBottom: 4, fontSize: '0.75rem' }}>
                                                                                {result.evidence ? '关键词命中' : '语义命中'}
                                                                            </div>
                                                                            {renderSnippetWithHighlight(snippet, shouldHL)}
                                                                        </div>
                                                                    )}
                                                                </motion.div>
                                                            )}
                                                        </AnimatePresence>
                                                    </motion.article>
                                                )
                                            })}
                                        </AnimatePresence>
                                    </div>
                                </section>

                                {/* Right: File Browser */}
                                <section className="mb-files-panel" aria-label="记忆文件总览">
                                    <div className="mb-section-head">
                                        <h2 className="mb-section-title">
                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                                            记忆文件
                                        </h2>
                                        <button
                                            className="chip-btn"
                                            onClick={loadMemoryFiles}
                                            disabled={memoryFilesLoading}
                                            style={{ fontSize: '0.76rem', padding: '3px 10px' }}
                                        >
                                            {memoryFilesLoading ? '刷新中...' : '刷新'}
                                        </button>
                                    </div>

                                    {/* Layer filter chips */}
                                    <div className="mb-layer-filters">
                                        {['', 'L1', 'L2', 'L3', 'root'].map((f) => (
                                            <button
                                                key={f}
                                                className={`chip-btn ${overviewFilter === f ? 'active' : ''}`}
                                                onClick={() => setOverviewFilter(f)}
                                                style={{ fontSize: '0.76rem', padding: '3px 10px' }}
                                            >
                                                {f === '' ? '全部' : LAYER_META[f]?.label || f}
                                            </button>
                                        ))}
                                    </div>

                                    {/* File search */}
                                    <input
                                        className="composer-input"
                                        style={{ marginBottom: 8, fontSize: '0.84rem' }}
                                        placeholder="搜索文件名、摘要、路径..."
                                        value={fileSearchQuery}
                                        onChange={(e) => setFileSearchQuery(e.target.value)}
                                        aria-label="记忆文件搜索"
                                    />

                                    {/* File list */}
                                    <div className="mb-file-list">
                                        {memoryFilesLoading && <Skeleton variant="card" count={4} />}

                                        {!memoryFilesLoading && filteredFiles.length === 0 && (
                                            <p className="muted" style={{ padding: '8px 0', fontSize: '0.84rem' }}>
                                                {overviewFilter ? '该层级暂无文件。' : '暂无记忆文件。'}
                                            </p>
                                        )}

                                        {!memoryFilesLoading && filteredFiles.map((file) => {
                                            const isExpanded = expandedFilePath === file.path
                                            return (
                                                <article
                                                    key={file.path}
                                                    className={`card mb-file-card ${isExpanded ? 'mb-file-card--expanded' : ''}`}
                                                    style={{ borderColor: isExpanded ? LAYER_META[file.layer]?.color : undefined }}
                                                    onClick={() => loadFileContent(file.path)}
                                                    role="button"
                                                    aria-expanded={isExpanded}
                                                    tabIndex={0}
                                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); loadFileContent(file.path) } }}
                                                >
                                                    <div className="mb-file-card__head">
                                                        <span className={`layer-badge layer-badge--${file.layer}`}>
                                                            {LAYER_META[file.layer]?.label || file.layer}
                                                        </span>
                                                        {file.item_type && (
                                                            <span className="mb-file-card__type">{file.item_type}</span>
                                                        )}
                                                        <span className="mb-file-card__meta">
                                                            {(file.size_bytes / 1024).toFixed(1)} KB
                                                        </span>
                                                    </div>
                                                    <div className="mb-file-card__title">{file.summary}</div>
                                                    <div className="muted mb-file-card__path">{file.path}</div>

                                                    {isExpanded && (
                                                        <div className="mb-file-card__content">
                                                            {fileContentLoading ? (
                                                                <Skeleton variant="card" count={1} />
                                                            ) : (
                                                                <pre className="mb-file-card__pre">{expandedFileContent}</pre>
                                                            )}
                                                        </div>
                                                    )}
                                                </article>
                                            )
                                        })}
                                    </div>
                                </section>
                            </div>

                            {/* ── Layer Legend (inline, not a separate tab) ── */}
                            <div className="mb-layer-legend">
                                {(['L1', 'L2', 'L3'] as const).map((layer) => {
                                    const meta = LAYER_META[layer]
                                    return (
                                        <div key={layer} className="mb-layer-legend__item">
                                            <span className={`layer-badge layer-badge--${layer}`}>{layer}</span>
                                            <span className="mb-layer-legend__desc">{meta.desc}</span>
                                        </div>
                                    )
                                })}
                            </div>
                        </motion.div>
                    )}

                    {view === 'identity' && (
                        <motion.div
                            key="identity"
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -8 }}
                            transition={{ duration: 0.15 }}
                        >
                            <section className="card mb-identity-panel" role="tabpanel" aria-label="L1 身份设定">
                                <div className="mb-identity-panel__head">
                                    <div>
                                        <h2 className="mb-section-title" style={{ marginBottom: 4 }}>
                                            <span className="layer-badge layer-badge--L1" style={{ marginRight: 8 }}>L1</span>
                                            身份设定
                                        </h2>
                                        <p className="muted" style={{ margin: 0, fontSize: '0.82rem' }}>
                                            世界观、角色硬约束、文风契约、禁忌规则。优先级最高，所有 Agent 决策均以此为准。
                                        </p>
                                    </div>
                                    <button className="primary-btn" onClick={saveIdentity} disabled={saving}>
                                        {saving ? '保存中...' : '保存'}
                                    </button>
                                </div>

                                {identityLoading ? (
                                    <Skeleton variant="card" count={1} />
                                ) : (
                                    <div className="mb-identity-panel__body">
                                        <textarea
                                            className="composer-input mb-identity-textarea"
                                            rows={20}
                                            value={identity}
                                            onChange={(e) => setIdentity(e.target.value)}
                                            placeholder="在此编辑身份设定内容..."
                                            aria-label="身份设定文本"
                                        />

                                        {runtimeState && (
                                            <div className="mb-runtime-state">
                                                <h3 className="mb-section-title" style={{ fontSize: '0.88rem' }}>
                                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
                                                    运行时状态
                                                </h3>
                                                <p className="muted" style={{ margin: '2px 0 8px', fontSize: '0.78rem' }}>
                                                    自动生成，记录最新角色登场、状态变化、主线进度。
                                                </p>
                                                <pre className="mb-runtime-state__pre">{runtimeState}</pre>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </section>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </PageTransition>
    )
}
