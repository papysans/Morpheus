import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { Link, useParams } from 'react-router-dom'
import ReactFlow, {
    type Node,
    type Edge,
    type ReactFlowInstance,
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
import { GRAPH_FEATURE_ENABLED } from '../config/features'

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

export interface BuildGraphEdgeOptions {
    includeProgress?: boolean
    latestPerPair?: boolean
}

export interface L4GraphNode {
    id: string
    label: string
    overview?: string
    personality?: string
}

export interface L4GraphEdge {
    id: string
    source: string
    target: string
    label: string
}

/* ── Style config ── */

export const ENTITY_STYLES: Record<string, { color: string; borderColor: string; textColor: string; shape: string; label: string }> = {
    character: { color: 'rgba(45, 126, 192, 0.14)', borderColor: 'rgba(45, 126, 192, 0.5)', textColor: '#2d7ec0', shape: 'circle', label: '人物' },
    location: { color: 'rgba(31, 159, 97, 0.14)', borderColor: 'rgba(31, 159, 97, 0.5)', textColor: '#1f9f61', shape: 'square', label: '地点' },
    item: { color: 'rgba(173, 111, 27, 0.14)', borderColor: 'rgba(173, 111, 27, 0.5)', textColor: '#ad6f1b', shape: 'diamond', label: '物品' },
}

const DEFAULT_STYLE = { color: 'rgba(102, 124, 164, 0.08)', borderColor: 'rgba(102, 124, 164, 0.2)', textColor: '#5a6e8d', shape: 'square', label: '未知' }

const ROLE_NAME_ALIASES: Record<string, string> = {
    primary: '主角',
    protagonist: '主角',
    secondary: '关键配角',
    supporting: '关键配角',
    antagonist: '反派',
}

const ROLE_NAME_IGNORES = new Set(['hidden', 'secret', 'unknown', 'none', 'null'])
const ROLE_NAME_STOPWORDS = new Set([
    '章节',
    '章末',
    '目标',
    '冲突',
    '线索',
    '伏笔',
    '回收',
    '开场',
    '结尾',
    '剧情',
    '故事',
    '万事屋',
    '猪肉铺',
    '猪肉铺2号',
    '长城路',
    '长城路猪肉铺',
    '长城路猪肉铺2号',
    '黑衣人',
    '器官库',
    '数据碎片',
    '都市传',
    '都市怪',
    '都没',
    '后者正',
    '胡说八',
    '任凭赵老板',
    '任谁',
    '后者',
    '前者',
    '通风管',
    '从管',
    '冷静',
])

const ROLE_NAME_PREFIX_BLOCKLIST = [
    '后者',
    '前者',
    '任凭',
    '都没',
    '胡说',
    '据说',
    '听说',
    '如果',
    '但是',
    '只是',
    '这个',
    '那个',
]

const ROLE_NAME_TRAILING_INVALID_CHARS = new Set(['没', '不', '了', '着', '过', '都', '也', '正', '谁', '啥', '么'])
const ROLE_NAME_INTERNAL_INVALID_CHARS = new Set(['者', '说', '没'])
const ROLE_NAME_TITLE_SUFFIXES = ['教授', '医生', '老板', '队长', '先生', '小姐', '同学']

function normalizeRoleName(name?: string) {
    const raw = String(name || '').trim()
    if (!raw) return ''
    const key = raw.toLowerCase()
    if (ROLE_NAME_IGNORES.has(key)) return ''

    let normalized = ROLE_NAME_ALIASES[key] || raw
    normalized = normalized.replace(/^(?:连|那|这|把|对|向|跟|让|与|和)/, '')
    normalized = normalized.replace(/(?:喊|问|说|看|听|追|知|苦|笑|道|叫|答|想|盯|望)$/, '')
    normalized = normalized.trim()

    if (!normalized) return ''
    if (!/^[\u4e00-\u9fff]{2,8}$/.test(normalized)) return ''
    if (normalized.includes('第') && normalized.includes('章')) return ''
    if (ROLE_NAME_STOPWORDS.has(normalized)) return ''
    if (ROLE_NAME_PREFIX_BLOCKLIST.some((prefix) => normalized.startsWith(prefix))) return ''

    if (normalized.length === 2 && ROLE_NAME_TRAILING_INVALID_CHARS.has(normalized[1])) return ''
    if (normalized.length >= 3) {
        if (ROLE_NAME_TRAILING_INVALID_CHARS.has(normalized[normalized.length - 1])) return ''
        for (let i = 1; i < normalized.length; i += 1) {
            if (ROLE_NAME_INTERNAL_INVALID_CHARS.has(normalized[i])) return ''
        }
    }

    const matchedTitleSuffix = ROLE_NAME_TITLE_SUFFIXES.find((suffix) => normalized.endsWith(suffix))
    if (matchedTitleSuffix) {
        const stem = normalized.slice(0, normalized.length - matchedTitleSuffix.length)
        if (!stem || stem.length > 2) return ''
    }

    if (normalized.length > 4 && !matchedTitleSuffix) return ''

    return normalized
}

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
            <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
            <div style={shapeStyle}>
                <span style={labelStyle}>{data.label}</span>
            </div>
            <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />

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

let elkInstancePromise: Promise<{ layout: (graph: unknown) => Promise<any> }> | null = null

async function getElkInstance() {
    if (!elkInstancePromise) {
        elkInstancePromise = import('elkjs/lib/elk.bundled.js').then((module) => {
            const ELKConstructor = (module as { default?: new () => { layout: (graph: unknown) => Promise<any> } }).default
            if (!ELKConstructor) {
                throw new Error('ELK constructor is unavailable')
            }
            return new ELKConstructor()
        })
    }
    return elkInstancePromise
}

function getNodeLayoutBox(node: Node<EntityNodeData>) {
    const entityType = node.data?.entityType
    if (entityType === 'character') return { width: 180, height: 120 }
    if (entityType === 'location') return { width: 170, height: 100 }
    if (entityType === 'item') return { width: 170, height: 100 }
    return { width: 170, height: 100 }
}

export async function layoutGraphWithElk(
    nodes: Node<EntityNodeData>[],
    edges: Edge[],
): Promise<{ nodes: Node<EntityNodeData>[]; edges: Edge[] }> {
    if (nodes.length === 0) {
        return { nodes, edges }
    }
    const elk = await getElkInstance()
    const elkGraph = {
        id: 'root',
        layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': 'RIGHT',
            'elk.layered.spacing.nodeNodeBetweenLayers': '180',
            'elk.spacing.nodeNode': '120',
            'elk.spacing.edgeNode': '70',
            'elk.edgeRouting': 'SPLINES',
            'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
        },
        children: nodes.map((node) => {
            const box = getNodeLayoutBox(node)
            return { id: node.id, width: box.width, height: box.height }
        }),
        edges: edges.map((edge) => ({
            id: edge.id,
            sources: [edge.source],
            targets: [edge.target],
        })),
    }
    const layouted = await elk.layout(elkGraph)
    const positioned = new Map<string, { x: number; y: number }>(
        (layouted.children || []).map((child: { id: string; x?: number; y?: number }) => [
            child.id,
            { x: child.x ?? 0, y: child.y ?? 0 },
        ]),
    )
    return {
        nodes: nodes.map((node) => {
            const nextPosition = positioned.get(node.id)
            const fallbackPosition = node.position || { x: 0, y: 0 }
            return {
                ...node,
                position: nextPosition
                    ? { x: nextPosition.x, y: nextPosition.y }
                    : { x: fallbackPosition.x, y: fallbackPosition.y },
                sourcePosition: Position.Right,
                targetPosition: Position.Left,
            }
        }),
        edges,
    }
}

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

function isProgressRelation(relation: string) {
    const value = String(relation || '').trim().toLowerCase()
    return value === 'progress' || value === '推进'
}

export function buildGraphEdges(
    events: EventEdge[],
    entities: EntityNode[],
    options: BuildGraphEdgeOptions = {},
): Edge[] {
    const includeProgress = options.includeProgress ?? false
    const latestPerPair = options.latestPerPair ?? true
    const entityNameToId = new Map<string, string>()
    for (const e of entities) {
        entityNameToId.set(e.name, e.entity_id)
    }

    type EdgeCandidate = {
        source: string
        target: string
        relation: string
        chapter: number
        eventId: string
    }
    const candidates: EdgeCandidate[] = []
    for (const event of events) {
        if (!includeProgress && isProgressRelation(event.relation)) continue
        const sourceId = entityNameToId.get(event.subject)
        const targetId = event.object ? entityNameToId.get(event.object) : undefined
        if (sourceId && targetId) {
            candidates.push({
                source: sourceId,
                target: targetId,
                relation: event.relation,
                chapter: event.chapter,
                eventId: event.event_id,
            })
        }
    }

    const aggregated = new Map<
        string,
        { source: string; target: string; relation: string; latestChapter: number; count: number; eventId: string }
    >()
    for (const item of candidates) {
        const key = `${item.source}::${item.target}::${item.relation}`
        const existing = aggregated.get(key)
        if (!existing) {
            aggregated.set(key, {
                source: item.source,
                target: item.target,
                relation: item.relation,
                latestChapter: item.chapter,
                count: 1,
                eventId: item.eventId,
            })
            continue
        }
        existing.count += 1
        if (item.chapter >= existing.latestChapter) {
            existing.latestChapter = item.chapter
            existing.eventId = item.eventId
        }
    }

    const edges: Edge[] = []
    const relationPriority: Record<string, number> = {
        背叛: 7,
        冲突: 6,
        揭露: 5,
        交易: 4,
        调查: 3,
        合作: 2,
        保护: 1,
        关联: 1,
        progress: 0,
    }

    if (latestPerPair) {
        const byUndirectedPair = new Map<
            string,
            Array<{ source: string; target: string; relation: string; latestChapter: number; count: number; eventId: string }>
        >()
        for (const item of aggregated.values()) {
            const pairKey = [item.source, item.target].sort().join('::')
            const bucket = byUndirectedPair.get(pairKey) ?? []
            bucket.push(item)
            byUndirectedPair.set(pairKey, bucket)
        }
        for (const pairItems of byUndirectedPair.values()) {
            const winner = [...pairItems].sort(
                (a, b) =>
                    b.latestChapter - a.latestChapter ||
                    (relationPriority[b.relation] ?? 0) - (relationPriority[a.relation] ?? 0) ||
                    a.relation.localeCompare(b.relation),
            )[0]
            edges.push({
                id: `edge-${winner.source}-${winner.target}-${winner.relation}`,
                source: winner.source,
                target: winner.target,
                type: 'default',
                label: winner.count > 1 ? `${winner.relation} ×${winner.count}` : winner.relation,
                animated: false,
                style: { stroke: 'rgba(102, 124, 164, 0.3)', strokeWidth: 1.5 },
                labelStyle: { fill: '#5a6e8d', fontSize: 11 },
                labelBgStyle: { fill: 'rgba(255, 255, 255, 0.9)', fillOpacity: 0.9 },
                labelBgPadding: [6, 4] as [number, number],
                labelBgBorderRadius: 4,
                markerEnd: { type: MarkerType.ArrowClosed, color: 'rgba(102, 124, 164, 0.3)' },
            })
        }
        return edges
    }

    const byDirectionalPair = new Map<
        string,
        Array<{ source: string; target: string; relation: string; latestChapter: number; count: number; eventId: string }>
    >()
    for (const item of aggregated.values()) {
        const pairKey = `${item.source}::${item.target}`
        const bucket = byDirectionalPair.get(pairKey) ?? []
        bucket.push(item)
        byDirectionalPair.set(pairKey, bucket)
    }

    for (const pairItems of byDirectionalPair.values()) {
        const bucket = [...pairItems].sort(
            (a, b) =>
                b.latestChapter - a.latestChapter ||
                (relationPriority[b.relation] ?? 0) - (relationPriority[a.relation] ?? 0) ||
                a.relation.localeCompare(b.relation),
        )
        bucket.forEach((item) => {
            edges.push({
                id: `edge-${item.source}-${item.target}-${item.relation}`,
                source: item.source,
                target: item.target,
                type: 'default',
                label: item.count > 1 ? `${item.relation} ×${item.count}` : item.relation,
                animated: false,
                style: { stroke: 'rgba(102, 124, 164, 0.3)', strokeWidth: 1.5 },
                labelStyle: { fill: '#5a6e8d', fontSize: 11 },
                labelBgStyle: { fill: 'rgba(255, 255, 255, 0.9)', fillOpacity: 0.9 },
                labelBgPadding: [6, 4] as [number, number],
                labelBgBorderRadius: 4,
                markerEnd: { type: MarkerType.ArrowClosed, color: 'rgba(102, 124, 164, 0.3)' },
            })
        })
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

export function sanitizeGraphData(
    entities: EntityNode[],
    events: EventEdge[],
): { entities: EntityNode[]; events: EventEdge[] } {
    const merged = new Map<string, EntityNode>()
    for (const entity of entities) {
        const normalizedName = normalizeRoleName(entity.name)
        if (!normalizedName) continue
        const key = `${entity.entity_type}:${normalizedName}`
        const existing = merged.get(key)
        if (!existing) {
            merged.set(key, { ...entity, name: normalizedName })
            continue
        }
        merged.set(key, {
            ...existing,
            attrs: { ...(existing.attrs || {}), ...(entity.attrs || {}) },
            first_seen_chapter: Math.min(existing.first_seen_chapter, entity.first_seen_chapter),
            last_seen_chapter: Math.max(existing.last_seen_chapter, entity.last_seen_chapter),
        })
    }
    const sanitizedEntities = [...merged.values()].sort(
        (a, b) => b.last_seen_chapter - a.last_seen_chapter || a.name.localeCompare(b.name),
    )

    const sanitizedEvents: EventEdge[] = []
    for (const event of events) {
        const subject = normalizeRoleName(event.subject)
        if (!subject) continue
        const objectCandidate = event.object ? normalizeRoleName(event.object) : ''
        sanitizedEvents.push({
            ...event,
            subject,
            object: objectCandidate && objectCandidate !== subject ? objectCandidate : undefined,
        })
    }

    return { entities: sanitizedEntities, events: sanitizedEvents }
}

export function buildL4GraphNodes(l4Nodes: L4GraphNode[]): Node<EntityNodeData>[] {
    const cols = 4
    const xGap = 200
    const yGap = 160
    return l4Nodes.map((node, i) => {
        const col = i % cols
        const row = Math.floor(i / cols)
        return {
            id: node.id,
            type: 'entity',
            position: { x: col * xGap + 50, y: row * yGap + 50 },
            data: {
                label: node.label,
                entityType: 'character' as const,
                attrs: {
                    ...(node.overview ? { 概述: node.overview } : {}),
                    ...(node.personality ? { 性格: node.personality } : {}),
                },
                firstSeen: 0,
                lastSeen: 0,
                highlighted: false,
                dimmed: false,
            },
        }
    })
}

export function buildL4GraphEdges(l4Edges: L4GraphEdge[]): Edge[] {
    return l4Edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'default',
        label: edge.label,
        animated: false,
        style: { stroke: 'rgba(102, 124, 164, 0.3)', strokeWidth: 1.5 },
        labelStyle: { fill: '#5a6e8d', fontSize: 11 },
        labelBgStyle: { fill: 'rgba(255, 255, 255, 0.9)', fillOpacity: 0.9 },
        labelBgPadding: [6, 4] as [number, number],
        labelBgBorderRadius: 4,
        markerEnd: { type: MarkerType.ArrowClosed, color: 'rgba(102, 124, 164, 0.3)' },
    }))
}

/* ── Main Page Component ── */

export default function KnowledgeGraphPage() {
    const { projectId } = useParams<{ projectId: string }>()
    const fetchProject = useProjectStore((s) => s.fetchProject)
    const currentProject = useProjectStore((s) => s.currentProject)
    const addToast = useToastStore((s) => s.addToast)

    const [_entities, setEntities] = useState<EntityNode[]>([])
    const [events, setEvents] = useState<EventEdge[]>([])
    const [l4Nodes, setL4Nodes] = useState<L4GraphNode[]>([])
    const [l4Edges, setL4Edges] = useState<L4GraphEdge[]>([])
    const [loading, setLoading] = useState(true)
    const [tab, setTab] = useState<'graph' | 'timeline'>('graph')
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
    const [showProgressEdges, setShowProgressEdges] = useState(false)
    const [showAllPairEdges, setShowAllPairEdges] = useState(false)
    const [layoutLoading, setLayoutLoading] = useState(false)
    const layoutRunRef = useRef(0)
    const flowRef = useRef<ReactFlowInstance | null>(null)

    const [nodes, setNodes, onNodesChange] = useNodesState<EntityNodeData>([])
    const [edges, setEdges, onEdgesChange] = useEdgesState([])

    // Load project context
    useEffect(() => {
        if (projectId && currentProject?.id !== projectId) {
            fetchProject(projectId)
        }
    }, [projectId, currentProject, fetchProject])

    // Load graph data
    useEffect(() => {
        if (!projectId) return
        if (!GRAPH_FEATURE_ENABLED) {
            setLoading(false)
            setLayoutLoading(false)
            setEntities([])
            setEvents([])
            return
        }
        loadData()
    }, [projectId])

    const loadData = async () => {
        setLoading(true)
        setLayoutLoading(true)
        setNodes([])
        setEdges([])
        setSelectedNodeId(null)
        try {
            const [graphRes, eventRes] = await Promise.all([
                api.get(`/projects/${projectId}/graph`),
                api.get(`/events/${projectId}`),
            ])
            const newL4Nodes: L4GraphNode[] = graphRes.data?.nodes ?? []
            const newL4Edges: L4GraphEdge[] = graphRes.data?.edges ?? []
            setL4Nodes(newL4Nodes)
            setL4Edges(newL4Edges)
            setEvents(eventRes.data ?? [])
        } catch (error) {
            addToast('error', '加载知识图谱数据失败')
            console.error(error)
        } finally {
            setLoading(false)
            setLayoutLoading(false)
        }
    }

    useEffect(() => {
        if (!GRAPH_FEATURE_ENABLED) return
        if (l4Nodes.length === 0) {
            setNodes([])
            setEdges([])
            return
        }
        const currentRun = layoutRunRef.current + 1
        layoutRunRef.current = currentRun
        setLayoutLoading(true)

        const rfNodes = buildL4GraphNodes(l4Nodes)
        const rfEdges = buildL4GraphEdges(l4Edges)

        void layoutGraphWithElk(rfNodes, rfEdges)
            .then((layouted) => {
                if (layoutRunRef.current !== currentRun) return
                setNodes(layouted.nodes)
                setEdges(layouted.edges)
                setSelectedNodeId(null)
                requestAnimationFrame(() => {
                    flowRef.current?.fitView({ padding: 0.18, duration: 280 })
                })
            })
            .catch((error) => {
                if (layoutRunRef.current !== currentRun) return
                console.error('ELK layout failed, fallback to static positions', error)
                setNodes(rfNodes)
                setEdges(rfEdges)
                setSelectedNodeId(null)
            })
            .finally(() => {
                if (layoutRunRef.current !== currentRun) return
                setLayoutLoading(false)
            })
    }, [l4Nodes, l4Edges, setEdges, setNodes])

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

    if (!GRAPH_FEATURE_ENABLED) {
        return (
            <PageTransition>
                <div>
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
                        </div>
                    </div>
                    <section className="card" style={{ padding: 16 }}>
                        <h2 className="section-title" style={{ marginTop: 0 }}>功能已暂时关闭</h2>
                        <p className="muted" style={{ marginBottom: 12 }}>
                            知识图谱已按当前配置下线，后续需要恢复时可重新开启。
                        </p>
                        <Link to={`/project/${projectId}`} className="btn btn-secondary" style={{ textDecoration: 'none' }}>
                            返回项目概览
                        </Link>
                    </section>
                </div>
            </PageTransition>
        )
    }

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
                    <>
                        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                            <button
                                className={`chip-btn ${showProgressEdges ? 'active' : ''}`}
                                onClick={() => setShowProgressEdges((v) => !v)}
                                aria-pressed={showProgressEdges}
                            >
                                {showProgressEdges ? 'progress 已显示' : 'progress 已隐藏'}
                            </button>
                            <button
                                className={`chip-btn ${showAllPairEdges ? 'active' : ''}`}
                                onClick={() => setShowAllPairEdges((v) => !v)}
                                aria-pressed={showAllPairEdges}
                            >
                                {showAllPairEdges ? '显示全部历史边' : '仅显示最新关系'}
                            </button>
                        </div>
                        <div
                            className="card"
                            style={{
                                padding: 0,
                                height: 560,
                                overflow: 'hidden',
                                position: 'relative',
                            }}
                        >
                            {l4Nodes.length === 0 ? (
                                <p className="muted" style={{ padding: 24 }}>暂无角色档案，完成章节后自动生成</p>
                            ) : (
                                <ReactFlow
                                    nodes={nodes}
                                    edges={edges}
                                    onNodesChange={onNodesChange}
                                    onEdgesChange={onEdgesChange}
                                    onNodeClick={onNodeClick}
                                    onPaneClick={onPaneClick}
                                    nodeTypes={nodeTypes}
                                    onInit={(instance) => {
                                        flowRef.current = instance
                                    }}
                                    proOptions={{ hideAttribution: true }}
                                    style={{ background: 'transparent' }}
                                />
                            )}
                            {layoutLoading && l4Nodes.length > 0 && (
                                <div
                                    style={{
                                        position: 'absolute',
                                        inset: 0,
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        background: 'rgba(255, 255, 255, 0.55)',
                                        backdropFilter: 'blur(2px)',
                                        zIndex: 3,
                                        pointerEvents: 'none',
                                        color: 'var(--text-secondary)',
                                        fontSize: '0.9rem',
                                        fontWeight: 600,
                                    }}
                                >
                                    正在自动布局关系图…
                                </div>
                            )}
                        </div>
                    </>
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
