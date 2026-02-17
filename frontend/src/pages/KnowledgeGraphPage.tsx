import { useEffect, useState, useCallback, useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import ReactFlow, {
    type Node,
    type Edge,
    type NodeTypes,
    type NodeProps,
    useNodesState,
    useEdgesState,
    MarkerType,
    Handle,
    Position,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { api } from '../lib/api'
import { useProjectStore } from '../stores/useProjectStore'
import { useToastStore } from '../stores/useToastStore'
import PageTransition from '../components/ui/PageTransition'
import Skeleton from '../components/ui/Skeleton'

/* ── Data types ── */

export interface EntityNode {
    entity_id: string
    entity_type: string // 'character' | 'location' | 'item'
    name: string
    attrs: Record<string, unknown>
    first_seen_chapter: number
    last_seen_chapter: number
}

export interface EventEdge {
    event_id: string
    subject: string
    relation: string
    object?: string
    chapter: number
    description: string
}

/* ── Style config ── */

export const ENTITY_STYLES: Record<string, { color: string; borderColor: string; textColor: string; shape: string; label: string }> = {
    character: { color: 'rgba(45, 126, 192, 0.14)', borderColor: 'rgba(45, 126, 192, 0.5)', textColor: '#2d7ec0', shape: 'circle', label: '人物' },
    location: { color: 'rgba(31, 159, 97, 0.14)', borderColor: 'rgba(31, 159, 97, 0.5)', textColor: '#1f9f61', shape: 'square', label: '地点' },
    item: { color: 'rgba(173, 111, 27, 0.14)', borderColor: 'rgba(173, 111, 27, 0.5)', textColor: '#ad6f1b', shape: 'diamond', label: '物品' },
}

const DEFAULT_STYLE = { color: 'rgba(102, 124, 164, 0.08)', borderColor: 'rgba(102, 124, 164, 0.2)', textColor: '#5a6e8d', shape: 'square', label: '未知' }

/* ── Custom Node Component ── */

interface EntityNodeData {
    label: string
    entityType: string
    attrs: Record<string, unknown>
    firstSeen: number
    lastSeen: number
    highlighted: boolean
    dimmed: boolean
}

function EntityNodeComponent({ data }: NodeProps<EntityNodeData>) {
    const style = ENTITY_STYLES[data.entityType] ?? DEFAULT_STYLE
    const [hovered, setHovered] = useState(false)

    const shapeStyle: React.CSSProperties = {
        padding: style.shape === 'circle' ? '16px' : '14px 18px',
        borderRadius: style.shape === 'circle' ? '50%' : style.shape === 'diamond' ? '4px' : '8px',
        transform: style.shape === 'diamond' ? 'rotate(45deg)' : undefined,
        background: style.color,
        border: `2px solid ${style.borderColor}`,
        color: 'var(--text-primary)',
        fontSize: '0.82rem',
        fontWeight: 700,
        textAlign: 'center' as const,
        minWidth: style.shape === 'circle' ? 72 : 80,
        minHeight: style.shape === 'circle' ? 72 : 40,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: data.dimmed ? 0.25 : 1,
        transition: 'opacity 200ms ease, box-shadow 200ms ease',
        boxShadow: data.highlighted ? `0 0 16px ${style.borderColor}` : 'none',
        position: 'relative' as const,
        cursor: 'pointer',
    }

    const labelStyle: React.CSSProperties = style.shape === 'diamond' ? { transform: 'rotate(-45deg)' } : {}

    const attrEntries = Object.entries(data.attrs || {})

    return (
        <div
            style={{ position: 'relative' }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
        >
            <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
            <div style={shapeStyle}>
                <span style={labelStyle}>{data.label}</span>
            </div>
            <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />

            {/* Hover tooltip */}
            {hovered && (
                <div
                    role="tooltip"
                    style={{
                        position: 'absolute',
                        top: '100%',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        marginTop: 8,
                        padding: '10px 14px',
                        borderRadius: 10,
                        border: '1px solid var(--glass-border)',
                        background: 'rgba(255, 255, 255, 0.96)',
                        backdropFilter: 'blur(20px)',
                        boxShadow: '0 4px 24px rgba(32, 53, 88, 0.10), 0 1.5px 6px rgba(27, 38, 63, 0.04)',
                        zIndex: 100,
                        minWidth: 180,
                        maxWidth: 280,
                        fontSize: '0.8rem',
                        pointerEvents: 'none',
                        whiteSpace: 'normal',
                    }}
                >
                    <div style={{ fontWeight: 700, marginBottom: 6, color: 'var(--text-primary)' }}>
                        {data.label}
                        <span
                            style={{
                                marginLeft: 8,
                                padding: '2px 8px',
                                borderRadius: 999,
                                fontSize: '0.7rem',
                                background: style.color,
                                border: `1px solid ${style.borderColor}`,
                            }}
                        >
                            {style.label}
                        </span>
                    </div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.76rem', marginBottom: attrEntries.length > 0 ? 6 : 0 }}>
                        首次出现：第 {data.firstSeen} 章 · 最近：第 {data.lastSeen} 章
                    </div>
                    {attrEntries.length > 0 && (
                        <div style={{ display: 'grid', gap: 3 }}>
                            {attrEntries.map(([key, value]) => (
                                <div key={key} style={{ color: 'var(--text-secondary)', fontSize: '0.76rem' }}>
                                    <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{key}:</span> {String(value)}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}

const nodeTypes: NodeTypes = { entity: EntityNodeComponent }

/* ── Graph building helpers ── */

export function buildGraphNodes(entities: EntityNode[]): Node<EntityNodeData>[] {
    const cols = 4
    const xGap = 200
    const yGap = 160

    return entities.map((entity, i) => {
        const col = i % cols
        const row = Math.floor(i / cols)
        return {
            id: entity.entity_id,
            type: 'entity',
            position: { x: col * xGap + 50, y: row * yGap + 50 },
            data: {
                label: entity.name,
                entityType: entity.entity_type,
                attrs: entity.attrs,
                firstSeen: entity.first_seen_chapter,
                lastSeen: entity.last_seen_chapter,
                highlighted: false,
                dimmed: false,
            },
        }
    })
}

export function buildGraphEdges(events: EventEdge[], entities: EntityNode[]): Edge[] {
    const entityNameToId = new Map<string, string>()
    for (const e of entities) {
        entityNameToId.set(e.name, e.entity_id)
    }

    const edges: Edge[] = []
    for (const event of events) {
        const sourceId = entityNameToId.get(event.subject)
        const targetId = event.object ? entityNameToId.get(event.object) : undefined
        if (sourceId && targetId) {
            edges.push({
                id: event.event_id,
                source: sourceId,
                target: targetId,
                label: event.relation,
                animated: false,
                style: { stroke: 'rgba(102, 124, 164, 0.3)', strokeWidth: 1.5 },
                labelStyle: { fill: '#5a6e8d', fontSize: 11 },
                labelBgStyle: { fill: 'rgba(255, 255, 255, 0.9)', fillOpacity: 0.9 },
                labelBgPadding: [6, 4] as [number, number],
                labelBgBorderRadius: 4,
                markerEnd: { type: MarkerType.ArrowClosed, color: 'rgba(102, 124, 164, 0.3)' },
            })
        }
    }
    return edges
}

/** Given a clicked node id and the full edge list, return the set of highlighted node ids and edge ids */
export function getHighlightSets(
    clickedNodeId: string,
    edges: Edge[],
): { highlightedNodeIds: Set<string>; highlightedEdgeIds: Set<string> } {
    const highlightedNodeIds = new Set<string>([clickedNodeId])
    const highlightedEdgeIds = new Set<string>()

    for (const edge of edges) {
        if (edge.source === clickedNodeId || edge.target === clickedNodeId) {
            highlightedEdgeIds.add(edge.id)
            highlightedNodeIds.add(edge.source)
            highlightedNodeIds.add(edge.target)
        }
    }

    return { highlightedNodeIds, highlightedEdgeIds }
}

/** Sort events by chapter ascending */
export function sortEventsByChapter(events: EventEdge[]): EventEdge[] {
    return [...events].sort((a, b) => a.chapter - b.chapter)
}

/* ── Main Page Component ── */

export default function KnowledgeGraphPage() {
    const { projectId } = useParams<{ projectId: string }>()
    const fetchProject = useProjectStore((s) => s.fetchProject)
    const currentProject = useProjectStore((s) => s.currentProject)
    const addToast = useToastStore((s) => s.addToast)

    const [entities, setEntities] = useState<EntityNode[]>([])
    const [events, setEvents] = useState<EventEdge[]>([])
    const [loading, setLoading] = useState(true)
    const [tab, setTab] = useState<'graph' | 'timeline'>('graph')
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

    const [nodes, setNodes, onNodesChange] = useNodesState<EntityNodeData>([])
    const [edges, setEdges, onEdgesChange] = useEdgesState([])

    // Load project context
    useEffect(() => {
        if (projectId && !currentProject) {
            fetchProject(projectId)
        }
    }, [projectId, currentProject, fetchProject])

    // Load graph data
    useEffect(() => {
        if (!projectId) return
        loadData()
    }, [projectId])

    const loadData = async () => {
        setLoading(true)
        try {
            const [entityRes, eventRes] = await Promise.all([
                api.get(`/entities/${projectId}`),
                api.get(`/events/${projectId}`),
            ])
            const loadedEntities: EntityNode[] = entityRes.data ?? []
            const loadedEvents: EventEdge[] = eventRes.data ?? []
            setEntities(loadedEntities)
            setEvents(loadedEvents)
            setNodes(buildGraphNodes(loadedEntities))
            setEdges(buildGraphEdges(loadedEvents, loadedEntities))
            setSelectedNodeId(null)
        } catch (error) {
            addToast('error', '加载知识图谱数据失败')
            console.error(error)
        } finally {
            setLoading(false)
        }
    }

    // Handle node click → highlight neighbors
    const onNodeClick = useCallback(
        (_: React.MouseEvent, node: Node) => {
            const clickedId = node.id
            if (selectedNodeId === clickedId) {
                // Deselect
                setSelectedNodeId(null)
                setNodes((nds) =>
                    nds.map((n) => ({ ...n, data: { ...n.data, highlighted: false, dimmed: false } })),
                )
                setEdges((eds) =>
                    eds.map((e) => ({
                        ...e,
                        animated: false,
                        style: { ...e.style, stroke: 'rgba(102, 124, 164, 0.3)', strokeWidth: 1.5 },
                    })),
                )
                return
            }

            setSelectedNodeId(clickedId)
            const allEdges = edges
            const { highlightedNodeIds, highlightedEdgeIds } = getHighlightSets(clickedId, allEdges)

            setNodes((nds) =>
                nds.map((n) => ({
                    ...n,
                    data: {
                        ...n.data,
                        highlighted: highlightedNodeIds.has(n.id),
                        dimmed: !highlightedNodeIds.has(n.id),
                    },
                })),
            )
            setEdges((eds) =>
                eds.map((e) => ({
                    ...e,
                    animated: highlightedEdgeIds.has(e.id),
                    style: {
                        ...e.style,
                        stroke: highlightedEdgeIds.has(e.id) ? '#0a8b83' : 'rgba(102, 124, 164, 0.1)',
                        strokeWidth: highlightedEdgeIds.has(e.id) ? 2.5 : 1,
                    },
                })),
            )
        },
        [selectedNodeId, edges, setNodes, setEdges],
    )

    // Click on pane → deselect
    const onPaneClick = useCallback(() => {
        setSelectedNodeId(null)
        setNodes((nds) =>
            nds.map((n) => ({ ...n, data: { ...n.data, highlighted: false, dimmed: false } })),
        )
        setEdges((eds) =>
            eds.map((e) => ({
                ...e,
                animated: false,
                style: { ...e.style, stroke: 'rgba(102, 124, 164, 0.3)', strokeWidth: 1.5 },
            })),
        )
    }, [setNodes, setEdges])

    const sortedEvents = useMemo(() => sortEventsByChapter(events), [events])

    const tabs: { key: 'graph' | 'timeline'; label: string }[] = [
        { key: 'graph', label: '关系视图' },
        { key: 'timeline', label: '事件时间线' },
    ]

    return (
        <PageTransition>
            <div>
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
                        <h1 className="title" style={{ marginTop: 6 }}>知识图谱</h1>
                        <p className="muted" style={{ margin: '4px 0 0', fontSize: '0.88rem' }}>
                            角色状态、关系事件与时间线一致性视图。
                        </p>
                    </div>
                </div>

                {/* Tab bar */}
                <div
                    style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}
                    role="tablist"
                    aria-label="知识图谱标签页"
                >
                    {tabs.map((t) => (
                        <button
                            key={t.key}
                            role="tab"
                            aria-selected={tab === t.key}
                            className={`chip-btn ${tab === t.key ? 'active' : ''}`}
                            onClick={() => setTab(t.key)}
                            style={{ padding: '8px 16px' }}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>

                {/* Loading */}
                {loading && (
                    <div style={{ display: 'grid', gap: 12 }}>
                        <Skeleton variant="card" count={3} />
                    </div>
                )}

                {/* Graph tab */}
                {!loading && tab === 'graph' && (
                    <div
                        className="card"
                        style={{
                            padding: 0,
                            height: 560,
                            overflow: 'hidden',
                            position: 'relative',
                        }}
                    >
                        {entities.length === 0 ? (
                            <p className="muted" style={{ padding: 24 }}>暂无实体数据，请先生成章节。</p>
                        ) : (
                            <ReactFlow
                                nodes={nodes}
                                edges={edges}
                                onNodesChange={onNodesChange}
                                onEdgesChange={onEdgesChange}
                                onNodeClick={onNodeClick}
                                onPaneClick={onPaneClick}
                                nodeTypes={nodeTypes}
                                fitView
                                proOptions={{ hideAttribution: true }}
                                style={{ background: 'transparent' }}
                            />
                        )}
                    </div>
                )}

                {/* Timeline tab */}
                {!loading && tab === 'timeline' && (
                    <section className="card" style={{ padding: 14 }}>
                        <h2 style={{ marginTop: 0, fontSize: '1.05rem', fontWeight: 600, letterSpacing: '-0.02em' }}>
                            章节事件序列
                        </h2>
                        <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
                            {sortedEvents.length === 0 && (
                                <p className="muted">暂无事件时间线。</p>
                            )}
                            {sortedEvents.map((event) => (
                                <article key={event.event_id} className="card-strong" style={{ padding: 12 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                                        <span className="chip">第 {event.chapter} 章</span>
                                        <span className="metric-label">{event.relation}</span>
                                    </div>
                                    <p style={{ margin: '8px 0 4px' }}>
                                        {event.subject} → {event.object || '未知对象'}
                                    </p>
                                    <p className="muted" style={{ margin: 0 }}>{event.description || '无描述'}</p>
                                </article>
                            ))}
                        </div>
                    </section>
                )}
            </div>
        </PageTransition>
    )
}
