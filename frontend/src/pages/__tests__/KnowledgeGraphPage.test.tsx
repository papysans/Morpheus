import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { useState as reactUseState } from 'react'
import KnowledgeGraphPage, {
    buildGraphNodes,
    buildGraphEdges,
    buildL4GraphNodes,
    getHighlightSets,
    sanitizeGraphData,
    sortEventsByChapter,
    ENTITY_STYLES,
    type EntityNode,
    type EventEdge,
    type L4GraphNode,
    type L4GraphEdge,
} from '../KnowledgeGraphPage'
import { useToastStore } from '../../stores/useToastStore'

/* ── Mocks ── */

vi.mock('framer-motion', () => ({
    motion: {
        div: ({ children, ...props }: any) => <div {...filterMotionProps(props)}>{children}</div>,
        section: ({ children, ...props }: any) => <section {...filterMotionProps(props)}>{children}</section>,
    },
    AnimatePresence: ({ children }: any) => <>{children}</>,
}))

function filterMotionProps(props: Record<string, any>) {
    const filtered: Record<string, any> = {}
    for (const key of Object.keys(props)) {
        if (!['initial', 'animate', 'exit', 'transition', 'whileHover', 'whileTap', 'layout'].includes(key)) {
            filtered[key] = props[key]
        }
    }
    return filtered
}

// Mock ReactFlow — render nodes as divs with data-testid
vi.mock('reactflow', () => {
    const Position = { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' }
    const MarkerType = { ArrowClosed: 'arrowclosed' }

    function ReactFlow({ nodes, edges, onNodeClick, onPaneClick, onNodeContextMenu, nodeTypes }: any) {
        const EntityComp = nodeTypes?.entity
        return (
            <div data-testid="reactflow-canvas" onClick={onPaneClick}>
                {nodes?.map((node: any) => (
                    <div
                        key={node.id}
                        data-testid={`rf-node-${node.id}`}
                        onClick={(e) => {
                            e.stopPropagation()
                            onNodeClick?.(e, node)
                        }}
                        onContextMenu={(e: any) => onNodeContextMenu?.(e, node)}
                    >
                        {EntityComp && <EntityComp id={node.id} data={node.data} type="entity" />}
                    </div>
                ))}
                {edges?.map((edge: any) => (
                    <div
                        key={edge.id}
                        data-testid={`rf-edge-${edge.id}`}
                        data-animated={edge.animated ? 'true' : 'false'}
                    >
                        {edge.label}
                    </div>
                ))}
            </div>
        )
    }

    return {
        default: ReactFlow,
        useNodesState: (init: any[]) => {
            const [nodes, setNodes] = reactUseState(init)
            return [nodes, setNodes, vi.fn()]
        },
        useEdgesState: (init: any[]) => {
            const [edges, setEdges] = reactUseState(init)
            return [edges, setEdges, vi.fn()]
        },
        Handle: ({ type, position }: any) => <div data-testid={`handle-${type}-${position}`} />,
        Position,
        MarkerType,
    }
})

const mockApiGet = vi.fn()
vi.mock('../../lib/api', () => ({
    api: { get: (...args: any[]) => mockApiGet(...args), delete: vi.fn(), patch: vi.fn(), post: vi.fn() },
}))

const mockFetchProject = vi.fn()
vi.mock('../../stores/useProjectStore', () => ({
    useProjectStore: (selector: (s: any) => any) =>
        selector({
            fetchProject: mockFetchProject,
            currentProject: { id: 'proj-1', name: '测试项目' },
        }),
}))

/* ── Test data ── */

const sampleEntities: EntityNode[] = [
    { entity_id: 'e1', entity_type: 'character', name: '李明', attrs: { age: 25, role: '主角' }, first_seen_chapter: 1, last_seen_chapter: 5 },
    { entity_id: 'e2', entity_type: 'location', name: '冰霜城', attrs: { climate: '寒冷' }, first_seen_chapter: 1, last_seen_chapter: 3 },
    { entity_id: 'e3', entity_type: 'item', name: '火焰剑', attrs: {}, first_seen_chapter: 2, last_seen_chapter: 4 },
]

const sampleEvents: EventEdge[] = [
    { event_id: 'ev1', subject: '李明', relation: '前往', object: '冰霜城', chapter: 1, description: '主角出发前往冰霜城' },
    { event_id: 'ev2', subject: '李明', relation: '获得', object: '火焰剑', chapter: 2, description: '主角获得火焰剑' },
    { event_id: 'ev3', subject: '李明', relation: '战斗', chapter: 3, description: '主角在冰霜城战斗' },
]

function renderPage(projectId = 'proj-1') {
    return render(
        <MemoryRouter initialEntries={[`/project/${projectId}/graph`]}>
            <Routes>
                <Route path="/project/:projectId/graph" element={<KnowledgeGraphPage />} />
                <Route path="/project/:projectId" element={<div>Project Detail</div>} />
            </Routes>
        </MemoryRouter>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    useToastStore.setState({ toasts: [] })
    mockApiGet.mockImplementation((url: string) => {
        if (url.includes('/projects/') && url.includes('/graph'))
            return Promise.resolve({
                data: {
                    nodes: [
                        { id: 'e1', label: '李明', overview: '主角', personality: '冷静' },
                        { id: 'e2', label: '冰霜城', overview: '地点', personality: '' },
                        { id: 'e3', label: '火焰剑', overview: '物品', personality: '' },
                    ],
                    edges: [
                        { id: 'edge-1', source: 'e1', target: 'e2', label: '前往' },
                        { id: 'edge-2', source: 'e1', target: 'e3', label: '获得' },
                    ],
                },
            })
        if (url.includes('/events/')) return Promise.resolve({ data: sampleEvents })
        if (url.includes('/entities/')) return Promise.resolve({ data: sampleEntities })
        return Promise.resolve({ data: [] })
    })
})

/* ── Unit tests for pure helpers ── */

describe('buildGraphNodes', () => {
    it('creates a ReactFlow node for each entity', () => {
        const nodes = buildGraphNodes(sampleEntities)
        expect(nodes).toHaveLength(3)
        expect(nodes[0].id).toBe('e1')
        expect(nodes[0].data.label).toBe('李明')
        expect(nodes[0].data.entityType).toBe('character')
    })

    it('sets correct data fields from entity', () => {
        const nodes = buildGraphNodes(sampleEntities)
        const node = nodes[0]
        expect(node.data.attrs).toEqual({ age: 25, role: '主角' })
        expect(node.data.firstSeen).toBe(1)
        expect(node.data.lastSeen).toBe(5)
        expect(node.data.highlighted).toBe(false)
        expect(node.data.dimmed).toBe(false)
    })

    it('returns empty array for empty input', () => {
        expect(buildGraphNodes([])).toEqual([])
    })
})

describe('KnowledgeGraphPage project fetch behavior', () => {
    it('route 项目与 currentProject 不一致时会重新拉取项目', async () => {
        renderPage('proj-2')
        await waitFor(() => {
            expect(mockFetchProject).toHaveBeenCalledWith('proj-2')
        })
    })
})

describe('buildGraphEdges', () => {
    it('creates edges for events with matching subject and object entities', () => {
        const edges = buildGraphEdges(sampleEvents, sampleEntities)
        // ev1: 李明→冰霜城, ev2: 李明→火焰剑, ev3: no object entity match
        expect(edges).toHaveLength(2)
        expect(edges[0].source).toBe('e1')
        expect(edges[0].target).toBe('e2')
        expect(edges[0].label).toBe('前往')
    })

    it('skips events without matching object entity', () => {
        const edges = buildGraphEdges(sampleEvents, sampleEntities)
        expect(edges.some((edge) => edge.label === '战斗')).toBe(false) // ev3 has no object
    })

    it('returns empty array when no entities', () => {
        expect(buildGraphEdges(sampleEvents, [])).toEqual([])
    })

    it('hides progress edges by default and can include them via option', () => {
        const events: EventEdge[] = [
            { event_id: 'ev-p', subject: '李明', relation: 'progress', object: '冰霜城', chapter: 1, description: '' },
            { event_id: 'ev-c', subject: '李明', relation: '冲突', object: '火焰剑', chapter: 2, description: '' },
        ]
        const defaultEdges = buildGraphEdges(events, sampleEntities)
        expect(defaultEdges.map((edge) => edge.label)).toEqual(['冲突'])

        const withProgress = buildGraphEdges(events, sampleEntities, { includeProgress: true })
        expect(withProgress.map((edge) => edge.label)).toContain('progress')
        expect(withProgress.map((edge) => edge.label)).toContain('冲突')
    })
})

describe('getHighlightSets', () => {
    it('returns clicked node and its direct neighbors', () => {
        const edges = buildGraphEdges(sampleEvents, sampleEntities)
        const { highlightedNodeIds, highlightedEdgeIds } = getHighlightSets('e1', edges)
        // e1 connects to e2 (ev1) and e3 (ev2)
        expect(highlightedNodeIds).toEqual(new Set(['e1', 'e2', 'e3']))
        expect(highlightedEdgeIds.size).toBe(2)
    })

    it('returns only clicked node when it has no edges', () => {
        const edges = buildGraphEdges(sampleEvents, sampleEntities)
        const { highlightedNodeIds, highlightedEdgeIds } = getHighlightSets('e999', edges)
        expect(highlightedNodeIds).toEqual(new Set(['e999']))
        expect(highlightedEdgeIds).toEqual(new Set())
    })

    it('includes both source and target for bidirectional connections', () => {
        const edges = buildGraphEdges(sampleEvents, sampleEntities)
        const { highlightedNodeIds } = getHighlightSets('e2', edges)
        // e2 is target of ev1 (source=e1)
        expect(highlightedNodeIds).toEqual(new Set(['e1', 'e2']))
    })
})

describe('sortEventsByChapter', () => {
    it('sorts events in ascending chapter order', () => {
        const unsorted: EventEdge[] = [
            { event_id: 'a', subject: 'X', relation: 'r', chapter: 3, description: '' },
            { event_id: 'b', subject: 'Y', relation: 'r', chapter: 1, description: '' },
            { event_id: 'c', subject: 'Z', relation: 'r', chapter: 2, description: '' },
        ]
        const sorted = sortEventsByChapter(unsorted)
        expect(sorted.map((e) => e.chapter)).toEqual([1, 2, 3])
    })

    it('does not mutate original array', () => {
        const original: EventEdge[] = [
            { event_id: 'a', subject: 'X', relation: 'r', chapter: 3, description: '' },
            { event_id: 'b', subject: 'Y', relation: 'r', chapter: 1, description: '' },
        ]
        sortEventsByChapter(original)
        expect(original[0].chapter).toBe(3)
    })

    it('returns empty array for empty input', () => {
        expect(sortEventsByChapter([])).toEqual([])
    })
})

describe('sanitizeGraphData', () => {
    it('normalizes placeholder role names and drops hidden roles', () => {
        const entities: EntityNode[] = [
            { entity_id: 'a', entity_type: 'character', name: 'primary', attrs: {}, first_seen_chapter: 2, last_seen_chapter: 2 },
            { entity_id: 'b', entity_type: 'character', name: 'secondary', attrs: {}, first_seen_chapter: 2, last_seen_chapter: 2 },
            { entity_id: 'c', entity_type: 'character', name: 'hidden', attrs: {}, first_seen_chapter: 2, last_seen_chapter: 2 },
            { entity_id: 'd', entity_type: 'character', name: '主角', attrs: {}, first_seen_chapter: 1, last_seen_chapter: 3 },
        ]
        const events: EventEdge[] = [
            { event_id: 'ev-a', subject: 'primary', relation: 'progress', object: 'secondary', chapter: 2, description: '' },
            { event_id: 'ev-b', subject: 'hidden', relation: 'progress', object: 'primary', chapter: 3, description: '' },
        ]

        const sanitized = sanitizeGraphData(entities, events)
        const names = sanitized.entities.map((item) => item.name)
        expect(names).toContain('主角')
        expect(names).toContain('关键配角')
        expect(names).not.toContain('primary')
        expect(names).not.toContain('secondary')
        expect(names).not.toContain('hidden')
        expect(names.filter((name) => name === '主角')).toHaveLength(1)

        expect(sanitized.events).toHaveLength(1)
        expect(sanitized.events[0].subject).toBe('主角')
        expect(sanitized.events[0].object).toBe('关键配角')
    })

    it('filters noisy pseudo-role fragments from entities and events', () => {
        const entities: EntityNode[] = [
            { entity_id: 'a', entity_type: 'character', name: '都没', attrs: {}, first_seen_chapter: 1, last_seen_chapter: 1 },
            { entity_id: 'b', entity_type: 'character', name: '后者正', attrs: {}, first_seen_chapter: 1, last_seen_chapter: 1 },
            { entity_id: 'c', entity_type: 'character', name: '胡说八', attrs: {}, first_seen_chapter: 1, last_seen_chapter: 1 },
            { entity_id: 'd', entity_type: 'character', name: '任凭赵老板', attrs: {}, first_seen_chapter: 1, last_seen_chapter: 1 },
            { entity_id: 'e', entity_type: 'character', name: '通风管', attrs: {}, first_seen_chapter: 1, last_seen_chapter: 1 },
            { entity_id: 'f', entity_type: 'character', name: '冷静', attrs: {}, first_seen_chapter: 1, last_seen_chapter: 1 },
            { entity_id: 'g', entity_type: 'character', name: '陆仁甲', attrs: {}, first_seen_chapter: 1, last_seen_chapter: 2 },
        ]
        const events: EventEdge[] = [
            { event_id: 'ev-a', subject: '都没', relation: '冲突', object: '陆仁甲', chapter: 1, description: '' },
            { event_id: 'ev-b', subject: '陆仁甲', relation: '合作', object: '后者正', chapter: 1, description: '' },
            { event_id: 'ev-c', subject: '陆仁甲', relation: '保护', object: '苏小柒', chapter: 2, description: '' },
        ]

        const sanitized = sanitizeGraphData(entities, events)
        const names = sanitized.entities.map((item) => item.name)
        expect(names).toContain('陆仁甲')
        expect(names).not.toContain('都没')
        expect(names).not.toContain('后者正')
        expect(names).not.toContain('胡说八')
        expect(names).not.toContain('任凭赵老板')
        expect(names).not.toContain('通风管')
        expect(names).not.toContain('冷静')

        const serializedEvents = JSON.stringify(sanitized.events)
        expect(serializedEvents).not.toContain('都没')
        expect(serializedEvents).not.toContain('后者正')
        expect(serializedEvents).not.toContain('胡说八')
        expect(serializedEvents).not.toContain('任凭赵老板')
        expect(
            sanitized.events.some(
                (event) => event.subject === '陆仁甲' && event.object === '苏小柒' && event.relation === '保护',
            ),
        ).toBe(true)
    })
})

describe('ENTITY_STYLES', () => {
    it('has distinct styles for character, location, and item', () => {
        const types = ['character', 'location', 'item']
        const colors = types.map((t) => ENTITY_STYLES[t].color)
        const borders = types.map((t) => ENTITY_STYLES[t].borderColor)
        const shapes = types.map((t) => ENTITY_STYLES[t].shape)

        // All unique
        expect(new Set(colors).size).toBe(3)
        expect(new Set(borders).size).toBe(3)
        expect(new Set(shapes).size).toBe(3)
    })
})

/* ── Component integration tests ── */

describe('KnowledgeGraphPage', () => {
    it('renders page title and subtitle', async () => {
        renderPage()
        expect(screen.getByText('知识图谱')).toBeInTheDocument()
        expect(screen.getByText(/角色状态、关系事件/)).toBeInTheDocument()
    })

    it('renders two tab buttons', () => {
        renderPage()
        expect(screen.getByText('关系视图')).toBeInTheDocument()
        expect(screen.getByText('事件时间线')).toBeInTheDocument()
    })

    it('defaults to graph tab', () => {
        renderPage()
        const graphTab = screen.getByText('关系视图')
        expect(graphTab.getAttribute('aria-selected')).toBe('true')
    })

    it('shows skeleton while loading', () => {
        mockApiGet.mockReturnValue(new Promise(() => { }))
        const { container } = renderPage()
        expect(container.querySelector('.skeleton--card')).toBeInTheDocument()
    })

    it('renders ReactFlow canvas after data loads', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByTestId('reactflow-canvas')).toBeInTheDocument()
        })
    })

    it('renders entity nodes in the graph', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByTestId('rf-node-e1')).toBeInTheDocument()
            expect(screen.getByTestId('rf-node-e2')).toBeInTheDocument()
            expect(screen.getByTestId('rf-node-e3')).toBeInTheDocument()
        })
    })

    it('renders entity names in nodes', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('李明')).toBeInTheDocument()
            expect(screen.getByText('冰霜城')).toBeInTheDocument()
            expect(screen.getByText('火焰剑')).toBeInTheDocument()
        })
    })

    it('renders edges with relation labels', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getAllByTestId(/^rf-edge-/).length).toBeGreaterThan(0)
            expect(screen.getByText('前往')).toBeInTheDocument()
            expect(screen.getByText('获得')).toBeInTheDocument()
        })
    })

    it('shows empty state when no entities', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url.includes('/entities/')) return Promise.resolve({ data: [] })
            if (url.includes('/events/')) return Promise.resolve({ data: [] })
            return Promise.resolve({ data: [] })
        })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText(/暂无角色档案/)).toBeInTheDocument()
        })
    })

    it('shows error toast when API fails', async () => {
        mockApiGet.mockRejectedValue(new Error('network error'))
        renderPage()
        await waitFor(() => {
            const toasts = useToastStore.getState().toasts
            expect(toasts).toHaveLength(1)
            expect(toasts[0].type).toBe('error')
            expect(toasts[0].message).toBe('加载知识图谱数据失败')
        })
    })

    it('switches to timeline tab and shows sorted events', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByTestId('reactflow-canvas')).toBeInTheDocument()
        })

        fireEvent.click(screen.getByText('事件时间线'))

        await waitFor(() => {
            const chapterLabels = screen.getAllByText(/^第 \d+ 章$/)
            expect(chapterLabels.length).toBeGreaterThanOrEqual(3)
            // Verify order: chapter 1, 2, 3
            const chapters = chapterLabels.map((el) => {
                const match = el.textContent?.match(/第 (\d+) 章/)
                return match ? parseInt(match[1]) : 0
            })
            for (let i = 1; i < chapters.length; i++) {
                expect(chapters[i]).toBeGreaterThanOrEqual(chapters[i - 1])
            }
        })
    })

    it('shows empty timeline state', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url.includes('/projects/') && url.includes('/graph'))
                return Promise.resolve({ data: { nodes: [{ id: 'e1', label: '李明', overview: '主角', personality: '' }], edges: [] } })
            if (url.includes('/events/')) return Promise.resolve({ data: [] })
            if (url.includes('/entities/')) return Promise.resolve({ data: sampleEntities })
            return Promise.resolve({ data: [] })
        })
        renderPage()
        await waitFor(() => {
            expect(screen.getByTestId('reactflow-canvas')).toBeInTheDocument()
        })

        fireEvent.click(screen.getByText('事件时间线'))
        await waitFor(() => {
            expect(screen.getByText('暂无事件时间线。')).toBeInTheDocument()
        })
    })

    it('has back link to project detail', () => {
        renderPage()
        const backLink = screen.getByText('← 返回项目')
        expect(backLink.closest('a')).toHaveAttribute('href', '/project/proj-1')
    })

    it('shows event descriptions in timeline', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByTestId('reactflow-canvas')).toBeInTheDocument()
        })

        fireEvent.click(screen.getByText('事件时间线'))
        await waitFor(() => {
            expect(screen.getByText('主角出发前往冰霜城')).toBeInTheDocument()
            expect(screen.getByText('主角获得火焰剑')).toBeInTheDocument()
        })
    })
})

describe('KnowledgeGraphPage L4 data', () => {
    it('fetches from /api/projects/{id}/graph endpoint', async () => {
        renderPage()
        await waitFor(() => {
            expect(mockApiGet).toHaveBeenCalledWith('/projects/proj-1/graph')
        })
    })

    it('renders L4 character node label in graph', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url.includes('/projects/') && url.includes('/graph'))
                return Promise.resolve({ data: { nodes: [{ id: 'p1', label: '张三', overview: '主角', personality: '冷静' }], edges: [] } })
            if (url.includes('/events/')) return Promise.resolve({ data: [] })
            return Promise.resolve({ data: [] })
        })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('张三')).toBeInTheDocument()
        })
    })

    it('shows empty state when no L4 profiles exist', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url.includes('/projects/') && url.includes('/graph'))
                return Promise.resolve({ data: { nodes: [], edges: [] } })
            if (url.includes('/events/')) return Promise.resolve({ data: [] })
            return Promise.resolve({ data: [] })
        })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText(/暂无角色档案/)).toBeInTheDocument()
        })
    })
})

describe('buildL4GraphNodes with D3 forceRadial', () => {
    it('places highest-degree node near center (0,0)', () => {
        const nodes: L4GraphNode[] = [
            { id: 'hub', label: 'Hub', overview: '', personality: '' },
            { id: 'a', label: 'A', overview: '', personality: '' },
            { id: 'b', label: 'B', overview: '', personality: '' },
            { id: 'c', label: 'C', overview: '', personality: '' },
            { id: 'leaf', label: 'Leaf', overview: '', personality: '' },
        ]
        const edges: L4GraphEdge[] = [
            { id: 'e1', source: 'hub', target: 'a', label: '' },
            { id: 'e2', source: 'hub', target: 'b', label: '' },
            { id: 'e3', source: 'hub', target: 'c', label: '' },
            { id: 'e4', source: 'hub', target: 'leaf', label: '' },
            { id: 'e5', source: 'a', target: 'b', label: '' },
        ]
        const result = buildL4GraphNodes(nodes, edges)
        const hubNode = result.find((n) => n.id === 'hub')!
        const leafNode = result.find((n) => n.id === 'leaf')!
        const hubDist = Math.sqrt(hubNode.position.x ** 2 + hubNode.position.y ** 2)
        const leafDist = Math.sqrt(leafNode.position.x ** 2 + leafNode.position.y ** 2)
        expect(hubDist).toBeLessThan(leafDist)
    })

    it('handles single node without crashing', () => {
        const nodes: L4GraphNode[] = [{ id: 'solo', label: 'Solo', overview: '', personality: '' }]
        const result = buildL4GraphNodes(nodes, [])
        expect(result).toHaveLength(1)
        expect(result[0].position).toBeDefined()
    })
})
describe('node context menu', () => {
    it('shows context menu on right-click', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByTestId('rf-node-e1')).toBeInTheDocument()
        })
        fireEvent.contextMenu(screen.getByTestId('rf-node-e1'))
        await waitFor(() => {
            expect(screen.getByTestId('node-context-menu')).toBeInTheDocument()
        })
    })
})


describe('graph toolbar', () => {
    it('renders add-node button', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('+ 添加节点')).toBeInTheDocument()
        })
    })
})
