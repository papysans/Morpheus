import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { api } from '../lib/api'
import { useProjectStore } from '../stores/useProjectStore'
import { useToastStore } from '../stores/useToastStore'
import Skeleton from '../components/ui/Skeleton'
import PageTransition from '../components/ui/PageTransition'

/* ── Types ── */

export interface AgentDecision {
    id: string
    agent_role: string
    input_refs: string[]
    decision_text: string
    reasoning?: string
    timestamp: string
}

export interface Conflict {
    id: string
    severity: 'P0' | 'P1' | 'P2'
    rule_id: string
    reason: string
    suggested_fix?: string
    evidence_paths?: string[]
}

export interface TraceData {
    id: string
    chapter_id: number
    decisions: AgentDecision[]
    memory_hits: Array<Record<string, unknown>>
    conflicts_detected: Conflict[]
    final_draft?: string
}

/* ── Agent Role Colors (exported for PBT testing) ── */

export const AGENT_ROLE_COLORS: Record<string, { color: string; borderColor: string; label: string }> = {
    director: { color: 'rgba(45, 126, 192, 0.14)', borderColor: 'rgba(45, 126, 192, 0.5)', label: '导演' },
    worldbuilder: { color: 'rgba(31, 159, 97, 0.14)', borderColor: 'rgba(31, 159, 97, 0.5)', label: '设定官' },
    continuity: { color: 'rgba(173, 111, 27, 0.14)', borderColor: 'rgba(173, 111, 27, 0.5)', label: '连续性审校' },
    stylist: { color: 'rgba(142, 87, 192, 0.14)', borderColor: 'rgba(142, 87, 192, 0.5)', label: '文风润色' },
    arbiter: { color: 'rgba(207, 62, 52, 0.14)', borderColor: 'rgba(207, 62, 52, 0.5)', label: '裁决器' },
}

const SEVERITY_STYLES: Record<string, string> = {
    p0: 'rgba(207, 62, 52, 0.14)',
    p1: 'rgba(173, 111, 27, 0.14)',
    p2: 'rgba(173, 155, 27, 0.14)',
}

function getRoleStyle(role: string) {
    return AGENT_ROLE_COLORS[role] ?? { color: 'rgba(167,192,222,0.2)', borderColor: 'rgba(167,192,222,0.4)', label: role }
}

function sanitizeDecisionText(text?: string) {
    if (!text) return ''
    return text
        .replace(/<\s*think(?:ing)?\s*>[\s\S]*?<\s*\/\s*think(?:ing)?\s*>/gi, '')
        .replace(/```(?:thinking|reasoning)\s*[\s\S]*?```/gi, '')
        .replace(/^\s*(thinking|thoughts?|reasoning)\s*[:：].*(?:\n|$)/gim, '')
        .trim()
}

function formatDecisionTime(timestamp: string) {
    const date = new Date(timestamp)
    if (Number.isNaN(date.getTime())) return '--:--:--'
    return date.toLocaleTimeString()
}

/* ── SVG 图标 ── */

export const IconReplay = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="1 4 1 10 7 10" />
        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
)

/* ── Component ── */

export default function TraceReplayPage() {
    const { projectId, chapterId } = useParams<{ projectId: string; chapterId: string }>()
    const fetchProject = useProjectStore((s) => s.fetchProject)
    const storeChapters = useProjectStore((s) => s.chapters)
    const fetchChapters = useProjectStore((s) => s.fetchChapters)
    const addToast = useToastStore((s) => s.addToast)

    const [trace, setTrace] = useState<TraceData | null>(null)
    const [loading, setLoading] = useState(true)
    const [selectedDecisionId, setSelectedDecisionId] = useState<string | null>(null)
    const navigate = useNavigate()

    useEffect(() => {
        if (projectId) fetchProject(projectId)
    }, [projectId, fetchProject])

    /* ── 无 chapterId 时加载章节列表 ── */
    useEffect(() => {
        if (!projectId || chapterId) return
        setLoading(true)
        fetchChapters(projectId).finally(() => setLoading(false))
    }, [projectId, chapterId, fetchChapters])

    const loadTrace = useCallback(async () => {
        setLoading(true)
        try {
            const response = await api.get(`/trace/${chapterId}`)
            setTrace(response.data)
            setSelectedDecisionId(response.data.decisions?.[0]?.id ?? null)
        } catch {
            addToast('error', '获取决策回放数据失败')
            setTrace(null)
        } finally {
            setLoading(false)
        }
    }, [addToast, chapterId])

    useEffect(() => {
        if (!chapterId) return
        void loadTrace()
    }, [chapterId, loadTrace])

    const selectedDecision = useMemo(
        () => trace?.decisions.find((d) => d.id === selectedDecisionId) ?? null,
        [trace, selectedDecisionId],
    )

    return (
        <PageTransition>
            <div>
                {/* ── 无 chapterId：显示章节选择列表 ── */}
                {!chapterId ? (
                    <>
                        <div className="page-head">
                            <div>
                                <Link to={`/project/${projectId}`} className="muted" style={{ textDecoration: 'none' }}>
                                    ← 返回项目
                                </Link>
                                <h1 className="title" style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <IconReplay /> 决策回放
                                </h1>
                                <p className="subtitle">请选择一个章节查看决策回放：</p>
                            </div>
                        </div>
                        {loading ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                <Skeleton variant="card" count={3} />
                            </div>
                        ) : storeChapters.length === 0 ? (
                            <div className="card" style={{ padding: 24, textAlign: 'center' }}>
                                <p className="muted">暂无章节数据。</p>
                                <Link to={`/project/${projectId}`} className="btn btn-primary" style={{ marginTop: 12, textDecoration: 'none', display: 'inline-block' }}>
                                    返回项目详情
                                </Link>
                            </div>
                        ) : (
                            <div style={{ display: 'grid', gap: 8 }}>
                                {[...storeChapters].sort((a, b) => a.chapter_number - b.chapter_number).map((ch) => (
                                    <button
                                        key={ch.id}
                                        onClick={() => navigate(`/project/${projectId}/trace/${ch.id}`)}
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
                    </>
                ) : (
                    <>
                        {/* Header */}
                        <div className="page-head">
                            <div>
                                <Link
                                    to={`/project/${projectId}/chapter/${chapterId}`}
                                    className="muted"
                                    style={{ textDecoration: 'none' }}
                                >
                                    ← 返回章节工作台
                                </Link>
                                <h1 className="title" style={{ marginTop: 6 }}>
                                    决策回放{trace ? ` · 第 ${trace.chapter_id} 章` : ''}
                                </h1>
                                <p className="subtitle">追踪多 Agent 决策链与记忆命中证据。</p>
                            </div>
                        </div>

                        {/* Loading skeleton */}
                        {loading && (
                            <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1.2fr 1fr', gap: 12 }}>
                                <div className="card" style={{ padding: 14 }}>
                                    <Skeleton variant="text" count={1} />
                                    <div style={{ marginTop: 12 }}>
                                        <Skeleton variant="card" count={4} />
                                    </div>
                                </div>
                                <div className="card" style={{ padding: 14 }}>
                                    <Skeleton variant="text" count={1} />
                                    <div style={{ marginTop: 12 }}>
                                        <Skeleton variant="card" count={2} />
                                    </div>
                                </div>
                                <div className="card" style={{ padding: 14 }}>
                                    <Skeleton variant="text" count={1} />
                                    <div style={{ marginTop: 12 }}>
                                        <Skeleton variant="card" count={3} />
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Empty state */}
                        {!loading && !trace && (
                            <div className="card" style={{ padding: 24, textAlign: 'center' }}>
                                <p className="muted">暂无决策回放数据</p>
                            </div>
                        )}

                        {/* Main content */}
                        {!loading && trace && (
                            <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1.2fr 1fr', gap: 12 }}>
                                {/* Decision timeline */}
                                <section className="card" style={{ padding: 14 }}>
                                    <h2 style={{ marginTop: 0, fontSize: '1.05rem', fontWeight: 600, letterSpacing: '-0.02em' }}>
                                        决策序列
                                    </h2>
                                    <div style={{ display: 'grid', gap: 8, maxHeight: 540, overflow: 'auto' }}>
                                        {trace.decisions.length === 0 && <p className="muted">暂无决策记录。</p>}
                                        <AnimatePresence>
                                            {trace.decisions.map((decision, index) => {
                                                const roleStyle = getRoleStyle(decision.agent_role)
                                                const isSelected = selectedDecisionId === decision.id
                                                const previewText =
                                                    sanitizeDecisionText(decision.decision_text) ||
                                                    sanitizeDecisionText(decision.reasoning) ||
                                                    '（暂无可展示文本）'
                                                return (
                                                    <motion.button
                                                        key={decision.id}
                                                        initial={{ opacity: 0, y: 8 }}
                                                        animate={{ opacity: 1, y: 0 }}
                                                        transition={{ delay: index * 0.04 }}
                                                        className="btn btn-secondary"
                                                        onClick={() => setSelectedDecisionId(decision.id)}
                                                        data-testid={`decision-${decision.id}`}
                                                        style={{
                                                            textAlign: 'left',
                                                            background: isSelected ? roleStyle.color : undefined,
                                                            borderLeft: `3px solid ${roleStyle.borderColor}`,
                                                            display: 'block',
                                                            width: '100%',
                                                            padding: '10px 12px',
                                                            whiteSpace: 'normal',
                                                            boxShadow: isSelected
                                                                ? `inset 0 0 0 1px ${roleStyle.borderColor}`
                                                                : undefined,
                                                        }}
                                                    >
                                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                                                            <span>
                                                                {index + 1}. <span style={{ color: roleStyle.borderColor }}>{roleStyle.label}</span>
                                                            </span>
                                                            <span className="metric-label">
                                                                {formatDecisionTime(decision.timestamp)}
                                                            </span>
                                                        </div>
                                                        <div className="line-clamp-2 muted" style={{ marginTop: 6 }}>
                                                            {previewText}
                                                        </div>
                                                    </motion.button>
                                                )
                                            })}
                                        </AnimatePresence>
                                    </div>
                                </section>

                                {/* Decision detail */}
                                <section className="card" style={{ padding: 14 }}>
                                    <h2 style={{ marginTop: 0, fontSize: '1.05rem', fontWeight: 600, letterSpacing: '-0.02em' }}>
                                        决策详情
                                    </h2>
                                    {!selectedDecision && <p className="muted">请选择左侧决策节点。</p>}
                                    {selectedDecision && (
                                        <div style={{ display: 'grid', gap: 10 }}>
                                            <div
                                                className="chip"
                                                style={{
                                                    background: getRoleStyle(selectedDecision.agent_role).color,
                                                    borderColor: getRoleStyle(selectedDecision.agent_role).borderColor,
                                                }}
                                            >
                                                {getRoleStyle(selectedDecision.agent_role).label}
                                            </div>

                                            <article className="card-strong" style={{ padding: 12 }}>
                                                <div className="metric-label">输入引用</div>
                                                <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
                                                    {selectedDecision.input_refs.length === 0 && <span className="muted">无</span>}
                                                    {selectedDecision.input_refs.map((ref) => (
                                                        <span key={ref} className="chip">{ref}</span>
                                                    ))}
                                                </div>
                                            </article>

                                            <article className="card-strong" style={{ padding: 12 }}>
                                                <div className="metric-label">决策文本</div>
                                                <div style={{ marginTop: 8, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                                                    {sanitizeDecisionText(selectedDecision.decision_text) || '（暂无可展示文本）'}
                                                </div>
                                            </article>

                                            {sanitizeDecisionText(selectedDecision.reasoning) && (
                                                <article className="card-strong" style={{ padding: 12 }}>
                                                    <div className="metric-label">推理过程</div>
                                                    <div style={{ marginTop: 8, whiteSpace: 'pre-wrap', lineHeight: 1.6, color: 'var(--text-secondary)' }}>
                                                        {sanitizeDecisionText(selectedDecision.reasoning)}
                                                    </div>
                                                </article>
                                            )}
                                        </div>
                                    )}
                                </section>

                                {/* Evidence & conflicts */}
                                <section className="card" style={{ padding: 14 }}>
                                    <h2 style={{ marginTop: 0, fontSize: '1.05rem', fontWeight: 600, letterSpacing: '-0.02em' }}>
                                        证据与冲突
                                    </h2>

                                    {/* Memory hits */}
                                    <div style={{ marginBottom: 10 }}>
                                        <div className="metric-label">记忆命中</div>
                                        <div style={{ marginTop: 8, display: 'grid', gap: 8, maxHeight: 210, overflow: 'auto' }}>
                                            {trace.memory_hits.length === 0 && <p className="muted">暂无命中。</p>}
                                            {trace.memory_hits.slice(0, 15).map((hit, index) => (
                                                <article key={index} className="card-strong" style={{ padding: 10 }}>
                                                    <span className="chip">{(hit.layer as string) || 'N/A'}</span>
                                                    <p style={{ margin: '6px 0 0' }} className="line-clamp-2">
                                                        {(hit.summary as string) || (hit.source_path as string) || '无摘要'}
                                                    </p>
                                                </article>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Conflicts */}
                                    <div>
                                        <div className="metric-label">冲突检测</div>
                                        <div style={{ marginTop: 8, display: 'grid', gap: 8, maxHeight: 250, overflow: 'auto' }}>
                                            {trace.conflicts_detected.length === 0 && <p className="muted">未发现冲突。</p>}
                                            {trace.conflicts_detected.map((conflict) => (
                                                <article key={conflict.id} className="card-strong" style={{ padding: 10 }}>
                                                    <span
                                                        className="chip"
                                                        style={{ background: SEVERITY_STYLES[conflict.severity.toLowerCase()] }}
                                                    >
                                                        {conflict.severity}
                                                    </span>
                                                    <p style={{ margin: '6px 0 0' }}>{conflict.reason}</p>
                                                    {conflict.suggested_fix && (
                                                        <p className="muted" style={{ margin: '4px 0 0', fontSize: '0.85rem' }}>
                                                            建议修复: {conflict.suggested_fix}
                                                        </p>
                                                    )}
                                                </article>
                                            ))}
                                        </div>
                                    </div>
                                </section>
                            </div>
                        )}
                    </>
                )}
            </div>
        </PageTransition>
    )
}
